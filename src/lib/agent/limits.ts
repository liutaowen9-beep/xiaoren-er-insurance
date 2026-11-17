import 'server-only';
import { redactSummary } from './workflow';

export const AGENT_LIMITS = Object.freeze({
  toolRounds: 5, callsPerRound: 3, toolsTotal: 15, modelCalls: 12,
  requestMs: 120000, modelMs: 30000, toolMs: 45000,
  inputBytes: 100000, historyMessages: 24, historyChars: 24000,
  argumentChars: 6000, contextChars: 100000, outputChars: 20000,
  toolResultChars: 14000, documentChars: 36000, segmentChars: 6000, analysisSegments: 6,
});
export class AgentError extends Error {
  constructor(message: string, public readonly status = 400, public readonly retryable = false) { super(message); }
}
export function stopCheck(signal: AbortSignal) { signal.throwIfAborted(); }
export function safeSummary(text: string, limit = 600) {
  return redactSummary(text, limit);
}
export function agentFailure(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return signal.reason?.name === 'TimeoutError' ? 'Agent 任务超时，已停止后续工具。请缩小任务范围后重试。' : 'Agent 任务已停止。';
  if (error instanceof AgentError) return error.message;
  return 'Agent 暂时无法完成任务，请稍后重试。';
}
