# lumen-kv

**Live demo:** https://sk090347.github.io/lumen-kv/

A from-scratch LSM key-value store in TypeScript. I built it to learn write amplification the hard way — no LevelDB bindings, no SQLite wrapper, just memtable → WAL → SST → compaction.

[![CI](https://github.com/SK090347/lumen-kv/actions/workflows/ci.yml/badge.svg)](https://github.com/SK090347/lumen-kv/actions/workflows/ci.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE)

[Sumit Kumar Ta](https://github.com/SK090347) · MIT OR Apache-2.0

## Notes

Writes append to a WAL and land in an in-memory **memtable**. On flush they become immutable **SSTables**. Reads probe memtable → L0…Lk (newest sequence wins). Compaction merges runs to keep amplification in check.

| Metric | Rough meaning |
|--------|----------------|
| Write amp | Bytes written / logical bytes ingested (> 1 with compaction) |
| Read amp | SST / Bloom probes per `get` |
| Space amp | On-disk bytes / live data (tombstones until compacted) |

Point lookups with a sparse index are roughly \(O(\log n)\) index steps plus I/O per candidate SST. Bloom filters (Kirsch–Mitzenmacher) are false-negative free:

\[
\mathrm{FPR} \approx \bigl(1 - e^{-kn/m}\bigr)^{k},\quad k \approx (m/n)\ln 2
\]

Each put/delete gets a monotonic sequence \(s\); merges keep max \(s\) per key.

### Why LSM vs B-tree (short version)

LSM leans append-only / write-heavy; B-trees win more often on point-read heavy workloads. This repo teaches the LSM side: memtable → WAL → flush → SST → size-tiered compaction → Bloom-filtered reads.

## Architecture

Size-tiered compaction: when a level hits `compactionThreshold` SSTs (default 4), merge into one SST on `level + 1`. Tombstones drop when merging into level ≥ 2 (simple educational GC).

```
data/
  wal.log
  MANIFEST.json
  sst/
    L0-000001.sst
    L1-000005.sst
```

SST header: magic `LMN1` → version → counts → Bloom → index → data.

| Module | Role |
|--------|------|
| `Memtable` | Sorted in-memory map |
| `WAL` | Length-prefixed log; replay on open |
| `SSTable` | Immutable sorted file + sparse index + Bloom |
| `BloomFilter` | Double hashing over SHA-256 seeds |
| `compaction` | Size-tiered k-way merge |
| `LumenDB` | Orchestrates open / put / get / delete / scan |

## Quick start

```bash
npm install && npm test && npm run build

npm run cli -- demo
npm run cli -- put hello world
npm run cli -- get hello
npm run cli -- scan
npm run cli -- stats
```

```ts
import { LumenDB } from 'lumen-kv';

const db = new LumenDB({ dataDir: './data', memtableFlushThreshold: 1000 });
await db.open();
await db.put('user:1', 'alice');
console.log(await db.get('user:1'));
await db.close();
```

## Tests

WAL recovery, SST round-trip + Bloom, merge/compaction (highest seq wins), flush → reopen, crash mid-memtable, L0 compaction under load.

## License

**MIT** OR **Apache-2.0** — see LICENSE files and [NOTICE](NOTICE).
