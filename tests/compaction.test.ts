import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeSorted, compactLevel } from '../src/compaction.js';
import { SSTableWriter, SSTableReader, listSSTables } from '../src/sstable.js';
import type { KeyValue } from '../src/types.js';

describe('compaction correctness', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-cmp-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mergeSorted picks highest sequence and optionally drops tombstones', () => {
    function* a(): Generator<KeyValue> {
      yield { key: 'a', entry: { kind: 'value', value: 'old', seq: 1 } };
      yield { key: 'b', entry: { kind: 'value', value: 'keep', seq: 2 } };
    }
    function* b(): Generator<KeyValue> {
      yield { key: 'a', entry: { kind: 'value', value: 'new', seq: 5 } };
      yield { key: 'c', entry: { kind: 'tombstone', seq: 4 } };
    }
    const merged = mergeSorted([a(), b()], false);
    expect(merged.find((x) => x.key === 'a')?.entry).toEqual({
      kind: 'value',
      value: 'new',
      seq: 5,
    });
    expect(merged.find((x) => x.key === 'c')?.entry.kind).toBe('tombstone');

    const dropped = mergeSorted([a(), b()], true);
    expect(dropped.find((x) => x.key === 'c')).toBeUndefined();
  });

  it('compactLevel merges threshold SSTs into next level', () => {
    const batches: KeyValue[][] = [
      [
        { key: 'a', entry: { kind: 'value', value: '1', seq: 1 } },
        { key: 'b', entry: { kind: 'value', value: '1', seq: 2 } },
      ],
      [
        { key: 'a', entry: { kind: 'value', value: '2', seq: 10 } },
        { key: 'c', entry: { kind: 'value', value: '2', seq: 11 } },
      ],
      [
        { key: 'b', entry: { kind: 'tombstone', seq: 20 } },
        { key: 'd', entry: { kind: 'value', value: '3', seq: 21 } },
      ],
      [
        { key: 'c', entry: { kind: 'value', value: '3', seq: 30 } },
        { key: 'e', entry: { kind: 'value', value: '3', seq: 31 } },
      ],
    ];

    let id = 1;
    const metas = batches.map((entries) =>
      SSTableWriter.write(dir, id++, 0, entries, true),
    );

    let next = id;
    const result = compactLevel(dir, metas, 0, 4, () => next++, true, 0.01);
    expect(result.removed).toHaveLength(4);
    expect(result.created).not.toBeNull();
    expect(result.created!.level).toBe(1);

    const remaining = listSSTables(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.level).toBe(1);

    const reader = new SSTableReader(remaining[0]!);
    expect(reader.get('a')).toEqual({ kind: 'value', value: '2', seq: 10 });
    expect(reader.get('b')).toEqual({ kind: 'tombstone', seq: 20 }); // kept (target L1 < 2)
    expect(reader.get('c')).toEqual({ kind: 'value', value: '3', seq: 30 });
    expect(reader.get('d')).toEqual({ kind: 'value', value: '3', seq: 21 });
    expect(reader.get('e')).toEqual({ kind: 'value', value: '3', seq: 31 });
  });
});
