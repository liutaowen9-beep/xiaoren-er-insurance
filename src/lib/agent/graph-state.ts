import { z } from 'zod';
import { StateSchema } from '@langchain/langgraph';
import { isSource } from '../chat';
import type { Source } from '../rag/types';
import { TOOL_NAMES } from './types';

export { GRAPH_NODES, type GraphNodeName } from './graph-events';
export const GRAPH_LIMITS = Object.freeze({ steps: 64, retries: 2, stateChars: 350000 });
const call = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), type: z.literal('function'), function: z.object({ name: z.string().regex(/^[a-z_]{1,64}$/), arguments: z.string().max(6000) }).strict() }).strict();
const message = z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string().max(20000), tool_calls: z.array(call).max(3).optional(), tool_call_id: z.string().max(128).optional() }).strict();
export const graphStateSchema = z.object({
  runId: z.uuid(), task: z.string().min(1).max(10000), status: z.enum(['running', 'success', 'error', 'cancelled']),
  messages: z.array(message).max(80).refine(ms => ms.reduce((n, m) => n + JSON.stringify(m).length, 0) <= 100000),
  plan: z.array(z.object({ toolCallId: z.string().max(128), name: z.enum(TOOL_NAMES), status: z.enum(['pending', 'success', 'error']) }).strict()).max(15),
  currentStep: z.number().int().min(0).max(3), round: z.number().int().min(0).max(5),
  turn: z.object({ content: z.string().max(20000), calls: z.array(call).max(3), finishReason: z.enum(['stop', 'length', 'tool_calls']) }).strict().optional(),
  sources: z.array(z.custom<Source>(isSource)).max(20),
  results: z.array(z.object({ toolCallId: z.string().max(128), name: z.enum(TOOL_NAMES), status: z.enum(['success', 'error']), attempt: z.number().int().min(0).max(2), result: z.string().max(14000) }).strict()).max(17),
  error: z.object({ message: z.string().max(600), retryable: z.boolean(), target: z.enum(['plan_task', 'execute_tools', 'synthesize_answer']) }).strict().optional(),
  retryCount: z.number().int().min(0).max(2), attempt: z.number().int().min(0).max(2), modelCalls: z.number().int().min(0).max(12),
  finalAnswer: z.string().max(20000), finished: z.boolean(), cancelled: z.boolean(), steps: z.number().int().min(0).max(64),
}).strict();
export type AgentGraphState = z.infer<typeof graphStateSchema>;
// One explicit channel: each node returns a validated complete state, never an implicit reducer.
export const AgentGraphSchema = new StateSchema({ data: graphStateSchema });
export function checkedGraphState(value: unknown): AgentGraphState {
  if (JSON.stringify(value).length > GRAPH_LIMITS.stateChars) throw new Error('Graph state size exceeded');
  return graphStateSchema.parse(value);
}
