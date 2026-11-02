import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';

export type Db = Database.Database;

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies pending migrations, each in its own transaction. Returns the resulting schema version.
 */
export function migrate(db: Db): number {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`Database at version ${current}, newer than this code (version ${MIGRATIONS.length}).`);
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version - 1]!);
      db.pragma(`user_version = ${version}`);
    })();
  }
  return schemaVersion(db);
}

/**
 * Opens (or creates) the database, then brings its schema up to date. Pass ":memory:" for tests.
 */
export function openDatabase(file: string): Db {
  const inMemory = file === ':memory:';
  if (!inMemory) mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
