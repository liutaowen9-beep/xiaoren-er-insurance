import { readSSE } from './sse';
import { isSource } from './chat';
import type { Source } from './rag/types';
import { isToolRecord, type AgentEvent } from './agent/types';
import { createWorkflowReceiver, isWorkflowEventType, redactSummary } from './agent/workflow';

export async function readChatReply(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void, onSources?: (sources: Source[]) => void, onAgentEvent?: (event: AgentEvent) => void) {
  const workflow = createWorkflowReceiver(event => onAgentEvent?.(event));
  let textLength = 0;
  for await (const data of readSSE(body)) {
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('回复格式异常，请重试。'); }
    if (event?.type === 'error') throw new Error(typeof event.error === 'string' ? redactSummary(event.error) : '回复中断，请重试。');
    if (isWorkflowEventType(event?.type)) {
      try { workflow.accept(event); } catch { throw new Error('工作流事件无效或顺序冲突，已安全停止；保留已确认的执行记录。'); }
    }
    else if (event?.type === 'status' && ['thinking', 'searching', 'calculating', 'analyzing', 'answering'].includes(event.phase) && (event.detail === undefined || (typeof event.detail === 'string' && event.detail.length <= 600))) onAgentEvent?.(event);
    else if (event?.type === 'tool_start' && isToolRecord(event.record) && event.record.status === 'running') onAgentEvent?.(event);
    else if ((event?.type === 'tool_finish' || event?.type === 'tool_error') && typeof event.id === 'string' && event.id.length <= 128 && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && typeof event.summary === 'string' && event.summary.length <= 600 && typeof event.outputSummary === 'string' && event.outputSummary.length <= 2000) onAgentEvent?.(event);
    else if (event?.type === 'sources' && Array.isArray(event.sources) && event.sources.length <= 20 && event.sources.every(isSource)) onSources?.(event.sources);
    else if (event?.type === 'delta' && typeof event.text === 'string') {
      textLength += event.text.length;
      if (textLength > 20000) throw new Error('回复超过本地安全长度限制。');
      onDelta(event.text);
    }
    else if (event?.type === 'done') { workflow.finish(); return event.finishReason === 'length' ? '回复达到长度上限，可继续提问。' : ''; }
    else throw new Error('回复格式异常，请重试。');
  }
  throw new Error('回复连接提前结束，请重试。');
}
