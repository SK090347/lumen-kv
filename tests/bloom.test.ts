import { describe, it, expect } from 'vitest';
import { BloomFilter } from '../src/bloom.js';

describe('BloomFilter', () => {
  it('never false-negatives for inserted keys', () => {
    const bf = new BloomFilter(100, 0.01);
    const keys = Array.from({ length: 50 }, (_, i) => `key-${i}`);
    for (const k of keys) bf.add(k);
    for (const k of keys) expect(bf.mightContain(k)).toBe(true);
  });

  it('round-trips via buffer', () => {
    const bf = new BloomFilter(20, 0.01);
    bf.add('hello');
    const copy = BloomFilter.fromBuffer(bf.toBuffer(), bf.bitCount, bf.hashCount);
    expect(copy.mightContain('hello')).toBe(true);
    expect(copy.mightContain('missing-xyz')).toBe(false);
  });
});
