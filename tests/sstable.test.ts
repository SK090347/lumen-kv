import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SSTableWriter, SSTableReader } from '../src/sstable.js';
import type { KeyValue } from '../src/types.js';

describe('SSTable read/write', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-sst-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips sorted entries including tombstones', () => {
    const entries: KeyValue[] = [
      { key: 'a', entry: { kind: 'value', value: 'alpha', seq: 1 } },
      { key: 'b', entry: { kind: 'tombstone', seq: 2 } },
      { key: 'c', entry: { kind: 'value', value: 'charlie', seq: 3 } },
    ];
    const meta = SSTableWriter.write(dir, 1, 0, entries, true);
    const reader = new SSTableReader(meta);

    expect(reader.get('a')).toEqual({ kind: 'value', value: 'alpha', seq: 1 });
    expect(reader.get('b')).toEqual({ kind: 'tombstone', seq: 2 });
    expect(reader.get('c')).toEqual({ kind: 'value', value: 'charlie', seq: 3 });
    expect(reader.get('missing')).toBeUndefined();

    const scanned = [...reader.scan()].map((e) => e.key);
    expect(scanned).toEqual(['a', 'b', 'c']);
  });

  it('bloom filter rejects absent keys without false negatives', () => {
    const entries: KeyValue[] = Array.from({ length: 30 }, (_, i) => ({
      key: `k${String(i).padStart(3, '0')}`,
      entry: { kind: 'value' as const, value: `v${i}`, seq: i + 1 },
    }));
    const meta = SSTableWriter.write(dir, 2, 0, entries, true, 0.01);
    const reader = new SSTableReader(meta);
    for (const e of entries) {
      expect(reader.get(e.key)?.kind).toBe('value');
    }
    expect(reader.get('zzz-absent-key-999')).toBeUndefined();
  });
});
