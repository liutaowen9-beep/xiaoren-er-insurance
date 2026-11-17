import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StateGraph, StateSchema, START, END } from '@langchain/langgraph';
import { z } from 'zod';

test('installed LangGraph compiles and executes a typed conditional StateGraph without a model', async () => {
  const state = new StateSchema({ count: z.number(), ready: z.boolean() });
  const graph = new StateGraph(state).addNode('increment', s => ({ count: s.count + 1 }))
    .addNode('complete', () => ({ ready: true })).addEdge(START, 'increment')
    .addConditionalEdges('increment', s => s.count >= 2 ? 'complete' : 'increment', ['complete', 'increment']).addEdge('complete', END).compile();
  const result = await graph.invoke({ count: 0, ready: false }, { recursionLimit: 5, callbacks: [] });
  assert.equal(result.count, 2); assert.equal(result.ready, true);
});


import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { AIError, type AIToolCall } from '../src/lib/ai';
import { runAgent, type ModelTransport } from '../src/lib/agent/orchestrator';
import { observeRun } from '../src/lib/agent/observe';
import { applyWorkflowEvent, isWorkflowRun, workflowEventSchema, type WorkflowRun, type WorkflowEvent, createWorkflowReceiver } from '../src/lib/agent/workflow';
import { checkedGraphState } from '../src/lib/agent/graph-state';
import { KnowledgeStore } from '../src/lib/rag/store';
import { prepareUpload, indexDocument } from '../src/lib/rag/service';
import { getEncoder } from '../src/lib/rag/embedding';
import { restoreHistory, serializeHistory } from '../src/lib/chat-history';
import { readChatReply } from '../src/lib/chat-stream';
import type { AgentEvent } from '../src/lib/agent/types';

// Invented, isolated fixtures only. No .env loading, private database or paid transport.
process.env.DEEPSEEK_API_KEY = '';
const bytes = new TextEncoder();
const call = (id: string, name: string, args: unknown): AIToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function wire(calls: AIToolCall[] = [], text = '') {
  const payload = [{ choices: [{ delta: { content: text, ...(calls.length ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : {}) } }] }, { choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }];
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.encode(payload.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n')); c.close(); } });
}
let reader: KnowledgeStore, writer: KnowledgeStore, fixtureId: string;
const fixture = '保险期间可选3/7/11/13年，提供多种保障期限选择。\n虚构例子：年交23万，保11年。\n保费4万起售，预期利益不等于保证收益。';
async function observed(model: ModelTransport, options: Partial<Parameters<typeof runAgent>[1]> = {}) {
  const signal = options.signal ?? new AbortController().signal, runId = randomUUID(), events: AgentEvent[] = [];
  for await (const e of observeRun(runAgent([{ role: 'user', content: '请完成本次虚构测试任务' }], { store: null, ...options, signal, runId, graphEvents: true, requestModel: model }), signal, runId)) events.push(e);
  let run: WorkflowRun | undefined;
  for (const e of events) if ('runId' in e) run = applyWorkflowEvent(run, e);
  return { events, run: run!, text: events.filter(e => e.type === 'delta').map(e => e.type === 'delta' ? e.text : '').join('') };
}
const history = (run?: WorkflowRun) => [{ id: randomUUID(), title: '虚构记录', mode: 'agent' as const, updatedAt: Date.now(), messages: [{ id: randomUUID(), role: 'assistant' as const, mode: 'agent' as const, content: '回答', workflow: run }] }];
after(async () => { reader?.close(); writer?.close(); if (writer) await (await getEncoder()).dispose(); });

test('shared graph state rejects unknown fields, oversized tasks and invalid counts', () => {
  const state = { runId: randomUUID(), task: '你好', status: 'running', messages: [], plan: [], currentStep: 0, round: 0, sources: [], results: [], retryCount: 0, attempt: 0, modelCalls: 0, finalAnswer: '', finished: false, cancelled: false, steps: 0 };
  assert.equal(checkedGraphState(state).task, '你好');
  for (const patch of [{ arbitrarySQL: 'not executed' }, { retryCount: 3 }, { steps: 65 }, { task: '字'.repeat(10001) }]) assert.throws(() => checkedGraphState({ ...state, ...patch }));
});

test('greeting takes the actual no-tool conditional path without invented execution', async () => {
  const r = await observed(async () => wire([], '你好。'));
  assert.equal(r.text, '你好。'); assert.equal(r.run.status, 'success'); assert.equal(r.run.steps.length, 0);
  assert.deepEqual(r.run.nodes!.map(n => n.name), ['plan_task', 'route_task', 'synthesize_answer', 'finish_task']);
});

test('single calculator uses real graph nodes and returns 7182 with matching tool_call_id', async () => {
  let count = 0;
  const r = await observed(async (messages) => {
    if (!count++) return wire([call('calc_graph', 'calculator', { expression: '20*399*0.9' })]);
    assert.equal(messages.at(-1)!.tool_call_id, 'calc_graph'); assert.equal(JSON.parse(messages.at(-1)!.content).result, '7182');
    return wire([], '计算结果为7182。');
  });
  assert.equal(r.run.steps[0].status, 'success'); assert.match(r.text, /7182/);
  assert.deepEqual(r.run.nodes!.map(n => n.name), ['plan_task', 'route_task', 'execute_tools', 'validate_evidence', 'plan_task', 'route_task', 'synthesize_answer', 'finish_task']);
});

test('same-round multiple tools follow actual graph edges without redoing successful work', async () => {
  let requests = 0;
  const r = await observed(async messages => {
    if (!requests++) return wire([call('first_graph', 'calculator', { expression: '2+3' }), call('second_graph', 'calculator', { expression: '7*8' })]);
    assert.deepEqual(messages.slice(-2).map(m => m.tool_call_id), ['first_graph', 'second_graph']);
    return wire([], '结果为5和56。');
  });
  assert.equal(r.run.steps.length, 2); assert.equal(r.run.nodes!.filter(n => n.name === 'execute_tools').length, 2);
  assert.ok(r.run.steps[0].endedAt! <= r.run.steps[1].startedAt!);
  for (let i = 1; i < r.run.nodes!.length; i++) assert.equal(r.run.nodes![i].previousNodeId, r.run.nodes![i - 1].nodeId);
});

test('recoverable network failure retries exactly twice and then succeeds', async () => {
  let attempts = 0;
  const r = await observed(async () => { if (++attempts <= 2) throw new AIError('临时不可用', 503, true); return wire([], '恢复完成。'); });
  assert.equal(attempts, 3); assert.equal(r.run.status, 'success'); assert.equal(r.run.nodes!.filter(n => n.name === 'retry_or_replan').length, 2);
  assert.equal(Math.max(...r.run.nodes!.map(n => n.retryCount)), 2);
});

test('retry exhaustion cannot make a fourth attempt or report success', async () => {
  let attempts = 0;
  const r = await observed(async () => { attempts++; throw new AIError('临时限流', 429, true); });
  assert.equal(attempts, 3); assert.equal(r.run.status, 'error'); assert.ok(!r.events.some(e => e.type === 'done'));
});

test('unauthorized model errors are nonretryable and safely terminate', async () => {
  let attempts = 0;
  const r = await observed(async () => { attempts++; throw new AIError('密钥配置无效', 401); });
  assert.equal(attempts, 1); assert.equal(r.run.status, 'error'); assert.equal(r.run.nodes!.filter(n => n.retryCount > 0).length, 0);
});

test('malformed model protocol is not treated as a temporary network failure', async () => {
  let calls = 0;
  const r = await observed(async () => { calls++; return new ReadableStream({ start(c) { c.enqueue(bytes.encode('data: {bad}\n\n')); c.close(); } }); });
  assert.equal(calls, 1); assert.equal(r.run.status, 'error'); assert.equal(r.run.steps.length, 0);
});

test('graph node budget fails before starting a successor tool', async () => {
  const r = await observed(async () => wire([call('never_run', 'calculator', { expression: '1+1' })]), { maxSteps: 1 });
  assert.equal(r.run.status, 'error'); assert.equal(r.run.nodes!.length, 1); assert.equal(r.run.steps.length, 0); assert.match(r.run.message!, /步数/);
});

test('request timeout aborts a blocked transport and closes active graph nodes', async () => {
  let aborted = false;
  const r = await observed(async (_messages, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })), { requestMs: 30 });
  assert.equal(aborted, true); assert.equal(r.run.status, 'error'); assert.ok(r.run.nodes!.every(n => n.status !== 'running')); assert.match(r.run.message!, /超时/);
});

test('isolated authorized fixtures are parsed and embedded without writing private data', async () => {
  mkdirSync('tmp/rag-tests', { recursive: true }); const root = mkdtempSync(path.resolve('tmp/rag-tests/langgraph-'));
  writer = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
  const prepared = prepareUpload('虚构资料（样本戊）.txt', 'text/plain', Buffer.from(fixture), writer);
  const doc = await indexDocument(prepared.document.id, writer); assert.equal(doc.status, 'ready'); fixtureId = doc.id;
  reader = new KnowledgeStore(path.join(root, 'knowledge.sqlite'), { readOnly: true });
});

test('graph knowledge_search retrieves actual normalized-vector evidence and exact source rows', async () => {
  let requests = 0;
  const r = await observed(async messages => {
    if (!requests++) return wire([call('search_graph', 'knowledge_search', { query: '样本戊提供哪些保险期间可选？' })]);
    assert.equal(JSON.parse(messages.at(-1)!.content).found, true); return wire([], '保障期间以原文为准。');
  }, { store: reader });
  assert.equal(r.run.status, 'success'); const sources = r.events.find(e => e.type === 'sources');
  assert.ok(sources?.type === 'sources'); assert.equal(sources.sources[0].documentId, fixtureId); assert.equal(sources.sources[0].text, fixture);
  assert.ok(r.run.steps[0].sourceChunkIds.includes(sources.sources[0].chunkId));
});

test('graph document analysis retries only the failed call, keeping the real call ID and prior error step', async () => {
  let main = 0, summary = 0;
  const r = await observed(async (_messages, _signal, options) => {
    if (!options?.tools) { if (!summary++) throw new AIError('临时不可用', 503, true); return wire([], '原文仅表明保障期限。'); }
    return !main++ ? wire([call('document_retry', 'document_analyze', { documentIds: [fixtureId], task: 'summary' })]) : wire([], '已获得文档证据。');
  }, { store: reader });
  assert.equal(r.run.status, 'success'); assert.equal(summary, 2); assert.deepEqual(r.run.steps.map(s => s.status), ['error', 'success']);
  assert.deepEqual(r.run.steps.map(s => s.toolCallId), ['document_retry', 'document_retry']); assert.equal(r.run.steps[1].attempt, 1);
  assert.ok(isWorkflowRun(r.run)); assert.deepEqual(restoreHistory(serializeHistory(history(r.run)))[0].messages[0].workflow, JSON.parse(JSON.stringify(r.run)));
});

test('graph critical fact checks still reject unsupported payment-duration claims', async () => {
  let main = 0;
  const r = await observed(async (_messages, _signal, options) => {
    if (!options?.tools) return wire([], '年交23万元、交11年。');
    return !main++ ? wire([call('fact_doc', 'document_analyze', { documentIds: [fixtureId], task: 'summary' })]) : wire([], '年交23万元、交11年。');
  }, { store: reader });
  assert.ok(!r.text.includes('交11年')); assert.match(r.text, /保11年/); assert.match(r.text, /未明确提及/);
});

test('empty knowledge remains no-answer with no fabricated sources', async () => {
  let requests = 0;
  const r = await observed(async messages => {
    if (!requests++) return wire([call('empty_graph', 'knowledge_search', { query: '虚构问题' })]);
    assert.equal(JSON.parse(messages.at(-1)!.content).found, false); return wire([], '当前知识库中没有找到足够的信息。');
  });
  assert.match(r.text, /没有找到足够/); assert.ok(!r.events.some(e => e.type === 'sources'));
});

test('invalid tool parameters and nonexistent tools never execute or retry', async () => {
  for (const [name, args] of [['calculator', { expression: '1+1', shell: 'not executable' }], ['document_analyze', { documentIds: ['../forbidden'], task: 'summary' }], ['read_file', { path: '../forbidden' }]] as const) {
    let requests = 0;
    const r = await observed(async messages => { if (!requests++) return wire([call('invalid_graph', name, args)]); assert.equal(JSON.parse(messages.at(-1)!.content).ok, false); return wire([], '操作已拒绝。'); });
    assert.equal(r.run.steps.length, 0); assert.ok(!r.run.nodes!.some(n => n.retryCount > 0));
  }
});

test('nonrecoverable arithmetic error produces one failed tool without blind retries', async () => {
  let requests = 0;
  const r = await observed(async () => !requests++ ? wire([call('zero_graph', 'calculator', { expression: '1/0' })]) : wire([], '除数不能为零。'));
  assert.equal(r.run.steps.length, 1); assert.equal(r.run.steps[0].status, 'error'); assert.equal(r.run.steps[0].attempt, undefined);
});

test('cancelling inside a real document summary prevents its following tool and restores cancelled nodes', async () => {
  const abort = new AbortController(); let entered!: () => void; const active = new Promise<void>(r => { entered = r; }); let summaryAborted = false;
  const cancel = active.then(() => abort.abort());
  const r = await observed(async (_m, signal, options) => {
    if (options?.tools) return wire([call('cancel_document', 'document_analyze', { documentIds: [fixtureId], task: 'summary' }), call('cancel_successor', 'calculator', { expression: '2+2' })]);
    return new ReadableStream({ start(c) { signal.addEventListener('abort', () => { summaryAborted = true; c.error(signal.reason); }, { once: true }); entered(); } });
  }, { store: reader, signal: abort.signal });
  await cancel; assert.ok(summaryAborted); assert.equal(r.run.status, 'cancelled'); assert.equal(r.run.steps.length, 1); assert.equal(r.run.steps[0].status, 'cancelled');
  assert.ok(!JSON.stringify(r.run).includes('cancel_successor')); assert.ok(r.run.nodes!.every(n => n.status !== 'running'));
  assert.equal(restoreHistory(serializeHistory(history(r.run)))[0].messages[0].workflow!.status, 'cancelled');
});

test('node events are schema checked, redacted, ordered, persisted and compatible with legacy histories', async () => {
  const r = await observed(async () => wire([], '你好。')); const events = r.events.filter((e): e is WorkflowEvent => 'runId' in e);
  let accepted = 0; const receiver = createWorkflowReceiver(() => accepted++);
  receiver.accept(events[1]); receiver.accept(events[0]); receiver.accept(events[1]); for (const e of events.slice(2)) receiver.accept(e); receiver.finish(); assert.equal(accepted, events.length);
  const started = events.find(e => e.type === 'node_started')!;
  assert.ok(!workflowEventSchema.safeParse({ ...started, messages: ['private input'] }).success);
  assert.ok(!workflowEventSchema.safeParse({ ...started, node: { ...('node' in started ? started.node : {}), summary: 'Bearer private-value' } }).success);
  const serialized = serializeHistory(history(r.run)); assert.ok(!serialized.includes('请完成本次虚构测试任务')); assert.ok(!serialized.includes('system')); assert.equal(restoreHistory(serialized)[0].messages[0].workflow!.nodes!.length, 4);
  assert.equal(restoreHistory(JSON.stringify(history()))[0].messages[0].content, '回答');
  let output = ''; const stream = new ReadableStream<Uint8Array>({ start(c) { for (const e of r.events) c.enqueue(bytes.encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } });
  await readChatReply(stream, text => { output += text; }); assert.equal(output, '你好。');
});

test('text deltas reach the consumer before the model turn and graph have completed', async () => {
  let finish!: () => void, saw = false;
  const model: ModelTransport = async () => new ReadableStream({ start(c) {
    c.enqueue(bytes.encode('data: {"choices":[{"delta":{"content":"你好。这是一段用于检验实时输出的虚构长句，长度超过引用语法缓冲窗口。"}}]}\n\n'));
    finish = () => { c.enqueue(bytes.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); c.close(); };
  } });
  for await (const e of runAgent([{ role: 'user', content: '你好' }], { store: null, signal: new AbortController().signal, requestModel: model, graphEvents: true })) if (e.type === 'delta' && !saw) { saw = true; finish(); }
  assert.ok(saw);
});

test('separate concurrent graph requests do not share plans, messages or run identities', async () => {
  const [a, b] = await Promise.all([observed(async () => wire([], '任务甲。')), observed(async () => wire([], '任务乙。'))]);
  assert.notEqual(a.run.runId, b.run.runId); assert.equal(a.text, '任务甲。'); assert.equal(b.text, '任务乙。');
  assert.notEqual(a.run.nodes![0].nodeId, b.run.nodes![0].nodeId);
});

test('remote tracing configuration is refused before sending private state or model requests', async () => {
  const previous = process.env.LANGSMITH_TRACING; let requests = 0;
  try { process.env.LANGSMITH_TRACING = 'true'; const r = await observed(async () => { requests++; return wire([], 'unused'); }); assert.equal(r.run.status, 'error'); assert.match(r.run.message!, /远程追踪/); assert.equal(requests, 0); }
  finally { if (previous === undefined) delete process.env.LANGSMITH_TRACING; else process.env.LANGSMITH_TRACING = previous; }
});


test('the same nonrecoverable call cannot be blindly replayed under another model call ID', async () => {
  let requests = 0;
  const r = await observed(async () => ++requests <= 2 ? wire([call(`blocked_${requests}`, 'calculator', { expression: '1/0' })]) : wire([], '请修改表达式。'));
  assert.equal(r.run.steps.length, 1); assert.equal(r.run.steps[0].status, 'error'); assert.equal(r.run.status, 'success');
});


test('an interrupted model body before any visible text is retried with a sanitized error', async () => {
  let requests = 0;
  const r = await observed(async () => ++requests === 1 ? new ReadableStream({ start(c) { c.error(new TypeError('private upstream detail')); } }) : wire([], '连接恢复。'));
  assert.equal(requests, 2); assert.equal(r.run.status, 'success'); assert.ok(!JSON.stringify(r.events).includes('private upstream detail'));
});

test('a body interrupted after visible text is not retried or duplicated', async () => {
  let requests = 0, fail!: () => void;
  const events: AgentEvent[] = []; const signal = new AbortController().signal;
  const model: ModelTransport = async () => { requests++; return new ReadableStream({ start(c) { c.enqueue(bytes.encode('data: {"choices":[{"delta":{"content":"你好。这是一段足够长的虚构文字，确保先显示有效片段后才人为中断连接。"}}]}\n\n')); fail = () => c.error(new TypeError('private network detail')); } }); };
  let failed = false;
  for await (const e of observeRun(runAgent([{ role: 'user', content: '测试断流' }], { store: null, signal, requestModel: model, graphEvents: true }), signal)) { events.push(e); if (e.type === 'delta' && !failed) { failed = true; fail(); } }
  assert.ok(failed); assert.equal(requests, 1); assert.ok(events.some(e => e.type === 'run_failed')); assert.ok(!events.some(e => e.type === 'done'));
});
