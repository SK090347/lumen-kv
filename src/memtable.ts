/**
 * Memtable — in-memory sorted map with skip-list-style API.
 *
 * Educational note: production systems (LevelDB/RocksDB) use a skip list
 * for O(log n) inserts with better concurrency. We use a TreeMap-like
 * approach via a sorted array + binary search for clarity, exposing the
 * same asymptotic complexity and ordered-scan semantics.
 */

import type { Entry, KeyValue } from './types.js';

export class Memtable {
  /** Sorted keys for binary search / ordered iteration */
  private keys: string[] = [];
  private map = new Map<string, Entry>();

  get size(): number {
    return this.map.size;
  }

  isEmpty(): boolean {
    return this.map.size === 0;
  }

  clear(): void {
    this.keys = [];
    this.map.clear();
  }

  /** O(log n) lookup via Map (hash) — key order maintained separately. */
  get(key: string): Entry | undefined {
    return this.map.get(key);
  }

  /**
   * Put or overwrite. Maintains sorted key array.
   * Amortized O(n) due to splice; skip-list would be O(log n).
   * Fine for educational flush thresholds (~1k entries).
   */
  put(key: string, entry: Entry): void {
    if (!this.map.has(key)) {
      const idx = this.lowerBound(key);
      this.keys.splice(idx, 0, key);
    }
    this.map.set(key, entry);
  }

  /** Soft-delete via tombstone. */
  delete(key: string, seq: number): void {
    this.put(key, { kind: 'tombstone', seq });
  }

  /** Ordered iteration — O(n). */
  *entries(): IterableIterator<KeyValue> {
    for (const key of this.keys) {
      const entry = this.map.get(key)!;
      yield { key, entry };
    }
  }

  /** Snapshot as sorted KeyValue array (for flush). */
  toSortedArray(): KeyValue[] {
    return Array.from(this.entries());
  }

  /** Binary search: first index where keys[i] >= key. */
  private lowerBound(key: string): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.keys[mid]! < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
