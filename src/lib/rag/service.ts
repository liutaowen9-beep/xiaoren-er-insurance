import 'server-only';
import { traceRetrieval, recordLifecycle } from '../data-platform/telemetry';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_DOCUMENTS, MAX_TOTAL_CHUNKS, MIN_SCORE, TOP_K, RagError } from './config';
import { planQuery } from './query-plan';
import { supportsBusinessQuestion } from './business-evidence';
import { getStore, type KnowledgeStore, type KnowledgeReadAccess } from './store';
import { parseDocument, validateFile } from './parse';
import { chunkSections } from './chunk';
import { embedQuery, embedText } from './embedding';

const state = globalThis as typeof globalThis & { __moyuSandboxIndexing?: Set<string> };
const indexing = state.__moyuSandboxIndexing ??= new Set<string>();
export function isIndexing(id?: string) { return id ? indexing.has(id) : indexing.size > 0; }
export function prepareUpload(name: string, mime: string, raw: Buffer, store = getStore()) {
  const valid = validateFile(name, mime, raw);
  const hash = createHash('sha256').update(raw).digest('hex');
  const previous = store.findHash(hash);
  if (previous) return { document: previous, duplicate: true };
  if (isIndexing()) throw new RagError('已有文档正在索引，请完成后再上传。', 429);
  if (store.list().length >= MAX_DOCUMENTS) throw new RagError(`文档上限为 ${MAX_DOCUMENTS} 个，请先删除部分文档。`, 429);
  const document = store.insert({ id: randomUUID(), ...valid, hash, raw });
  claimIndex(document.id, store);
  recordLifecycle(store,document,'upload_queued');
  return { document, duplicate: false };
}
export function claimIndex(id: string, store = getStore()) {
  store.get(id);
  if (isIndexing()) throw new RagError('已有文档正在索引，请稍后重试。', 429);
  indexing.add(id); store.status(id, 'queued');
}
export function prepareReplacement(id: string, name: string, mime: string, raw: Buffer, revision: number, store = getStore()) {
  const valid = validateFile(name, mime, raw);
  if (isIndexing()) throw new RagError('已有文档正在索引，请稍后重试。', 429);
  const hash = createHash('sha256').update(raw).digest('hex');
  const previous = store.get(id);
  if (previous.revision !== revision || (!previous.isCurrent && !(previous.version === 1 && previous.status === 'failed'))) throw new RagError('文档已变化，请刷新后重试。', 409);
  if (previous.hash === hash) return { document: previous, duplicate: true };
  const document = store.replace(id, { ...valid, hash, raw }, revision);
  claimIndex(document.id, store);
  recordLifecycle(store,document,'replacement_queued');
  return { document, duplicate: false };
}
export function prepareReindex(id: string, store = getStore()) {
  if (isIndexing()) throw new RagError('已有文档正在索引，请稍后重试。', 429);
  if (!store.managed) { claimIndex(id, store); return store.get(id); }
  const doc = store.get(id);
  const candidate = doc.status === 'failed' && !doc.isCurrent ? store.retryVersion(id)
    : store.replace(id, { name: doc.name, extension: doc.extension, hash: doc.hash, raw: store.raw(id) }, doc.revision!);
  claimIndex(candidate.id, store); recordLifecycle(store,candidate,'reindex_queued'); return candidate;
}
export async function indexDocument(id: string, store: KnowledgeStore = getStore()) {
  try {
    store.status(id, 'parsing');
    const document = store.get(id);
    const sections = await parseDocument(store.raw(id), document.extension);
    store.status(id, 'chunking');
    const chunks = await chunkSections(id, sections);
    if (store.countChunks() - document.chunkCount + chunks.length > MAX_TOTAL_CHUNKS) throw new RagError(`知识库切片上限为 ${MAX_TOTAL_CHUNKS} 个，请清理后重试。`, 429);
    store.status(id, 'embedding');
    const vectors = [];
    for (const chunk of chunks) vectors.push(await embedText(chunk.text, 'passage'));
    store.status(id, 'indexing');
    store.commitIndex(id, chunks, vectors);
    recordLifecycle(store,{id},'index_success');
  } catch (e) {
    store.status(id, 'failed', e instanceof RagError ? e.message : '索引失败，文件可能损坏。请重新索引或换用 UTF-8 文本。');
    recordLifecycle(store,{id},'index_failed');
  } finally { indexing.delete(id); }
  return store.get(id);
}
export async function retrieve(question: string, topK = TOP_K, store: KnowledgeReadAccess = getStore(), signal?: AbortSignal) {
  return traceRetrieval(question,topK,store as KnowledgeReadAccess & {file?:string},'rag-vector-v1',()=>retrieveCore(question,topK,store,signal),value=>value);
}
async function retrieveCore(question: string, topK: number, store: KnowledgeReadAccess, signal?: AbortSignal) {
  if (!question.trim() || question.length > 2000) throw new RagError('检索问题不能为空，且不能超过 2000 字符。');
  if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw new RagError('检索数量必须为 1–10。');
  const plan = planQuery(question, store.list().filter(d => !store.isEligible || store.isEligible(d.id)));
  signal?.throwIfAborted();
  if(plan.overview&&plan.allowed&&store.overviewSources)return store.overviewSources([...plan.allowed],topK).filter(s=>!store.isEligible||store.isEligible(s.documentId));
  const found = new Map<string, Awaited<ReturnType<KnowledgeReadAccess['search']>>[number]>();
  for (const query of plan.queries) {
    signal?.throwIfAborted();
    const vector = await embedQuery(query);
    signal?.throwIfAborted();
    // Apply document scope before Top K; retain the actual cosine score, not a name boost.
    for (const source of store.search(vector, MAX_TOTAL_CHUNKS, MIN_SCORE)) {
      if (plan.allowed && !plan.allowed.has(source.documentId)) continue;
      if (!supportsBusinessQuestion(question, [source])) continue;
      if (!found.has(source.chunkId) || found.get(source.chunkId)!.score < source.score) found.set(source.chunkId, source);
    }
  }
  return [...found.values()].filter(s => !store.isEligible || store.isEligible(s.documentId)).sort((a, b) => b.score - a.score).slice(0, topK).map((s, i) => ({ ...s, number: i + 1 }));
}
export function deleteDocument(id: string, store = getStore(), revision?: number) {
  if (isIndexing(id)) throw new RagError('文档正在索引，请完成后再删除。', 409);
  store.delete(id, revision); recordLifecycle(store,{id},'deleted');
}
