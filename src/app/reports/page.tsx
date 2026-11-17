'use client';
import Link from 'next/link';
import { ShowcaseShell } from '@/components/showcase-shell';
import { BrandMark, useBranding } from '@/components/brand-provider';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, Moon, Sun, Download, Sparkles, Square } from 'lucide-react';
import { readSSE } from '@/lib/sse';
import { eventSchema, STAGE_LABELS, type ReportEvent, type ReportInput } from '@/lib/reports/types';
import './reports.css';

type Step=Extract<ReportEvent,{type:'step'}>;
type Complete=Extract<ReportEvent,{type:'complete'}>;
export default function ReportsPage(){
  const {brand}=useBranding();
  const [input,setInput]=useState<ReportInput>({topic:'中文团队协作改进报告',requirements:'请提供清晰的摘要、分析框架和对比表格。',type:'custom',useKnowledge:false,formats:['docx','pdf'],engine:'mock'});
  const [busy,setBusy]=useState(false),[steps,setSteps]=useState<Step[]>([]),[result,setResult]=useState<Complete|null>(null),[error,setError]=useState(''),[dark,setDark]=useState(false),[paid,setPaid]=useState(false),[downloading,setDownloading]=useState('');
  const [knowledgeNotice,setKnowledgeNotice]=useState('正在确认知识库连接…');
  const abort=useRef<AbortController|null>(null);
  useEffect(()=>{let value=document.documentElement.dataset.theme!=='light';try{value=(localStorage.getItem('moyu-theme')||document.documentElement.dataset.theme||'dark')==='dark';}catch{/* Optional preference. */}document.documentElement.dataset.theme=value?'dark':'light';queueMicrotask(()=>setDark(value));const c=new AbortController();fetch('/api/reports',{signal:c.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'知识库连接失败');return d;}).then(d=>{setPaid(d.paidEnabled===true);setKnowledgeNotice(`${d.knowledge?.mode==='production-read-only'?'原有正式知识库 · 安全只读':'隔离测试知识库'} · ${d.knowledge?.eligible??0} 份有效文档。停用、归档及旧版本自动排除。`);if(d.paidEnabled===true)setInput(prev=>({...prev,engine:'deepseek'}));}).catch(e=>setKnowledgeNotice(e instanceof Error?e.message:'无法确认知识库连接'));return()=>{c.abort();abort.current?.abort();};},[]);
  function stop(){abort.current?.abort();setSteps(prev=>prev.map(s=>s.status==='running'?{...s,status:'cancelled',elapsedMs:Date.now()-s.at}:s));setError('生成已停止，可调整要求后重新生成。');}
  async function generate(){
    if(abort.current)return;const c=new AbortController();abort.current=c;setBusy(true);setResult(null);setSteps([]);setError('');let complete=false,runId='',count=0;
    try{
      const response=await fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:c.signal});
      if(!response.ok){const e=await response.json();throw new Error(e.error||'生成请求失败。');}if(!response.body)throw new Error('流式响应不可用。');
      for await(const data of readSSE(response.body)){
        if(c.signal.aborted)break;if(++count>60)throw new Error('工作流事件超过上限。');const event=eventSchema.parse(JSON.parse(data));
        if(event.type==='error')throw new Error(event.message);if(runId&&runId!==event.runId)throw new Error('工作流标识不一致。');runId=event.runId;
        if(event.type==='step')setSteps(prev=>{const i=prev.findIndex(s=>s.stepId===event.stepId);return i<0?[...prev,event]:prev.map((s,j)=>j===i?event:s);});
        else {setResult(event);complete=true;}
      }
      if(!complete&&!c.signal.aborted)throw new Error('连接提前结束，未保存不完整报告，请重试。');
    }catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'生成失败，请重试。');setSteps(prev=>prev.map(s=>s.status==='running'?{...s,status:c.signal.aborted?'cancelled':'error',elapsedMs:Date.now()-s.at}:s));}
    finally{abort.current=null;setBusy(false);}
  }
  async function download(format:'docx'|'pdf'){
    if(!result||downloading)return;setDownloading(format);setError('');
    try{const r=await fetch('/api/reports/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:result.id,token:result.token,format})});if(!r.ok){const e=await r.json();throw new Error(e.error||'下载失败。');}const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=result.report.content.title.replace(/[<>:"/\\|?*]/g,'_').slice(0,70)+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){setError(e instanceof Error?e.message:'下载失败。');}finally{setDownloading('');}
  }
  const cite=(sources:number[])=>sources.length?' 〔'+sources.join('、')+'〕':'';
  const status={running:'运行中',success:'已完成',error:'失败',cancelled:'已取消'};
  return <ShowcaseShell active="reports"><div className="reports-page"><header className="reports-header"><Link href="/" className="studio-brand"><BrandMark/><strong>{brand.siteName}</strong></Link><Link href="/"><ArrowLeft size={16}/>{brand.chatName}</Link><Link href="/knowledge">{brand.knowledgeName}</Link><button aria-label="切换主题" onClick={()=>{const next=!dark;setDark(next);document.documentElement.dataset.theme=next?'dark':'light';try{localStorage.setItem('moyu-theme',next?'dark':'light');}catch{/* Optional preference. */}}}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button></header><section className="visual-page-intro"><div><span className="suite-eyebrow">INTELLIGENCE TO DOCUMENT</span><h2>从知识依据，到专业交付。</h2><p>有结构的分析，可追溯的来源。生成、核验与导出，在同一个工作空间完成。</p></div><div className="visual-output-labels"><span>DOCX · 可编辑</span><span>PDF · 中文排版</span></div></section>
    <main className="reports-layout"><section className="report-settings"><div className="reports-eyebrow"><Sparkles size={16}/>{brand.subtitle}</div><h1>{brand.reportName}</h1><p className="report-muted">把主题整理成结构清晰、可以继续编辑的报告。</p>
      <form onSubmit={e=>{e.preventDefault();void generate();}}><fieldset disabled={busy}>
        <label>报告主题<input required minLength={2} maxLength={160} value={input.topic} onChange={e=>setInput({...input,topic:e.target.value})}/></label>
        <label>报告类型<select value={input.type} onChange={e=>setInput({...input,type:e.target.value as ReportInput['type']})}><option value="knowledge">知识库总结</option><option value="business">业务分析</option><option value="comparison">产品对比</option><option value="custom">自定义报告</option></select></label>
        <label>具体要求<textarea rows={5} maxLength={2000} value={input.requirements} placeholder="说明目标读者、关注的问题和期望结构" onChange={e=>setInput({...input,requirements:e.target.value})}/></label>
        <label className="report-check"><input type="checkbox" checked={input.useKnowledge} onChange={e=>setInput({...input,useKnowledge:e.target.checked})}/>使用{brand.knowledgeName}当前有效文档</label><p className="report-muted report-small">{knowledgeNotice}</p>
        <label>生成引擎<select value={input.engine} onChange={e=>setInput({...input,engine:e.target.value as ReportInput['engine']})}><option value="mock">Mock 演示 · 不调用付费 API</option><option value="deepseek" disabled={!paid}>DeepSeek · {paid?'已获服务端授权':'待服务端授权'}</option></select></label>
        {input.engine==='deepseek'&&<p className="report-muted report-small">真实生成会向 DeepSeek 发送主题、要求及所检索片段，并产生费用。请确认资料允许外发；重要结论需人工核验。</p>}
        <label>导出格式<select value={input.formats.length===2?'both':input.formats[0]} onChange={e=>setInput({...input,formats:e.target.value==='both'?['docx','pdf']:[e.target.value as 'docx'|'pdf']})}><option value="both">Word 和 PDF</option><option value="docx">Word · 可编辑 DOCX</option><option value="pdf">PDF · 中文排版</option></select></label>
        <button className="report-primary" type="submit"><FileText size={17}/>{error?'重新生成':'生成报告'}</button>
      </fieldset></form>{busy&&<button className="report-stop" onClick={stop}><Square size={14}/>停止生成</button>}
      <p className="report-muted report-small">文件仅在本机临时保存 60 分钟。刷新后下载凭证不会保留，请及时下载。私有资料请勿公开部署。</p>
    </section><section className="report-workspace" aria-label="报告工作区">
      {error&&<div className="report-error" role="alert">{error}</div>}
      {!!steps.length&&<details className="report-progress" open><summary>{brand.agentName} · {busy?'处理中':result?'已完成':'已结束'} · {steps.filter(s=>s.status==='success').length}/{steps.length} 步完成</summary><ol aria-live="polite">{steps.map(s=><li key={s.stepId} data-status={s.status}><details><summary><span className="report-node"/>{STAGE_LABELS[s.stage]}<small>{status[s.status]}{s.elapsedMs!==undefined?` · ${(s.elapsedMs/1000).toFixed(1)} 秒`:''}</small></summary><p className="report-muted report-small">开始时间 {new Date(s.at-(s.elapsedMs??0)).toLocaleTimeString('zh-CN')} · 仅展示实际节点事件，不展示内部推理。</p></details></li>)}</ol></details>}
      {result?<><div className="report-actions"><strong>报告已就绪</strong>{result.formats.map(f=><button key={f} disabled={!!downloading} onClick={()=>void download(f)}><Download size={15}/>{downloading===f?'下载中…':f==='docx'?'下载 Word':'下载 PDF'}</button>)}</div><article className="report-paper"><span className="report-badge">{result.report.engine==='mock'?'MOCK 演示 · 非真实 AI 分析':'AI 辅助报告 · 请核验'}</span><h2>{result.report.content.title}</h2><h3>摘要</h3><p>{result.report.content.abstract}</p>{result.report.limitations.map(t=><p className="report-note" key={t}>{t}</p>)}{result.report.content.sections.map((s,i)=><section key={i}><h3>{s.heading}</h3>{s.paragraphs.map((p,j)=><p key={j}>{p.text}<sup>{cite(p.sources)}</sup></p>)}{s.table&&<div className="report-table-scroll"><table><thead><tr>{s.table.columns.map((c,j)=><th key={j}>{c}</th>)}</tr></thead><tbody>{s.table.rows.map((r,j)=><tr key={j}>{r.map((c,k)=><td key={k}>{c}</td>)}</tr>)}</tbody></table><small>{cite(s.table.sources)}</small></div>}</section>)}<h3>结论</h3><p>{result.report.content.conclusion}</p><h3>引用来源</h3>{result.report.references.length?result.report.references.map(r=><details key={r.number}><summary>〔{r.number}〕{r.fileName}{r.version?` · 版本 ${r.version}`:''}{r.page?` · 第 ${r.page} 页`:''}</summary><p>{r.excerpt}</p></details>):<p className="report-muted">资料不足，没有可靠来源。未伪造文档引用。</p>}</article></>:<div className="report-placeholder"><FileText size={44}/><h2>{busy?'正在组织报告':'让想法成为一份完整报告'}</h2><p>填写主题，生成后在这里预览正文、表格和引用。</p><span>真实可编辑 Word · 嵌入中文字体 PDF</span></div>}
    </section></main></div></ShowcaseShell>;
}
