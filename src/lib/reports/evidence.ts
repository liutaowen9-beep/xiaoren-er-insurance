import 'server-only';
import { createHash } from 'node:crypto';
import type { KnowledgeStore } from '../rag/store';
import type { Source } from '../rag/types';
import { readStoredSource } from '../agent/knowledge';
import { ReportError, type Report } from './types';

export function checkEvidence(store: KnowledgeStore | null, sources: Pick<Source,'documentId'|'chunkId'|'text'>[]) {
  if (!sources.length) return;
  if (!store) throw new ReportError('知识库连接不可用，未生成或提供过期报告。', 409);
  for (const s of sources) {
    if (!store.isEligible(s.documentId)) throw new ReportError('来源已停用、归档或替换，请重新生成报告。', 409);
    if (readStoredSource(store, s.documentId, s.chunkId).text !== s.text) throw new ReportError('证据片段已变化，请重新生成报告。', 409);
  }
}
export function references(store: KnowledgeStore | null, sources: Source[]): Report['references'] {
  checkEvidence(store, sources);
  return sources.map((s,i) => { const d = store!.get(s.documentId); return { number: i+1, documentId: s.documentId, chunkId: s.chunkId, fileName: d.name, ...(d.version ? {version:d.version} : {}), ...(s.page ? {page:s.page} : {}), excerpt:s.text.slice(0,350), evidenceHash:createHash('sha256').update(s.text).digest('hex') }; });
}
export function checkDownloadEvidence(store: KnowledgeStore | null, report: Report) {
  for (const r of report.references) {
    if (!store?.isEligible(r.documentId) || store.get(r.documentId).version !== r.version) throw new ReportError('报告来源已失效，请重新生成后下载。',409);
    const source = readStoredSource(store,r.documentId,r.chunkId);
    if (source.text.slice(0,350).trim()!==r.excerpt || createHash('sha256').update(source.text).digest('hex')!==r.evidenceHash) throw new ReportError('报告证据已变化，请重新生成。',409);
  }
}
