/**
 * LumenDB — LSM-tree key-value store engine.
 *
 * Write path:  Put/Delete → WAL append → Memtable
 *              Memtable full → flush to L0 SSTable → WAL checkpoint → compact
 * Read path:   Memtable → L0..Ln SSTables (newest seq wins), Bloom skip
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry, LumenOptions, Stats } from './types.js';
import { Memtable } from './memtable.js';
import { WAL } from './wal.js';
import { SSTableMeta, SSTableReader, SSTableWriter, listSSTables } from './sstable.js';
import { compactLevel } from './compaction.js';

const MANIFEST = 'MANIFEST.json';

interface Manifest {
  nextSstId: number;
  sequence: number;
}

export class LumenDB {
  private readonly dataDir: string;
  private readonly flushThreshold: number;
  private readonly compactionThreshold: number;
  private readonly useBloom: boolean;
  private readonly bloomFpr: number;

  private memtable = new Memtable();
  private wal: WAL;
  private tables: SSTableMeta[] = [];
  private sequence = 0;
  private nextSstId = 1;
  private openFlag = false;

  constructor(options: LumenOptions = {}) {
    this.dataDir = options.dataDir ?? './data';
    this.flushThreshold = options.memtableFlushThreshold ?? 1000;
    this.compactionThreshold = options.compactionThreshold ?? 4;
    this.useBloom = options.bloomFilter !== false;
    this.bloomFpr = options.bloomFpr ?? 0.01;
    this.wal = new WAL(this.dataDir);
  }

  /** Open (or create) the database and recover from WAL + SST manifests. */
  async open(): Promise<void> {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });

    const manifestPath = join(this.dataDir, MANIFEST);
    if (existsSync(manifestPath)) {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      this.nextSstId = m.nextSstId;
      this.sequence = m.sequence;
    }

    this.tables = listSSTables(this.dataDir);
    this.wal.open();
    const walSeq = this.wal.recover(this.memtable);
    this.sequence = Math.max(this.sequence, walSeq);
    this.openFlag = true;
    this.persistManifest();
  }

  async close(): Promise<void> {
    if (!this.openFlag) return;
    if (!this.memtable.isEmpty()) {
      await this.flush();
    }
    await this.wal.close();
    this.persistManifest();
    this.openFlag = false;
  }

  async put(key: string, value: string): Promise<void> {
    this.assertOpen();
    const seq = ++this.sequence;
    await this.wal.appendPut(key, value, seq);
    this.memtable.put(key, { kind: 'value', value, seq });
    if (this.memtable.size >= this.flushThreshold) {
      await this.flush();
    }
  }

  async delete(key: string): Promise<void> {
    this.assertOpen();
    const seq = ++this.sequence;
    await this.wal.appendDelete(key, seq);
    this.memtable.delete(key, seq);
    if (this.memtable.size >= this.flushThreshold) {
      await this.flush();
    }
  }

  async get(key: string): Promise<string | undefined> {
    this.assertOpen();
    const fromMem = this.memtable.get(key);
    let best: Entry | undefined = fromMem;

    // Scan SSTables from newest (higher id / lower level first by creation)
    // Level 0 may overlap; higher levels from size-tiered may too — always
    // pick highest sequence number.
    const ordered = [...this.tables].sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return b.id - a.id; // newer first within level
    });

    for (const meta of ordered) {
      const reader = new SSTableReader(meta);
      const entry = reader.get(key);
      if (!entry) continue;
      if (!best || entry.seq > best.seq) best = entry;
    }

    if (!best || best.kind === 'tombstone') return undefined;
    return best.value;
  }

  /** Inclusive range scan over memtable + SSTs (merged by seq). */
  async *scan(start?: string, end?: string): AsyncGenerator<[string, string]> {
    this.assertOpen();
    const map = new Map<string, Entry>();

    for (const meta of this.tables) {
      const reader = new SSTableReader(meta);
      for (const { key, entry } of reader.scan()) {
        if (start !== undefined && key < start) continue;
        if (end !== undefined && key > end) continue;
        const prev = map.get(key);
        if (!prev || entry.seq > prev.seq) map.set(key, entry);
      }
    }
    for (const { key, entry } of this.memtable.entries()) {
      if (start !== undefined && key < start) continue;
      if (end !== undefined && key > end) continue;
      const prev = map.get(key);
      if (!prev || entry.seq > prev.seq) map.set(key, entry);
    }

    const keys = [...map.keys()].sort();
    for (const key of keys) {
      const e = map.get(key)!;
      if (e.kind === 'value') yield [key, e.value];
    }
  }

  async flush(): Promise<void> {
    this.assertOpen();
    if (this.memtable.isEmpty()) return;

    const entries = this.memtable.toSortedArray();
    const meta = SSTableWriter.write(
      this.dataDir,
      this.nextSstId++,
      0,
      entries,
      this.useBloom,
      this.bloomFpr,
    );
    this.tables.push(meta);
    this.memtable.clear();
    await this.wal.checkpoint();
    this.persistManifest();
    await this.maybeCompact();
  }

  private async maybeCompact(): Promise<void> {
    // Compact from level 0 upward while any level exceeds threshold.
    let changed = true;
    while (changed) {
      changed = false;
      const levels = new Set(this.tables.map((t) => t.level));
      const maxLevel = levels.size ? Math.max(...levels) : 0;
      for (let lvl = 0; lvl <= maxLevel; lvl++) {
        const result = compactLevel(
          this.dataDir,
          this.tables,
          lvl,
          this.compactionThreshold,
          () => this.nextSstId++,
          this.useBloom,
          this.bloomFpr,
        );
        if (result.removed.length) {
          const removedPaths = new Set(result.removed.map((r) => r.path));
          this.tables = this.tables.filter((t) => !removedPaths.has(t.path));
          if (result.created) this.tables.push(result.created);
          this.persistManifest();
          changed = true;
          break; // restart from L0 after structural change
        }
      }
    }
  }

  stats(): Stats {
    const levelMap = new Map<number, number>();
    for (const t of this.tables) {
      levelMap.set(t.level, (levelMap.get(t.level) ?? 0) + 1);
    }
    const maxL = levelMap.size ? Math.max(...levelMap.keys()) : -1;
    const levels: number[] = [];
    for (let i = 0; i <= maxL; i++) levels.push(levelMap.get(i) ?? 0);

    return {
      memtableSize: this.memtable.size,
      walBytes: this.wal.byteLength,
      sstables: this.tables.length,
      levels,
      sequence: this.sequence,
    };
  }

  private persistManifest(): void {
    const manifest: Manifest = {
      nextSstId: this.nextSstId,
      sequence: this.sequence,
    };
    writeFileSync(join(this.dataDir, MANIFEST), JSON.stringify(manifest, null, 2));
  }

  private assertOpen(): void {
    if (!this.openFlag) throw new Error('LumenDB is not open — call open() first');
  }
}
