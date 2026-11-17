import { NextResponse } from 'next/server';
import { AIError, CONFIG_MESSAGE, MODEL, deepSeekDeltas, isAIConfigured, openDeepSeekStream, publicAIError, type AIMessage } from '@/lib/ai';
import type { Message } from '@/lib/chat';
import type { Source } from '@/lib/rag/types';
import { withoutInlineCitations } from '@/lib/rag/citations';
import { qualityDeltas } from '@/lib/rag/business-evidence';
import { runtimeRequestReason } from '@/lib/rag/deployment';

export const runtime = 'nodejs';
export const maxDuration = 70;
const MAX_BODY = 200000;
// Local, process-wide guard; public hosting needs authenticated distributed limits.
const quota = { since: 0, count: 0, active: 0 };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', ...(status === 503 && message === CONFIG_MESSAGE ? { 'X-Moyu-Key-Required': '1' } : {}) } });
}

async function parseMessages(request: Request): Promise<{ messages: Pick<Message, 'role' | 'content'>[]; knowledge: boolean }> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new AIError('请使用 JSON 格式发送消息。', 415);
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new AIError('请求过大，请缩短对话后重试。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AIError('消息不能为空。', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new AIError('请求过大，请缩短对话后重试。', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AIError('请求 JSON 格式不正确。', 400); }
  const messages: unknown = body?.messages;
  if (body?.mode !== undefined && body.mode !== 'chat' && body.mode !== 'knowledge') throw new AIError('聊天模式不正确。', 400);
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) throw new AIError('每次请求需要 1–100 条历史消息，请新建对话或缩短上下文。', 400);
  let total = 0;
  const cleaned = messages.map(m => {
    if (!m || typeof m !== 'object' || !('role' in m) || !('content' in m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > (m.role === 'user' ? 10000 : 20000)) throw new AIError('消息仅支持 user/assistant 角色，用户消息限 10000 字符，助手消息限 20000 字符且不能为空。', 400);
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > 60000) throw new AIError('对话上下文超过 60000 字符，请新建对话或缩短消息。', 400);
  if (cleaned.at(-1)?.role !== 'user') throw new AIError('最后一条消息必须是用户问题。', 400);
  return { messages: cleaned, knowledge: body?.mode === 'knowledge' };
}

export function GET() {
  return NextResponse.json({ configured: isAIConfigured(), model: MODEL }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const maintenanceReason=runtimeRequestReason(request);if(maintenanceReason)return jsonError(maintenanceReason,503);
  const origin = request.headers.get('origin');
  // Next dev may normalize request.url to 0.0.0.0; Host retains the browser's host.
  let sameOrigin = !origin;
  if (origin) {
    try {
      const url = new URL(origin);
      sameOrigin = ['http:', 'https:'].includes(url.protocol) && url.host === (request.headers.get('host') || new URL(request.url).host);
    } catch { sameOrigin = false; }
  }
  if (!sameOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return jsonError('不允许跨站调用聊天接口。', 403);
  let parsed;
  try { parsed = await parseMessages(request); }
  catch (e) { return jsonError(e instanceof AIError ? e.message : '读取消息失败，请重试。', e instanceof AIError ? e.status : 400); }
  const { messages, knowledge } = parsed;
  let modelMessages: AIMessage[] = messages;
  let sources: Source[] | undefined;
  if (knowledge) {
    let release: (() => void) | undefined;
    try {
      const { localOnly, querySlot } = await import('@/lib/rag/http');
      const { retrieve } = await import('@/lib/rag/service');
      const { ragQuery, ragMessages, NO_EVIDENCE } = await import('@/lib/rag/prompt');
      localOnly(request); release = querySlot();
      sources = await retrieve(ragQuery(messages), undefined, undefined, request.signal);
      if (!sources.length) {
        const events = [{ type: 'sources', sources: [] }, { type: 'delta', text: NO_EVIDENCE }, { type: 'done', finishReason: 'stop' }];
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Moyu-Provider': 'local-policy', 'X-Moyu-Evidence-Count':'0' } });
      }
      modelMessages = ragMessages(messages, sources);
    } catch (e) {
      const { RagError } = await import('@/lib/rag/config');
      return jsonError(e instanceof RagError ? e.message : '知识库检索失败或已取消，请重试。', e instanceof RagError ? e.status : 502);
    } finally { release?.(); }
  }
  if (!isAIConfigured()) return jsonError(CONFIG_MESSAGE, 503);
  if (Date.now() - quota.since >= 60000) { quota.since = Date.now(); quota.count = 0; }
  if (quota.count >= 12 || quota.active >= 2) return jsonError('本地请求次数或并发数已达上限，请稍后再试（每分钟最多 12 次，同时最多 2 次）。', 429);
  quota.count++; quota.active++;
  let released = false;
  const release = () => { if (!released) { released = true; quota.active--; } };
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(60000)]);
  signal.addEventListener('abort', release, { once: true });
  let upstream;
  try { upstream = await openDeepSeekStream(modelMessages, signal); }
  catch (e) { const safe = publicAIError(e, signal); release(); abort.abort(); return jsonError(safe.message, safe.status); }
  const encoder = new TextEncoder();
  const iterator = knowledge ? qualityDeltas(withoutInlineCitations(deepSeekDeltas(upstream)), () => sources ?? [], false, true) : deepSeekDeltas(upstream);
  let cancelled = false;
  let sourcesSent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (sources && !sourcesSent) { sourcesSent = true; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`)); return; }
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) { release(); abort.abort(); controller.close(); return; }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
        if (next.value.type === 'done') { release(); abort.abort(); controller.close(); await iterator.return(undefined); }
      } catch (e) {
        if (cancelled) return;
        const safe = publicAIError(e, signal);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: safe.message })}\n\n`));
        controller.close(); release(); abort.abort();
      }
    },
    async cancel() { cancelled = true; abort.abort(); release(); await iterator.return(undefined); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Moyu-Provider':'deepseek', 'X-Moyu-Evidence-Count':String(sources?.length??0) } });
}
