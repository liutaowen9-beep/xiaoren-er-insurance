import { Calculator, Check, CircleAlert, Clock3, FileSearch, LoaderCircle, Search } from 'lucide-react';
import type { ToolRecord } from '@/lib/agent/types';

const labels = { knowledge_search: '知识库检索', calculator: '计算器', document_analyze: '文档分析' };
const icons = { knowledge_search: Search, calculator: Calculator, document_analyze: FileSearch };
export function ToolCards({ tools }: { tools?: ToolRecord[] }) {
  if (!tools?.length) return null;
  return <div className="tool-cards" aria-label="实际工具执行记录">{tools.map(tool => {
    const Icon = icons[tool.name];
    const State = tool.status === 'completed' ? Check : tool.status === 'running' ? LoaderCircle : tool.status === 'failed' ? CircleAlert : Clock3;
    return <details className={`tool-card ${tool.status}`} key={tool.id}><summary><span className="tool-icon"><Icon size={16} /></span><strong>{labels[tool.name]}</strong><State size={13} className={tool.status === 'running' ? 'tool-spinning' : ''} /><span>{tool.status === 'running' ? '执行中' : tool.status === 'completed' ? '已完成' : tool.status === 'failed' ? '失败' : '已中断'}</span>{tool.elapsedMs !== undefined && <small>{(tool.elapsedMs / 1000).toFixed(2)} 秒</small>}</summary>{tool.summary && <p className="tool-result">{tool.summary}</p>}<div className="tool-details"><label>输入摘要</label><pre>{tool.inputSummary}</pre><label>输出摘要（展开内容可能已截短）</label><pre>{tool.outputSummary || '等待工具返回；未完成的步骤不会标记成功。'}</pre></div></details>;
  })}</div>;
}
