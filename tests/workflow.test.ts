import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { observeRun } from '../src/lib/agent/observe';
import { runAgent } from '../src/lib/agent/orchestrator';
import { applyWorkflowEvent, createWorkflowReceiver, finishWorkflow, isWorkflowRun, isWorkflowEventType, redactSummary, workflowEventSchema, MAX_WORKFLOW_EVENTS, type WorkflowEvent, type WorkflowRun } from '../src/lib/agent/workflow';
import { restoreHistory, serializeHistory, MAX_HISTORY_CHARS } from '../src/lib/chat-history';
import { readChatReply } from '../src/lib/chat-stream';
import type { AgentEvent } from '../src/lib/agent/types';
import type { Conversation } from '../src/lib/chat';
import { GET as sourceGET } from '../src/app/api/knowledge/sources/route';

// No .env loading or real model requests. These are actual calculator/runtime events.
const encode = new TextEncoder();
function modelWire(calls = false, failure = false) {
  return new ReadableStream<Uint8Array>({ start(c) {
    const delta = calls ? { tool_calls: [{ index: 0, id: 'real_call_1', type: 'function', function: { name: 'calculator', arguments: JSON.stringify({ expression: failure ? '1/0' : '50*299*0.85' }) } }] } : { content: '计算已完成。' };
    c.enqueue(encode.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)); c.close();
  } });
}
async function recorded(failure = false, noTools = false) {
  let calls = 0;
  const abort = new AbortController();
  const events: AgentEvent[] = [];
  for await (const event of observeRun(runAgent([{ role: 'user', content: '计算' }], { signal: abort.signal, store: null, requestModel: async () => modelWire(!noTools && calls++ === 0, failure) }), abort.signal)) events.push(event);
  return events;
}
function trace(events: AgentEvent[]) { return events.filter((e): e is WorkflowEvent => isWorkflowEventType(e.type)); }
function reduce(events: WorkflowEvent[]) { let run: WorkflowRun | undefined; events.forEach(e => { run = applyWorkflowEvent(run, e); }); return run!; }
function stream(events: unknown[]) { return new ReadableStream<Uint8Array>({ start(c) { events.forEach(e => c.enqueue(encode.encode(`data: ${JSON.stringify(e)}\n\n`))); c.close(); } }); }
function history(run?: WorkflowRun): Conversation[] { return [{ id: randomUUID(), title: '计算测试', updatedAt: Date.now(), mode: 'agent', messages: [{ id: randomUUID(), role: 'assistant', mode: 'agent', content: '结果', workflow: run }] }]; }

test('V5 observes real calculator execution with unique run/step IDs and exact tool_call_id', async () => {
  const events = trace(await recorded()); const run = reduce(events);
  assert.deepEqual(events.map(e => e.type), ['run_started', 'tool_pending', 'tool_started', 'tool_completed', 'run_completed']);
  assert.equal(run.status, 'success'); assert.equal(run.steps[0].status, 'success');
  assert.equal(run.steps[0].toolCallId, 'real_call_1'); assert.notEqual(run.steps[0].stepId, run.steps[0].toolCallId);
  assert.match(run.steps[0].outputSummary!, /12707.5/);
  assert.equal(run.elapsedMs, run.endedAt! - run.startedAt);
  assert.equal(run.steps[0].elapsedMs, run.steps[0].endedAt! - run.steps[0].startedAt!);
  assert.notEqual(reduce(trace(await recorded())).runId, run.runId);
  assert.ok(isWorkflowRun(run));
});
test('tool failures are actual error nodes even when the model explains them successfully', async () => {
  const run = reduce(trace(await recorded(true)));
  assert.equal(run.steps[0].status, 'error'); assert.match(run.steps[0].outputSummary!, /除数/);
  assert.equal(run.status, 'success'); // generation completed, not a claim every tool succeeded
});
test('no-tool answers contain no fictitious steps', async () => {
  const events = await recorded(false, true), run = reduce(trace(events));
  assert.equal(run.steps.length, 0); assert.equal(run.events.length, 2);
  assert.ok(events.some(e => e.type === 'delta'));
});
test('API failures emit a safe terminal run_failed without leaking exceptions', async () => {
  const abort = new AbortController(); const events: AgentEvent[] = [];
  async function* broken(): AsyncGenerator<AgentEvent> { yield { type: 'status', phase: 'thinking' }; throw new Error('secret stack/internal system prompt'); }
  for await (const e of observeRun(broken(), abort.signal)) events.push(e);
  assert.equal(reduce(trace(events)).status, 'error');
  assert.ok(!JSON.stringify(events).includes('secret stack'));
});
test('user cancellation ends active steps as cancelled and stops further tools', async () => {
  const abort = new AbortController(); let modelCalls = 0; const events: AgentEvent[] = [];
  for await (const event of observeRun(runAgent([{ role: 'user', content: '计算' }], { store: null, signal: abort.signal, requestModel: async () => { modelCalls++; return modelWire(true); } }), abort.signal)) {
    events.push(event); if (event.type === 'tool_started') abort.abort();
  }
  const run = reduce(trace(events)); assert.equal(run.status, 'cancelled'); assert.equal(run.steps[0].status, 'cancelled'); assert.equal(modelCalls, 1);
});
test('task timeout is error, not successful or user cancellation', async () => {
  const abort = new AbortController(); const events: AgentEvent[] = [];
  async function* timeout(): AsyncGenerator<AgentEvent> { abort.abort(new DOMException('private timeout', 'TimeoutError')); abort.signal.throwIfAborted(); }
  for await (const e of observeRun(timeout(), abort.signal)) events.push(e);
  const run = reduce(trace(events)); assert.equal(run.status, 'error'); assert.match(run.message!, /超时/);
});
test('bounded receiver reorders events, ignores exact duplicates and requires terminal confirmation', async () => {
  const events = trace(await recorded()); const accepted: WorkflowEvent[] = [];
  const receiver = createWorkflowReceiver(e => accepted.push(e));
  [events[3], events[0], events[2], events[0], events[1], events[4], events[3]].forEach(e => receiver.accept(e));
  receiver.finish(); assert.deepEqual(accepted, events);
  const partial = createWorkflowReceiver(() => {}); partial.accept(events[0]); partial.accept(events[2]);
  assert.throws(() => partial.finish(), /不完整/);
});
test('conflicting duplicate, run identity and event count violations fail closed', async () => {
  const events = trace(await recorded()); const receiver = createWorkflowReceiver(() => {});
  receiver.accept(events[0]); assert.throws(() => receiver.accept({ ...events[0], eventId: randomUUID() }), /冲突/);
  const different = createWorkflowReceiver(() => {}); different.accept(events[0]); assert.throws(() => different.accept({ ...events[1], runId: randomUUID() }), /运行编号/);
  const flood = createWorkflowReceiver(() => {}); for (let i = 0; i < MAX_WORKFLOW_EVENTS * 2; i++) flood.accept(events[0]);
  assert.throws(() => flood.accept(events[0]), /数量/);
});
test('strict schemas reject extra fields, overlong summaries, bad IDs, unsafe content and impossible time', async () => {
  const events = trace(await recorded()); const started = events.find(e => e.type === 'tool_started')!;
  assert.ok('step' in started); if (!('step' in started)) return;
  for (const input of [{ ...started, env: 'private' }, { ...started, runId: '../secret' }, { ...started, step: { ...started.step, inputSummary: 'x'.repeat(601) } }, { ...started, step: { ...started.step, inputSummary: 'DEEPSEEK_API_KEY=secret-value' } }, { ...started, step: { ...started.step, endedAt: 1 } }]) assert.equal(workflowEventSchema.safeParse(input).success, false);
  assert.throws(() => reduce([events[0], { ...events[2], sequence: 2 }]), /关联/);
});
test('client parser separates workflow from text and rejects malformed, gapped or truncated streams', async () => {
  const events = await recorded(); let text = '', received = 0;
  await readChatReply(stream(events), delta => { text += delta; }, undefined, event => { if ('runId' in event) received++; });
  assert.equal(received, 5); assert.equal(text, '计算已完成。');
  await assert.rejects(readChatReply(stream([{ type: 'run_started', runId: 'invalid' }]), () => {}), /工作流事件无效/);
  await assert.rejects(readChatReply(stream(trace(events).slice(0, 3)), () => {}), /提前结束/);
  await assert.rejects(readChatReply(stream([trace(events)[0], trace(events)[2], { type: 'done' }]), () => {}), /不完整/);
});
test('workflow updates are delivered while the response is still open, before final answer completion', async () => {
  const events = trace(await recorded()); let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  let acknowledge!: () => void, run: WorkflowRun | undefined, finished = false;
  const running = new Promise<void>(resolve => { acknowledge = resolve; });
  const reading = readChatReply(body, () => {}, undefined, event => {
    if ('runId' in event) { run = applyWorkflowEvent(run, event); if (event.type === 'tool_started') acknowledge(); }
  }).then(() => { finished = true; });
  const send = (value: unknown) => controller.enqueue(encode.encode(`data: ${JSON.stringify(value)}\n\n`));
  events.slice(0, 3).forEach(send); await running;
  assert.equal(run!.steps[0].status, 'running'); assert.equal(finished, false);
  events.slice(3).forEach(send); send({ type: 'done', finishReason: 'stop' }); controller!.close(); await reading;
  assert.equal(run!.status, 'success');
});
test('overlapping parallel event intervals retain separate nodes without invented serial dependencies', () => {
  const runId = randomUUID(), one = randomUUID(), two = randomUUID(); let sequence = 0;
  const make = (type: string, at: number, extra: object): WorkflowEvent => workflowEventSchema.parse({ version: 1, runId, eventId: randomUUID(), sequence: ++sequence, type, at, ...extra });
  const a = { stepId: one, toolCallId: 'a', name: 'calculator' as const, status: 'pending' as const, queuedAt: 1001, inputSummary: '1+1', dependsOn: [], sourceChunkIds: [] };
  const b = { ...a, stepId: two, toolCallId: 'b', queuedAt: 1003 };
  const ar = { ...a, status: 'running', startedAt: 1002 }, br = { ...b, status: 'running', startedAt: 1004 };
  const events = [make('run_started', 1000, { execution: 'parallel' }), make('tool_pending', 1001, { step: a }), make('tool_started', 1002, { step: ar }), make('tool_pending', 1003, { step: b }), make('tool_started', 1004, { step: br }), make('tool_completed', 1008, { step: { ...br, status: 'success', endedAt: 1008, elapsedMs: 4 } }), make('tool_completed', 1010, { step: { ...ar, status: 'success', endedAt: 1010, elapsedMs: 8 } }), make('run_completed', 1011, { elapsedMs: 11 })];
  const run = reduce(events); assert.equal(run.steps.length, 2); assert.ok(run.steps.every(s => s.dependsOn.length === 0)); assert.ok(run.steps[1].startedAt! < run.steps[0].endedAt!); assert.ok(isWorkflowRun(run));
  assert.throws(() => reduce([{ ...events[0], execution: 'serial' } as WorkflowEvent, ...events.slice(1)]), /串行任务出现并行/);
});
test('disconnect locally ends unfinished nodes without rewriting successful tools', async () => {
  const events = trace(await recorded());
  const active = reduce(events.slice(0, 3)); const cancelled = finishWorkflow(active, 'cancelled', '用户停止');
  assert.equal(cancelled.steps[0].status, 'cancelled'); assert.equal(cancelled.endOrigin, 'client'); assert.ok(isWorkflowRun(cancelled));
  const toolFinished = reduce(events.slice(0, 4)), failed = finishWorkflow(toolFinished, 'error', '连接中断');
  assert.equal(failed.steps[0].status, 'success'); assert.equal(failed.status, 'error'); assert.ok(isWorkflowRun(failed));
});
test('refresh restores completed workflow and remains compatible with V3/V4 histories', async () => {
  const run = reduce(trace(await recorded())), restored = restoreHistory(serializeHistory(history(run)));
  assert.deepEqual(restored[0].messages[0].workflow, JSON.parse(JSON.stringify(run)));
  const legacy = history(); legacy[0].messages[0].tools = [{ id: 'legacy', name: 'calculator', status: 'completed', startedAt: Date.now(), inputSummary: '1+1', outputSummary: '2' }];
  assert.equal(restoreHistory(JSON.stringify(legacy))[0].messages[0].tools?.[0].status, 'completed');
  legacy[0].messages[0].tools[0].status = 'running';
  assert.equal(restoreHistory(JSON.stringify(legacy))[0].messages[0].tools?.[0].status, 'interrupted');
  for (const mode of ['chat', 'knowledge'] as const) {
    const old = history(); old[0].mode = mode; old[0].messages[0].mode = mode;
    assert.equal(restoreHistory(JSON.stringify(old))[0].mode, mode);
  }
  const active = history(reduce(trace(await recorded()).slice(0, 3)));
  const reload = restoreHistory(JSON.stringify(active))[0].messages[0].workflow!;
  assert.equal(reload.status, 'cancelled'); assert.equal(reload.steps[0].status, 'cancelled');
});
test('damaged optional workflow does not discard old chat content', () => {
  const item = history(); (item[0].messages[0] as unknown as { workflow: unknown }).workflow = { runId: 'broken' };
  const restored = restoreHistory(JSON.stringify(item)); assert.equal(restored[0].messages[0].content, '结果'); assert.equal(restored[0].messages[0].workflow, undefined);
});
test('history omits source bodies and legacy private tool outputs and enforces size without mutating input', () => {
  const item = history(); const privateBody = '不应保存的私有原文';
  item[0].messages[0].sources = [{ number: 1, documentId: randomUUID(), chunkId: randomUUID(), fileName: '测试.md', score: 0.9, text: privateBody }];
  item[0].messages[0].tools = [{ id: 'old', name: 'document_analyze', status: 'completed', startedAt: Date.now(), inputSummary: '参数', outputSummary: privateBody }];
  const serialized = serializeHistory(item); assert.ok(!serialized.includes(privateBody));
  assert.equal(item[0].messages[0].sources[0].text, privateBody);
  assert.equal(restoreHistory(serialized)[0].messages[0].sources![0].text, '');
  item[0].messages[0].content = '字'.repeat(MAX_HISTORY_CHARS);
  assert.throws(() => serializeHistory(item), /上限/); assert.throws(() => restoreHistory(' '.repeat(MAX_HISTORY_CHARS + 1)), /体积/);
});
test('redaction covers tokens, authorization, assignments and personal identifiers', () => {
  const token = 'sk-' + 'q'.repeat(24), input = `${token} Bearer private-value DEEPSEEK_API_KEY=private-value demo@example.com 13812345678`;
  const safe = redactSummary(input);
  for (const secret of [token, 'private-value', 'demo@example.com', '13812345678']) assert.ok(!safe.includes(secret));
  for (const text of ['{"api_key":"private-value"}', 'Bearer "private-value"', JSON.stringify({ query: '{"DEEPSEEK_API_KEY":"private-value"}' })]) assert.ok(!redactSummary(text).includes('private-value'));
  assert.equal(redactSummary(safe), safe); assert.equal(redactSummary('x'.repeat(900)).length, 600);
});
test('source endpoint rejects traversal and external hosts without accessing file paths', async () => {
  assert.equal((await sourceGET(new Request('https://public.example/api/knowledge/sources'))).status, 403);
  assert.equal((await sourceGET(new Request('http://localhost/api/knowledge/sources?documentId=../../.env.local&chunkId=x'))).status, 400);
  assert.equal((await sourceGET(new Request(`http://localhost/api/knowledge/sources?documentId=${randomUUID()}&chunkId=${randomUUID()}&path=secret`))).status, 400);
});
test('timeline markup is accessible, escaped, has no invented steps and does not connect overlapping tools', async () => {
  const run = reduce(trace(await recorded())); run.steps[0].inputSummary = '<script>unsafe()</script>';
  run.steps[0].endedAt = run.steps[0].startedAt! + 1000; run.steps[0].elapsedMs = 1000;
  const peer = { ...run.steps[0], stepId: randomUUID(), toolCallId: 'parallel_2' }; run.steps.push(peer); run.execution = 'parallel';
  const script = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {WorkflowPanel} from './src/components/workflow-panel.tsx'; const run=JSON.parse(process.env.MOYU_TEST_TRACE); console.log(renderToStaticMarkup(React.createElement(WorkflowPanel,{run,scope:'test'})));`;
  const html = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, MOYU_TEST_TRACE: JSON.stringify(run) } });
  assert.match(html, /Agent 工作流/); assert.match(html, /aria-expanded="true"/); assert.match(html, /实际执行时间重叠/);
  assert.ok(!html.includes('has-successor')); assert.ok(!html.includes('<script>unsafe')); assert.ok(html.includes('&lt;script&gt;'));
  for (const state of ['pending', 'running', 'error', 'cancelled'] as const) { const r = { ...run, status: state }; const marked = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, MOYU_TEST_TRACE: JSON.stringify(r) } }); assert.match(marked, new RegExp(`workflow-panel ${state}`)); }
});
