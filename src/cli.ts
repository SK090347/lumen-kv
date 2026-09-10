#!/usr/bin/env node
/**
 * lumen CLI — interactive / one-shot get, put, delete, scan, stats.
 *
 * Usage:
 *   lumen put <key> <value>
 *   lumen get <key>
 *   lumen delete <key>
 *   lumen scan [start] [end]
 *   lumen stats
 *   lumen demo
 */

import { LumenDB } from './db.js';
import { resolve } from 'node:path';

const dataDir = process.env.LUMEN_DATA ?? resolve(process.cwd(), 'data');

async function withDb<T>(fn: (db: LumenDB) => Promise<T>): Promise<T> {
  const db = new LumenDB({
    dataDir,
    memtableFlushThreshold: 100,
    compactionThreshold: 4,
  });
  await db.open();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

function usage(): never {
  console.log(`lumen-kv — educational LSM key-value store

Usage:
  lumen put <key> <value>     Store a key
  lumen get <key>             Read a key
  lumen delete <key>          Soft-delete (tombstone)
  lumen scan [start] [end]    Range scan
  lumen stats                 Show memtable / SST / WAL stats
  lumen demo                  Seed sample data and print scan

Env:
  LUMEN_DATA   Data directory (default: ./data)
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  if (!cmd) usage();

  switch (cmd) {
    case 'put': {
      const [key, ...rest] = args;
      const value = rest.join(' ');
      if (!key || value === undefined || value === '') usage();
      await withDb(async (db) => {
        await db.put(key!, value);
        console.log(`OK put ${key}`);
      });
      break;
    }
    case 'get': {
      const key = args[0];
      if (!key) usage();
      await withDb(async (db) => {
        const v = await db.get(key!);
        if (v === undefined) {
          console.log('(nil)');
          process.exitCode = 1;
        } else {
          console.log(v);
        }
      });
      break;
    }
    case 'delete':
    case 'del': {
      const key = args[0];
      if (!key) usage();
      await withDb(async (db) => {
        await db.delete(key!);
        console.log(`OK delete ${key}`);
      });
      break;
    }
    case 'scan': {
      const start = args[0];
      const end = args[1];
      await withDb(async (db) => {
        for await (const [k, v] of db.scan(start, end)) {
          console.log(`${k}\t${v}`);
        }
      });
      break;
    }
    case 'stats': {
      await withDb(async (db) => {
        console.log(JSON.stringify(db.stats(), null, 2));
      });
      break;
    }
    case 'demo': {
      await withDb(async (db) => {
        await db.put('alpha', 'first');
        await db.put('beta', 'second');
        await db.put('gamma', 'third');
        await db.put('beta', 'updated');
        await db.delete('gamma');
        console.log('--- scan ---');
        for await (const [k, v] of db.scan()) {
          console.log(`${k}\t${v}`);
        }
        console.log('--- stats ---');
        console.log(JSON.stringify(db.stats(), null, 2));
      });
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
