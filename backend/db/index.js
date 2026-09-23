/**
 * Database access layer -- thin wrapper over Node's built-in `node:sqlite`.
 *
 * Why built-in SQLite: the whole project installs with zero npm dependencies,
 * so `git clone && node backend/server.js` works on any machine with Node 22.5+.
 * Every statement is prepared and cached; every write goes through a
 * transaction helper so multi-table operations cannot half-apply.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';

let db = null;
const stmtCache = new Map();

/** Opens (and lazily initialises) the singleton database handle. */
export function getDb() {
  if (db) return db;

  mkdirSync(path.dirname(config.db.file), { recursive: true });
  db = new DatabaseSync(config.db.file);

  // WAL keeps readers from blocking the writer -- important because the ESP32
  // polls while a browser is reading the tree.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  return db;
}

/** Applies `database/schema.sql`. Safe to run repeatedly (all DDL is IF NOT EXISTS). */
export function applySchema() {
  const d = getDb();
  const sql = readFileSync(config.db.schemaFile, 'utf8');
  d.exec(sql);
  const row = d.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  if (!row || row.v === null) {
    d.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(
      1,
      'Initial schema: users, persons, relationships, biometrics, matching, verification, audit'
    );
  }
  return d;
}

/** Prepared-statement cache -- avoids re-parsing hot SQL on every request. */
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export const all = (sql, ...params) => prep(sql).all(...params);
export const get = (sql, ...params) => prep(sql).get(...params) ?? null;
export const run = (sql, ...params) => prep(sql).run(...params);
export const exec = (sql) => getDb().exec(sql);

/** Returns the first column of the first row, or null. */
export function pluck(sql, ...params) {
  const row = prep(sql).get(...params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 * Supports nesting via SAVEPOINT so route handlers can compose freely.
 */
let txDepth = 0;
export function transaction(fn) {
  const d = getDb();
  if (txDepth === 0) {
    d.exec('BEGIN IMMEDIATE');
  } else {
    d.exec(`SAVEPOINT sp_${txDepth}`);
  }
  const depthAtEntry = txDepth;
  txDepth += 1;
  try {
    const result = fn();
    if (depthAtEntry === 0) d.exec('COMMIT');
    else d.exec(`RELEASE sp_${depthAtEntry}`);
    return result;
  } catch (err) {
    if (depthAtEntry === 0) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* the transaction was already rolled back by SQLite */
      }
    } else {
      d.exec(`ROLLBACK TO sp_${depthAtEntry}`);
      d.exec(`RELEASE sp_${depthAtEntry}`);
    }
    throw err;
  } finally {
    txDepth = depthAtEntry;
  }
}

/** Public, non-sequential identifier handed to clients instead of a rowid. */
export const newPublicId = () => crypto.randomUUID();

/** ISO-8601 UTC timestamp matching SQLite's `datetime('now')` format. */
export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Drops every table/view -- used by `npm run db:reset`. */
export function dropAll() {
  const d = getDb();
  d.exec('PRAGMA foreign_keys = OFF;');
  const views = d
    .prepare("SELECT name FROM sqlite_master WHERE type='view'")
    .all();
  for (const v of views) d.exec(`DROP VIEW IF EXISTS "${v.name}"`);
  const tables = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const t of tables) d.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  d.exec('PRAGMA foreign_keys = ON;');
  stmtCache.clear();
}

export function closeDb() {
  if (db) {
    stmtCache.clear();
    db.close();
    db = null;
  }
}

export default { getDb, applySchema, all, get, run, exec, pluck, transaction, newPublicId, nowIso, dropAll, closeDb };
