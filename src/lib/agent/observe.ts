import 'server-only';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from './types';
import { agentFailure } from './limits';
import { applyWorkflowEvent, workflowEventSchema, redactSummary, type WorkflowEvent, type WorkflowRun, type WorkflowStep } from './workflow';

// Observe existing execution boundaries, never invoke tools from the UI/protocol.
export async function* observeRun(events: AsyncIterable<AgentEvent>, signal: AbortSignal, runId = randomUUID()): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  let sequence = 0, run: WorkflowRun | undefined;
  const calls = new Map<string, WorkflowStep>();
  function emit(payload: Record<string, unknown>, at = Date.now()): WorkflowEvent {
    const event = workflowEventSchema.parse({ ...payload, version: 1, runId, eventId: randomUUID(), sequence: sequence + 1, at: Math.max(startedAt, at) });
    run = applyWorkflowEvent(run, event);
    sequence++;
    return event;
  }
  yield emit({ type: 'run_started', execution: 'serial' }, startedAt);
  try {
    for await (const event of events) {
      if (event.type === 'graph_node_start' || event.type === 'graph_node_end') {
        yield emit({ type: event.type === 'graph_node_start' ? 'node_started' : 'node_finished', node: event.node }, event.node.endedAt ?? event.node.startedAt);
      } else if (event.type === 'tool_start') {
        const last = run!.steps.at(-1);
        const queuedAt = Math.max(startedAt, event.record.startedAt, last?.endedAt ?? 0);
        const step: WorkflowStep = { stepId: randomUUID(), toolCallId: event.record.id, name: event.record.name, ...(event.record.attempt ? { attempt: event.record.attempt } : {}), status: 'pending', queuedAt, inputSummary: redactSummary(event.record.inputSummary), dependsOn: last ? [last.stepId] : [], sourceChunkIds: [] };
        calls.set(step.toolCallId, step);
        yield emit({ type: 'tool_pending', step }, queuedAt);
        // The tool is validated and about to run; pending is not a model prediction.
        if (signal.aborted) signal.throwIfAborted();
        const running: WorkflowStep = { ...step, status: 'running', startedAt: Math.max(queuedAt, Date.now()) };
        calls.set(step.toolCallId, running);
        yield emit({ type: 'tool_started', step: running }, running.startedAt);
      } else if (event.type === 'tool_finish' || event.type === 'tool_error') {
        const step = calls.get(event.id);
        if (!step || step.status !== 'running') throw new Error('Invalid execution event');
        const endedAt = Math.max(step.startedAt!, Date.now());
        const finished: WorkflowStep = { ...step, status: event.type === 'tool_finish' ? 'success' : 'error', endedAt, elapsedMs: endedAt - step.startedAt!, summary: redactSummary(event.summary), outputSummary: redactSummary(event.outputSummary), sourceChunkIds: event.sourceChunkIds ?? [] };
        calls.set(event.id, finished);
        yield emit({ type: event.type === 'tool_finish' ? 'tool_completed' : 'tool_failed', step: finished }, endedAt);
      } else if (event.type === 'done') {
        const endedAt = Math.max(Date.now(), startedAt, ...run!.steps.map(s => s.endedAt ?? s.queuedAt));
        yield emit({ type: 'run_completed', elapsedMs: endedAt - startedAt }, endedAt);
        yield event; return;
      } else if (event.type === 'status') {
        yield { ...event, ...(event.detail ? { detail: redactSummary(event.detail) } : {}) };
      } else yield event;
    }
    throw new Error('Execution ended without completion');
  } catch (error) {
    const message = redactSummary(agentFailure(error, signal));
    const cancelled = signal.aborted && signal.reason?.name !== 'TimeoutError';
    const endedAt = Math.max(Date.now(), startedAt, ...run!.steps.map(s => s.startedAt ?? s.queuedAt));
    yield emit({ type: cancelled ? 'run_cancelled' : 'run_failed', elapsedMs: endedAt - startedAt, message }, endedAt);
    yield { type: 'error', error: message };
  }
}
