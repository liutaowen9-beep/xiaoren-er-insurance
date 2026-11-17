import { z } from 'zod';

export const GRAPH_NODES = ['plan_task', 'route_task', 'execute_tools', 'validate_evidence', 'retry_or_replan', 'synthesize_answer', 'finish_task'] as const;
export type GraphNodeName = typeof GRAPH_NODES[number];
export const graphNodeSchema = z.object({
  nodeId: z.uuid(), name: z.enum(GRAPH_NODES), previousNodeId: z.uuid().optional(),
  status: z.enum(['running', 'success', 'error', 'cancelled']), startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(), elapsedMs: z.number().int().nonnegative().optional(),
  retryCount: z.number().int().min(0).max(2), summary: z.string().max(180),
}).strict().superRefine((s, ctx) => {
  if (s.status === 'running' ? s.endedAt !== undefined || s.elapsedMs !== undefined : s.endedAt === undefined || s.elapsedMs !== s.endedAt - s.startedAt || s.endedAt < s.startedAt) ctx.addIssue({ code: 'custom', message: '节点时间无效' });
});
export type GraphNodeRecord = z.infer<typeof graphNodeSchema>;
