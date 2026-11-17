import type { Source } from './rag/types';
import { isToolRecord, type ToolRecord } from './agent/types';
import { isWorkflowRun, type WorkflowRun } from './agent/workflow';
export type ChatMode = 'chat' | 'knowledge' | 'agent';
export type Message = { id: string; role: 'user' | 'assistant'; content: string; provider?: 'deepseek'; mode?: ChatMode; sources?: Source[]; tools?: ToolRecord[]; workflow?: WorkflowRun; status?: 'interrupted' | 'error' | 'limited' };
export type Conversation = { id: string; title: string; updatedAt: number; messages: Message[]; mode?: ChatMode };

export function isSource(value: unknown): value is Source {
  if (!value || typeof value !== 'object') return false;
  const s = value as Source;
  return Number.isInteger(s.number) && s.number > 0 && s.number <= 20 && typeof s.documentId === 'string' && typeof s.chunkId === 'string' && typeof s.fileName === 'string' && s.fileName.length <= 180 && typeof s.text === 'string' && s.text.length <= 20000 && Number.isFinite(s.score) && (s.kind === undefined || s.kind === 'document') && (s.page === undefined || (Number.isInteger(s.page) && s.page > 0));
}

export function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const c = value as Conversation;
  return typeof c.id === 'string' && typeof c.title === 'string' && typeof c.updatedAt === 'number' && (c.mode === undefined || c.mode === 'chat' || c.mode === 'knowledge' || c.mode === 'agent') && Array.isArray(c.messages) && c.messages.length <= 200 && c.messages.every(m => m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && (m.sources === undefined || (Array.isArray(m.sources) && m.sources.length <= 20 && m.sources.every(isSource))) && (m.tools === undefined || (Array.isArray(m.tools) && m.tools.length <= 17 && m.tools.every(isToolRecord))) && (m.workflow === undefined || isWorkflowRun(m.workflow)));
}
