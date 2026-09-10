/**
 * Core types for lumen-kv — educational LSM-tree key-value store.
 */

/** Value entry: present value or tombstone (deleted). */
export type Entry =
  | { kind: 'value'; value: string; seq: number }
  | { kind: 'tombstone'; seq: number };

export interface KeyValue {
  key: string;
  entry: Entry;
}

export interface LumenOptions {
  /** Directory for WAL + SSTables (default: ./data) */
  dataDir?: string;
  /** Flush memtable when it reaches this many entries (default: 1000) */
  memtableFlushThreshold?: number;
  /** Trigger size-tiered compaction when a level has this many SSTs (default: 4) */
  compactionThreshold?: number;
  /** Enable simple Bloom filters on SST writes (default: true) */
  bloomFilter?: boolean;
  /** Bloom filter false-positive rate target (default: 0.01) */
  bloomFpr?: number;
}

export interface Stats {
  memtableSize: number;
  walBytes: number;
  sstables: number;
  levels: number[];
  sequence: number;
}
