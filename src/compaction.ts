/**
 * Size-tiered compaction (simplified).
 *
 * Strategy: when any level accumulates `threshold` SSTables, merge them
 * into a single SSTable on the next level (or same level+1). Newer
 * sequence numbers win; tombstones are dropped only when compacting
 * into the lowest level that is the final destination for that key
 * (here: we drop tombstones when merging into level >= 2 for simplicity,
 * otherwise we keep them so deletes remain visible above older values).
 *
 * Why size-tiered (vs leveled):
 * - Size-tiered (Cassandra/Scylla style): compact similarly-sized files
 *   together. Write amp lower, read amp higher.
 * - Leveled (LevelDB/RocksDB): each level is ~10x previous and non-
 *   overlapping. Read amp lower, write amp higher.
 * We implement size-tiered for teaching clarity and fewer moving parts.
 */

import type { KeyValue } from './types.js';
import { SSTableMeta, SSTableReader, SSTableWriter } from './sstable.js';

export interface CompactionResult {
  removed: SSTableMeta[];
  created: SSTableMeta | null;
}

/**
 * K-way merge of sorted SST iterators by key; highest seq wins.
 */
export function mergeSorted(
  sources: IterableIterator<KeyValue>[],
  dropTombstones: boolean,
): KeyValue[] {
  // Materialize for educational simplicity (real systems stream).
  const heaps: { key: string; entry: KeyValue['entry']; src: number }[][] = sources.map(
    (it, src) => {
      const arr: { key: string; entry: KeyValue['entry']; src: number }[] = [];
      for (const kv of it) arr.push({ key: kv.key, entry: kv.entry, src });
      return arr;
    },
  );
  const pointers = heaps.map(() => 0);
  const out: KeyValue[] = [];

  const pickMinKey = (): string | null => {
    let min: string | null = null;
    for (let i = 0; i < heaps.length; i++) {
      const p = pointers[i]!;
      const row = heaps[i]![p];
      if (!row) continue;
      if (min === null || row.key < min) min = row.key;
    }
    return min;
  };

  while (true) {
    const key = pickMinKey();
    if (key === null) break;

    // Collect all versions of this key across sources; pick highest seq.
    let best: KeyValue | null = null;
    for (let i = 0; i < heaps.length; i++) {
      const p = pointers[i]!;
      const row = heaps[i]![p];
      if (!row || row.key !== key) continue;
      if (!best || row.entry.seq > best.entry.seq) {
        best = { key: row.key, entry: row.entry };
      }
      pointers[i] = p + 1;
      // skip duplicate keys within same source (shouldn't happen)
      while (heaps[i]![pointers[i]!] && heaps[i]![pointers[i]!]!.key === key) {
        const dup = heaps[i]![pointers[i]!]!;
        if (dup.entry.seq > (best?.entry.seq ?? -1)) {
          best = { key: dup.key, entry: dup.entry };
        }
        pointers[i]!++;
      }
    }

    if (!best) continue;
    if (dropTombstones && best.entry.kind === 'tombstone') continue;
    out.push(best);
  }
  return out;
}

export function compactLevel(
  dataDir: string,
  tables: SSTableMeta[],
  level: number,
  threshold: number,
  nextId: () => number,
  useBloom: boolean,
  bloomFpr: number,
): CompactionResult {
  const atLevel = tables.filter((t) => t.level === level);
  if (atLevel.length < threshold) {
    return { removed: [], created: null };
  }

  const readers = atLevel.map((m) => new SSTableReader(m));
  const iters = readers.map((r) => r.scan());
  const targetLevel = level + 1;
  // Drop tombstones when pushing to level >= 2 (educational GC heuristic).
  const dropTombstones = targetLevel >= 2;
  const merged = mergeSorted(iters, dropTombstones);

  if (merged.length === 0) {
    for (const m of atLevel) SSTableReader.deleteFile(m.path);
    return { removed: atLevel, created: null };
  }

  const created = SSTableWriter.write(
    dataDir,
    nextId(),
    targetLevel,
    merged,
    useBloom,
    bloomFpr,
  );

  for (const m of atLevel) SSTableReader.deleteFile(m.path);
  return { removed: atLevel, created };
}
