import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LumenDB } from '../src/db.js';

describe('LumenDB integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-db-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('put/get/delete across flush and reopen (WAL + SST)', async () => {
    {
      const db = new LumenDB({
        dataDir: dir,
        memtableFlushThreshold: 3,
        compactionThreshold: 8,
      });
      await db.open();
      await db.put('user:1', 'alice');
      await db.put('user:2', 'bob');
      await db.put('user:3', 'carol'); // triggers flush
      await db.put('user:1', 'alice-updated');
      await db.delete('user:2');
      await db.close();
    }

    const db2 = new LumenDB({
      dataDir: dir,
      memtableFlushThreshold: 3,
      compactionThreshold: 8,
    });
    await db2.open();
    expect(await db2.get('user:1')).toBe('alice-updated');
    expect(await db2.get('user:2')).toBeUndefined();
    expect(await db2.get('user:3')).toBe('carol');

    const rows: [string, string][] = [];
    for await (const row of db2.scan('user:')) rows.push(row);
    expect(rows).toEqual([
      ['user:1', 'alice-updated'],
      ['user:3', 'carol'],
    ]);
    await db2.close();
  });

  it('survives crash mid-memtable via WAL replay', async () => {
    const db = new LumenDB({
      dataDir: dir,
      memtableFlushThreshold: 1000,
      compactionThreshold: 8,
    });
    await db.open();
    await db.put('x', '1');
    await db.put('y', '2');
    // simulate crash: close WAL stream without flush
    await (db as unknown as { wal: { close: () => Promise<void> } }).wal.close();

    const db2 = new LumenDB({ dataDir: dir, memtableFlushThreshold: 1000 });
    await db2.open();
    expect(await db2.get('x')).toBe('1');
    expect(await db2.get('y')).toBe('2');
    await db2.close();
  });

  it('compacts when L0 fills', async () => {
    const db = new LumenDB({
      dataDir: dir,
      memtableFlushThreshold: 2,
      compactionThreshold: 3,
    });
    await db.open();
    for (let i = 0; i < 12; i++) {
      await db.put(`k${i}`, `v${i}`);
    }
    await db.flush();
    const s = db.stats();
    expect(s.sstables).toBeGreaterThan(0);
    // After size-tiered compaction, should not have 6+ raw L0 files
    expect(s.levels[0] ?? 0).toBeLessThan(3);
    for (let i = 0; i < 12; i++) {
      expect(await db.get(`k${i}`)).toBe(`v${i}`);
    }
    await db.close();
  });
});
