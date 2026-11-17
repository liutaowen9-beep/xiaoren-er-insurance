import type { DatabaseSync } from 'node:sqlite';
import { auditDatabase, requireSafe, schemaVersion } from './database-audit';
import { MIGRATION_COPY_SQL, MIGRATION_REBUILD_SQL } from './schema-sql';

/** Internal transaction engine. Callers must establish path, backup and maintenance guards first. */
export function migrateSchema(db: DatabaseSync, checkpoint?: (phase: string) => void, exclusive = false) {
  const before = auditDatabase(db);
  if (schemaVersion(db) === 1) return { status: 'already-migrated' as const, before, after: before };
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys);
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN ${exclusive ? 'EXCLUSIVE' : 'IMMEDIATE'}`);
  try {
    db.exec(MIGRATION_COPY_SQL); checkpoint?.('copied');
    db.exec(MIGRATION_REBUILD_SQL); checkpoint?.('rebuilt');
    const after = auditDatabase(db);
    requireSafe(after.digest === before.digest && after.documents === before.documents && after.chunks === before.chunks, 'LEGACY_DATA_CHANGED');
    checkpoint?.('validated');
    db.exec('COMMIT');
    return { status: 'migrated' as const, before, after };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`); }
}
