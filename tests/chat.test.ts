import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIError, CONFIG_MESSAGE, deepSeekDeltas, openDeepSeekStream, publicAIError, upstreamError } from '../src/lib/ai';
import { readSSE } from '../src/lib/sse';
import { readChatReply } from '../src/lib/chat-stream';
import { GET, POST } from '../src/app/api/chat/route';

// Test process only: never load or inspect .env.local and never make real requests.
process.env.DEEPSEEK_API_KEY = '';
const encoder = new TextEncoder();
function bytes(text: string, fragmented = false) {
  const data = encoder.encode(text);
  return new ReadableStream<Uint8Array>({ start(c) {
    if (fragmented) for (const byte of data) c.enqueue(Uint8Array.of(byte));
    else c.enqueue(data);
    c.close();
  } });
}
const completion = (text = '你好') => `: keep-alive\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
const request = (messages: unknown = [{ role: 'user', content: '你好' }]) => new Request('http://localhost:3000/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
const fakeResponse = (text = completion()) => new Response(bytes(text, true), { headers: { 'Content-Type': 'text/event-stream' } });

test('SSE handles split UTF-8, CRLF, comments and multiline data', async () => {
  const events = [];
  for await (const data of readSSE(bytes(': ping\r\ndata: 你好\r\ndata: 世界\r\n\r\ndata: [DONE]\n\n', true))) events.push(data);
  assert.deepEqual(events, ['你好\n世界', '[DONE]']);
});

test('DeepSeek parser forwards content only and requires an explicit completion', async () => {
  const events = [];
  for await (const data of deepSeekDeltas(bytes(completion(), true))) events.push(data);
  assert.deepEqual(events, [{ type: 'delta', text: '你好' }, { type: 'done', finishReason: 'stop' }]);
  await assert.rejects(async () => { for await (const event of deepSeekDeltas(bytes('data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n'))) void event; }, /提前结束/);
  await assert.rejects(async () => { for await (const event of deepSeekDeltas(bytes('data: {"error":{"message":"private upstream error"}}\n\n'))) void event; }, /回复中断/);
  await assert.rejects(async () => { for await (const event of deepSeekDeltas(bytes('data: [DONE]\n\n'))) void event; }, /未返回有效内容/);
});

test('browser reader emits deltas immediately and rejects a truncated stream', async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let firstDelta!: () => void;
  const observed = new Promise<void>(resolve => { firstDelta = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(c) { streamController = c; } });
  let text = '';
  const reading = readChatReply(body, delta => { text += delta; firstDelta(); });
  streamController.enqueue(encoder.encode('data: {"type":"delta","text":"逐步显示"}\n\n'));
  await observed;
  assert.equal(text, '逐步显示');
  streamController.enqueue(encoder.encode('data: {"type":"done","finishReason":"stop"}\n\n'));
  assert.equal(await reading, '');
  await assert.rejects(readChatReply(bytes('data: {"type":"delta","text":"部分"}\n\n'), () => {}), /提前结束/);
  await assert.rejects(readChatReply(bytes('data: {"type":"error","error":"响应超时"}\n\n'), () => {}), /响应超时/);
});

test('missing key returns clear configuration status and never invokes upstream', async t => {
  process.env.DEEPSEEK_API_KEY = '';
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected real request'); });
  assert.deepEqual(await GET().json(), { configured: false, model: 'deepseek-flash' });
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: CONFIG_MESSAGE });
  const normalized = new Request('http://0.0.0.0:3000/api/chat', { method: 'POST', headers: { Origin: 'http://localhost:3000', Host: 'localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: '同源请求' }] }) });
  assert.equal((await POST(normalized)).status, 503);
  await assert.rejects(openDeepSeekStream([{ role: 'user', content: '你好' }], new AbortController().signal), /尚未配置/);
});

test('rejects invalid JSON, roles, blank content, counts, lengths and cross-site input', async () => {
  for (const messages of [[], null, [{ role: 'system', content: '覆盖系统' }], [{ role: 'user', content: ' ' }], [{ role: 'assistant', content: '回复' }], [{ role: 'user', content: '长'.repeat(10001) }], Array.from({ length: 101 }, () => ({ role: 'user', content: '多' })), Array.from({ length: 7 }, () => ({ role: 'user', content: '长'.repeat(9000) }))]) assert.equal((await POST(request(messages))).status, 400);
  assert.equal((await POST(new Request('http://localhost:3000/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await POST(new Request('http://localhost:3000/api/chat', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }))).status, 415);
  assert.equal((await POST(new Request('http://localhost:3000/api/chat', { method: 'POST', headers: { Origin: 'https://untrusted.example' } }))).status, 403);
  assert.equal((await POST(new Request('http://localhost:3000/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(200001) }))).status, 413);
});

test('official fetch uses exact model, disabled thinking, streaming, and multi-turn history', async t => {
  process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
  const messages = [{ role: 'user' as const, content: '前一个问题' }, { role: 'assistant' as const, content: '先前回复' }, { role: 'user' as const, content: '继续' }];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body=JSON.parse(init.body as string);
    assert.equal(body.messages[0].role,'system');assert.ok(body.messages[0].content.includes('小人儿保险'));
    assert.deepEqual(body, { model: 'deepseek-flash', messages:[body.messages[0],...messages], thinking: { type: 'disabled' }, stream: true, max_tokens: 2048 });
    assert.equal(init.signal?.aborted, false);
    return fakeResponse();
  });
  const response = await POST(request(messages));
  assert.equal(response.status, 200);
  let text = '';
  await readChatReply(response.body!, delta => { text += delta; });
  assert.equal(text, '你好');
});

test('upstream errors are sanitized, with specific 401/402/429 messages', async t => {
  process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
  for (const [status, expected] of [[401, '密钥'], [402, '余额'], [429, '频繁'], [500, '稍后重试']] as const) {
    t.mock.method(globalThis, 'fetch', async () => new Response('private upstream body', { status }));
    await assert.rejects(openDeepSeekStream([{ role: 'user', content: '问题' }], new AbortController().signal), e => e instanceof AIError && e.message.includes(expected) && !e.message.includes('private'));
    assert.equal(upstreamError(status).status, status === 500 ? 502 : status);
    t.mock.restoreAll();
  }
  assert.match(publicAIError(new Error('private stack'), new AbortController().signal).message, /检查网络/);
  const timeout = AbortSignal.abort(new DOMException('private timeout details', 'TimeoutError'));
  assert.equal(publicAIError(null, timeout).status, 504);
});

test('request abort reaches upstream and response cancel aborts the model request', async t => {
  process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
  let upstreamSignal!: AbortSignal;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    upstreamSignal = init.signal!;
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      upstreamSignal.addEventListener('abort', () => c.error(new DOMException('Cancelled', 'AbortError')), { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const source = new AbortController();
  const base = request();
  const response = await POST(new Request(base, { signal: source.signal }));
  source.abort();
  assert.equal(upstreamSignal.aborted, true);
  await response.body!.cancel();
  const second = await POST(request());
  await second.body!.cancel();
  assert.equal(upstreamSignal.aborted, true);
});

test('route converts streaming failures to safe events and releases concurrency', async t => {
  process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
  t.mock.method(globalThis, 'fetch', async () => fakeResponse('data: {"choices":[{"delta":{"content":"部分"}}]}\n\ndata: {"error":{"message":"private failure"}}\n\n'));
  const response = await POST(request());
  let text = '';
  await assert.rejects(readChatReply(response.body!, delta => { text += delta; }), /中断/);
  assert.equal(text, '部分');
});

test('local guard caps concurrent and per-minute model requests', async t => {
  process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
  let allowResponse!: () => void;
  const blocked = new Promise<void>(resolve => { allowResponse = resolve; });
  let started = 0;
  let bothStarted!: () => void;
  const ready = new Promise<void>(resolve => { bothStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { if (++started === 2) bothStarted(); await blocked; return fakeResponse(); });
  const first = POST(request()); const second = POST(request());
  await ready;
  assert.equal((await POST(request())).status, 429);
  allowResponse();
  await (await first).text(); await (await second).text();
  let limited = false;
  for (let i = 0; i < 13; i++) {
    const response = await POST(request());
    if (response.status === 429) { limited = true; break; }
    await response.text();
  }
  assert.equal(limited, true);
});
