'use client';

import { memo, useEffect, useState } from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {ExecutionMeter} from './visual-motion';
import { useBranding } from '@/components/brand-provider';
import { Calculator, Check, ChevronDown, CircleAlert, Clock3, FileSearch, LoaderCircle, Search, Square, Workflow } from 'lucide-react';
import type { WorkflowRun, WorkflowStep } from '@/lib/agent/workflow';
import type { Source } from '@/lib/rag/types';

const labels = { knowledge_search: '知识库检索', calculator: '计算器', document_analyze: '文档分析' };
const icons = { knowledge_search: Search, calculator: Calculator, document_analyze: FileSearch };
const states = { pending: '等待执行', running: '执行中', success: '已完成', error: '失败', cancelled: '已取消' };
const nodeLabels = { plan_task: '任务规划与续接', route_task: '条件路由', execute_tools: '执行安全工具', validate_evidence: '核验实际证据', retry_or_replan: '重试决策', synthesize_answer: '回答收尾核对', finish_task: '任务结束' };
const stateIcons = { pending: Clock3, running: LoaderCircle, success: Check, error: CircleAlert, cancelled: Square };
const seconds = (value: number) => value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(2)} 秒`;
const time = (value?: number) => value === undefined ? '尚未发生' : new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) + `.${String(value % 1000).padStart(3, '0')}`;

export function parallelPeers(step: WorkflowStep, steps: WorkflowStep[]) {
  if (step.startedAt === undefined) return [];
  return steps.filter(other => other.stepId !== step.stepId && other.startedAt !== undefined && other.startedAt < (step.endedAt ?? Infinity) && step.startedAt! < (other.endedAt ?? Infinity));
}
export const WorkflowPanel = memo(function WorkflowPanel({ run, sources, scope }: { run: WorkflowRun; sources?: Source[]; scope: string }) {
  const {brand}=useBranding();const reduced=useReducedMotion();
  const [open, setOpen] = useState(true), [now, setNow] = useState(run.startedAt);
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);
  const completed = run.steps.filter(s => s.status === 'success').length;
  const failures = run.steps.filter(s => s.status === 'error').length;
  const State = stateIcons[run.status];
  return <section className={`workflow-panel ${run.status}`} aria-label={brand.agentName}>
    <button className="workflow-heading" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={`workflow-${run.runId}`}>
      <Workflow size={17} /><strong>{brand.agentName}</strong><span className="workflow-run-state"><State size={13} className={run.status === 'running' ? 'tool-spinning' : ''} />{states[run.status]}</span><ChevronDown size={14} className={open ? 'workflow-chevron open' : 'workflow-chevron'} />
    </button>
    <div className="workflow-overview"><ExecutionMeter done={completed} total={run.steps.length} running={run.status==='running'}/><span>成功 {completed} / {run.steps.length} 个工具{failures ? ` · 失败 ${failures}` : ''}</span><span>总耗时 {seconds(run.elapsedMs ?? Math.max(0, now - run.startedAt))}</span></div>
    <AnimatePresence initial={false}>{open && <motion.div key="execution-details" id={`workflow-${run.runId}`} initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} exit={{opacity:0,height:0}} transition={{duration:reduced?0:0.18}} style={{overflow:'hidden'}}>
      <div className="workflow-caption">{run.execution === 'serial' ? '串行执行 · 按真实依赖连接' : '并行执行 · 按实际时间重叠展示'} · 仅记录实际操作，不展示内部思维链</div>
      {run.nodes?.length ? <details className="workflow-graph" open><summary>LangGraph 实际节点路径 · {run.nodes.length} 个节点 · 重试 {Math.max(...run.nodes.map(n => n.retryCount))} 次</summary><ol className="workflow-timeline">{run.nodes.map((node, index) => {
        const NodeState = stateIcons[node.status];
        return <li key={node.nodeId} className={`workflow-node ${node.status} ${index < run.nodes!.length - 1 ? 'has-successor' : ''}`}>
          <span className="workflow-dot"><NodeState size={13} className={node.status === 'running' ? 'tool-spinning' : ''} /></span>
          {index > 0 && <div className="workflow-dependency">来自节点 {index} · 实际条件路径</div>}
          <details className="workflow-step"><summary><strong>{index + 1}. {nodeLabels[node.name]}</strong><span>{states[node.status]}</span><small>{seconds(node.elapsedMs ?? Math.max(0, now - node.startedAt))}</small></summary>
            <div className="workflow-detail"><dl><div><dt>开始时间</dt><dd>{time(node.startedAt)}</dd></div><div><dt>结束时间</dt><dd>{time(node.endedAt)}</dd></div></dl><p>{node.summary}</p><p>已发生重试：{node.retryCount} / 2</p></div>
          </details>
        </li>;
      })}</ol></details> : null}
      {!run.steps.length && <p className="workflow-empty">{run.status === 'running' ? '等待实际工具事件；模型也可能直接回答。' : '本次没有执行工具。'}</p>}
      <ol className="workflow-timeline">{run.steps.map((step, index) => {
        const Icon = icons[step.name], StepState = stateIcons[step.status];
        const peers = parallelPeers(step, run.steps);
        return <li key={step.stepId} className={`workflow-node ${step.status} ${run.steps.some(next => next.dependsOn.includes(step.stepId)) ? 'has-successor' : ''}`}>
          <span className="workflow-dot"><Icon size={14} /></span>
          {step.dependsOn.length > 0 && <div className="workflow-dependency">接续步骤 {step.dependsOn.map(id => run.steps.findIndex(s => s.stepId === id) + 1).join('、')}</div>}
          <details className="workflow-step"><summary><strong>{index + 1}. {labels[step.name]}</strong><StepState size={12} className={step.status === 'running' ? 'tool-spinning' : ''} /><span>{states[step.status]}</span><small>{step.elapsedMs === undefined ? (step.startedAt === undefined ? '尚未开始' : seconds(Math.max(0, now - step.startedAt))) : seconds(step.elapsedMs)}</small></summary>
            {peers.length > 0 && <p className="workflow-parallel">与步骤 {peers.map(p => run.steps.indexOf(p) + 1).join('、')} 的实际执行时间重叠</p>}
            <div className="workflow-detail"><dl><div><dt>开始时间</dt><dd>{time(step.startedAt)}</dd></div><div><dt>结束时间</dt><dd>{time(step.endedAt)}</dd></div></dl>{step.attempt ? <p>此工具的第 {step.attempt} 次重试</p> : null}<label>输入摘要（已脱敏、可能截短）</label><pre>{step.inputSummary}</pre><label>{step.status === 'error' ? '错误说明' : '输出摘要'}</label><pre>{step.outputSummary || step.summary || '尚未收到工具结果。'}</pre><div className="workflow-identifiers">步骤 {step.stepId.slice(0, 8)}<br />工具调用标识仅保存在本机执行记录中</div></div>
          </details>
          {step.summary && <p className="workflow-result">{step.summary}</p>}
          {step.sourceChunkIds.length > 0 && <div className="workflow-references">{step.sourceChunkIds.map(id => {
            const source = sources?.find(s => s.chunkId === id);
            return source ? <a key={id} href={`#source-${scope}-${id}`}>查看来源 {source.number}</a> : null;
          })}</div>}
        </li>;
      })}</ol>
      {run.message && <p className="workflow-notice">{run.message}</p>}
      <div className="workflow-footer">开始 {time(run.startedAt)}{run.endedAt !== undefined && ` · 结束 ${time(run.endedAt)}`}<br />{run.endOrigin === 'client' ? '本地结束标记 · 未确认服务端最终完成' : run.endOrigin === 'server' ? '服务端已确认任务结束' : '正在接收服务端事件'}<span>运行 {run.runId.slice(0, 8)}</span></div>
    </motion.div>}</AnimatePresence>
  </section>;
});
