import 'server-only';
import type { DatabaseSync } from 'node:sqlite';
import { assertSandboxPath } from './config';
import { migrateSchema } from './schema-migration';
import { MigrationSafetyError, assertExpectedSchema, schemaVersion } from './database-audit';
import { RagError } from './config';

/** Application auto-migration remains sandbox-only. Deployment databases never auto-migrate. */
export function migrateManagement(db: DatabaseSync, checkpoint?: (phase: string) => void) {
  const file = (db.prepare('PRAGMA database_list').get() as { file: string }).file;
  assertSandboxPath(file);
  if(schemaVersion(db)===1){assertExpectedSchema(db,1);return {status:'already-migrated' as const};}
  try { return migrateSchema(db, checkpoint); }
  catch(e){if(e instanceof MigrationSafetyError&&e.code==='INDEXING_IN_PROGRESS')throw new RagError('存在未完成索引，禁止迁移。',409);throw e;}
}
