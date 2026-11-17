// Shared, reviewed SQL. Never interpolates model or user input.
export const LEGACY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, extension TEXT NOT NULL, size INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, error TEXT, model TEXT, dimension INTEGER, raw BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, text TEXT NOT NULL, page INTEGER, title TEXT,
        vector BLOB NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);`;
export const MIGRATION_COPY_SQL = `
      CREATE TABLE knowledge_documents (
        id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','inactive','archived')),
        current_version_id TEXT REFERENCES documents(id), revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE documents_next (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, extension TEXT NOT NULL, size INTEGER NOT NULL,
        hash TEXT NOT NULL, status TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, error TEXT, model TEXT, dimension INTEGER, raw BLOB NOT NULL,
        logical_id TEXT NOT NULL REFERENCES knowledge_documents(id), version INTEGER NOT NULL CHECK(version>0),
        expected_version_id TEXT, expected_revision INTEGER NOT NULL DEFAULT 0,
        UNIQUE(logical_id,version));
      INSERT INTO knowledge_documents(id,current_version_id,created_at,updated_at)
        SELECT id,CASE WHEN status='ready' THEN id ELSE NULL END,created_at,created_at FROM documents;
      INSERT INTO documents_next SELECT id,name,extension,size,hash,status,chunk_count,created_at,error,model,dimension,raw,id,1,NULL,0 FROM documents;
    `;
export const MIGRATION_REBUILD_SQL = `DROP TABLE documents; ALTER TABLE documents_next RENAME TO documents;
      CREATE INDEX idx_documents_hash ON documents(hash);
      CREATE INDEX idx_knowledge_state ON knowledge_documents(state,current_version_id);
      CREATE TABLE document_jobs (
        id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        logical_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('running','success','failed')),
        slot INTEGER NOT NULL DEFAULT 1 CHECK(slot=1), started_at INTEGER NOT NULL, finished_at INTEGER,
        owner_pid INTEGER NOT NULL);
      CREATE UNIQUE INDEX idx_single_index_job ON document_jobs(slot) WHERE state='running';
      PRAGMA user_version=1;`;
