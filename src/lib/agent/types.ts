import type { Source } from '../rag/types';
import type { WorkflowEvent } from './workflow';
import type { GraphNodeRecord } from './graph-events';

export const TOOL_NAMES = ['knowledge_search', 'calculator', 'document_analyze'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type AgentPhase = 'thinking' | 'searching' | 'calculating' | 'analyzing' | 'answering';
export type ToolRecord = { id: string; name: ToolName; status: 'running' | 'completed' | 'failed' | 'interrupted'; startedAt: number; elapsedMs?: number; inputSummary: string; summary?: string; outputSummary?: string; attempt?: number };
export type AgentEvent =
  | WorkflowEvent
  | { type: 'graph_node_start' | 'graph_node_end'; node: GraphNodeRecord }
  | { type: 'status'; phase: AgentPhase; detail?: string }
  | { type: 'tool_start'; record: ToolRecord }
  | { type: 'tool_finish' | 'tool_error'; id: string; elapsedMs: number; summary: string; outputSummary: string; sourceChunkIds?: string[] }
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done'; finishReason: 'stop' | 'length' }
  | { type: 'error'; error: string };

export function isToolRecord(value: unknown): value is ToolRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as ToolRecord;
  return (r.attempt === undefined || (Number.isInteger(r.attempt) && r.attempt >= 0 && r.attempt <= 2)) && typeof r.id === 'string' && r.id.length <= 128 && TOOL_NAMES.includes(r.name) && ['running', 'completed', 'failed', 'interrupted'].includes(r.status) && Number.isFinite(r.startedAt) && typeof r.inputSummary === 'string' && r.inputSummary.length <= 600 && (r.elapsedMs === undefined || (Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0)) && (r.summary === undefined || (typeof r.summary === 'string' && r.summary.length <= 600)) && (r.outputSummary === undefined || (typeof r.outputSummary === 'string' && r.outputSummary.length <= 2000));
}
