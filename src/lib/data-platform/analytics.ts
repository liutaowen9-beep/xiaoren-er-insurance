import 'server-only';
import { z } from 'zod';
import { PlatformStore, assetKey, snapshotDiff } from './store';
import { observationHealth } from './telemetry';
import { PlatformError } from './types';
import type { QualityCheck } from './types';

export const monitorQuery=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),window:z.enum(['24h','7d','30d','all']).default('7d'),mode:z.enum(['all','live','mock','test-adapter','unknown']).default('all'),type:z.enum(['all','agent','needs','reports','comparison']).default('all'),status:z.enum(['all','running','success','partial','insufficient','error','cancelled','unknown','empty']).default('all'),libraryId:z.uuid().optional(),assetId:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export type MonitorQuery=z.infer<typeof monitorQuery>;
type Run={id:string;type:string;workflow:string;mode:string;library_id:string|null;model:string|null;started_at:number;ended_at:number|null;status:string;elapsed_ms:number|null;input_tokens:number|null;output_tokens:number|null;error_code:string|null};
type Step={run_id:string;id:string;kind:string;name:string;status:string;started_at:number;ended_at:number|null;elapsed_ms:number|null;error_code:string|null};
type Retrieval={id:string;run_id:string|null;parent_id:string|null;library_id:string|null;query_hash:string;query_length:number;profile:string;top_k:number;started_at:number;elapsed_ms:number|null;status:string;error_code:string|null};
type Hit={request_id:string;rank:number;document_id:string;version:number|null;chunk_id:string;page:number|null;score:number|null;method:string;text_hash:string};
const cutoff=(q:MonitorQuery)=>q.window==='all'?0:Date.now()-({'24h':86400000,'7d':604800000,'30d':2592000000}[q.window]);
const mean=(values:(number|null)[])=>{const known=values.filter((v):v is number=>v!==null);return known.length?Math.round(known.reduce((a,b)=>a+b,0)/known.length):null;};
const ratio=(yes:number,total:number)=>total?Math.round(yes/total*10000)/100:null;
function page<T>(items:T[],q:MonitorQuery){return {items:items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:items.length,page:q.page,pageSize:q.pageSize};}
const stale=<T extends {status:string;started_at:number}>(r:T):T=>r.status==='running'&&Date.now()-r.started_at>600000?{...r,status:'unknown'}:r;
export class PlatformAnalytics{
  constructor(public store:PlatformStore){}
  runs(q:MonitorQuery){return (this.store.db.prepare('SELECT * FROM observed_runs WHERE started_at>=? ORDER BY started_at DESC LIMIT 10000').all(cutoff(q)) as unknown as Run[]).map(r=>stale(r) as Run).filter(r=>(q.type==='all'||r.type===q.type)&&(q.mode==='all'||r.mode===q.mode)&&(q.status==='all'||r.status===q.status)&&(!q.libraryId||r.library_id===q.libraryId));}
  runList(q:MonitorQuery){return page(this.runs(q),q);}
  runDetail(id:string){const row=this.store.db.prepare('SELECT * FROM observed_runs WHERE id=?').get(id) as unknown as Run|undefined;if(!row)throw new PlatformError('运行记录不存在。',404);const run=stale(row) as Run;return {run,steps:(this.store.db.prepare('SELECT * FROM observed_steps WHERE run_id=? ORDER BY started_at,rowid').all(id) as unknown as Step[]).map(s=>run.status==='unknown'&&s.status==='running'?{...s,status:'unknown'}:s),retrievals:this.store.db.prepare('SELECT * FROM retrieval_requests WHERE run_id=? ORDER BY started_at').all(id),citations:this.store.db.prepare('SELECT * FROM observed_citations WHERE run_id=?').all(id),notice:'只展示实际执行元数据；Token 未采集为 UNKNOWN，不保存客户输入、工具参数、模型上下文或原文。'};}
  runStats(q:MonitorQuery){
    const runs=this.runs({...q,status:'all'}),terminal=runs.filter(r=>['success','partial','insufficient','error'].includes(r.status)),errors=terminal.filter(r=>r.status==='error').length;
    const ids=new Set(runs.map(r=>r.id));const steps=(this.store.db.prepare('SELECT * FROM observed_steps WHERE started_at>=? ORDER BY started_at DESC LIMIT 100000').all(cutoff(q)) as unknown as Step[]).filter(s=>ids.has(s.run_id));
    const groups=new Map<string,{name:string;success:number;error:number;other:number;terminal:number}>();
    for(const s of steps.filter(s=>s.kind==='node')){const g=groups.get(s.name)??{name:s.name,success:0,error:0,other:0,terminal:0};if(['success','partial','insufficient','error'].includes(s.status)){g.terminal++;if(s.status==='success')g.success++;else if(s.status==='error')g.error++;else g.other++;}groups.set(s.name,g);}
    return {total:runs.length,failures:errors,failureRate:ratio(errors,terminal.length),settled:terminal.length,averageMs:mean(terminal.map(r=>r.elapsed_ms)),nodes:[...groups.values()].map(g=>({...g,successRate:ratio(g.success,g.terminal)})),states:countBy(runs,r=>r.status),health:observationHealth(),metricDefinition:'运行失败率=error/(success+partial+insufficient+error)，排除未结束、取消和未确认；节点成功率=success/已确认终态节点，不代表任务答案正确率。平均耗时仅统计已确认终态且有耗时的记录。',usage:'UNKNOWN：当前传输未提供统一 usage，未推算 Token 或成本。'};
  }
  retrievals(q:MonitorQuery){
    const runIds=new Set(this.runs({...q,status:'all'}).map(r=>r.id));
    return (this.store.db.prepare('SELECT * FROM retrieval_requests WHERE started_at>=? AND parent_id IS NULL ORDER BY started_at DESC LIMIT 20000').all(cutoff(q)) as unknown as Retrieval[]).map(r=>stale(r) as Retrieval).filter(r=>(q.status==='all'||r.status===q.status)&&(!q.libraryId||r.library_id===q.libraryId)&&((q.type==='all'&&q.mode==='all')||r.run_id!==null&&runIds.has(r.run_id)));
  }
  retrievalList(q:MonitorQuery){return page(this.retrievals(q),q);}
  retrievalDetail(id:string){
    const request=this.store.db.prepare('SELECT * FROM retrieval_requests WHERE id=?').get(id) as unknown as Retrieval|undefined;if(!request)throw new PlatformError('检索记录不存在。',404);
    const hits=this.store.db.prepare('SELECT * FROM retrieval_hits WHERE request_id=? ORDER BY rank').all(id) as unknown as Hit[];
    const citations=request.run_id?this.store.db.prepare('SELECT * FROM observed_citations WHERE run_id=?').all(request.run_id):[];
    const names=this.versionNames();
    return {request:stale(request),hits:hits.map(h=>({...h,documentName:names.get(`${request.library_id}:${h.document_id}`)??'未扫描的文档版本',assetId:request.library_id?this.findAsset(request.library_id,h.document_id):null})),citations,children:this.store.db.prepare('SELECT * FROM retrieval_requests WHERE parent_id=?').all(id),notice:'返回片段不等于答案正确。report_citation 是结构化报告采用的编号；source_card 仅代表实际发送的引用卡片。未采集到引用不能断言模型没有使用。关键词候选没有余弦分数，不以 0 伪造置信度。'};
  }
  retrievalStats(q:MonitorQuery){
    const requests=this.retrievals({...q,status:'all'}),ids=new Set(requests.map(r=>r.id));const hits=(this.store.db.prepare('SELECT h.*,r.library_id FROM retrieval_hits h JOIN retrieval_requests r ON r.id=h.request_id WHERE r.started_at>=? AND r.parent_id IS NULL').all(cutoff(q)) as unknown as (Hit&{library_id:string|null})[]).filter(h=>ids.has(h.request_id));
    const names=this.versionNames(),freq=new Map<string,{id:string;name:string;hits:number}>();
    for(const h of hits){const id=`${h.library_id}:${h.document_id}`;const g=freq.get(id)??{id,name:names.get(id)??'未扫描版本 · '+h.document_id.slice(0,8),hits:0};g.hits++;freq.set(id,g);}
    const selected=new Map<string,number>();hits.forEach(h=>selected.set(h.request_id,(selected.get(h.request_id)??0)+1));
    const daily=new Map<string,{day:string;requests:number;empty:number;errors:number}>();for(const r of requests){const day=new Date(r.started_at+8*3600000).toISOString().slice(0,10),v=daily.get(day)??{day,requests:0,empty:0,errors:0};v.requests++;if(r.status==='empty')v.empty++;if(r.status==='error')v.errors++;daily.set(day,v);}
    return {total:requests.length,empty:requests.filter(r=>r.status==='empty').length,errors:requests.filter(r=>r.status==='error').length,averageMs:mean(requests.filter(r=>['success','empty','error'].includes(r.status)).map(r=>r.elapsed_ms)),documents:[...freq.values()].sort((a,b)=>b.hits-a.hits).slice(0,20),topK:requests.map(r=>({id:r.id,k:r.top_k,returned:selected.get(r.id)??0,status:r.status})).slice(0,20),trend:[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day)),metricDefinition:'只统计顶层检索，混合检索的向量子请求单独保留但不重复计数。命中频率=返回片段次数，不是 Recall/准确率；日桶 Asia/Shanghai，仅展示有记录的日期。'};
  }
  quality(libraryId?:string){
    const snapshot=this.store.latest(libraryId);if(!snapshot)return {initialized:false,score:null,metrics:null,groups:[],trend:[],checks:[],change:null,rule:'quality-pass-rate-v1',formula:'100 × PASS/(PASS+FAIL+WARNING+UNKNOWN)，等权；分母为0时 UNKNOWN'};
    const checks=this.store.db.prepare('SELECT payload FROM quality_checks WHERE snapshot_id=?').all(snapshot.id).map(r=>JSON.parse(String(r.payload)) as QualityCheck);
    const manifest=snapshot.manifest,states=manifest.assets.filter(a=>a.state!=='active'||!manifest.versions.some(v=>v.id===a.currentVersionId&&v.status==='ready'&&v.logicalId===a.id)).length;
    const emptyKnown=manifest.members.every(m=>m.contentEmpty!==undefined);
    const metrics={documents:manifest.assets.length,versions:manifest.versions.length,chunks:manifest.members.length,vectors:snapshot.counts.vectors,nonRetrievable:states,nonCurrentVersions:manifest.versions.filter(v=>!manifest.assets.some(a=>a.currentVersionId===v.id&&a.id===v.logicalId)).length,emptyContentVersions:emptyKnown?manifest.versions.filter(v=>!manifest.members.some(m=>m.documentId===v.id&&!m.contentEmpty)).length:null,orphanChunks:manifest.qualityMetrics?.orphanChunks??(checks.some(c=>c.rule==='orphan_chunks'&&c.result==='PASS')?0:null),relationFailures:checks.filter(c=>['version_relation','current','orphan_chunks','foreign_keys','vectors','chunks'].includes(c.rule)&&c.result==='FAIL').length,integrity:checks.find(c=>c.rule==='integrity')?.result??'UNKNOWN'};
    const snapshots=this.store.db.prepare('SELECT id,created_at FROM corpus_snapshots WHERE source_id=? ORDER BY rowid DESC LIMIT 20').all(snapshot.sourceId).reverse();
    const trend=snapshots.map(s=>{const rows=this.store.db.prepare('SELECT result FROM quality_checks WHERE snapshot_id=?').all(s.id);return {id:String(s.id),at:Number(s.created_at),checks:rows.length,score:ratio(rows.filter(r=>r.result==='PASS').length,rows.length)};});
    const previous=trend.at(-2),current=trend.at(-1);const change=previous&&current?{previousId:previous.id,currentId:current.id,deltaScore:previous.score!==null&&current.score!==null?Math.round((current.score-previous.score)*100)/100:null,sameDenominator:previous.checks===current.checks}:null;
    return {initialized:true,score:ratio(checks.filter(c=>c.result==='PASS').length,checks.length),metrics,groups:countBy(checks.filter(c=>c.result!=='PASS'),c=>c.name),trend,checks:checks.filter(c=>c.result!=='PASS'),change,rule:'quality-pass-rate-v1',formula:'100 × PASS/(PASS+FAIL+WARNING+UNKNOWN)，所有检查项等权，未知不当通过；分母为0时 UNKNOWN。合法停用/归档也产生警告，分数不等于业务质量或保险准确率。历史规则和覆盖范围可能不同，不作为固定样本集准确率。'};
  }
  private versionNames(){const names=new Map<string,string>();for(const r of this.store.db.prepare('SELECT a.source_id,v.external_id,v.payload FROM asset_versions v JOIN assets a ON v.asset_id=a.id').all()){const v=JSON.parse(String(r.payload));names.set(`${r.source_id}:${r.external_id}`,String(v.name));}return names;}
  private findAsset(library:string,version:string){const row=this.store.db.prepare('SELECT a.id FROM assets a JOIN asset_versions v ON v.asset_id=a.id WHERE a.source_id=? AND v.external_id=?').get(library,version);return row?String(row.id):null;}
  lineage(q:MonitorQuery){
    let snapshot=this.store.latest(q.libraryId);if(!snapshot)return {initialized:false,nodes:[],edges:[],assets:[],changes:[],truncated:false,totalNodes:0};
    const latestId=snapshot.id;
    const assets=this.store.db.prepare('SELECT id FROM assets WHERE source_id=? ORDER BY missing,id').all(snapshot.sourceId).map(r=>this.store.asset(String(r.id))).map(a=>({id:a.id,name:(a.state==='missing'?'已移除 · ':'')+a.name,externalId:a.externalId}));
    const selected=q.assetId?assets.find(a=>a.id===q.assetId):assets.find(a=>snapshot!.manifest.assets.some(m=>m.id===a.externalId));if(q.assetId&&!selected)throw new PlatformError('资产不在该知识库中。',404);
    if(selected&&!snapshot.manifest.assets.some(a=>a.id===selected.externalId)){const prior=this.store.db.prepare("SELECT id FROM corpus_snapshots WHERE source_id=? AND EXISTS(SELECT 1 FROM json_each(manifest,'$.assets') a WHERE json_extract(a.value,'$.id')=?) ORDER BY rowid DESC LIMIT 1").get(snapshot.sourceId,selected.externalId);if(!prior)throw new PlatformError('没有可追溯的历史快照。',404);snapshot=this.store.snapshot(String(prior.id));}
    const m=snapshot.manifest;
    type Node={id:string;kind:string;label:string;level:number;meta:Record<string,unknown>};const nodes:Node[]=[],edges:{source:string;target:string}[]=[];
    const add=(kind:string,id:string,label:string,level:number,meta:Record<string,unknown>,parent?:string)=>{const key=assetKey(m.libraryId,kind+':'+id);if(!nodes.some(n=>n.id===key))nodes.push({id:key,kind,label,level,meta});if(parent)edges.push({source:parent,target:key});return key;};
    if(selected){
      const doc=m.assets.find(a=>a.id===selected.externalId)!;const raw=add('document',doc.id,selected.name,0,{...doc,snapshotId:snapshot.id});
      for(const v of m.versions.filter(v=>v.logicalId===doc.id)){const version=add('version',v.id,`版本 ${v.version}${v.isCurrent?' · 当前':''}`,1,{...v},raw);for(const c of m.members.filter(c=>c.documentId===v.id).slice(0,120)){const chunk=add('chunk',c.id,`片段 ${c.sequence+1}${c.page?` · 页${c.page}`:''}`,2,{...c},version),vector=add('vector',c.id,'向量 · '+c.dimension+'维',3,{hash:c.vectorHash,model:c.model},chunk);
        const hits=this.store.db.prepare('SELECT h.*,r.started_at,r.id AS query_id FROM retrieval_hits h JOIN retrieval_requests r ON r.id=h.request_id WHERE r.library_id=? AND h.document_id=? AND h.chunk_id=? AND r.parent_id IS NULL ORDER BY r.started_at DESC LIMIT 10').all(m.libraryId,v.id,c.id);
        for(const hit of hits)add('retrieval',String(hit.query_id),`检索 ${String(hit.query_id).slice(0,8)}`,4,{requestId:hit.query_id,rank:hit.rank,score:hit.score,method:hit.method,at:hit.started_at},vector);
      }}
    }
    const actual=this.store.db.prepare('SELECT document_id,logical_id,action,at FROM asset_changes WHERE library_id=? ORDER BY at DESC LIMIT 100').all(m.libraryId).map(r=>({documentId:String(r.document_id),logicalId:r.logical_id===null?null:String(r.logical_id),action:String(r.action),at:Number(r.at),source:'实际操作事件'}));
    const previousRow=this.store.db.prepare('SELECT id FROM corpus_snapshots WHERE source_id=? AND rowid<(SELECT rowid FROM corpus_snapshots WHERE id=?) ORDER BY rowid DESC LIMIT 1').get(m.libraryId,snapshot.id);
    const observed=previousRow?snapshotDiff(this.store.snapshot(String(previousRow.id)),snapshot):null;
    const visible=nodes.slice(0,180),ids=new Set(visible.map(n=>n.id));
    return {initialized:true,sourceId:m.libraryId,snapshotId:snapshot.id,capturedAt:snapshot.createdAt,selectedAsset:selected?.id??null,assets,nodes:visible,edges:edges.filter(e=>ids.has(e.source)&&ids.has(e.target)),changes:actual,observedDiff:observed,truncated:visible.length<nodes.length||m.members.filter(c=>m.versions.some(v=>v.logicalId===selected?.externalId&&v.id===c.documentId)).length>120,totalNodes:nodes.length,historical:snapshot.id!==latestId,notice:(snapshot.id!==latestId?'历史快照：该源对象可能已移除，不得作为当前证据。':'')+'节点连线表示实际关联，不是流量或模型思维链。无历史操作日志时，仅显示扫描观察到的变化，不能判定具体操作或发生时间。停用/历史版本在此仅供溯源，不进入默认检索。'};
  }
}
function countBy<T>(rows:T[],key:(r:T)=>string){const map=new Map<string,number>();for(const r of rows)map.set(key(r),(map.get(key(r))??0)+1);return [...map].map(([name,value])=>({name,value}));}
