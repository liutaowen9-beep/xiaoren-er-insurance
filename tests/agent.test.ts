import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from '../src/lib/rag/store';
import { prepareUpload, indexDocument } from '../src/lib/rag/service';
import { getEncoder } from '../src/lib/rag/embedding';
import { calculate } from '../src/lib/agent/calculator';
import { prepareTool, AGENT_TOOLS } from '../src/lib/agent/tools';
import { readModelTurn } from '../src/lib/agent/model-stream';
import { runAgent, abortable, type ModelTransport } from '../src/lib/agent/orchestrator';
import { observeRun } from '../src/lib/agent/observe';
import { applyWorkflowEvent, type WorkflowRun } from '../src/lib/agent/workflow';
import { readStoredSource } from '../src/lib/agent/knowledge';
import { analyzeDocuments } from '../src/lib/agent/document-analysis';
import { AGENT_LIMITS, AgentError, agentFailure } from '../src/lib/agent/limits';
import { POST as agentPOST } from '../src/app/api/agent/route';
import { readChatReply } from '../src/lib/chat-stream';
import { isConversation } from '../src/lib/chat';
import type { AgentEvent } from '../src/lib/agent/types';
import type { AIToolCall } from '../src/lib/ai';

// No .env loading and no paid API calls in this suite. Generation is intercepted;
// document parsing, embeddings, vector search, calculator and SQLite are real.
process.env.DEEPSEEK_API_KEY = '';
mkdirSync('tmp/rag-tests', { recursive: true });
const root = mkdtempSync(path.resolve('tmp/rag-tests/agent-'));
const databaseFile = path.join(root, 'knowledge.sqlite');
const writer = new KnowledgeStore(databaseFile);
let reader: KnowledgeStore;
let documentId: string;
let longId: string;
let oversizedId: string;
const encoder = new TextEncoder();
const call = (id: string, name: string, args: unknown): AIToolCall => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

function wire(calls: AIToolCall[] = [], text = '', fragment = false) {
  const chunks: unknown[] = [];
  if (text) chunks.push({ choices: [{ delta: { content: text } }] });
  calls.forEach((tool, index) => {
    const half = Math.floor(tool.function.arguments.length / 2);
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.function.name, arguments: tool.function.arguments.slice(0, half) } }] } }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: tool.function.arguments.slice(half) } }] } }] });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
  const bytes = encoder.encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new ReadableStream<Uint8Array>({ start(c) { if (fragment) for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); else c.enqueue(bytes); c.close(); } });
}
async function collect(model: ModelTransport, messages = [{ role: 'user' as const, content: '请完成任务。' }], store: KnowledgeStore | null = reader) {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(messages, { store, signal: new AbortController().signal, requestModel: model })) events.push(event);
  return events;
}
function textOf(events: AgentEvent[]) { return events.filter(e => e.type === 'delta').map(e => e.type === 'delta' ? e.text : '').join(''); }
after(async () => { reader?.close(); writer.close(); await (await getEncoder()).dispose(); });

test('calculator handles required business result, decimals, parentheses and percent with explicit rounding', () => {
  assert.equal(calculate('50*299*0.85').result, '12707.5');
  assert.equal(calculate('50*299*85%').roundedAmount, '12707.50');
  assert.equal(calculate('(0.1+0.2)*10').result, '3');
  assert.equal(calculate('-(-2)+.5').result, '2.5');
  assert.equal(calculate('1.005').roundedAmount, '1.01');
  assert.match(calculate('1/3').note, /舍入/);
});

test('calculator rejects code, division by zero, overflow and excessive nesting without side effects', () => {
  for (const expression of ['process.env.DEEPSEEK_API_KEY', 'globalThis.agentSentinel=1', '1; console.log(1)', 'Function("return 1")()', '1/0', '9999999999999999', '1e100', '2**999', '1..2', '('.repeat(25) + '1' + ')'.repeat(25), '1+'.repeat(100) + '1']) assert.throws(() => calculate(expression), AgentError, expression);
  assert.equal((globalThis as { agentSentinel?: unknown }).agentSentinel, undefined);
});

test('tool registry has exactly three whitelisted schemas and refuses paths, extra keys and bad parameters', () => {
  assert.deepEqual(AGENT_TOOLS.map(t => t.function.name).sort(), ['calculator', 'document_analyze', 'knowledge_search']);
  const context = { store: null, allowed: new Set<string>(), generate: async () => 'unused' };
  for (const [name, args] of [['shell', '{}'], ['__proto__', '{}'], ['calculator', '{bad'], ['calculator', '{"expression":"1+2","command":"dir"}'], ['knowledge_search', '{"query":"保险","topK":999}'], ['document_analyze', '{"documentIds":["../../.env.local"],"task":"summary"}'], ['document_analyze', '{"documentIds":[],"task":"delete"}']] as const) assert.throws(() => prepareTool(name, args, context), AgentError);
});

test('stream parser assembles fragmented Chinese arguments and correlates multiple tool calls', async () => {
  const calls = [call('calc_a', 'calculator', { expression: '50*299*0.85' }), call('search_b', 'knowledge_search', { query: '保险理赔资料', topK: 2 })];
  let turn;
  for await (const event of readModelTurn(wire(calls, '', true))) if (event.type === 'turn') turn = event.turn;
  assert.deepEqual(turn?.calls, calls); assert.equal(turn?.finishReason, 'tool_calls');
});

test('incomplete or malformed tool streams never become executable calls', async () => {
  const broken = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"calculator","arguments":"{"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":4,"id":"a"}]}}]}\n\ndata: [DONE]\n\n',
    'data: {"error":{"message":"private upstream exception"}}\n\n',
  ];
  for (const payload of broken) await assert.rejects(async () => { for await (const event of readModelTurn(new ReadableStream({ start(c) { c.enqueue(encoder.encode(payload)); c.close(); } }))) void event; }, AgentError);
});

test('orchestrator automatically executes calculator and returns matching tool_call_id to model', async () => {
  let round = 0;
  const events = await collect(async (messages, _signal, options) => {
    assert.equal(options?.tools?.length, 3);
    if (!round++) return wire([call('business_calc', 'calculator', { expression: '50*299*0.85' })]);
    const result = messages.at(-1)!;
    assert.equal(result.role, 'tool'); assert.equal(result.tool_call_id, 'business_calc');
    assert.equal(JSON.parse(result.content).result, '12707.5');
    assert.equal(messages.at(-2)?.tool_calls?.[0].id, 'business_calc');
    return wire([], '合计 12707.50 元。');
  }, undefined, null);
  assert.match(textOf(events), /12707.50/);
  assert.equal(events.filter(e => e.type === 'tool_start').length, 1);
  assert.equal(events.filter(e => e.type === 'tool_finish').length, 1);
  assert.equal(round, 2);
});

test('same-round multiple tools execute serially with distinct result IDs', async () => {
  let round = 0;
  const events = await collect(async messages => {
    if (!round++) return wire([call('first', 'calculator', { expression: '2+3' }), call('second', 'calculator', { expression: '7*8' })]);
    assert.deepEqual(messages.slice(-2).map(m => m.tool_call_id), ['first', 'second']);
    assert.deepEqual(messages.slice(-2).map(m => JSON.parse(m.content).result), ['5', '56']);
    return wire([], '结果为 5 和 56。');
  }, undefined, null);
  assert.deepEqual(events.filter(e => e.type === 'tool_start').map(e => e.type === 'tool_start' ? e.record.id : ''), ['first', 'second']);
});

test('unknown or schema-invalid tools are rejected without fabricated execution cards', async () => {
  let round = 0;
  const events = await collect(async messages => {
    if (!round++) return wire([call('bad', 'read_file', { path: '.env.local' })]);
    assert.equal(JSON.parse(messages.at(-1)!.content).ok, false);
    return wire([], '该操作不在授权工具范围内。');
  }, undefined, null);
  assert.equal(events.filter(e => e.type === 'tool_start').length, 0);
  assert.equal(events.filter(e => e.type === 'tool_finish').length, 0);
});

test('tool execution failures generate real failure events and safe results instead of crashing', async () => {
  let round = 0;
  const events = await collect(async messages => {
    if (!round++) return wire([call('divide', 'calculator', { expression: '1/0' })]);
    assert.match(JSON.parse(messages.at(-1)!.content).error, /除数/);
    return wire([], '除数不能为零，请修改表达式。');
  }, undefined, null);
  assert.equal(events.filter(e => e.type === 'tool_error').length, 1);
  assert.match(textOf(events), /除数/);
});

test('five-round ceiling forces safe termination without a sixth tool execution', async () => {
  let requests = 0; let starts = 0;
  await assert.rejects(async () => {
    for await (const event of runAgent([{ role: 'user', content: '循环' }], { store: null, signal: new AbortController().signal, requestModel: async (_messages, _signal, options) => {
      requests++; if (requests === 6) assert.equal(options?.tool_choice, 'none');
      return wire([call(`loop_${requests}`, 'calculator', { expression: '1+1' })]);
    } })) if (event.type === 'tool_start') starts++;
  }, /5 轮/);
  assert.equal(starts, 5); assert.equal(requests, 6);
});

test('cancellation after tool start prevents that and subsequent tools from starting work', async () => {
  const abort = new AbortController(); let requests = 0;
  const events: AgentEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of runAgent([{ role: 'user', content: '计算' }], { store: null, signal: abort.signal, requestModel: async () => { requests++; return wire([call('a', 'calculator', { expression: '1+1' }), call('b', 'calculator', { expression: '2+2' })]); } })) {
      events.push(event); if (event.type === 'tool_start') abort.abort();
    }
  });
  assert.equal(requests, 1); assert.equal(events.filter(e => e.type === 'tool_start').length, 1); assert.equal(events.filter(e => e.type === 'tool_finish').length, 0);
});

test('bounded task cancellation rejects promptly and public errors do not expose internal details', async () => {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(new DOMException('private timeout detail', 'TimeoutError')), 10);
  await assert.rejects(abortable(() => new Promise(() => {}), abort.signal)); clearTimeout(timer);
  assert.match(agentFailure(null, abort.signal), /超时/);
  assert.ok(!agentFailure(new Error('private stack and secret'), new AbortController().signal).includes('private'));
  assert.equal(AGENT_LIMITS.toolRounds, 5);
});

test('prepare real local document indexes without touching the private production database', async () => {
  const prepared = prepareUpload('Agent测试资料.md', 'text/markdown', Buffer.from('# 团体保险报价\n\n每人保费为299元；投保50人享八五折。申请保险理赔需要准备身份证、保险合同、诊断证明和发票，在保险公司线上提交材料。'), writer);
  documentId = prepared.document.id;
  assert.equal((await indexDocument(documentId, writer)).status, 'ready');
  const long = prepareUpload('长文档测试.md', 'text/markdown', Buffer.from('# 条款\n\n' + '每项服务须提前申请，工作人员应保存原始凭证。'.repeat(420) + '\n末尾关键条款：取消需提前七天告知。'), writer);
  longId = long.document.id; assert.equal((await indexDocument(longId, writer)).status, 'ready');
  const oversized = prepareUpload('容量边界测试.txt', 'text/plain', Buffer.from('本合同的服务时间为工作日上午九点至下午六点。'.repeat(1800)), writer);
  oversizedId = oversized.document.id; assert.equal((await indexDocument(oversizedId, writer)).status, 'ready');
  reader = new KnowledgeStore(databaseFile, { readOnly: true });
  assert.throws(() => reader.db.prepare("DELETE FROM documents").run(), /readonly|read.only/i);
});

test('knowledge_search uses real Chinese vector retrieval and returns exact SQLite source IDs', async () => {
  const prepared = prepareTool('knowledge_search', JSON.stringify({ query: '申请保险理赔需要哪些资料？', topK: 2 }), { store: reader, allowed: new Set([documentId]), generate: async () => 'unused' });
  const result = await prepared.execute(new AbortController().signal);
  assert.ok(result.sources.length > 0);
  const source = result.sources[0]; assert.equal(source.documentId, documentId);
  const row = reader.db.prepare('SELECT text FROM chunks WHERE id=?').get(source.chunkId) as { text: string };
  assert.equal(source.text, row.text);
});

test('Agent combines real knowledge retrieval and calculator across model tool rounds', async () => {
  let requests = 0;
  const events = await collect(async messages => {
    requests++;
    if (requests === 1) return wire([call('find_price', 'knowledge_search', { query: '每人保费为299元，投保50人有什么折扣？', topK: 1 })]);
    if (requests === 2) {
      const result = JSON.parse(messages.at(-1)!.content); assert.equal(result.found, true); assert.equal(result.sources[0].documentId, documentId);
      return wire([call('calculate_total', 'calculator', { expression: '50*299*0.85' })]);
    }
    assert.equal(JSON.parse(messages.at(-1)!.content).result, '12707.5');
    return wire([], '依据实际报价，合计 12707.50 元。');
  });
  assert.equal(events.filter(e => e.type === 'tool_finish').length, 2);
  const sourceEvent = events.find(e => e.type === 'sources'); assert.ok(sourceEvent && sourceEvent.type === 'sources' && sourceEvent.sources.some(s => s.documentId === documentId));
});

test('empty knowledge is represented as actual no-result tool output', async () => {
  let requests = 0;
  const events = await collect(async messages => {
    if (!requests++) return wire([call('empty', 'knowledge_search', { query: '不存在的资料' })]);
    assert.equal(JSON.parse(messages.at(-1)!.content).found, false);
    return wire([], '当前知识库中没有找到足够的信息。');
  }, undefined, null);
  assert.match(textOf(events), /没有找到足够/);
});

test('Agent document_analyze reads authorized chunks, calls summary model without tools, and returns sources', async () => {
  let requests = 0;
  const before = writer.countChunks();
  const events = await collect(async (messages, _signal, options) => {
    requests++;
    if (requests === 1) return wire([call('analyze_doc', 'document_analyze', { documentIds: [documentId], task: 'summary' })]);
    if (requests === 2) {
      assert.equal(options?.tools, undefined); assert.match(messages[0].content, /不可信/); assert.match(messages.at(-1)!.content, /299/);
      return wire([], '每人保费299元，50人享八五折，理赔需身份证等材料。');
    }
    assert.equal(JSON.parse(messages.at(-1)!.content).coverage.method, 'direct');
    return wire([], '文档说明了团体报价和理赔材料要求。');
  });
  assert.equal(requests, 3); assert.equal(writer.countChunks(), before);
  assert.ok(events.some(e => e.type === 'sources' && e.sources.some(s => s.documentId === documentId && s.kind === 'document')));
});

test('long document analysis maps every segment then reduces; no tail is silently dropped', async () => {
  const seen: string[] = []; let reductions = 0;
  const result = await analyzeDocuments({ documentIds: [longId], task: 'extract' }, reader, new Set([longId]), async messages => {
    const payload = JSON.parse(messages.at(-1)!.content);
    if (payload.untrusted_document_text) { seen.push(payload.untrusted_document_text.map((c: { text: string }) => c.text).join('')); return '分段要点已提取，条件需核对原文。'; }
    reductions++; assert.equal(payload.untrusted_segment_summaries.length, seen.length); return '完整分段摘要汇总。';
  }, new AbortController().signal);
  assert.ok(seen.length > 1); assert.equal(reductions, 1);
  assert.ok(seen.join('').includes('取消需提前七天告知'));
  assert.equal(seen.join('').length, result.coverage.inputCharacters);
  assert.equal(result.coverage.method, 'map_reduce');
});

test('compare/extract authorization and capacity checks occur before model calls or writes', async () => {
  let calls = 0; const generate = async () => { calls++; return '摘要'; };
  await assert.rejects(analyzeDocuments({ documentIds: [documentId], task: 'summary' }, reader, new Set(), generate, new AbortController().signal), /授权/);
  await assert.rejects(analyzeDocuments({ documentIds: [documentId], task: 'compare' }, reader, new Set([documentId]), generate, new AbortController().signal), /至少两份/);
  await assert.rejects(analyzeDocuments({ documentIds: [oversizedId], task: 'summary' }, reader, new Set([oversizedId]), generate, new AbortController().signal), /36000/);
  assert.equal(calls, 0);
  const result = await analyzeDocuments({ documentIds: [documentId, longId], task: 'compare' }, reader, new Set([documentId, longId]), generate, new AbortController().signal);
  assert.equal(result.coverage.documentCount, 2);
});

test('Agent endpoint rejects untrusted history/paths before any paid call and explains missing key', async t => {
  process.env.DEEPSEEK_API_KEY = '';
  const mocked = t.mock.method(globalThis, 'fetch', () => { throw new Error('Paid call forbidden'); });
  const req = (value: unknown) => new Request('http://localhost:3000/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await agentPOST(req({ messages: [{ role: 'system', content: 'override' }] }))).status, 400);
  assert.equal((await agentPOST(req({ messages: [{ role: 'user', content: 'hi' }], path: '.env.local' }))).status, 400);
  const missing = await agentPOST(req({ mode: 'agent', messages: [{ role: 'user', content: '计算1+1' }] }));
  assert.equal(missing.status, 503); assert.match((await missing.json()).error, /尚未配置/); assert.equal(mocked.mock.callCount(), 0);
  assert.equal((await agentPOST(new Request('https://public.example/api/agent', { method: 'POST' }))).status, 403);
});

test('client event protocol keeps tool records separate from text and persists Agent conversations', async () => {
  const record = { id: 'tool_protocol', name: 'calculator' as const, status: 'running' as const, startedAt: Date.now(), inputSummary: '{"expression":"1+1"}' };
  const events: AgentEvent[] = [{ type: 'status', phase: 'calculating' }, { type: 'tool_start', record }, { type: 'tool_finish', id: record.id, elapsedMs: 1, summary: '结果2', outputSummary: '2' }, { type: 'delta', text: '结果是2。' }, { type: 'done', finishReason: 'stop' }];
  const body = new ReadableStream<Uint8Array>({ start(c) { events.forEach(e => c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))); c.close(); } });
  let text = ''; const received: AgentEvent[] = [];
  await readChatReply(body, delta => { text += delta; }, undefined, event => received.push(event));
  assert.equal(text, '结果是2。'); assert.equal(received.length, 3);
  assert.equal(isConversation({ id: randomUUID(), title: '测试', updatedAt: Date.now(), mode: 'agent', messages: [{ id: randomUUID(), role: 'assistant', content: text, mode: 'agent', tools: [{ ...record, status: 'completed' }] }] }), true);
});

test('V5 observes real search, calculation and document analysis with read-only source association', async () => {
  let round = 0; const abort = new AbortController(); let run: WorkflowRun | undefined;
  const events: AgentEvent[] = [];
  for await (const event of observeRun(runAgent([{ role: 'user', content: '检索理赔要求，计算报价并总结文档。' }], { store: reader, signal: abort.signal, requestModel: async (_messages, _signal, options) => {
    if (!options?.tools) return wire([], '文档要求按规定提交材料，报价由计算器确定。');
    if (!round++) return wire([call('v5_search', 'knowledge_search', { query: '理赔需要什么资料', topK: 2 }), call('v5_calc', 'calculator', { expression: '50*299*0.85' }), call('v5_analyze', 'document_analyze', { documentIds: [documentId], task: 'summary' })]);
    return wire([], '查询、计算和摘要处理完成，请核对真实来源。');
  } }), abort.signal)) { events.push(event); if ('runId' in event) run = applyWorkflowEvent(run, event); }
  assert.equal(run!.status, 'success'); assert.deepEqual(run!.steps.map(s => s.name), ['knowledge_search', 'calculator', 'document_analyze']);
  assert.ok(run!.steps.every(s => s.status === 'success'));
  assert.ok(run!.steps[0].sourceChunkIds.length > 0); assert.ok(run!.steps[2].sourceChunkIds.length > 0);
  assert.match(run!.steps[0].summary!, /真实片段/); assert.match(run!.steps[2].inputSummary, /文档数量：1/);
  assert.ok(!JSON.stringify(run).includes('身份证')); // private source text isn't in workflow summaries
  assert.deepEqual(run!.steps[1].dependsOn, [run!.steps[0].stepId]);
  assert.ok(run!.steps[1].startedAt! >= run!.steps[0].endedAt!);
  const sourceEvent = events.find(e => e.type === 'sources'); assert.ok(sourceEvent?.type === 'sources');
  if (sourceEvent?.type === 'sources') {
    const source = sourceEvent.sources[0]; const stored = readStoredSource(reader, source.documentId, source.chunkId);
    assert.equal(stored.text, source.text); assert.equal(stored.fileName, source.fileName);
  }
});

test('V5 stored source requires the actual document/chunk pair and rejects stale source IDs', () => {
  const row = reader.db.prepare('SELECT id,text FROM chunks WHERE document_id=? LIMIT 1').get(documentId) as { id: string; text: string };
  assert.equal(readStoredSource(reader, documentId, row.id).text, row.text);
  assert.throws(() => readStoredSource(reader, longId, row.id), /切片已删除/);
  assert.throws(() => readStoredSource(reader, documentId, randomUUID()), /切片已删除/);
});
