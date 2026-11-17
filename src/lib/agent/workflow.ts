import { z } from 'zod';
import { TOOL_NAMES } from './types';
import { graphNodeSchema } from './graph-events';

// Up to 64 graph nodes × 2, 17 tool attempts × 3, and run start/end.
export const MAX_WORKFLOW_EVENTS = 181;
export const MAX_WORKFLOW_CHARS = 120000;
const timestamp = z.number().int().min(0).max(8640000000000000);
const duration = z.number().int().min(0).max(8640000000000000);
const status = z.enum(['pending', 'running', 'success', 'error', 'cancelled']);
const summary = z.string().max(600);
export function redactSummary(value: string, max = 600) {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[密钥已隐藏]')
    .replace(/\bBearer\s+(?:\\?["'])?[A-Za-z0-9._~+\/=\-]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|password)(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)[^\s"'\\,;}]+/gi, '$1[已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]').slice(0, max);
}
const safeText = summary.refine(s => redactSummary(s) === s, '摘要含未脱敏字段');
export const workflowStepSchema = z.object({
  stepId: z.uuid(), toolCallId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.enum(TOOL_NAMES), attempt: z.number().int().min(0).max(2).optional(), status, queuedAt: timestamp, startedAt: timestamp.optional(),
  endedAt: timestamp.optional(), elapsedMs: duration.optional(),
  inputSummary: safeText, outputSummary: safeText.optional(), summary: safeText.optional(),
  dependsOn: z.array(z.uuid()).max(17), sourceChunkIds: z.array(z.uuid()).max(20),
}).strict().superRefine((s, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (s.status === 'pending' && s.startedAt !== undefined) bad('pending 不得有开始时间');
  if (s.status === 'running' && s.startedAt === undefined) bad('running 缺少开始时间');
  if (s.startedAt !== undefined && s.startedAt < s.queuedAt) bad('开始时间早于排队时间');
  if (['success', 'error', 'cancelled'].includes(s.status)) {
    if (s.endedAt === undefined || s.elapsedMs === undefined || s.endedAt < (s.startedAt ?? s.queuedAt) || s.elapsedMs !== s.endedAt - (s.startedAt ?? s.queuedAt)) bad('结束时间与耗时不符');
  } else if (s.endedAt !== undefined || s.elapsedMs !== undefined) bad('未结束步骤不能有结束时间');
  if (s.status === 'success' && s.startedAt === undefined) bad('成功步骤缺少开始时间');
  if (new Set(s.dependsOn).size !== s.dependsOn.length || s.dependsOn.includes(s.stepId)) bad('步骤依赖不合法');
});
const safeNode = graphNodeSchema.refine(n => redactSummary(n.summary, 180) === n.summary);
const base = { version: z.literal(1), runId: z.uuid(), eventId: z.uuid(), sequence: z.number().int().min(1).max(MAX_WORKFLOW_EVENTS), at: timestamp };
const stepEvent = <T extends string>(type: T, expected: z.infer<typeof status>) => z.object({ ...base, type: z.literal(type), step: workflowStepSchema.refine(s => s.status === expected) }).strict();
export const workflowEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('run_started'), execution: z.enum(['serial', 'parallel']) }).strict(),
  z.object({ ...base, type: z.literal('node_started'), node: safeNode.refine(n => n.status === 'running') }).strict(),
  z.object({ ...base, type: z.literal('node_finished'), node: safeNode.refine(n => n.status !== 'running') }).strict(),
  stepEvent('tool_pending', 'pending'), stepEvent('tool_started', 'running'),
  stepEvent('tool_completed', 'success'), stepEvent('tool_failed', 'error'),
  ...(['run_completed', 'run_failed', 'run_cancelled'] as const).map(type => z.object({ ...base, type: z.literal(type), elapsedMs: duration, message: safeText.optional() }).strict()),
]);
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
const logSchema = z.object({ eventId: z.uuid(), sequence: z.number().int().min(1).max(MAX_WORKFLOW_EVENTS), type: z.string().max(30), at: timestamp, stepId: z.uuid().optional(), nodeId: z.uuid().optional() }).strict();
export const workflowSchema = z.object({
  runId: z.uuid(), status, startedAt: timestamp, endedAt: timestamp.optional(), elapsedMs: duration.optional(),
  execution: z.enum(['serial', 'parallel']), endOrigin: z.enum(['server', 'client']).optional(), message: safeText.optional(),
  steps: z.array(workflowStepSchema).max(17), nodes: z.array(safeNode).max(64).optional(), events: z.array(logSchema).max(MAX_WORKFLOW_EVENTS),
}).strict();
export type WorkflowRun = z.infer<typeof workflowSchema>;
export const isWorkflowEventType = (type: unknown): boolean => typeof type === 'string' && /^(?:run_started|node_started|node_finished|tool_pending|tool_started|tool_completed|tool_failed|run_completed|run_failed|run_cancelled)$/.test(type);

export function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (JSON.stringify(value)?.length > MAX_WORKFLOW_CHARS) return false;
  const parsed = workflowSchema.safeParse(value);
  if (!parsed.success) return false;
  const r = parsed.data;
  if (r.events.some(e => !isWorkflowEventType(e.type)) || r.events[0]?.at !== r.startedAt) return false;
  if (new Set(r.steps.map(s => s.stepId)).size !== r.steps.length || new Set(r.steps.map(s => `${s.toolCallId}:${s.attempt ?? 0}`)).size !== r.steps.length) return false;
  if (r.events.length < 1 || r.events[0].type !== 'run_started' || new Set(r.events.map(e => e.eventId)).size !== r.events.length || r.events.some((e, i) => e.sequence !== i + 1)) return false;
  if (r.steps.some(s => s.queuedAt < r.startedAt || s.dependsOn.some(id => !r.steps.some(p => p.stepId === id && p.endedAt !== undefined && p.endedAt <= (s.startedAt ?? s.queuedAt))))) return false;
  if (r.steps.filter(s => (s.attempt ?? 0) > 0).length > 2) return false;
  for (const step of r.steps) {
    if ((step.attempt ?? 0) > 0 && !r.steps.some(p => p.toolCallId === step.toolCallId && (p.attempt ?? 0) === step.attempt! - 1 && p.status === 'error' && p.name === step.name && p.inputSummary === step.inputSummary && p.endedAt! <= step.queuedAt)) return false;
  }
  const nodes = r.nodes ?? [];
  if (r.endedAt !== undefined && (nodes.some(n => (n.endedAt ?? n.startedAt) > r.endedAt!) || r.steps.some(s => (s.endedAt ?? s.queuedAt) > r.endedAt!))) return false;
  if (new Set(nodes.map(n => n.nodeId)).size !== nodes.length || nodes.some((n, i) => n.startedAt < r.startedAt || n.previousNodeId !== nodes[i - 1]?.nodeId || (i > 0 && (nodes[i - 1].endedAt === undefined || nodes[i - 1].endedAt! > n.startedAt)))) return false;
  if (r.status === 'pending' || r.status === 'running') return r.endedAt === undefined && r.elapsedMs === undefined;
  if (r.endOrigin === 'server' && (r.events.at(-1)?.type !== (r.status === 'success' ? 'run_completed' : r.status === 'error' ? 'run_failed' : 'run_cancelled') || r.events.at(-1)?.at !== r.endedAt)) return false;
  return r.endedAt !== undefined && r.endedAt >= r.startedAt && r.elapsedMs === r.endedAt - r.startedAt && r.endOrigin !== undefined && r.steps.every(s => !['pending', 'running'].includes(s.status)) && nodes.every(n => n.status !== 'running');
}

export function finishWorkflow(run: WorkflowRun, state: 'error' | 'cancelled', message: string, at = Date.now()): WorkflowRun {
  if (!['running', 'pending'].includes(run.status)) return run;
  const end = Math.max(at, run.startedAt, ...run.steps.map(s => s.endedAt ?? s.startedAt ?? s.queuedAt), ...(run.nodes ?? []).map(n => n.endedAt ?? n.startedAt));
  return { ...run, status: state, endedAt: end, elapsedMs: end - run.startedAt, endOrigin: 'client', message: redactSummary(message), ...(run.nodes ? { nodes: run.nodes.map(n => n.status === 'running' ? { ...n, status: state, endedAt: end, elapsedMs: end - n.startedAt, summary: '连接或任务已结束，节点未确认完成' } : n) } : {}), steps: run.steps.map(s => ['pending', 'running'].includes(s.status) ? { ...s, status: state === 'cancelled' || s.status === 'pending' ? 'cancelled' : 'error', endedAt: end, elapsedMs: end - (s.startedAt ?? s.queuedAt), summary: redactSummary(message) } : s) };
}

// Deterministic state machine: duplicates are idempotent; conflicts fail safely.
export function applyWorkflowEvent(run: WorkflowRun | undefined, input: WorkflowEvent): WorkflowRun {
  const event = workflowEventSchema.parse(input);
  if (run) {
    const prior = run.events.find(e => e.sequence === event.sequence || e.eventId === event.eventId);
    if (prior) {
      if (prior.eventId === event.eventId && prior.sequence === event.sequence && prior.type === event.type) return run;
      throw new Error('工作流事件编号冲突，已停止展示。');
    }
    if (run.runId !== event.runId || event.sequence !== run.events.length + 1 || !['running', 'pending'].includes(run.status)) throw new Error('工作流事件顺序异常，已停止展示。');
  } else if (event.type !== 'run_started' || event.sequence !== 1) throw new Error('工作流缺少开始事件。');
  let next: WorkflowRun;
  if (event.type === 'run_started') {
    if (run) throw new Error('工作流重复开始。');
    next = { runId: event.runId, status: 'running', startedAt: event.at, execution: event.execution, steps: [], events: [] };
  } else {
    next = { ...run!, steps: [...run!.steps] };
    if (event.at < next.startedAt) throw new Error('工作流时间异常。');
    if ('node' in event) {
      const nodes = [...(next.nodes ?? [])], index = nodes.findIndex(n => n.nodeId === event.node.nodeId), previous = nodes[index];
      if (event.type === 'node_started') {
        if (previous || nodes.length >= 64 || nodes.some(n => n.status === 'running') || event.node.previousNodeId !== nodes.at(-1)?.nodeId) throw new Error('图节点重复、并发或路径错误。');
        nodes.push(event.node);
      } else {
        if (!previous || previous.status !== 'running' || previous.name !== event.node.name || previous.startedAt !== event.node.startedAt || previous.previousNodeId !== event.node.previousNodeId || previous.retryCount !== event.node.retryCount) throw new Error('图节点结束关联错误。');
        nodes[index] = event.node;
      }
      if (event.at !== (event.node.endedAt ?? event.node.startedAt)) throw new Error('图节点事件时间错误。');
      next.nodes = nodes;
    } else if ('step' in event) {
      const step = event.step, index = next.steps.findIndex(s => s.stepId === step.stepId), previous = next.steps[index];
      if (event.type === 'tool_pending') {
        if (previous || next.steps.length >= 17 || next.steps.some(s => s.toolCallId === step.toolCallId && (s.attempt ?? 0) === (step.attempt ?? 0))) throw new Error('工作流步骤重复或超限。');
        next.steps.push(step);
      } else {
        if (!previous || previous.name !== step.name || previous.toolCallId !== step.toolCallId || previous.inputSummary !== step.inputSummary || previous.queuedAt !== step.queuedAt || previous.attempt !== step.attempt || JSON.stringify(previous.dependsOn) !== JSON.stringify(step.dependsOn)) throw new Error('工具步骤关联错误。');
        if (event.type === 'tool_started' ? previous.status !== 'pending' : previous.status !== 'running') throw new Error('工具状态跳转错误。');
        if (event.type !== 'tool_started' && previous.startedAt !== step.startedAt) throw new Error('工具时间关联错误。');
        next.steps[index] = step;
      }
      if (event.at !== (step.endedAt ?? step.startedAt ?? step.queuedAt)) throw new Error('工具事件时间错误。');
      if (next.execution === 'serial' && next.steps.filter(s => s.status === 'running').length > 1) throw new Error('串行任务出现并行步骤。');
    } else {
      if (event.elapsedMs !== event.at - next.startedAt) throw new Error('工作流总耗时错误。');
      const terminal = event.type === 'run_completed' ? 'success' : event.type === 'run_failed' ? 'error' : 'cancelled';
      if (terminal === 'success' && (next.steps.some(s => ['pending', 'running'].includes(s.status)) || next.nodes?.some(n => n.status === 'running'))) throw new Error('工作流仍有未结束的工具。');
      next = { ...finishWorkflow(next, terminal === 'success' ? 'error' : terminal, event.message ?? '', event.at), status: terminal, endedAt: event.at, elapsedMs: event.elapsedMs, endOrigin: 'server', message: event.message };
    }
  }
  next.events = [...next.events, { eventId: event.eventId, sequence: event.sequence, type: event.type, at: event.at, ...('step' in event ? { stepId: event.step.stepId } : {}), ...('node' in event ? { nodeId: event.node.nodeId } : {}) }];
  if (!isWorkflowRun(next)) throw new Error('工作流数据不符合安全约束。');
  return next;
}

// Bounded reordering buffer; no missing step is fabricated to fill a gap.
export function createWorkflowReceiver(onEvent: (event: WorkflowEvent) => void) {
  let run: WorkflowRun | undefined;
  let received = 0;
  const waiting = new Map<number, WorkflowEvent>();
  const fingerprints = new Map<number, string>();
  return {
    accept(value: unknown) {
      if (++received > MAX_WORKFLOW_EVENTS * 2) throw new Error('工作流事件数量超限。');
      if (JSON.stringify(value).length > 8000) throw new Error('工作流事件过大。');
      const event = workflowEventSchema.parse(value);
      const fingerprint = JSON.stringify(event);
      if (fingerprints.has(event.sequence)) {
        if (fingerprints.get(event.sequence) !== fingerprint) throw new Error('工作流重复事件内容冲突。');
        return;
      }
      if (fingerprints.size >= MAX_WORKFLOW_EVENTS || (run && run.runId !== event.runId)) throw new Error('工作流事件超限或运行编号错误。');
      fingerprints.set(event.sequence, fingerprint); waiting.set(event.sequence, event);
      while (waiting.has((run?.events.length ?? 0) + 1)) {
        const sequence = (run?.events.length ?? 0) + 1, current = waiting.get(sequence)!;
        run = applyWorkflowEvent(run, current); waiting.delete(sequence); onEvent(current);
      }
    },
    finish() { if (waiting.size || (run && ['running', 'pending'].includes(run.status))) throw new Error('工作流连接不完整，未确认任务结束。'); },
  };
}
