import { isConversation, type Conversation } from './chat';
import { finishWorkflow, isWorkflowRun, redactSummary } from './agent/workflow';

export const MAX_HISTORY_CHARS = 2000000; // ~4 MB UTF-16; never silently evict old chats.
function protect(conversations: Conversation[]): Conversation[] {
  return conversations.map(c => ({ ...c, title: redactSummary(c.title, c.title.length), messages: c.messages.map(m => ({ ...m,
    content: redactSummary(m.content, m.content.length),
    sources: m.sources?.map(s => ({ ...s, fileName: redactSummary(s.fileName, 180), text: '', title: undefined })),
    tools: m.tools?.map(t => ({ ...t, ...(t.status === 'running' ? { status: 'interrupted' as const, elapsedMs: Math.max(0, Date.now() - t.startedAt) } : {}), inputSummary: t.name === 'document_analyze' ? '历史文档分析参数已省略' : redactSummary(t.inputSummary), summary: t.status === 'running' ? '历史会话已结束，工具未确认完成。' : redactSummary(t.summary ?? ''), outputSummary: t.name === 'calculator' ? redactSummary(t.outputSummary ?? '') : '历史详细输出不保存，请核对实际来源。' })),
    workflow: m.workflow && (['running', 'pending'].includes(m.workflow.status) ? finishWorkflow(m.workflow, 'cancelled', '页面会话已结束，未确认服务端执行完成。') : m.workflow),
  })) }));
}
export function restoreHistory(raw: string): Conversation[] {
  if (raw.length > MAX_HISTORY_CHARS) throw new Error('本地历史超过安全体积，原存储未覆盖。');
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) return [];
  const recovered = value.map(c => c && typeof c === 'object' && Array.isArray(c.messages) ? { ...c, messages: c.messages.map((m: unknown) => {
    if (!m || typeof m !== 'object' || !('workflow' in m) || isWorkflowRun(m.workflow)) return m;
    const copy = { ...m }; delete copy.workflow; return copy;
  }) } : c).filter(isConversation).slice(0, 100);
  return protect(recovered);
}
export function serializeHistory(conversations: Conversation[]) {
  const value = JSON.stringify(protect(conversations));
  if (value.length > MAX_HISTORY_CHARS) throw new Error('聊天历史达到安全存储上限，旧记录未覆盖；本次内容暂留在当前页面。');
  return value;
}
