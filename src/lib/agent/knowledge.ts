import 'server-only';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { KnowledgeStore } from '../rag/store';
import { DATA_DIR } from '../rag/config';
import type { Source, TextChunk } from '../rag/types';
import { AgentError } from './limits';

export function openAgentStore() {
  const file = path.join(DATA_DIR, 'knowledge.sqlite');
  return existsSync(file) ? new KnowledgeStore(file, { readOnly: true }) : null;
}
export function readStoredSource(store: KnowledgeStore, documentId: string, chunkId: string): Source {
  const document = store.get(documentId);
  if (document.status !== 'ready') throw new AgentError('来源文档尚未就绪或已发生变化，请重新检索。', 409);
  const row = store.db.prepare('SELECT text,page,title FROM chunks WHERE id=? AND document_id=?').get(chunkId, documentId) as { text: string; page: number | null; title: string | null } | undefined;
  if (!row) throw new AgentError('来源切片已删除或重新索引，请重新提问获取当前证据。', 404);
  return { number: 1, documentId, chunkId, fileName: document.name, text: row.text, score: 0, kind: 'document', ...(document.version ? { version: document.version, state: document.state, isCurrent: document.isCurrent } : {}), ...(row.page ? { page: row.page } : {}), ...(row.title ? { title: row.title } : {}) };
}
export function authorizedChunks(store: KnowledgeStore, ids: string[], allowed: ReadonlySet<string>) {
  const documents = ids.map(id => {
    if (!allowed.has(id)) throw new AgentError('所选文档不在当前授权的本机知识库中，或文档尚未完成索引。', 403);
    const document = store.get(id);
    if (!store.isEligible(id)) throw new AgentError('文档已停用、归档或被新版本替换，请重新选择当前有效文档。', 409);
    const rows = store.db.prepare('SELECT id,document_id,sequence,text,page,title FROM chunks WHERE document_id=? ORDER BY sequence').all(id) as unknown as { id: string; document_id: string; sequence: number; text: string; page: number | null; title: string | null }[];
    if (!rows.length || rows.length !== document.chunkCount) throw new AgentError('文档切片不完整，请先重新索引。', 409);
    const chunks: TextChunk[] = rows.map(r => ({ id: r.id, documentId: r.document_id, sequence: r.sequence, text: r.text, ...(r.page ? { page: r.page } : {}), ...(r.title ? { title: r.title } : {}) }));
    return { document, chunks };
  });
  return documents;
}
