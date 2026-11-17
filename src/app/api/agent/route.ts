import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CONFIG_MESSAGE, isAIConfigured } from '@/lib/ai';
import { boundedBody, localOnly } from '@/lib/rag/http';
import { RagError } from '@/lib/rag/config';
import { openAgentStore } from '@/lib/agent/knowledge';
import { runAgent } from '@/lib/agent/orchestrator';
import { observeRun } from '@/lib/agent/observe';
import { AGENT_LIMITS, agentFailure } from '@/lib/agent/limits';

export const runtime = 'nodejs';
export const maxDuration = 130;
const schema = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(20000) }).strict().refine(m => m.role !== 'user' || m.content.length <= 10000)).min(1).max(AGENT_LIMITS.historyMessages), mode: z.literal('agent').optional() }).strict();
const globalState = globalThis as typeof globalThis & { __moyuAgentQuota?: { active: number; count: number; time: number } };
const quota = globalState.__moyuAgentQuota ??= { active: 0, count: 0, time: 0 };
function errorResponse(message: string, status: number) { return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', ...(message === CONFIG_MESSAGE ? { 'X-Moyu-Key-Required': '1' } : {}) } }); }

export async function POST(request: Request) {
  let input;
  try {
    localOnly(request);
    if (!request.headers.get('content-type')?.includes('application/json')) return errorResponse('Agent 请求必须使用 JSON。', 415);
    const bytes = await boundedBody(request, AGENT_LIMITS.inputBytes);
    const result = schema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!result.success) return errorResponse('Agent 消息格式不正确：最多 24 条，每条最多 10000 字符，且只允许用户/助手文本。', 400);
    input = result.data;
    if (input.messages.at(-1)?.role !== 'user' || input.messages.reduce((sum, m) => sum + m.content.length, 0) > AGENT_LIMITS.historyChars) return errorResponse('最后一条必须为用户问题，Agent 历史总长度不能超过 24000 字符。', 400);
  } catch (e) { return errorResponse(e instanceof RagError ? e.message : 'Agent 请求内容不正确。', e instanceof RagError ? e.status : 400); }
  if (!isAIConfigured()) return errorResponse(CONFIG_MESSAGE, 503);
  if (Date.now() - quota.time >= 60000) { quota.time = Date.now(); quota.count = 0; }
  if (quota.active >= 1 || quota.count >= 6) return errorResponse('Agent 同时最多运行 1 个任务，每分钟最多 6 个任务，请稍后再试。', 429);
  quota.active++; quota.count++;
  let released = false;
  const release = () => { if (!released) { released = true; quota.active--; } };
  let store;
  try { store = openAgentStore(); }
  catch { release(); return errorResponse('无法以只读方式打开知识库，请先检查本地知识库状态。', 500); }
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(AGENT_LIMITS.requestMs)]);
  const runId = randomUUID();
  const iterator = observeRun(runAgent(input.messages, { store, signal, runId, graphEvents: true }), signal, runId);
  const encoder = new TextEncoder();
  let cancelled = false, closed = false;
  const cleanup = () => { if (!closed) { closed = true; store?.close(); release(); } };
  signal.addEventListener('abort', cleanup, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) { controller.close(); cleanup(); abort.abort(); return; }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
        if (next.value.type === 'done' || next.value.type === 'error') { controller.close(); await iterator.return(undefined); cleanup(); abort.abort(); }
      } catch (e) {
        if (cancelled) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: agentFailure(e, signal) })}\n\n`));
        controller.close(); cleanup(); abort.abort();
      }
    },
    async cancel() { cancelled = true; abort.abort(); try { await iterator.return(undefined); } finally { cleanup(); } },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no' } });
}
