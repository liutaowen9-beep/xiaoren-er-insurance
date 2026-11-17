'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ClipboardList, Download, Play, Square, UserRound, GitBranch, FileText } from 'lucide-react';
import { z } from 'zod';
import { ShowcaseShell } from '@/components/showcase-shell';
import { Sources } from '@/components/sources';
import { readSSE } from '@/lib/sse';
import { FIELDS, STATUS_LABELS } from '@/lib/comparison/types';
import { reportSchema } from '@/lib/reports/types';
import { createConnection } from '@/lib/needs/connection';
import {PRODUCT_FIELDS,PROOF_LABELS,fieldDisplay} from '@/lib/needs/product-types';
import { EVIDENCE_LABELS, PROFILE_LABELS } from '@/lib/needs/assessment';
import { DEMO_PROFILE, profileSchema, eventSchema, LABELS, TOPICS, type Profile, type NeedsEvent, type NeedsResult } from '@/lib/needs/types';
import '../../reports/reports.css';
import '../compare/comparison.css';
import './needs.css';

const blank:Profile={gender:'unspecified',family:'',children:'',occupation:'',existingCoverage:'',needs:'',notes:''};
const numbers=[['age','客户年龄','岁'],['personalIncome','个人年收入','元/年'],['householdIncome','家庭年收入','元/年'],['annualBudget','年度保险预算','元/年']] as const;
const texts=[['family','家庭情况'],['children','子女及教育责任'],['occupation','职业情况'],['existingCoverage','当前保障情况'],['needs','主要保障需求（按关注顺序填写）'],['notes','特殊要求与补充信息']] as const;
type Step=Extract<NeedsEvent,{type:'step'}>;
const style={RUNNING:'running',SUCCESS:'success',PARTIAL_SUCCESS:'partial',INSUFFICIENT:'insufficient',FAILED:'error',CANCELLED:'cancelled'};
const revision=z.object({id:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),formats:z.array(z.enum(['docx','pdf'])),report:reportSchema}).strict();

export default function CustomerNeedsPage(){
  const [profile,setProfile]=useState<Profile>({...blank});
  const [engine,setEngine]=useState<'mock'|'deepseek'>('mock'),[paid,setPaid]=useState(false),[consent,setConsent]=useState(false);
  const [eligible,setEligible]=useState<number|null>(null),[connectionError,setConnectionError]=useState(''),[attempt,setAttempt]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[steps,setSteps]=useState<Step[]>([]),[result,setResult]=useState<NeedsResult|null>(null);
  const [note,setNote]=useState(''),[saving,setSaving]=useState(false),[downloading,setDownloading]=useState(false);
  const connection=useRef<ReturnType<typeof createConnection>|null>(null),controller=useRef<AbortController|null>(null),editController=useRef<AbortController|null>(null);
  const form=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const request=connection.current??(connection.current=createConnection());
    return request.subscribe(attempt,value=>{
      if('data' in value){setEligible(value.data.eligible);setPaid(value.data.paidEnabled);setConnectionError('');}
      else setConnectionError(value.error);
    });
  },[attempt]);
  useEffect(()=>()=>{controller.current?.abort();editController.current?.abort();},[]);
  function edit(next:Profile){setProfile(next);setResult(null);setSteps([]);setNote('');setError('');setConsent(false);}
  async function analyze(){
    if(controller.current||saving)return;
    const valid=profileSchema.safeParse(profile);if(!valid.success){setError('请至少填写一项客户信息或需求，并检查年龄、预算和文字长度。');return;}
    const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setSteps([]);setResult(null);setNote('');
    try{
      const response=await fetch('/api/needs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:valid.data,engine,consent}),signal:abort.signal});
      if(!response.ok){const data=await response.json();throw new Error(data.error||'分析请求失败。');}if(!response.body)throw new Error('分析数据流为空。');
      let complete=false,count=0;
      for await(const raw of readSSE(response.body)){
        abort.signal.throwIfAborted();if(++count>120)throw new Error('执行事件超过安全上限。');
        const event=eventSchema.parse(JSON.parse(raw));
        if(event.type==='error')throw new Error(event.message);
        if(event.type==='complete'){setResult(event);complete=true;break;}
        setSteps(old=>{const previous=old.find(s=>s.stepId===event.stepId);if(previous&&previous.status!=='RUNNING')return old;return previous?old.map(s=>s.stepId===event.stepId?event:s):[...old,event].slice(0,32);});
      }
      if(!complete)throw new Error('连接中断，未获得完整报告，请重新分析。');
    }catch(e){
      setError(abort.signal.aborted?'已停止分析，后续节点不再启动；未完成报告不提供下载。':e instanceof z.ZodError?'分析响应格式异常，未展示未经校验的结果。':e instanceof Error?e.message:'分析失败。');
      setSteps(old=>old.map(s=>s.status==='RUNNING'?{...s,status:abort.signal.aborted?'CANCELLED':'FAILED'}:s));
    }finally{if(controller.current===abort){controller.current=null;setBusy(false);}}
  }
  async function saveNote(){
    if(!result||saving||busy)return;const abort=new AbortController();editController.current=abort;setSaving(true);setError('');
    try{
      const r=await fetch('/api/needs/revise',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:result.id,token:result.token,note}),signal:abort.signal}),raw=await r.json();
      if(!r.ok)throw new Error(raw.error||'备注保存失败。');const updated=revision.parse(raw);setResult(old=>old?{...old,...updated}:old);setNote('');
    }catch(e){setError(e instanceof Error?e.message:'备注保存失败。');}finally{if(editController.current===abort){editController.current=null;setSaving(false);}}
  }
  async function download(format:'docx'|'pdf'){
    if(!result||downloading||saving)return;setDownloading(true);setError('');
    try{const response=await fetch('/api/reports/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:result.id,token:result.token,format})});
      if(!response.ok){const data=await response.json();throw new Error(data.error||'下载失败。');}
      const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download=`客户需求分析报告.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(e instanceof Error?e.message:'下载失败。');}finally{setDownloading(false);}
  }
  return <ShowcaseShell active="analysis"><main className="needs-page">
    <Link className="back-link" href="/analysis"><ArrowLeft size={14}/>返回智能业务分析</Link>
    <div className="suite-page-heading"><div><span className="suite-eyebrow">CUSTOMER NEEDS AGENT · V9.0.3</span><h1>客户需求分析 Agent</h1><p>从客户原话到真实证据，形成可核验的沟通起点。</p></div><span className="suite-status">{engine==='mock'?'Mock 规则演示':'DeepSeek AI'} · 人工核验</span></div>
    {error&&<div role="alert" className="report-error">{error}</div>}
    <div className="needs-layout">
      <section className="suite-panel needs-input" ref={form} aria-label="客户信息录入">
        <h2><UserRound size={19}/>客户信息</h2><p className="report-muted">允许部分留空。只填写虚构或已授权资料，不填写姓名、联系方式、证件号或未经授权的健康隐私。</p>
        <div className="needs-demo-actions"><button disabled={busy||saving} className="suite-secondary" onClick={()=>edit({...DEMO_PROFILE})}>填入虚构案例</button><button disabled={busy||saving} className="suite-secondary" onClick={()=>edit({...blank})}>清空输入</button></div>
        <form onSubmit={e=>{e.preventDefault();void analyze();}}><fieldset disabled={busy||saving}><legend>客户基本情况与关注点</legend><div className="needs-fields">
          {numbers.map(([key,label,unit])=><label key={key}>{label}<small>{unit}</small><input type="number" min={0} max={key==='age'?100:100000000} step={key==='age'?1:'0.01'} value={profile[key]??''} onChange={e=>edit({...profile,[key]:e.target.value===''?undefined:Number(e.target.value)})}/></label>)}
          <label className="needs-wide">性别（可留空）<select value={profile.gender} onChange={e=>edit({...profile,gender:e.target.value as Profile['gender']})}><option value="unspecified">未提供</option><option value="female">女</option><option value="male">男</option><option value="other">其他 / 不作推断</option></select></label>
          {texts.map(([key,label])=><label className="needs-wide" key={key}>{label}<textarea rows={key==='needs'?4:2} maxLength={key==='occupation'?200:key==='family'||key==='children'?500:1200} value={profile[key]} onChange={e=>edit({...profile,[key]:e.target.value})}/></label>)}
          <label className="needs-wide">分析引擎<select value={engine} onChange={e=>{setEngine(e.target.value as typeof engine);setConsent(false);}}><option value="mock">Mock · 本地规则与真实检索</option><option value="deepseek" disabled={!paid}>DeepSeek · 真实结构化分析{!paid?'（未授权）':''}</option></select></label>
        </div>
        {engine==='deepseek'&&<label className="needs-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我确认资料为虚构或已获授权，同意将本次输入和相关片段发送给 DeepSeek，并接受调用费用。</label>}
        <p className="report-muted">{engine==='mock'?'Mock 验证实际流程与检索，未知产品字段保持资料未提供，不冒充模型提取。':'真实分析调用需求整理、AI 待确认判断和最多3份产品提取；每次格式修复最多一次，单次模型请求限45秒。'}</p>
        <p className="needs-connection" role="status">{connectionError||eligible===null?'知识库：'+(connectionError||'正在连接…'):`当前知识库 · ${eligible} 份有效资料`}</p>
        {connectionError&&<button className="suite-secondary" type="button" onClick={()=>{setConnectionError('');setEligible(null);setAttempt(n=>n+1);}}>重试知识库连接</button>}
        <button className="suite-primary" disabled={eligible===null||!!connectionError||engine==='deepseek'&&!consent}><Play size={15}/>{busy?'正在分析…':result?'重新分析':'开始分析'}</button>
        </fieldset></form>
        {busy&&<button className="suite-secondary needs-stop" onClick={()=>controller.current?.abort()}><Square size={14}/>停止分析</button>}
        <p className="report-muted">最多3个需求、3份候选资料和5个片段。输入及结果不写入知识库或浏览器历史；刷新清除本页内容。</p>
      </section>
      <section className="suite-panel needs-timeline" aria-label="Agent 实际执行过程">
        <h2><GitBranch size={19}/>Agent 工作流</h2><p className="report-muted">{busy?'正在执行实际节点':result?STATUS_LABELS[result.status]:error?'任务中断或失败':'提交后显示实际节点和工具记录'}</p>
        {!steps.length?<div className="needs-flow-empty"><ClipboardList size={30}/><p>客户信息 → 需求与缺口 → 检索 → 核验与匹配 → 报告</p><small>流程示意，尚未执行。不会展示隐藏推理。</small></div>:<details open className="needs-run"><summary>执行记录 · {steps.filter(s=>s.status!=='RUNNING').length}/{steps.length}</summary><ol aria-live="polite">{steps.map(s=><li key={s.stepId} data-status={style[s.status]}><details><summary><span className="needs-dot"/><strong>{s.productIndex?`资料 ${s.productIndex} · `:''}{LABELS[s.stage]}</strong><small>{STATUS_LABELS[s.status]}{s.elapsedMs!==undefined?` · ${(s.elapsedMs/1000).toFixed(1)}s`:''}</small></summary><p>{s.note||'当前节点正在执行。'}</p>{s.retrieval&&<div className="needs-retrieval"><p>查询：{s.retrieval.query}</p><p>知识库：{s.retrieval.library} · {s.retrieval.eligibleDocuments} 份有效文档</p><p>检索方式：{s.retrieval.methods.join(' + ')||'未命中'} · {s.retrieval.documents} 份文档 / {s.retrieval.chunks} 个片段</p><ul>{s.retrieval.hits.map((hit,i)=><li key={i}>{hit.name} · 版本 {hit.version} · {hit.chunks} 个片段</li>)}</ul></div>}</details></li>)}</ol></details>}
      </section>
      <section className="needs-output" aria-label="客户需求分析结果">
        {!result?<div className="suite-panel needs-placeholder"><FileText size={34}/><h2>从明确需求出发</h2><p>结构化输入、沟通优先级、真实候选资料和可追溯证据将在这里呈现。</p><small>资料缺失不等于保障不存在；不自动作适合性或核保决定。</small></div>:<>
          <section className="suite-panel needs-summary"><div className="comparison-result-heading"><h2>需求分析</h2><span className="suite-status">{result.report.engine==='mock'?'Mock · ':'DeepSeek AI · '}{STATUS_LABELS[result.status]}</span></div>
            <p className="report-muted">完成于 {new Date(result.completedAt).toLocaleString('zh-CN')} · 实际检索 {result.report.references.length} 个片段、{new Set(result.report.references.map(r=>r.documentId)).size} 份文档。产品证据状态与 AI 需求判断分别核验。</p>
            <h3>客户核心关注点与沟通顺序</h3>{result.priorities.length?<ol>{result.priorities.map(p=><li key={p.needIndex}><strong>{TOPICS[result.needs[p.needIndex].category]}</strong>{(result.needs[p.needIndex].quotes??[result.needs[p.needIndex].quote]).map(q=><p key={q}>客户原话：“{q}”</p>)}<small>{p.basis}</small></li>)}</ol>:<p>主要需求未明确，不根据人口属性自行推断。</p>}
            {result.monthlyBudget&&<p className="comparison-warning">年度预算按12个月折算：{result.monthlyBudget}元/月。仅作预算参考，不是保费报价。</p>}
            <details><summary>信息缺口 · {result.missing.length}项</summary><ul>{result.missing.map(t=><li key={t}>{t}</li>)}</ul></details><details><summary>后续需要询问的问题</summary><ol>{result.questions.map(t=><li key={t}>{t}</li>)}</ol></details>
            <button className="suite-secondary" onClick={()=>form.current?.scrollIntoView({behavior:'smooth',block:'start'})}>修改客户信息</button>
          </section>
          {result.aiAnalysis&&<section className="suite-panel needs-summary"><h2>AI 判断 · 待客户及人工核实</h2><p>{result.aiAnalysis.summary}</p><p className="comparison-warning">以下是 AI 判断，不是客户已确认信息、产品官方条款或保险推荐；潜在缺口不等于已确认缺口。</p>
            <h3>潜在缺口与待确认判断</h3>{result.aiAnalysis.hypotheses.length?result.aiAnalysis.hypotheses.map((h,i)=><details key={i}><summary>待核实：{h.text}</summary>{h.basis.map((b,j)=><p key={j}>客户输入依据 · {PROFILE_LABELS[b.field]}：“{b.quote}”</p>)}</details>):<p>未提出额外判断。</p>}
            <h3>AI 沟通优先级建议</h3>{result.aiAnalysis.prioritySuggestions.map((n,i)=><details key={i}><summary>{TOPICS[n.category]} · 待客户确认</summary><p>{n.reason}</p>{n.basis.map((b,j)=><p key={j}>{PROFILE_LABELS[b.field]}原话：“{b.quote}”</p>)}</details>)}
            <h3>建议进一步核验的字段</h3><p>{result.aiAnalysis.fieldsToVerify.map(k=>FIELDS.find(([key])=>key===k)![1]).join('、')||'本次无额外字段建议。'}</p><h3>AI 后续追问</h3><ul>{result.aiAnalysis.questions.map((q,i)=><li key={i}>{q}</li>)}</ul>
          </section>}
          <section className="needs-candidates"><h2>候选资料与原文核验</h2><p className="report-muted">检索命中不是产品推荐。缺失字段不能解释为该责任不存在。</p>
            {!result.candidates.length?<div className="suite-panel">未找到足够的有效产品资料，请补充需求或相关文档。</div>:result.candidates.map(c=><article key={c.product.documentId} className="suite-panel"><h3>{c.product.fields.name.status==='SUCCESS'?c.product.fields.name.value:'产品名称待核实'}</h3><p className="report-muted">{c.product.name} · 版本 {c.product.version} · {STATUS_LABELS[c.product.status]}</p>{c.failure&&<p className="report-error" role="alert">{c.failure}</p>}
              <details><summary>查看保障、期间、缴费、投保条件及其他字段</summary><dl>{FIELDS.map(([key,label])=>{const f=c.product.fields[key];return <div key={key}><dt>{label}</dt><dd><small>{EVIDENCE_LABELS[f.status]}</small>{f.value&&<p>{f.value}</p>}{f.note&&<p className="report-muted">{f.note}</p>}{f.evidence&&<details><summary>原文依据〔{f.source}〕</summary><p>{f.quote}</p><small>{f.evidence.fileName} · 版本 {f.evidence.version}{f.evidence.page?` · 第${f.evidence.page}页`:''}</small></details>}</dd></div>;})}</dl></details>
              <p className="comparison-warning">{c.budget}</p>{c.links.map((l,i)=><p key={i} className="needs-match">{l.note}<br/>原文：{l.quote}〔{l.source}〕</p>)}<details><summary>不匹配依据缺口与待核实事项</summary><ul>{c.unknowns.map((t,i)=><li key={i}>{t}</li>)}</ul></details>
            </article>)}
          </section>
          {!!result.products?.length&&<section className="suite-panel needs-candidates"><h2>{result.products.filter(p=>p.identityConfirmed).length>=2?'产品智能对比':'候选资料字段核验'}</h2><p className="report-muted">只按有原文支持的产品名称及公司归并；名称未确认的资料保留独立。字段相同不代表产品相同，不对产品排名。</p>
            {result.products.map(p=><article className="needs-candidate" key={p.id}><h3>{p.displayName}</h3><p>{p.documents.map(d=>d.name+' · 版本 '+d.version).join('；')}</p><details><summary>查看12项字段、冲突和原文</summary><dl>{PRODUCT_FIELDS.map(([key,label])=>{const f=p.fields[key];return <div key={key}><dt>{label}</dt><dd><strong>{f.conflict?'证据冲突，待核实':PROOF_LABELS[f.status]}</strong>{f.value&&<p>{f.value}</p>}<p>{f.note}</p>{f.proofs.map((proof,i)=><details key={i}><summary>原文〔{proof.source}〕 · 版本 {proof.version}{proof.page?' · 第'+proof.page+'页':''}</summary><p>{proof.quote}</p><small>{proof.fileName}</small></details>)}</dd></div>;})}</dl></details></article>)}
            {result.products.length>=2&&<div className="comparison-table-scroll"><table><thead><tr><th>字段</th>{result.products.map(p=><th key={p.id}>{p.displayName}</th>)}</tr></thead><tbody>{PRODUCT_FIELDS.map(([key,label])=><tr key={key}><th>{label}</th>{result.products!.map(p=><td key={p.id}>{fieldDisplay(p.fields[key])}</td>)}</tr>)}</tbody></table></div>}
          </section>}
          <Sources scope="needs" sources={result.report.references.map(r=>({number:r.number,documentId:r.documentId,chunkId:r.chunkId,fileName:r.fileName,version:r.version,page:r.page,kind:'document',score:0,text:''}))}/>
          <section className="suite-panel needs-report"><h2>完整分析报告</h2>{result.report.limitations.map(t=><p className="comparison-warning" key={t}>{t}</p>)}{result.report.content.sections.map((s,i)=><details key={i} open={i===0}><summary>{s.heading}</summary>{s.paragraphs.map((p,j)=><p key={j}>{p.text}{p.sources.length?`〔${p.sources.join('、')}〕`:''}</p>)}{s.table&&<div className="comparison-table-scroll"><table><thead><tr>{s.table.columns.map((v,j)=><th key={j}>{v}</th>)}</tr></thead><tbody>{s.table.rows.map((r,j)=><tr key={j}>{r.map((v,k)=><td key={k}>{v}</td>)}</tr>)}</tbody></table></div>}</details>)}<p>{result.report.content.conclusion}</p>
            <label className="needs-note">修改沟通备注<textarea rows={3} maxLength={1200} disabled={saving} value={note} onChange={e=>setNote(e.target.value)} placeholder="补充需要追问或后续沟通的事项；不会覆盖已核验产品字段。"/></label><button className="suite-secondary" disabled={saving||!note.trim()} onClick={()=>void saveNote()}>{saving?'正在重新导出…':'保存备注并更新报告'}</button>
            <div className="report-actions"><button disabled={downloading||saving} onClick={()=>void download('docx')}><Download size={16}/>下载 Word</button><button disabled={downloading||saving} onClick={()=>void download('pdf')}><Download size={16}/>下载 PDF</button></div><p className="report-muted">下载凭证有效60分钟。来源版本失效时须重新分析；已下载资料无法撤回。</p>
          </section>
        </>}
      </section>
    </div>
  </main></ShowcaseShell>;
}
