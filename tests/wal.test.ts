import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WAL } from '../src/wal.js';
import { Memtable } from '../src/memtable.js';

describe('WAL recovery', () => {
  let dir: string;
  const openWals: WAL[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-wal-'));
    openWals.length = 0;
  });

  afterEach(async () => {
    for (const w of openWals) {
      try {
        await w.close();
      } catch {
        /* ignore */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovers puts and deletes after crash (re-open)', async () => {
    const wal = new WAL(dir);
    openWals.push(wal);
    wal.open();
    await wal.appendPut('a', '1', 1);
    await wal.appendPut('b', '2', 2);
    await wal.appendDelete('a', 3);
    await wal.close();

    const mem = new Memtable();
    const wal2 = new WAL(dir);
    openWals.push(wal2);
    const maxSeq = wal2.recover(mem);
    expect(maxSeq).toBe(3);
    expect(mem.get('a')).toEqual({ kind: 'tombstone', seq: 3 });
    expect(mem.get('b')).toEqual({ kind: 'value', value: '2', seq: 2 });
  });

  it('checkpoint truncates the log', async () => {
    const wal = new WAL(dir);
    openWals.push(wal);
    wal.open();
    await wal.appendPut('k', 'v', 1);
    expect(wal.byteLength).toBeGreaterThan(0);
    await wal.checkpoint();
    expect(wal.byteLength).toBe(0);
    await wal.close();

    const mem = new Memtable();
    const wal2 = new WAL(dir);
    openWals.push(wal2);
    wal2.recover(mem);
    expect(mem.size).toBe(0);
  });
});
