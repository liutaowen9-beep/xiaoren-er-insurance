import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { LEGACY_SCHEMA_SQL, MIGRATION_COPY_SQL, MIGRATION_REBUILD_SQL } from './schema-sql';
import { EMBEDDING_DIMENSION, EMBEDDING_ID } from './model-spec';

export class MigrationSafetyError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function requireSafe(value: unknown, code: string): asserts value { if (!value) throw new MigrationSafetyError(code); }
export function schemaVersion(db: DatabaseSync) { return Number(db.prepare('PRAGMA user_version').get()!.user_version); }
function schemaSignature(db: DatabaseSync) {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type,name").all().map(row => ({ ...row,
    sql: typeof row.sql === 'string' ? row.sql.replace(/IF NOT EXISTS\s*/gi, '').replace(/"(\w+)"/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase() : null,
  })));
}
const expected = new Map<number, string>();
function expectedSchema(version: number) {
  if (!expected.has(version)) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(LEGACY_SCHEMA_SQL);
      if (version === 1) db.exec(MIGRATION_COPY_SQL + MIGRATION_REBUILD_SQL);
      expected.set(version, schemaSignature(db));
    } finally { db.close(); }
  }
  return expected.get(version)!;
}
/** Hash all original columns, including IDs, original bytes, private text and vectors. Never return rows. */
export function legacyDataDigest(db: DatabaseSync) {
  const hash = createHash('sha256');
  for (const [table, query] of [
    ['documents', 'SELECT id,name,extension,size,hash,status,chunk_count,created_at,error,model,dimension,raw FROM documents ORDER BY id'],
    ['chunks', 'SELECT id,document_id,sequence,text,page,title,vector,model,dimension FROM chunks ORDER BY id'],
  ]) {
    hash.update(table);
    for (const row of db.prepare(query).iterate()) {
      hash.update('row');
      for (const value of Object.values(row)) {
        const bytes = value === null ? Buffer.alloc(0) : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
        hash.update(value === null ? 'n' : value instanceof Uint8Array ? 'b' : typeof value === 'number' ? 'i' : 's');
        const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length); hash.update(bytes);
      }
    }
  }
  return hash.digest('hex');
}
export function auditDatabase(db: DatabaseSync) {
  const version = schemaVersion(db);
  requireSafe(version === 0 || version === 1, 'SCHEMA_VERSION_UNSUPPORTED');
  requireSafe(schemaSignature(db) === expectedSchema(version), 'SCHEMA_NOT_EXPECTED');
  requireSafe(db.prepare('PRAGMA integrity_check').get()!.integrity_check === 'ok', 'INTEGRITY_FAILED');
  requireSafe(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'FOREIGN_KEYS_FAILED');
  let documents = 0, chunks = 0;
  const count = db.prepare('SELECT count(*) AS n FROM chunks WHERE document_id=?');
  for (const row of db.prepare('SELECT id,size,hash,status,chunk_count,raw,model,dimension FROM documents').iterate()) {
    documents++;
    requireSafe(['ready', 'failed'].includes(String(row.status)), 'INDEXING_IN_PROGRESS');
    requireSafe(row.raw instanceof Uint8Array && row.raw.byteLength === row.size && createHash('sha256').update(row.raw).digest('hex') === row.hash, 'ORIGINAL_BYTES_FAILED');
    requireSafe(count.get(row.id)!.n === row.chunk_count, 'CHUNK_COUNT_FAILED');
    if (row.status === 'ready') requireSafe(Number(row.chunk_count) > 0 && row.model === EMBEDDING_ID && row.dimension === EMBEDDING_DIMENSION, 'DOCUMENT_MODEL_FAILED');
  }
  const seq = new Map<string, number>();
  for (const row of db.prepare('SELECT document_id,sequence,length(text) AS chars,page,vector,model,dimension FROM chunks ORDER BY document_id,sequence').iterate()) {
    chunks++;
    const id = String(row.document_id), next = seq.get(id) ?? 0; seq.set(id, next + 1);
    requireSafe(row.sequence === next && Number(row.chars) > 0 && (row.page === null || Number(row.page) >= 1), 'CHUNK_METADATA_FAILED');
    requireSafe(row.vector instanceof Uint8Array && row.vector.byteLength === EMBEDDING_DIMENSION * 4 && row.dimension === EMBEDDING_DIMENSION && row.model === EMBEDDING_ID, 'VECTOR_METADATA_FAILED');
    const raw = row.vector as Uint8Array;
    const vector = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    requireSafe(vector.every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) < .001, 'VECTOR_VALUES_FAILED');
  }
  if (version === 1) {
    requireSafe(Number(db.prepare('SELECT count(*) AS n FROM knowledge_documents k JOIN documents d ON d.id=k.current_version_id WHERE d.logical_id<>k.id').get()!.n) === 0, 'CURRENT_VERSION_RELATION_FAILED');
  }
  return { schemaVersion: version, documents, chunks, vectors: chunks, digest: legacyDataDigest(db), integrity: 'ok' as const };
}
export function assertExpectedSchema(db:DatabaseSync,version:number){requireSafe(schemaVersion(db)===version&&schemaSignature(db)===expectedSchema(version),'DEPLOYMENT_SCHEMA_MISMATCH');}
