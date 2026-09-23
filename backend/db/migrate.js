/**
 * Migration / bootstrap entry point.
 *   node backend/db/migrate.js           -- create or update the schema
 *   node backend/db/migrate.js --drop    -- destroy everything first (DANGEROUS)
 */
import { applySchema, dropAll, getDb, closeDb } from './index.js';
import config from '../config.js';

const args = process.argv.slice(2);

if (args.includes('--drop')) {
  console.log(`[migrate] Dropping all tables in ${config.db.file}`);
  getDb();
  dropAll();
}

applySchema();

const d = getDb();
const tables = d
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
const version = d.prepare('SELECT MAX(version) AS v FROM schema_version').get();

console.log(`[migrate] Database : ${config.db.file}`);
console.log(`[migrate] Schema v : ${version?.v ?? 'unknown'}`);
console.log(`[migrate] Tables   : ${tables.length} (${tables.join(', ')})`);
console.log('[migrate] Done.');

closeDb();
