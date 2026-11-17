import 'server-only';
import { readSSE } from '../sse';
import type { AIToolCall } from '../ai';
import { AGENT_LIMITS, AgentError } from './limits';

export type ModelTurn = { content: string; calls: AIToolCall[]; finishReason: 'stop' | 'length' | 'tool_calls' };
export type TurnEvent = { type: 'delta'; text: string } | { type: 'turn'; turn: ModelTurn };
export async function* readModelTurn(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const calls = new Map<number, AIToolCall>();
  let content = '', reason: ModelTurn['finishReason'] | undefined;
  for await (const data of readSSE(body)) {
    if (data === '[DONE]') {
      if (!reason || (reason === 'tool_calls' && !calls.size) || (reason !== 'tool_calls' && calls.size)) throw new AgentError('DeepSeek 工具响应未完整结束，请重试。', 502);
      const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
      ordered.forEach(([index, call], i) => {
        if (index !== i || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || !/^[a-z_]{1,64}$/.test(call.function.name)) throw new AgentError('DeepSeek 工具标识格式异常，未执行工具。', 502);
      });
      if (new Set(ordered.map(([, c]) => c.id)).size !== ordered.length) throw new AgentError('工具调用编号重复，未执行工具。', 502);
      if (reason !== 'tool_calls' && !content.trim()) throw new AgentError('DeepSeek 未返回有效回答。', 502);
      yield { type: 'turn', turn: { content, calls: ordered.map(([, c]) => c), finishReason: reason } }; return;
    }
    let payload;
    try { payload = JSON.parse(data); } catch { throw new AgentError('DeepSeek 返回了无效流数据。', 502); }
    if (!payload || payload.error) throw new AgentError('DeepSeek 工具请求失败，请稍后重试。', 502);
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      if (content.length > AGENT_LIMITS.outputChars) throw new AgentError('Agent 单轮回复达到长度限制。');
      yield { type: 'delta', text: delta.content };
    }
    if (delta?.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw new AgentError('工具调用流格式错误。', 502);
      for (const part of delta.tool_calls) {
        if (!Number.isInteger(part?.index) || part.index < 0 || part.index >= AGENT_LIMITS.callsPerRound || (part.type !== undefined && part.type !== 'function')) throw new AgentError('单轮工具数量或类型超出限制，未执行工具。');
        let call = calls.get(part.index);
        if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(part.index, call); }
        if (part.id !== undefined) {
          if (typeof part.id !== 'string' || (call.id && call.id !== part.id)) throw new AgentError('工具调用编号冲突。', 502);
          call.id = part.id;
        }
        if (part.function?.name !== undefined) {
          if (typeof part.function.name !== 'string') throw new AgentError('工具名称格式错误。', 502);
          call.function.name += part.function.name;
        }
        if (part.function?.arguments !== undefined) {
          if (typeof part.function.arguments !== 'string') throw new AgentError('工具参数格式错误。', 502);
          call.function.arguments += part.function.arguments;
        }
        if (call.function.arguments.length > AGENT_LIMITS.argumentChars || call.function.name.length > 64 || call.id.length > 128) throw new AgentError('工具参数超出长度限制，未执行工具。');
      }
    }
    if (choice.finish_reason != null) {
      if (!['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) throw new AgentError('DeepSeek 生成被中断，工具请求未执行。', 502);
      reason = choice.finish_reason;
    }
  }
  throw new AgentError('DeepSeek 流提前结束，未执行不完整的工具调用。', 502);
}
