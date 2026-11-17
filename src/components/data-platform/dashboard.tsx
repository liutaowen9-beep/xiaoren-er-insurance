'use client';
import {PlatformTabs} from './tabs';
import { useEffect, useRef, useState } from 'react';
import { ShowcaseShell } from '@/components/showcase-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { BarChart, LineChart, PieChart } from '@/components/charts';
import type { PlatformStore } from '@/lib/data-platform/store';
import type { Snapshot } from '@/lib/data-platform/types';
import styles from './dashboard.module.css';

type View='overview'|'assets'|'quality'|'versions'|'snapshots';
type Overview=ReturnType<PlatformStore['overview']>&{platformIntegrity:boolean};
type Assets=ReturnType<PlatformStore['assets']>;
type Quality=ReturnType<PlatformStore['quality']>;
type Snapshots=ReturnType<PlatformStore['snapshots']>;
type Detail=ReturnType<PlatformStore['asset']>;
type Diff=ReturnType<PlatformStore['diff']>;
const date=(n:number|null|undefined)=>n?new Date(n).toLocaleString('zh-CN'):'UNKNOWN';
const states:Record<string,string>={active:'已启用',inactive:'已停用',archived:'已归档',missing:'源库已移除'};
const resultLabel:Record<string,string>={PASS:'PASS · 通过',FAIL:'FAIL · 失败',WARNING:'WARNING · 警告',UNKNOWN:'UNKNOWN · 无法确认'};
async function json<T>(url:string,init?:RequestInit):Promise<T>{const r=await fetch(url,{cache:'no-store',...init});const body=await r.json();if(!r.ok)throw new Error(body.error??'数据中台请求失败。');return body;}

export function DataDashboard({view}:{view:View}){
  const [overview,setOverview]=useState<Overview|null>(null),[assets,setAssets]=useState<Assets|null>(null),[quality,setQuality]=useState<Quality|null>(null),[snapshots,setSnapshots]=useState<Snapshots|null>(null);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[reload,setReload]=useState(0),[page,setPage]=useState(1);
  const [draft,setDraft]=useState(''),[search,setSearch]=useState(''),[state,setState]=useState('all'),[sort,setSort]=useState('updatedAt'),[result,setResult]=useState('all');
  const [detail,setDetail]=useState<Detail|null>(null),[diff,setDiff]=useState<Diff|null>(null),[snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const scanAbort=useRef<AbortController|null>(null),detailAbort=useRef<AbortController|null>(null);
  useEffect(()=>()=>{scanAbort.current?.abort();detailAbort.current?.abort();},[]);
  useEffect(()=>{
    const controller=new AbortController();
    async function load(){
      setLoading(true);setError('');
      try{
        const o=await json<Overview>('/api/data-platform/overview',{signal:controller.signal});
        if(controller.signal.aborted)return;setOverview(o);
        const q=new URLSearchParams({page:String(page),pageSize:'20',search,state,sort,result});
        if(view==='assets'||view==='versions'){const a=await json<Assets>(`/api/data-platform/assets?${q}`,{signal:controller.signal});if(!controller.signal.aborted)setAssets(a);}
        if(view==='quality'){const a=await json<Quality>(`/api/data-platform/quality?${q}`,{signal:controller.signal});if(!controller.signal.aborted)setQuality(a);}
        if(view==='snapshots'){const a=await json<Snapshots>(`/api/data-platform/snapshots?page=${page}`,{signal:controller.signal});if(!controller.signal.aborted)setSnapshots(a);}
      }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'加载失败。');}finally{if(!controller.signal.aborted)setLoading(false);}
    }
    void load();return()=>controller.abort();
  },[view,page,search,state,sort,result,reload]);
  async function scan(){
    if(busy)return;const controller=new AbortController();scanAbort.current=controller;setBusy(true);setError('');setNotice('正在读取知识库稳定副本、核对哈希与质量；不执行索引。');
    try{await json('/api/data-platform/scans',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:controller.signal});setNotice('扫描完成，质量结果和不可变快照已保存。');setPage(1);setReload(v=>v+1);}catch(e){setNotice('');setError(controller.signal.aborted?'扫描已请求取消；如提交已完成，请刷新核对快照。':e instanceof Error?e.message:'扫描失败。');}finally{setBusy(false);scanAbort.current=null;}
  }
  async function showAsset(id:string){
    detailAbort.current?.abort();const c=new AbortController();detailAbort.current=c;setDetail(null);setError('');
    try{const a=await json<Detail>(`/api/data-platform/assets/${id}`,{signal:c.signal});const v=await json<{items:Detail['versions']}>(`/api/data-platform/assets/${id}/versions?pageSize=100`,{signal:c.signal});if(!c.signal.aborted)setDetail({...a,versions:v.items});}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'详情加载失败。');}
  }
  async function showSnapshot(id:string){
    detailAbort.current?.abort();const c=new AbortController();detailAbort.current=c;setError('');setDiff(null);setSnapshot(null);
    try{const [s,d]=await Promise.all([json<Snapshot>(`/api/data-platform/snapshots/${id}`,{signal:c.signal}),json<Diff>(`/api/data-platform/snapshots/${id}/diff`,{signal:c.signal})]);if(!c.signal.aborted){setSnapshot(s);setDiff(d);}}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'快照加载失败。');}
  }
  const source={kind:'business' as const,label:'数据中台最近成功的只读扫描',scope:'当前登记知识库；元数据快照，非实时统计',observedAt:overview?.lastScan?date(overview.lastScan):undefined,metricDefinition:'逻辑文档、物理版本与切片分别计数；异常按检查项计数'};
  const total=view==='quality'?quality?.total:view==='snapshots'?snapshots?.total:assets?.total;
  return <ShowcaseShell active="data-platform"><main className={styles.root}>
    <div className="suite-page-heading"><div><span className="suite-eyebrow">DATA PLATFORM · V10.0</span><h1>数据中台</h1><p>资产、质量、版本与 SHA-256 快照。只读观察知识库，不修复或修改源数据。</p></div><div className={styles.actions}><Button onClick={()=>void scan()} disabled={busy}>{busy?'正在扫描…':'执行只读扫描'}</Button>{busy&&<Button variant="outline" onClick={()=>scanAbort.current?.abort()}>取消扫描</Button>}<Button variant="outline" disabled={busy} onClick={()=>setReload(v=>v+1)}>刷新结果</Button></div></div>
    <PlatformTabs view={view} className={styles.tabs}/>
    {error&&<div role="alert" className={styles.error}>{error}</div>}{notice&&<p role="status">{notice}</p>}{loading&&<p role="status">正在读取中台记录…</p>}
    {!loading&&overview&&!overview.initialized&&<Card><CardContent><h2>尚未扫描知识库</h2><p>统计尚未接入，请执行首次只读扫描。未知数据不会显示为零。</p></CardContent></Card>}
    {view==='overview'&&<><div className={styles.metrics}>{[['数据资产总数',overview?.counts?.assets],['有效文档',overview?.counts?.active],['文档版本',overview?.counts?.versions],['切片总数',overview?.counts?.chunks],['向量总数',overview?.counts?.vectors],['异常检查项',overview?.anomalies]].map(([label,value])=><Card key={String(label)}><CardContent><span>{label}</span><strong>{value??'—'}</strong></CardContent></Card>)}</div><p>最近扫描：{date(overview?.lastScan)} · 中台完整性：{overview?overview.platformIntegrity?'PASS':'FAIL':'UNKNOWN'}</p><div className={styles.charts}>
      <BarChart title="数据资产统计" source={source} notConnected={!overview?.initialized} categories={['逻辑文档','文档版本','切片','向量']} series={overview?.counts?[{name:'数量',values:[overview.counts.assets,overview.counts.versions,overview.counts.chunks,overview.counts.vectors]}]:[]}/>
      <PieChart title="当前版本文件类型" source={source} notConnected={!overview?.initialized} data={overview?.types??[]}/>
      <PieChart title="数据质量状态" source={source} notConnected={!overview?.initialized} data={overview?Object.entries(overview.quality).map(([name,value])=>({name,value})):[]}/>
      <LineChart title="扫描时文档版本数量" source={{...source,metricDefinition:'最近 20 次成功扫描的版本数量；不是上传次数或每日新增量'}} notConnected={!overview?.initialized} categories={overview?.trend.map((t,i)=>`${i+1} · ${date(t.at)}`)??[]} series={overview?.initialized?[{name:'版本数',values:overview.trend.map(t=>t.versions)}]:[]}/>
    </div></>}
    {(view==='assets'||view==='versions'||view==='quality')&&<form className={styles.filters} onSubmit={e=>{e.preventDefault();setSearch(draft);setPage(1);}}><Input aria-label="搜索文档" placeholder="文档名称或质量检查名称" value={draft} onChange={e=>setDraft(e.target.value)}/><Button type="submit" variant="outline">搜索</Button>{view==='quality'?<label>检查结果<select value={result} onChange={e=>{setResult(e.target.value);setPage(1);}}>{['all','PASS','FAIL','WARNING','UNKNOWN'].map(v=><option key={v} value={v}>{v==='all'?'全部结果':v}</option>)}</select></label>:<><label>文档状态<select value={state} onChange={e=>{setState(e.target.value);setPage(1);}}>{['all','active','inactive','archived','missing'].map(v=><option key={v} value={v}>{states[v]??'全部状态'}</option>)}</select></label><label>排序<select value={sort} onChange={e=>{setSort(e.target.value);setPage(1);}}><option value="updatedAt">更新时间倒序</option><option value="createdAt">创建时间倒序</option><option value="name">名称倒序</option></select></label></>}</form>}
    {(view==='assets'||view==='versions')&&<div className={styles.scroll}><table><caption>{view==='versions'?'选择文档查看历史版本与哈希变化':'资产目录 · 来自最近成功扫描'}</caption><thead><tr>{['文档','类型','当前版本','大小','SHA-256','切片 / 向量','状态','创建 / 更新','操作'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{assets?.items.map(a=><tr key={a.id}><td>{a.name}</td><td>{a.current?.extension??'UNKNOWN'}</td><td>{a.current?.version??'UNKNOWN'}</td><td>{a.current?.size??'UNKNOWN'} B</td><td><code>{a.current?.hash??'UNKNOWN'}</code></td><td>{a.current?.chunkCount??'UNKNOWN'} / {a.current?.vectorCount??'UNKNOWN'}</td><td>{states[a.state]??a.state}</td><td>{date(a.createdAt)}<br/>{date(a.updatedAt)}</td><td><Button size="sm" variant="outline" onClick={()=>void showAsset(a.id)}>查看详情</Button></td></tr>)}</tbody></table>{assets?.total===0&&<p>没有符合条件的资产。</p>}</div>}
    {detail&&<Card aria-label="资产详情"><CardHeader><CardTitle>{detail.name} · 版本历史</CardTitle><Button variant="ghost" onClick={()=>setDetail(null)}>关闭详情</Button></CardHeader><CardContent><p>来源库 ID：{detail.sourceId} · 状态：{states[detail.state]??detail.state}</p><p>更新：{date(detail.updatedAt)}。历史版本仅供溯源，不能作为当前检索依据。</p>{detail.versions.map((v,i)=><section key={v.id} className={styles.version}><h3>版本 {v.version} {v.id===detail.currentVersionId?'· 当前版本':'· 历史/候选版本'}</h3><p>{v.status} · {date(v.createdAt)} · {v.chunkCount} 个切片 / {v.vectorCount} 个向量</p><p>文件哈希：<code>{v.hash}</code></p><p>与上一版本：{detail.versions[i+1]?v.hash===detail.versions[i+1].hash?'文件哈希相同':'文件哈希变化':'首次版本'}</p><p>Embedding：{v.model??'UNKNOWN'} · {v.dimension??'UNKNOWN'} 维</p></section>)}</CardContent></Card>}
    {view==='quality'&&<div className={styles.scroll}><table><caption>最近扫描质量检查；停用、归档和保留重复版本可能为合法管理状态。</caption><thead><tr>{['检查名称','结果','对应文档','异常/说明','处理建议','检查时间'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{quality?.items.map(c=><tr key={c.id}><td>{c.name}</td><td data-result={c.result}>{resultLabel[c.result]}</td><td>{c.documentName??'全库'}</td><td>{c.reason}</td><td>{c.suggestion}</td><td>{date(c.checkedAt)}</td></tr>)}</tbody></table>{quality?.total===0&&<p>暂无检查记录。</p>}</div>}
    {view==='snapshots'&&<><p>每次扫描追加独立快照；相同内容哈希不会覆盖历史。快照不包含原文件、正文或向量，不能替代完整备份。</p><div className={styles.scroll}><table><thead><tr>{['快照编号','扫描时间','文档 / 版本 / 切片','清单 SHA-256','与上次比较','操作'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{snapshots?.items.map(s=><tr key={s.id}><td>{s.id}</td><td>{date(s.createdAt)}</td><td>{s.counts.assets} / {s.counts.versions} / {s.counts.chunks}</td><td><code>{s.hash}</code></td><td>{s.changed?'有变化 / 首次扫描':'内容未变化'}</td><td><Button size="sm" variant="outline" onClick={()=>void showSnapshot(s.id)}>查看快照差异</Button></td></tr>)}</tbody></table></div>
      {snapshot&&diff&&<Card aria-label="快照差异"><CardContent><h2>快照差异</h2><p>{diff.unchanged?'内容未变化':'检测到变化'} · 状态变化 {diff.stateChanges.length} 项</p><p>前一快照：{diff.previousId??'无（首次扫描）'}</p><BarChart title="快照差异数量" source={source} categories={['逻辑文档','文档版本','切片']} series={['added','removed','modified'].map(key=>({name:({added:'新增',removed:'移除',modified:'修改'} as Record<string,string>)[key],values:[diff.assets,diff.versions,diff.chunks].map(d=>d[key as keyof typeof d].length)}))}/><details><summary>查看变化标识与哈希清单</summary><pre>{JSON.stringify({diff,manifest:snapshot.manifest},null,2)}</pre><p>切片哈希清单按页返回，完整分页接口见 README。</p></details></CardContent></Card>}
    </>}
    {view!=='overview'&&<div className={styles.actions}><Button variant="outline" disabled={page<=1||loading} onClick={()=>setPage(p=>p-1)}>上一页</Button><span>第 {page} 页 · 共 {total??'—'} 项</span><Button variant="outline" disabled={loading||page*20>=(total??0)} onClick={()=>setPage(p=>p+1)}>下一页</Button></div>}
  </main></ShowcaseShell>;
}
