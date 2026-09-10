/**
 * Write-Ahead Log — append-only durability for memtable mutations.
 *
 * Record format (binary):
 *   [u32 length][u8 op][u32 keyLen][key utf8][u32 valLen?][value?][u64 seq]
 * op: 1 = PUT, 2 = DELETE
 *
 * On open, replay recovers the memtable. After successful flush the WAL
 * is truncated (checkpointed).
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { Entry } from './types.js';
import { Memtable } from './memtable.js';

const OP_PUT = 1;
const OP_DELETE = 2;

export class WAL {
  private readonly path: string;
  private stream: WriteStream | null = null;
  private bytes = 0;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'wal.log');
  }

  get byteLength(): number {
    return this.bytes;
  }

  /** Open for append; create empty if missing. */
  open(): void {
    if (!existsSync(this.path)) {
      writeFileSync(this.path, Buffer.alloc(0));
    }
    const existing = readFileSync(this.path);
    this.bytes = existing.length;
    this.attachStream();
  }

  /** Replay all records into a fresh memtable; returns max sequence. */
  recover(memtable: Memtable): number {
    if (!existsSync(this.path)) {
      writeFileSync(this.path, Buffer.alloc(0));
      return 0;
    }
    const buf = readFileSync(this.path);
    this.bytes = buf.length;
    let offset = 0;
    let maxSeq = 0;

    while (offset + 4 <= buf.length) {
      const len = buf.readUInt32BE(offset);
      offset += 4;
      if (len === 0 || offset + len > buf.length) break; // truncated tail

      const record = buf.subarray(offset, offset + len);
      offset += len;

      const op = record.readUInt8(0);
      const keyLen = record.readUInt32BE(1);
      const key = record.subarray(5, 5 + keyLen).toString('utf8');
      let pos = 5 + keyLen;
      let entry: Entry;

      if (op === OP_PUT) {
        const valLen = record.readUInt32BE(pos);
        pos += 4;
        const value = record.subarray(pos, pos + valLen).toString('utf8');
        pos += valLen;
        const seq = Number(record.readBigUInt64BE(pos));
        entry = { kind: 'value', value, seq };
        maxSeq = Math.max(maxSeq, seq);
      } else if (op === OP_DELETE) {
        const seq = Number(record.readBigUInt64BE(pos));
        entry = { kind: 'tombstone', seq };
        maxSeq = Math.max(maxSeq, seq);
      } else {
        continue;
      }
      memtable.put(key, entry);
    }
    return maxSeq;
  }

  appendPut(key: string, value: string, seq: number): Promise<void> {
    return this.append(OP_PUT, key, value, seq);
  }

  appendDelete(key: string, seq: number): Promise<void> {
    return this.append(OP_DELETE, key, undefined, seq);
  }

  private append(op: number, key: string, value: string | undefined, seq: number): Promise<void> {
    const keyBuf = Buffer.from(key, 'utf8');
    let body: Buffer;
    if (op === OP_PUT) {
      const valBuf = Buffer.from(value ?? '', 'utf8');
      body = Buffer.alloc(1 + 4 + keyBuf.length + 4 + valBuf.length + 8);
      let p = 0;
      body.writeUInt8(op, p); p += 1;
      body.writeUInt32BE(keyBuf.length, p); p += 4;
      keyBuf.copy(body, p); p += keyBuf.length;
      body.writeUInt32BE(valBuf.length, p); p += 4;
      valBuf.copy(body, p); p += valBuf.length;
      body.writeBigUInt64BE(BigInt(seq), p);
    } else {
      body = Buffer.alloc(1 + 4 + keyBuf.length + 8);
      let p = 0;
      body.writeUInt8(op, p); p += 1;
      body.writeUInt32BE(keyBuf.length, p); p += 4;
      keyBuf.copy(body, p); p += keyBuf.length;
      body.writeBigUInt64BE(BigInt(seq), p);
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    return new Promise((resolve, reject) => {
      if (!this.stream) {
        reject(new Error('WAL not open'));
        return;
      }
      this.stream.write(frame, (err) => {
        if (err) reject(err);
        else {
          this.bytes += frame.length;
          resolve();
        }
      });
    });
  }

  /** Truncate WAL after successful memtable flush (checkpoint). */
  async checkpoint(): Promise<void> {
    await this.close();
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, Buffer.alloc(0));
    renameSync(tmp, this.path);
    this.bytes = 0;
    this.attachStream();
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolve) => {
      s.end(() => resolve());
      s.on('error', () => resolve());
    });
  }

  private attachStream(): void {
    this.stream = createWriteStream(this.path, { flags: 'a' });
    this.stream.on('error', () => {
      /* ignore late errors after teardown / checkpoint races */
    });
  }

  /** Sync path helper for tests. */
  static pathFor(dataDir: string): string {
    return join(dataDir, 'wal.log');
  }

  get filePath(): string {
    return this.path;
  }
}

/** Ensure parent dir exists (used by engine). */
export function ensureDir(path: string): void {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
