import { describe, it, expect } from 'vitest';
import { Memtable } from '../src/memtable.js';

describe('Memtable', () => {
  it('stores and retrieves values in sorted order', () => {
    const m = new Memtable();
    m.put('c', { kind: 'value', value: '3', seq: 1 });
    m.put('a', { kind: 'value', value: '1', seq: 2 });
    m.put('b', { kind: 'value', value: '2', seq: 3 });
    expect([...m.entries()].map((e) => e.key)).toEqual(['a', 'b', 'c']);
    expect(m.get('b')).toEqual({ kind: 'value', value: '2', seq: 3 });
  });

  it('overwrites and supports tombstones', () => {
    const m = new Memtable();
    m.put('x', { kind: 'value', value: 'old', seq: 1 });
    m.put('x', { kind: 'value', value: 'new', seq: 2 });
    expect(m.size).toBe(1);
    expect(m.get('x')?.kind === 'value' && m.get('x').value).toBe('new');
    m.delete('x', 3);
    expect(m.get('x')).toEqual({ kind: 'tombstone', seq: 3 });
  });
});
