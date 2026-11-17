import 'server-only';
import { readSSE } from './sse';
import { PRODUCT_BRAND_RULE, withProductBrand } from './product-identity';

export const MODEL = 'deepseek-flash';
export type AIToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AIMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: AIToolCall[]; tool_call_id?: string };
export type AITool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type AIOptions = { tools?: AITool[]; tool_choice?: 'auto' | 'none'; max_tokens?: number; credentialScope?: 'report'; response_format?: { type: 'json_object' } };
export const CONFIG_MESSAGE = '尚未配置 DeepSeek API Key。请在项目根目录的 .env.local 中填写 DEEPSEEK_API_KEY，然后重启开发服务器。';

export class AIError extends Error {
  constructor(message: string, public readonly status = 502, public readonly retryable = false) { super(message); }
}

export function isAIConfigured() { return Boolean(process.env.DEEPSEEK_API_KEY?.trim()); }

export function upstreamError(status: number) {
  switch (status) {
    case 401: return new AIError('DeepSeek 密钥无效或已失效，请检查本地 DEEPSEEK_API_KEY 配置。', 401);
    case 402: return new AIError('DeepSeek 账户余额不足，请在官方控制台检查余额。', 402);
    case 429: return new AIError('DeepSeek 请求过于频繁或服务繁忙，请稍后重试。', 429, true);
    default: return new AIError('DeepSeek 暂时无法处理请求，请稍后重试。', 502, status >= 500 && status <= 599);
  }
}

export function publicAIError(error: unknown, signal: AbortSignal): AIError {
  if (signal.aborted) return signal.reason?.name === 'TimeoutError'
    ? new AIError('DeepSeek 响应超时，请稍后重试。', 504)
    : new AIError('生成已停止。', 499);
  if (error instanceof AIError) return error;
  return new AIError('连接 DeepSeek 失败或回复中断，请检查网络后重试。');
}

export async function openDeepSeekStream(messages: AIMessage[], signal: AbortSignal, options?: AIOptions) {
  const key = (options?.credentialScope === 'report' ? process.env.MOYU_REPORT_API_KEY : process.env.DEEPSEEK_API_KEY)?.trim();
  if (!key) throw new AIError(CONFIG_MESSAGE, 503);
  const brandedMessages:AIMessage[]=messages.some(m=>m.role==='system')
    ? messages.map(m=>m.role==='system'?{...m,content:withProductBrand(m.content)}:m)
    : [{role:'system',content:PRODUCT_BRAND_RULE},...messages];
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model: MODEL, messages:brandedMessages, thinking: { type: 'disabled' }, stream: true, max_tokens: options?.max_tokens ?? 2048, ...(options?.response_format ? {response_format:options.response_format} : {}), ...(options?.tools ? { tools: options.tools, tool_choice: options.tool_choice ?? 'auto' } : {}) }),
    signal, cache: 'no-store', redirect: 'error',
  });
  if (!response.ok) { await response.body?.cancel(); throw upstreamError(response.status); }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel(); throw new AIError('DeepSeek 回复格式异常，请稍后重试。');
  }
  return response.body;
}

// Never forward raw upstream payloads or error bodies to the browser.
export async function* deepSeekDeltas(body: ReadableStream<Uint8Array>) {
  let received = 0;
  let finishReason: string | undefined;
  for await (const data of readSSE(body)) {
    if (data === '[DONE]') {
      if (!received) throw new AIError('DeepSeek 未返回有效内容，请重试。');
      if (finishReason !== 'stop' && finishReason !== 'length') throw new AIError('DeepSeek 回复未完成，请重试。');
      yield { type: 'done' as const, finishReason }; return;
    }
    let chunk;
    try { chunk = JSON.parse(data); } catch { throw new AIError('DeepSeek 回复格式异常，请重试。'); }
    if (!chunk || chunk.error) throw new AIError('DeepSeek 回复中断，请稍后重试。');
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (typeof text === 'string' && text) {
      received += text.length;
      if (received > 20000) throw new AIError('回复已达到本地长度限制，请缩小问题范围后重试。');
      yield { type: 'delta' as const, text };
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
  }
  throw new AIError('DeepSeek 连接提前结束，请重试。');
}
