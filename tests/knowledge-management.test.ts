import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getStore, KnowledgeStore } from '../src/lib/rag/store';
import { migrateManagement } from '../src/lib/rag/migration';
import { prepareUpload, indexDocument, prepareReplacement, prepareReindex, retrieve } from '../src/lib/rag/service';
import { EMBEDDING_DIMENSION, DATA_DIR, MODEL_CACHE, assertSandboxPath } from '../src/lib/rag/config';
import { embedText, getEncoder } from '../src/lib/rag/embedding';
import { readStoredSource, authorizedChunks } from '../src/lib/agent/knowledge';
import { prepareTool } from '../src/lib/agent/tools';
import { runAgent, type ModelTransport } from '../src/lib/agent/orchestrator';
import { GET, PATCH } from '../src/app/api/knowledge/documents/[id]/manage/route';
import { analyzeDocuments } from '../src/lib/agent/document-analysis';
import type { AgentEvent } from '../src/lib/agent/types';

mkdirSync('tmp/rag-tests', { recursive: true });
const root = mkdtempSync(path.resolve('tmp/rag-tests/management-suite-'));
const stores: KnowledgeStore[] = [];
let usedEncoder = false;
function store(management = true) {
  const s = new KnowledgeStore(path.join(root, randomUUID()+'.sqlite'), { management });
  stores.push(s); return s;
}
const vector = Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => i === 0 ? 1 : 0);
function input(text: string) { const raw = Buffer.from(text); return { id: randomUUID(), name: '虚构办公规范.txt', extension: '.txt', raw, hash: createHash('sha256').update(raw).digest('hex') }; }
function publish(s: KnowledgeStore, id: string, text: string, v = vector) {
  const chunkId = randomUUID();
  s.commitIndex(id, [{ id: chunkId, documentId: id, sequence: 0, text, page: 1 }], [v]);
  return chunkId;
}
function ready(s: KnowledgeStore, text = '虚构办公规范：假期十八天。') {
  const doc = s.insert(input(text)); const chunkId = publish(s, doc.id, text); return { doc: s.get(doc.id), chunkId };
}
function dump(s: KnowledgeStore) { return JSON.stringify({ docs: s.db.prepare('SELECT * FROM documents ORDER BY id').all(), chunks: s.db.prepare('SELECT * FROM chunks ORDER BY id').all(), schema: s.db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() }); }
after(async () => { for (const s of stores) s.close(); if (usedEncoder) await (await getEncoder()).dispose(); });

test('isolation rejects production, traversal and outside paths before opening SQLite', () => {
  assert.throws(() => new KnowledgeStore(path.resolve('.moyu/knowledge.sqlite')), /隔离/);
  assert.throws(() => new KnowledgeStore(path.resolve('.moyu/knowledge.sqlite'), { readOnly: true }), /隔离/);
  assert.throws(() => assertSandboxPath(path.join(root, '../../../../outside.sqlite')), /隔离/);
  assert.ok(DATA_DIR.startsWith(path.resolve('tmp/rag-tests')+path.sep));
  assert.equal(MODEL_CACHE, path.join(DATA_DIR, 'models'));
});

test('HMR cannot reuse an old production store object, and no query or close is attempted', () => {
  const state = globalThis as typeof globalThis & { __moyuKnowledgeStore?: KnowledgeStore };
  state.__moyuKnowledgeStore = { db: { prepare() { assert.fail('old connection must never be queried'); } }, close() { assert.fail('old connection must never be closed'); } } as unknown as KnowledgeStore;
  try { assert.throws(() => getStore(), /旧进程/); }
  finally { delete state.__moyuKnowledgeStore; }
  state.__moyuKnowledgeStore = { file: path.resolve('.moyu/knowledge.sqlite'), db: { prepare() { assert.fail('cached production object must not be queried'); } } } as unknown as KnowledgeStore;
  try { assert.throws(() => getStore(), /隔离/); }
  finally { delete state.__moyuKnowledgeStore; }
});

test('legacy migration preserves exact IDs, raw bytes, metadata, chunks and vectors', () => {
  const s = store(false); const { doc, chunkId } = ready(s);
  const before = JSON.stringify(s.db.prepare('SELECT * FROM chunks').all());
  const metadataBefore = s.db.prepare('SELECT id,name,extension,size,hash,status,chunk_count,created_at,error,model,dimension FROM documents').all();
  const raw = s.raw(doc.id);
  migrateManagement(s.db);
  assert.equal(s.managed, true);
  assert.equal(s.get(doc.id).version, 1);
  assert.equal(s.get(doc.id).isCurrent, true);
  assert.deepEqual(s.raw(doc.id), raw);
  assert.equal(s.get(doc.id).hash, doc.hash);
  assert.deepEqual(s.db.prepare('SELECT id,name,extension,size,hash,status,chunk_count,created_at,error,model,dimension FROM documents').all(), metadataBefore);
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM chunks').all()), before);
  assert.equal(readStoredSource(s, doc.id, chunkId).text, '虚构办公规范：假期十八天。');
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(Object.values(s.db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
  migrateManagement(s.db); assert.equal(s.list().length, 1);
});

for (const phase of ['copied', 'rebuilt']) test(`migration failure at ${phase} rolls back schema, metadata, BLOBs and constraints`, () => {
  const s = store(false); ready(s); const before = dump(s);
  assert.throws(() => migrateManagement(s.db, p => { if (p === phase) throw new Error('Injected fictional migration failure'); }), /Injected/);
  assert.equal(dump(s), before);
  assert.equal(s.managed, false);
  assert.equal(Object.values(s.db.prepare('PRAGMA foreign_keys').get()!)[0], 1);
});

test('migration refuses unfinished indexing rather than rewriting an active database', () => {
  const s = store(false); s.insert(input('虚构未完成文档'));
  const before = dump(s); assert.throws(() => migrateManagement(s.db), /未完成/); assert.equal(dump(s), before);
});

test('replacement is staged, validated, atomically published and retains historical references', () => {
  const s = store(); const { doc, chunkId } = ready(s);
  const candidate = s.replace(doc.id, input('虚构新版本：假期二十天。'), doc.revision!);
  assert.equal(s.search(vector, 5, .88)[0].documentId, doc.id);
  assert.equal(s.list()[0].replacement?.id, candidate.id);
  publish(s, candidate.id, '虚构新版本：假期二十天。');
  assert.equal(s.search(vector, 5, .88).length, 1);
  assert.equal(s.search(vector, 5, .88)[0].documentId, candidate.id);
  assert.equal(s.versions(candidate.id).length, 2);
  assert.equal(s.get(doc.id).isCurrent, false);
  assert.equal(readStoredSource(s, doc.id, chunkId).text, '虚构办公规范：假期十八天。');
  assert.throws(() => authorizedChunks(s, [doc.id], new Set([doc.id])), /停用|替换/);
});

test('failed candidate validation never replaces or removes the working old index', () => {
  const s = store(); const { doc, chunkId } = ready(s);
  const candidate = s.replace(doc.id, input('虚构候选文本'), doc.revision!);
  assert.throws(() => publish(s, candidate.id, '虚构候选文本', Array(384).fill(0)), /向量/);
  s.status(candidate.id, 'failed', '虚构失败');
  assert.equal(s.search(vector, 5, .88)[0].documentId, doc.id);
  assert.equal(readStoredSource(s, doc.id, chunkId).text, '虚构办公规范：假期十八天。');
  assert.equal(s.get(candidate.id).chunkCount, 0);
  const retry = s.retryVersion(candidate.id); publish(s, retry.id, '虚构候选文本');
  assert.equal(s.isEligible(retry.id), true);
});

test('disable, restore, archive and unarchive filter new retrieval without losing history', () => {
  const s = store(); const { doc, chunkId } = ready(s);
  for (const state of ['inactive', 'active', 'archived', 'inactive', 'active'] as const) {
    s.setState(doc.id, state, s.get(doc.id).revision!);
    assert.equal(s.search(vector, 5, .88).length, state === 'active' ? 1 : 0);
    assert.equal(s.raw(doc.id).length, doc.size);
    assert.equal(readStoredSource(s, doc.id, chunkId).text, '虚构办公规范：假期十八天。');
  }
});

test('restore checks corrupted vectors; stale revisions and concurrent index jobs are rejected', () => {
  const s = store(); const { doc } = ready(s);
  s.setState(doc.id, 'inactive', doc.revision!);
  assert.throws(() => s.setState(doc.id, 'active', doc.revision!), /变更/);
  s.db.prepare('UPDATE chunks SET vector=? WHERE document_id=?').run(Buffer.alloc(1536), doc.id);
  assert.throws(() => s.setState(doc.id, 'active', s.get(doc.id).revision!), /向量/);
  assert.equal(s.get(doc.id).state, 'inactive');
  const next = s.replace(doc.id, input('虚构候选一'), s.get(doc.id).revision!);
  assert.throws(() => s.replace(doc.id, input('虚构候选二'), s.get(doc.id).revision!), /任务/);
  s.status(next.id, 'failed', '虚构失败');
});

test('a lifecycle change during indexing blocks stale publication and keeps old version', () => {
  const s = store(); const { doc } = ready(s);
  const next = s.replace(doc.id, input('虚构新内容'), doc.revision!);
  s.setState(doc.id, 'inactive', doc.revision!);
  assert.throws(() => publish(s, next.id, '虚构新内容'), /未发布/);
  assert.equal(s.get(doc.id).isCurrent, true); assert.equal(s.get(doc.id).state, 'inactive');
  s.status(next.id, 'failed', '状态冲突');
});

test('reindex creates a same-content version without changing old chunk IDs; double publication fails', () => {
  const s = store(); const { doc, chunkId } = ready(s);
  // Exercise repository entry point (service task set is tested with the asynchronous pipeline below).
  const next = s.replace(doc.id, { ...input('虚构办公规范：假期十八天。'), raw: s.raw(doc.id), hash: doc.hash }, doc.revision!);
  publish(s, next.id, '虚构办公规范：假期十八天。');
  assert.equal(s.get(next.id).hash, doc.hash);
  assert.equal(readStoredSource(s, doc.id, chunkId).documentId, doc.id);
  assert.throws(() => publish(s, next.id, '不得覆盖'), /不可覆盖/);
  assert.equal(s.versions(next.id).length, 2);
});

test('restart keeps a live indexing owner but recovers a proven exited process without changing published version', () => {
  const s = store(); const { doc } = ready(s);
  const candidate = s.replace(doc.id, input('虚构重启候选'), doc.revision!);
  const file = (s.db.prepare('PRAGMA database_list').get() as { file: string }).file;
  const live = new KnowledgeStore(file, { management: true }); stores.push(live);
  assert.equal(live.get(candidate.id).status, 'queued');
  assert.throws(() => live.replace(doc.id, input('虚构第二连接候选'), doc.revision!), /任务/);
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']); assert.equal(child.status, 0);
  s.db.prepare('UPDATE document_jobs SET owner_pid=? WHERE id=?').run(child.pid, candidate.id);
  const reopened = new KnowledgeStore(file, { management: true }); stores.push(reopened);
  assert.equal(reopened.get(candidate.id).status, 'failed');
  assert.equal(reopened.get(doc.id).isCurrent, true);
  const retried = reopened.retryVersion(candidate.id); publish(reopened, retried.id, '虚构重启候选');
  assert.equal(reopened.isEligible(retried.id), true);
});

test('failed first upload can be archived, replaced and later restored without losing failed-version metadata', () => {
  const s = store(); const initial = s.insert(input('虚构失败上传')); s.status(initial.id, 'failed', '虚构失败');
  s.setState(initial.id, 'archived', s.get(initial.id).revision!);
  const next = s.replace(initial.id, input('虚构有效新文件'), s.get(initial.id).revision!); publish(s, next.id, '虚构有效新文件');
  assert.equal(s.search(vector, 5, .88).length, 0);
  s.setState(next.id, 'active', s.get(next.id).revision!);
  assert.equal(s.search(vector, 5, .88).length, 1);
  assert.equal(s.get(initial.id).error, '虚构失败');
});

test('stale delete cannot remove a newly published document and confirmed delete removes only its fictional version family', () => {
  const s = store(); const { doc } = ready(s);
  const next = s.replace(doc.id, input('虚构删除测试新版'), doc.revision!); publish(s, next.id, '虚构删除测试新版');
  assert.throws(() => s.delete(doc.id, doc.revision), /确认/);
  assert.equal(s.list().length, 1);
  s.delete(next.id, s.get(next.id).revision);
  assert.equal(s.list().length, 0); assert.equal(s.countChunks(), 0);
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('document_analyze rechecks lifecycle between generation segments and never returns stale results', async () => {
  const s = store(); const { doc } = ready(s); let calls = 0;
  const allowed = new Set([doc.id]);
  const result = await analyzeDocuments({ documentIds: [doc.id], task: 'summary' }, s, allowed, async () => { calls++; return '虚构办公规范摘要。'; }, new AbortController().signal);
  assert.equal(result.sources[0].documentId, doc.id); assert.equal(calls, 1);
  await assert.rejects(analyzeDocuments({ documentIds: [doc.id], task: 'summary' }, s, allowed, async () => {
    s.setState(doc.id, 'inactive', s.get(doc.id).revision!); return '不应返回此过期摘要。';
  }, new AbortController().signal), /停用/);
});

test('lifecycle management API validates JSON, revision, cross-site requests and history metadata', async () => {
  const s = store(); const { doc } = ready(s);
  const global = globalThis as typeof globalThis & { __moyuKnowledgeStore?: KnowledgeStore };
  global.__moyuKnowledgeStore = s;
  try {
    const context = { params: Promise.resolve({ id: doc.id }) };
    const request = (body: unknown, headers = {}) => new Request(`http://localhost/api/knowledge/documents/${doc.id}/manage`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await PATCH(request({ state: 'inactive', revision: doc.revision }), context)).status, 200);
    assert.equal((await PATCH(request({ state: 'active', revision: doc.revision }), context)).status, 409);
    assert.equal((await PATCH(request({ state: 'invalid', revision: 2 }), context)).status, 400);
    assert.equal((await PATCH(request({ state: 'active', revision: 2 }, { Origin: 'https://example.invalid' }), context)).status, 403);
    const response = await GET(new Request('http://localhost'), context);
    const body = await response.json(); assert.equal(body.versions.length, 1); assert.equal(body.versions[0].state, 'inactive');
    assert.ok(!JSON.stringify(body).includes('raw')); assert.ok(!JSON.stringify(body).includes('vector'));
  } finally { delete global.__moyuKnowledgeStore; }
});

test('real fictional TXT pipeline, failure, replacement, reindex and LangGraph knowledge_search use isolated data', async () => {
  usedEncoder = true;
  const s = store(); const text = '本测试办公文档规定：员工每年有十八天虚构假期。';
  const first = prepareUpload('虚构办公.txt', 'text/plain', Buffer.from(text), s);
  await indexDocument(first.document.id, s);
  assert.equal(s.get(first.document.id).status, 'ready');
  assert.ok((await retrieve(text, 5, s)).length);
  const next = prepareReplacement(first.document.id, '虚构办公新版.txt', 'text/plain', Buffer.from(text+'此资料只用于软件测试。'), s.get(first.document.id).revision!, s);
  await indexDocument(next.document.id, s); assert.equal(s.get(next.document.id).isCurrent, true);
  const reindexed = prepareReindex(next.document.id, s); await indexDocument(reindexed.id, s);
  assert.equal(s.get(reindexed.id).isCurrent, true);
  // A broken but structurally recognized PDF exercises the actual parser failure path.
  const broken = prepareReplacement(reindexed.id, '虚构损坏.pdf', 'application/pdf', Buffer.from('%PDF-invalid-test-only'), s.get(reindexed.id).revision!, s);
  await indexDocument(broken.document.id, s);
  assert.equal(s.get(broken.document.id).status, 'failed'); assert.equal(s.get(reindexed.id).isCurrent, true);
  const reader = new KnowledgeStore(path.join(root, path.basename((s.db.prepare('PRAGMA database_list').get() as { file: string }).file)), { readOnly: true }); stores.push(reader);
  let requests = 0;
  const model: ModelTransport = async () => {
    const calls = requests++ === 0 ? [{ index: 0, id: 'fictional-call', type: 'function', function: { name: 'knowledge_search', arguments: JSON.stringify({ query: text }) } }] : undefined;
    return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: calls ? { tool_calls: calls } : { content: '请核对检索来源。' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)); c.close(); } });
  };
  const events: AgentEvent[] = [];
  for await (const event of runAgent([{ role: 'user', content: text }], { store: reader, signal: new AbortController().signal, requestModel: model })) events.push(event);
  assert.ok(events.some(e => e.type === 'tool_finish'));
  assert.ok(events.some(e => e.type === 'sources' && e.sources.some(source => source.documentId === reindexed.id)));
  const tool = prepareTool('knowledge_search', JSON.stringify({ query: text }), { store: reader, allowed: new Set([reindexed.id]), generate: async () => '不应调用' });
  s.setState(reindexed.id, 'inactive', s.get(reindexed.id).revision!);
  assert.equal((await tool.execute(new AbortController().signal)).sources.length, 0);
  assert.throws(() => authorizedChunks(reader, [reindexed.id], new Set([reindexed.id])), /停用/);
  assert.equal((await retrieve(text, 5, reader)).length, 0);
  s.setState(reindexed.id, 'archived', s.get(reindexed.id).revision!);
  assert.equal((await tool.execute(new AbortController().signal)).sources.length, 0);
  assert.equal((await retrieve(text, 5, reader)).length, 0);
  s.setState(reindexed.id, 'active', s.get(reindexed.id).revision!);
  assert.ok((await tool.execute(new AbortController().signal)).sources.some(source => source.documentId === reindexed.id));
  assert.ok((await retrieve(text, 5, reader)).some(source => source.documentId === reindexed.id));
  // Synthetic embedding is real; no DeepSeek or other HTTP request is permitted by setup.
  assert.equal((await embedText(text, 'passage')).length, 384);
});
