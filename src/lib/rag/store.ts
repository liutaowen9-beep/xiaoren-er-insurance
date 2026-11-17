import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertKnowledgePath, ACTIVE_DEPLOYMENT, LOCAL_KNOWLEDGE_ROOT, DATA_DIR, EMBEDDING_DIMENSION, EMBEDDING_ID, RagError } from './config';
import { migrateManagement } from './migration';
import { migrateSchema } from './schema-migration';
import { assertExpectedSchema } from './database-audit';
import type { DocumentState, DocumentStatus, KnowledgeDocument, Source, TextChunk } from './types';

type DocumentRow = { id: string; name: string; extension: string; size: number; hash: string; status: DocumentStatus; chunk_count: number; created_at: number; error: string | null; model: string | null; dimension: number | null };
function document(row: DocumentRow): KnowledgeDocument { return { id: row.id, name: row.name, extension: row.extension, size: row.size, hash: row.hash, status: row.status, chunkCount: row.chunk_count, createdAt: row.created_at, error: row.error, model: row.model, dimension: row.dimension }; }

// Replace this repository with Qdrant/pgvector without changing the UI contracts.
export class KnowledgeStore {
  readonly db: DatabaseSync;
  readonly file: string;
  constructor(file: string, options?: { readOnly?: boolean; management?: boolean }) {
    assertKnowledgePath(file);
    this.file = path.resolve(file);
    if(ACTIVE_DEPLOYMENT&&this.file===ACTIVE_DEPLOYMENT.target){
      this.db=new DatabaseSync(file,{readOnly:options?.readOnly||ACTIVE_DEPLOYMENT.readOnly});
      try {assertExpectedSchema(this.db,1);if(!options?.readOnly&&!ACTIVE_DEPLOYMENT.readOnly){this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');this.recoverAbandonedJobs();}}
      catch(e){this.db.close();throw e;}
      return;
    }
    if(LOCAL_KNOWLEDGE_ROOT && this.file===path.join(LOCAL_KNOWLEDGE_ROOT,'knowledge.sqlite') && existsSync(file)) {
      this.db=new DatabaseSync(file,{readOnly:options?.readOnly});
      try { assertExpectedSchema(this.db,1); if(!options?.readOnly){this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');this.recoverAbandonedJobs();} } catch(e){this.db.close();throw e;}
      return;
    }
    if (options?.readOnly) { this.db = new DatabaseSync(file, { readOnly: true }); return; }
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, extension TEXT NOT NULL, size INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, error TEXT, model TEXT, dimension INTEGER, raw BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, text TEXT NOT NULL, page INTEGER, title TEXT,
        vector BLOB NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);`);
    // A killed Node process must never leave a document falsely marked complete.
    if (options?.management) { if(LOCAL_KNOWLEDGE_ROOT && this.file===path.join(LOCAL_KNOWLEDGE_ROOT,'knowledge.sqlite')) migrateSchema(this.db); else migrateManagement(this.db); this.recoverAbandonedJobs(); }
    if (!this.managed) this.db.prepare("UPDATE documents SET status='failed', error='上次索引被中断，请重新索引。' WHERE status NOT IN ('ready','failed')").run();
  }
  get managed() { return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version === 1; }
  private recoverAbandonedJobs() {
    const jobs = this.db.prepare("SELECT id,owner_pid FROM document_jobs WHERE state='running'").all() as { id: string; owner_pid: number }[];
    for (const job of jobs) {
      // Signal 0 is a liveness probe, never a process termination. Permission errors fail closed.
      let dead = false;
      try { process.kill(job.owner_pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const changed = this.db.prepare("UPDATE document_jobs SET state='failed',finished_at=? WHERE id=? AND owner_pid=? AND state='running'").run(Date.now(), job.id, job.owner_pid);
        if (changed.changes) this.db.prepare("UPDATE documents SET status='failed',error='索引所属进程已退出，旧版本未改变；可重试候选版本。' WHERE id=? AND status<>'ready'").run(job.id);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  private decorate(row: DocumentRow): KnowledgeDocument {
    const result = document(row);
    if (!this.managed) return result;
    const info = this.db.prepare('SELECT d.logical_id,d.version,k.state,k.revision,k.updated_at,k.current_version_id FROM documents d JOIN knowledge_documents k ON k.id=d.logical_id WHERE d.id=?').get(row.id) as { logical_id: string; version: number; state: DocumentState; revision: number; updated_at: number; current_version_id: string | null };
    return { ...result, logicalId: info.logical_id, version: info.version, state: info.state, revision: info.revision, updatedAt: info.updated_at, isCurrent: info.current_version_id === row.id };
  }
  list() {
    const rows = this.db.prepare(this.managed
      ? 'SELECT d.id,d.name,d.extension,d.size,d.hash,d.status,d.chunk_count,d.created_at,d.error,d.model,d.dimension FROM knowledge_documents k JOIN documents d ON d.id=coalesce(k.current_version_id,(SELECT id FROM documents WHERE logical_id=k.id ORDER BY version LIMIT 1)) ORDER BY k.created_at DESC'
      : 'SELECT id,name,extension,size,hash,status,chunk_count,created_at,error,model,dimension FROM documents ORDER BY created_at DESC').all() as unknown as DocumentRow[];
    return rows.map(row => {
      const result = this.decorate(row);
      if (this.managed) {
        const latest = this.db.prepare('SELECT id,version,status,error FROM documents WHERE logical_id=? AND version>? ORDER BY version DESC LIMIT 1').get(result.logicalId!, result.version!) as KnowledgeDocument['replacement'];
        if (latest) result.replacement = latest;
      }
      return result;
    });
  }
  get(id: string) { const row = this.db.prepare('SELECT id,name,extension,size,hash,status,chunk_count,created_at,error,model,dimension FROM documents WHERE id=?').get(id) as unknown as DocumentRow | undefined; if (!row) throw new RagError('文档不存在或已删除。', 404); return this.decorate(row); }
  findHash(hash: string) { const row = this.db.prepare('SELECT id,name,extension,size,hash,status,chunk_count,created_at,error,model,dimension FROM documents WHERE hash=? ORDER BY created_at DESC LIMIT 1').get(hash) as unknown as DocumentRow | undefined; return row ? this.decorate(row) : null; }
  raw(id: string) { const row = this.db.prepare('SELECT raw FROM documents WHERE id=?').get(id) as { raw: Uint8Array } | undefined; if (!row) throw new RagError('文档不存在。', 404); return Buffer.from(row.raw); }
  insert(input: { id: string; name: string; extension: string; hash: string; raw: Buffer }) {
    if (this.managed) return this.newVersion(input);
    this.db.prepare("INSERT INTO documents(id,name,extension,size,hash,status,created_at,raw) VALUES(?,?,?,?,?,'queued',?,?)").run(input.id, input.name, input.extension, input.raw.length, input.hash, Date.now(), input.raw);
    return this.get(input.id);
  }
  status(id: string, status: DocumentStatus, error: string | null = null) {
    this.db.prepare('UPDATE documents SET status=?,error=? WHERE id=?').run(status, error, id);
    if (this.managed && status === 'failed') this.db.prepare("UPDATE document_jobs SET state='failed',finished_at=? WHERE id=? AND state='running'").run(Date.now(), id);
  }
  private newVersion(input: { id: string; name: string; extension: string; hash: string; raw: Buffer }, previous?: KnowledgeDocument, revision?: number) {
    const time = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if ((this.db.prepare("SELECT count(*) AS n FROM document_jobs WHERE state='running'").get() as { n: number }).n) throw new RagError('已有索引任务正在执行，请稍后重试。', 409);
      const logicalId = previous?.logicalId ?? input.id;
      let version = 1;
      let expectedVersionId: string | null = null;
      if (previous) {
        const current = this.get(previous.id);
        const group = this.db.prepare('SELECT current_version_id FROM knowledge_documents WHERE id=?').get(logicalId) as { current_version_id: string | null };
        if ((!current.isCurrent && !(group.current_version_id === null && current.version === 1 && current.status === 'failed')) || current.revision !== revision) throw new RagError('文档已变更，请刷新后重试。', 409);
        expectedVersionId = group.current_version_id;
        if ((this.db.prepare('SELECT count(*) AS n FROM documents WHERE logical_id=?').get(logicalId) as { n: number }).n >= 20) throw new RagError('每份文档最多保留 20 个版本（含失败候选），请先评估存储与保留策略。', 429);
        version = (this.db.prepare('SELECT max(version)+1 AS n FROM documents WHERE logical_id=?').get(logicalId) as { n: number }).n;
      } else this.db.prepare('INSERT INTO knowledge_documents(id,created_at,updated_at) VALUES(?,?,?)').run(logicalId, time, time);
      this.db.prepare("INSERT INTO documents(id,name,extension,size,hash,status,created_at,raw,logical_id,version,expected_version_id,expected_revision) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?)")
        .run(input.id, input.name, input.extension, input.raw.length, input.hash, time, input.raw, logicalId, version, expectedVersionId, revision ?? 0);
      this.db.prepare("INSERT INTO document_jobs(id,logical_id,state,started_at,owner_pid) VALUES(?,?,'running',?,?)").run(input.id, logicalId, time, process.pid);
      this.db.exec('COMMIT'); return this.get(input.id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  replace(id: string, input: { name: string; extension: string; hash: string; raw: Buffer }, revision: number) {
    if (!this.managed) throw new RagError('当前数据库未启用版本管理。', 409);
    return this.newVersion({ ...input, id: randomUUID() }, this.get(id), revision);
  }
  versions(id: string) {
    const current = this.get(id);
    if (!this.managed) return [current];
    return (this.db.prepare('SELECT id FROM documents WHERE logical_id=? ORDER BY version DESC').all(current.logicalId!) as { id: string }[]).map(row => this.get(row.id));
  }
  isEligible(id: string) {
    const doc = this.get(id);
    return doc.status === 'ready' && (!this.managed || (doc.state === 'active' && doc.isCurrent === true));
  }
  verifyVersion(id: string) {
    const doc = this.get(id), raw = this.raw(id);
    if (doc.status !== 'ready' || createHash('sha256').update(raw).digest('hex') !== doc.hash || raw.length !== doc.size) throw new RagError('原始文件或索引未就绪，不能恢复。', 409);
    const rows = this.db.prepare('SELECT vector,model,dimension,sequence,length(text) AS chars FROM chunks WHERE document_id=? ORDER BY sequence').all(id) as { vector: Uint8Array; model: string; dimension: number; sequence: number; chars: number }[];
    if (!rows.length || rows.length !== doc.chunkCount || doc.model !== EMBEDDING_ID || doc.dimension !== EMBEDDING_DIMENSION) throw new RagError('文档切片或模型不一致，不能恢复。', 409);
    rows.forEach((row, i) => {
      if (!row.chars || row.sequence !== i || row.model !== EMBEDDING_ID || row.dimension !== EMBEDDING_DIMENSION || row.vector.byteLength !== 4 * EMBEDDING_DIMENSION) throw new RagError('切片或向量损坏，不能恢复。', 409);
      const v = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
      if (v.some(n => !Number.isFinite(n)) || Math.abs(Math.hypot(...v) - 1) > 0.001) throw new RagError('向量损坏，不能恢复。', 409);
    });
  }
  setState(id: string, state: DocumentState, revision: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const doc = this.get(id);
      const group = this.managed ? this.db.prepare('SELECT current_version_id FROM knowledge_documents WHERE id=?').get(doc.logicalId!) as { current_version_id: string | null } : null;
      if (!this.managed || (!doc.isCurrent && group?.current_version_id !== null) || doc.revision !== revision) throw new RagError('文档已变更，请刷新后重试。', 409);
      if (state === 'active') this.verifyVersion(id);
      this.db.prepare('UPDATE knowledge_documents SET state=?,revision=revision+1,updated_at=? WHERE id=?').run(state, Date.now(), doc.logicalId!);
      this.db.exec('COMMIT'); return this.get(id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  retryVersion(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const doc = this.get(id);
      if (!this.managed || doc.status !== 'failed' || doc.isCurrent) throw new RagError('该版本不能重复索引。', 409);
      if ((this.db.prepare("SELECT count(*) AS n FROM document_jobs WHERE state='running'").get() as { n: number }).n) throw new RagError('已有索引任务正在执行。', 409);
      const group = this.db.prepare('SELECT current_version_id,revision FROM knowledge_documents WHERE id=?').get(doc.logicalId!) as { current_version_id: string | null; revision: number };
      if (group.current_version_id && this.get(group.current_version_id).version! >= doc.version!) throw new RagError('该失败候选已过时，请从当前版本重新发起替换。', 409);
      this.db.prepare("UPDATE documents SET status='queued',error=NULL,expected_version_id=?,expected_revision=? WHERE id=?").run(group.current_version_id, group.revision, id);
      this.db.prepare("INSERT INTO document_jobs(id,logical_id,state,started_at,owner_pid) VALUES(?,?,'running',?,?) ON CONFLICT(id) DO UPDATE SET state='running',started_at=excluded.started_at,finished_at=NULL,owner_pid=excluded.owner_pid").run(id, doc.logicalId!, Date.now(), process.pid);
      this.db.exec('COMMIT'); return this.get(id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  countChunks() { return (this.db.prepare('SELECT count(*) AS count FROM chunks').get() as { count: number }).count; }
  commitIndex(id: string, chunks: TextChunk[], vectors: number[][]) {
    if (chunks.length !== vectors.length || !chunks.length) throw new RagError('索引数据不完整，未提交。', 500);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const doc = this.get(id);
      if (this.managed && doc.status === 'ready') throw new RagError('已发布版本不可覆盖，请创建新版本重新索引。', 409);
      this.db.prepare('DELETE FROM chunks WHERE document_id=?').run(id);
      const insert = this.db.prepare('INSERT INTO chunks(id,document_id,sequence,text,page,title,vector,model,dimension) VALUES(?,?,?,?,?,?,?,?,?)');
      chunks.forEach((chunk, i) => {
        const vector = vectors[i];
        if (vector.length !== EMBEDDING_DIMENSION || vector.some(v => !Number.isFinite(v))) throw new RagError('Embedding 维度不匹配，未提交索引。', 500);
        insert.run(chunk.id, id, chunk.sequence, chunk.text, chunk.page ?? null, chunk.title ?? null, Buffer.from(new Float32Array(vector).buffer), EMBEDDING_ID, EMBEDDING_DIMENSION);
      });
      this.db.prepare("UPDATE documents SET status='ready',chunk_count=?,error=NULL,model=?,dimension=? WHERE id=?").run(chunks.length, EMBEDDING_ID, EMBEDDING_DIMENSION, id);
      if (this.managed) {
        this.verifyVersion(id);
        const expected = this.db.prepare('SELECT expected_version_id,expected_revision FROM documents WHERE id=?').get(id) as { expected_version_id: string | null; expected_revision: number };
        const changed = this.db.prepare('UPDATE knowledge_documents SET current_version_id=?,revision=revision+1,updated_at=? WHERE id=? AND current_version_id IS ? AND revision=?').run(id, Date.now(), doc.logicalId!, expected.expected_version_id, expected.expected_revision);
        if (changed.changes !== 1) throw new RagError('文档状态已变化，新版本未发布，旧版本保持不变。', 409);
        this.db.prepare("UPDATE document_jobs SET state='success',finished_at=? WHERE id=?").run(Date.now(), id);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  delete(id: string, revision?: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const doc = this.get(id);
      if (this.managed) {
        if (doc.revision !== revision || (!doc.isCurrent && doc.status !== 'failed')) throw new RagError('删除确认已过期，请刷新后重新确认。', 409);
        if ((this.db.prepare("SELECT count(*) AS n FROM document_jobs WHERE logical_id=? AND state='running'").get(doc.logicalId!) as { n: number }).n) throw new RagError('版本正在索引，不能删除。', 409);
        this.db.prepare('UPDATE knowledge_documents SET current_version_id=NULL WHERE id=?').run(doc.logicalId!);
        this.db.prepare('DELETE FROM documents WHERE logical_id=?').run(doc.logicalId!);
        this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(doc.logicalId!);
      } else this.db.prepare('DELETE FROM documents WHERE id=?').run(id);
      this.db.exec('COMMIT');
    }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  search(vector: number[], topK: number, threshold: number): Source[] {
    if (vector.length !== EMBEDDING_DIMENSION) throw new RagError('查询向量维度不匹配，请重新索引。', 409);
    const rows = this.db.prepare("SELECT c.*,d.name FROM chunks c JOIN documents d ON d.id=c.document_id " + (this.managed ? "JOIN knowledge_documents k ON k.id=d.logical_id AND k.current_version_id=d.id AND k.state='active' " : '') + "WHERE d.status='ready'").all() as unknown as { id: string; document_id: string; name: string; text: string; page: number | null; title: string | null; vector: Uint8Array; dimension: number; model: string }[];
    return rows.map(row => {
      if (row.model !== EMBEDDING_ID || row.dimension !== vector.length || row.vector.byteLength !== vector.length * 4) throw new RagError('已有向量与当前模型不一致或已损坏，请重新索引。', 409);
      const values = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
      let score = 0;
      for (let i = 0; i < vector.length; i++) { if (!Number.isFinite(values[i])) throw new RagError('索引向量损坏，请重新索引。', 409); score += vector[i] * values[i]; }
      return { number: 0, documentId: row.document_id, chunkId: row.id, fileName: row.name, text: row.text, ...(row.page ? { page: row.page } : {}), ...(row.title ? { title: row.title } : {}), score };
    }).filter(row => row.score >= threshold).sort((a, b) => b.score - a.score).slice(0, topK).map((row, i) => ({ ...row, number: i + 1 }));
  }
  overviewSources(ids:readonly string[],limit:number):Source[] {
    if(ids.length>3||!Number.isInteger(limit)||limit<1||limit>10)throw new RagError('文档概述范围超过限制。');
    const groups=ids.map(id=>{
      if(!this.isEligible(id))return [];
      const doc=this.get(id);
      const rows=this.db.prepare('SELECT id,text,page,title,model,dimension,vector FROM chunks WHERE document_id=? ORDER BY sequence LIMIT ?').all(id,limit) as {id:string;text:string;page:number|null;title:string|null;model:string;dimension:number;vector:Uint8Array}[];
      if(rows.length!==Math.min(limit,doc.chunkCount))throw new RagError('所选文档切片数量不一致。',409);
      for(const row of rows){if(row.model!==EMBEDDING_ID||row.dimension!==EMBEDDING_DIMENSION||row.vector.byteLength!==EMBEDDING_DIMENSION*4)throw new RagError('所选文档索引与模型不一致或已损坏。',409);const vector=new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength));if(!vector.every(Number.isFinite)||Math.abs(Math.hypot(...vector)-1)>0.001)throw new RagError('所选文档包含损坏的向量。',409);}
      return rows.map(row=>({number:0,documentId:id,chunkId:row.id,fileName:doc.name,text:row.text,score:0,kind:'document' as const,...(doc.version?{version:doc.version,state:doc.state,isCurrent:doc.isCurrent}:{}),...(row.page?{page:row.page}:{}),...(row.title?{title:row.title}:{})}));
    });
    // Interleave selected documents; never turn a filename match into a cosine score.
    const result:Source[]=[];let chars=0;
    for(let i=0;i<limit;i++)for(const group of groups){const s=group[i];if(!s||result.length>=limit||chars+s.text.length>12000||!this.isEligible(s.documentId))continue;chars+=s.text.length;result.push({...s,number:result.length+1});}
    return result;
  }
  close() { this.db.close(); }
}

const globalStore = globalThis as typeof globalThis & { __moyuKnowledgeStore?: KnowledgeStore };
export function getStore() {
  const cached = globalStore.__moyuKnowledgeStore;
  // A pre-upgrade dev process may retain a production object through HMR. Never query or close it.
  if (cached) {
    if (typeof cached.file !== 'string') throw new RagError('隔离保护：检测到旧进程数据连接，请重启隔离服务器。', 503);
    if(ACTIVE_DEPLOYMENT&&cached.file!==ACTIVE_DEPLOYMENT.target)throw new RagError('部署数据库与缓存连接不匹配，请重启服务。',503);
    assertKnowledgePath(cached.file);
    return cached;
  }
  return globalStore.__moyuKnowledgeStore = new KnowledgeStore(path.join(DATA_DIR, 'knowledge.sqlite'), { management: true });
}
export type KnowledgeReadAccess = Pick<KnowledgeStore, 'list' | 'get' | 'search'> & Partial<Pick<KnowledgeStore, 'isEligible'|'overviewSources'>>;
