/**
 * Simple Bloom filter for SST membership tests.
 * Uses double-hashing (Kirsch-Mitzenmacher) over FNV-1a seeds.
 */

import { createHash } from 'node:crypto';

export class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly k: number;
  readonly bitCount: number;

  constructor(expectedItems: number, fpr = 0.01) {
    const n = Math.max(1, expectedItems);
    // m = -n * ln(p) / (ln2)^2
    const m = Math.ceil((-n * Math.log(fpr)) / (Math.LN2 * Math.LN2));
    this.bitCount = Math.max(64, m);
    this.bits = new Uint8Array(Math.ceil(this.bitCount / 8));
    // k = (m/n) * ln2
    this.k = Math.max(1, Math.round((this.bitCount / n) * Math.LN2));
  }

  static fromBuffer(buf: Buffer, bitCount: number, k: number): BloomFilter {
    const bf = Object.create(BloomFilter.prototype) as BloomFilter;
    (bf as unknown as { bits: Uint8Array }).bits = new Uint8Array(buf);
    (bf as unknown as { bitCount: number }).bitCount = bitCount;
    (bf as unknown as { k: number }).k = k;
    return bf;
  }

  add(key: string): void {
    const [h1, h2] = this.hashes(key);
    for (let i = 0; i < this.k; i++) {
      const idx = Number((h1 + BigInt(i) * h2) % BigInt(this.bitCount));
      this.bits[idx >>> 3]! |= 1 << (idx & 7);
    }
  }

  /** Returns false ⇒ definitely not present; true ⇒ maybe present. */
  mightContain(key: string): boolean {
    const [h1, h2] = this.hashes(key);
    for (let i = 0; i < this.k; i++) {
      const idx = Number((h1 + BigInt(i) * h2) % BigInt(this.bitCount));
      if ((this.bits[idx >>> 3]! & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bits);
  }

  get hashCount(): number {
    return this.k;
  }

  private hashes(key: string): [bigint, bigint] {
    const a = createHash('sha256').update(key).update('\0a').digest();
    const b = createHash('sha256').update(key).update('\0b').digest();
    const h1 = a.readBigUInt64BE(0);
    const h2 = (b.readBigUInt64BE(0) | 1n); // force odd for full period
    return [h1, h2];
  }
}
