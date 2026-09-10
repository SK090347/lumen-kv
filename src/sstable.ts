/**
 * SSTable — immutable sorted string table on disk.
 *
 * File layout:
 *   magic "LMN1" (4)
 *   version u32 (4)
 *   entryCount u32 (4)
 *   bloomBitCount u32 (4)
 *   bloomK u32 (4)
 *   bloomBytesLen u32 (4)
 *   bloomBytes
 *   indexOffset u64 (8)  — absolute file offset of index
 *   --- data block ---
 *   repeated: [u32 keyLen][key][u8 kind][u32 valLen?][value?][u64 seq]
 *   --- index ---
 *   repeated: [u32 keyLen][key][u64 offset]  (offset into data block start)
 *   footer: indexEntryCount u32
 *
 * Reads use Bloom → index binary search → data seek.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Entry, KeyValue } from './types.js';
import { BloomFilter } from './bloom.js';

const MAGIC = Buffer.from('LMN1');
const KIND_VALUE = 1;
const KIND_TOMB = 2;

export interface SSTableMeta {
  path: string;
  id: number;
  level: number;
  minKey: string;
  maxKey: string;
  entryCount: number;
  bloom?: BloomFilter;
}

export class SSTableWriter {
  static write(
    dataDir: string,
    id: number,
    level: number,
    entries: KeyValue[],
    useBloom = true,
    bloomFpr = 0.01,
  ): SSTableMeta {
    const sstDir = join(dataDir, 'sst');
    if (!existsSync(sstDir)) mkdirSync(sstDir, { recursive: true });

    const bloom = useBloom ? new BloomFilter(Math.max(1, entries.length), bloomFpr) : null;
    if (bloom) {
      for (const { key } of entries) bloom.add(key);
    }

    const dataParts: Buffer[] = [];
    const indexParts: Buffer[] = [];
    let dataOffset = 0;

    for (const { key, entry } of entries) {
      const keyBuf = Buffer.from(key, 'utf8');
      // index entry
      const idx = Buffer.alloc(4 + keyBuf.length + 8);
      idx.writeUInt32BE(keyBuf.length, 0);
      keyBuf.copy(idx, 4);
      idx.writeBigUInt64BE(BigInt(dataOffset), 4 + keyBuf.length);
      indexParts.push(idx);

      // data record
      if (entry.kind === 'value') {
        const valBuf = Buffer.from(entry.value, 'utf8');
        const rec = Buffer.alloc(4 + keyBuf.length + 1 + 4 + valBuf.length + 8);
        let p = 0;
        rec.writeUInt32BE(keyBuf.length, p); p += 4;
        keyBuf.copy(rec, p); p += keyBuf.length;
        rec.writeUInt8(KIND_VALUE, p); p += 1;
        rec.writeUInt32BE(valBuf.length, p); p += 4;
        valBuf.copy(rec, p); p += valBuf.length;
        rec.writeBigUInt64BE(BigInt(entry.seq), p);
        dataParts.push(rec);
        dataOffset += rec.length;
      } else {
        const rec = Buffer.alloc(4 + keyBuf.length + 1 + 8);
        let p = 0;
        rec.writeUInt32BE(keyBuf.length, p); p += 4;
        keyBuf.copy(rec, p); p += keyBuf.length;
        rec.writeUInt8(KIND_TOMB, p); p += 1;
        rec.writeBigUInt64BE(BigInt(entry.seq), p);
        dataParts.push(rec);
        dataOffset += rec.length;
      }
    }

    const bloomBytes = bloom ? bloom.toBuffer() : Buffer.alloc(0);
    const headerSize =
      4 + 4 + 4 + 4 + 4 + 4 + bloomBytes.length + 8;

    const dataBuf = Buffer.concat(dataParts);
    const indexBuf = Buffer.concat(indexParts);
    const footer = Buffer.alloc(4);
    footer.writeUInt32BE(entries.length, 0);

    const header = Buffer.alloc(headerSize);
    let hp = 0;
    MAGIC.copy(header, hp); hp += 4;
    header.writeUInt32BE(1, hp); hp += 4; // version
    header.writeUInt32BE(entries.length, hp); hp += 4;
    header.writeUInt32BE(bloom ? bloom.bitCount : 0, hp); hp += 4;
    header.writeUInt32BE(bloom ? bloom.hashCount : 0, hp); hp += 4;
    header.writeUInt32BE(bloomBytes.length, hp); hp += 4;
    bloomBytes.copy(header, hp); hp += bloomBytes.length;
    header.writeBigUInt64BE(BigInt(headerSize + dataBuf.length), hp); // index offset

    const file = Buffer.concat([header, dataBuf, indexBuf, footer]);
    const filename = `L${level}-${String(id).padStart(6, '0')}.sst`;
    const path = join(sstDir, filename);
    const tmp = path + '.tmp';
    writeFileSync(tmp, file);
    renameSync(tmp, path);

    return {
      path,
      id,
      level,
      minKey: entries.length ? entries[0]!.key : '',
      maxKey: entries.length ? entries[entries.length - 1]!.key : '',
      entryCount: entries.length,
      bloom: bloom ?? undefined,
    };
  }
}

export class SSTableReader {
  private meta: SSTableMeta;
  private index: { key: string; offset: number }[] = [];
  private dataStart = 0;
  private loaded = false;

  constructor(meta: SSTableMeta) {
    this.meta = meta;
  }

  get metadata(): SSTableMeta {
    return this.meta;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const buf = readFileSync(this.meta.path);
    if (buf.subarray(0, 4).compare(MAGIC) !== 0) {
      throw new Error(`Invalid SST magic: ${this.meta.path}`);
    }
    let p = 4;
    p += 4; // version
    const entryCount = buf.readUInt32BE(p); p += 4;
    const bloomBits = buf.readUInt32BE(p); p += 4;
    const bloomK = buf.readUInt32BE(p); p += 4;
    const bloomLen = buf.readUInt32BE(p); p += 4;
    const bloomBytes = buf.subarray(p, p + bloomLen); p += bloomLen;
    if (bloomLen > 0) {
      this.meta.bloom = BloomFilter.fromBuffer(Buffer.from(bloomBytes), bloomBits, bloomK);
    }
    const indexOffset = Number(buf.readBigUInt64BE(p)); p += 8;
    this.dataStart = p;

    // parse index
    let ip = indexOffset;
    this.index = [];
    for (let i = 0; i < entryCount; i++) {
      const keyLen = buf.readUInt32BE(ip); ip += 4;
      const key = buf.subarray(ip, ip + keyLen).toString('utf8'); ip += keyLen;
      const offset = Number(buf.readBigUInt64BE(ip)); ip += 8;
      this.index.push({ key, offset });
    }
    this.meta.entryCount = entryCount;
    if (this.index.length) {
      this.meta.minKey = this.index[0]!.key;
      this.meta.maxKey = this.index[this.index.length - 1]!.key;
    }
    this.loaded = true;
  }

  get(key: string): Entry | undefined {
    this.ensureLoaded();
    if (this.meta.bloom && !this.meta.bloom.mightContain(key)) {
      return undefined;
    }
    if (this.index.length === 0) return undefined;
    if (key < this.meta.minKey || key > this.meta.maxKey) return undefined;

    // binary search index
    let lo = 0;
    let hi = this.index.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = this.index[mid]!.key.localeCompare(key);
      if (cmp === 0) {
        found = mid;
        break;
      }
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    if (found < 0) return undefined;

    const fd = openSync(this.meta.path, 'r');
    try {
      const offset = this.dataStart + this.index[found]!.offset;
      // read keyLen first
      const hdr = Buffer.alloc(4);
      readSync(fd, hdr, 0, 4, offset);
      const keyLen = hdr.readUInt32BE(0);
      // skip key, read kind
      const kindBuf = Buffer.alloc(1);
      readSync(fd, kindBuf, 0, 1, offset + 4 + keyLen);
      const kind = kindBuf.readUInt8(0);
      if (kind === KIND_TOMB) {
        const seqBuf = Buffer.alloc(8);
        readSync(fd, seqBuf, 0, 8, offset + 4 + keyLen + 1);
        return { kind: 'tombstone', seq: Number(seqBuf.readBigUInt64BE(0)) };
      }
      const valLenBuf = Buffer.alloc(4);
      readSync(fd, valLenBuf, 0, 4, offset + 4 + keyLen + 1);
      const valLen = valLenBuf.readUInt32BE(0);
      const valBuf = Buffer.alloc(valLen);
      readSync(fd, valBuf, 0, valLen, offset + 4 + keyLen + 1 + 4);
      const seqBuf = Buffer.alloc(8);
      readSync(fd, seqBuf, 0, 8, offset + 4 + keyLen + 1 + 4 + valLen);
      return {
        kind: 'value',
        value: valBuf.toString('utf8'),
        seq: Number(seqBuf.readBigUInt64BE(0)),
      };
    } finally {
      closeSync(fd);
    }
  }

  /** Full scan in key order (for compaction / range). */
  *scan(): IterableIterator<KeyValue> {
    this.ensureLoaded();
    const buf = readFileSync(this.meta.path);
    for (const { offset } of this.index) {
      let p = this.dataStart + offset;
      const keyLen = buf.readUInt32BE(p); p += 4;
      const key = buf.subarray(p, p + keyLen).toString('utf8'); p += keyLen;
      const kind = buf.readUInt8(p); p += 1;
      if (kind === KIND_TOMB) {
        const seq = Number(buf.readBigUInt64BE(p));
        yield { key, entry: { kind: 'tombstone', seq } };
      } else {
        const valLen = buf.readUInt32BE(p); p += 4;
        const value = buf.subarray(p, p + valLen).toString('utf8'); p += valLen;
        const seq = Number(buf.readBigUInt64BE(p));
        yield { key, entry: { kind: 'value', value, seq } };
      }
    }
  }

  static deleteFile(path: string): void {
    if (existsSync(path)) unlinkSync(path);
  }
}

export function listSSTables(dataDir: string): SSTableMeta[] {
  const sstDir = join(dataDir, 'sst');
  if (!existsSync(sstDir)) return [];
  const files = readdirSync(sstDir).filter((f) => f.endsWith('.sst'));
  const metas: SSTableMeta[] = [];
  for (const f of files) {
    // L{level}-{id}.sst
    const m = /^L(\d+)-(\d+)\.sst$/.exec(f);
    if (!m) continue;
    const level = Number(m[1]);
    const id = Number(m[2]);
    const path = join(sstDir, f);
    const reader = new SSTableReader({
      path,
      id,
      level,
      minKey: '',
      maxKey: '',
      entryCount: 0,
    });
    // force load to populate min/max
    reader.get('\0'); // touch load
    const meta = reader.metadata;
    metas.push({ ...meta });
  }
  return metas.sort((a, b) => a.level - b.level || a.id - b.id);
}
