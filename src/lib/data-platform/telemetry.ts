import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MODEL } from '../ai';
import type { Source } from '../rag/types';
import { PlatformStore } from './store';
import { safeFile, sha } from './scanner';

type Context={file?:string;runId?:string;libraryId?:string|null;parentQuery?:string;steps?:number;suppressed?:boolean};
const local=new AsyncLocalStorage<Context>();
const health=globalThis as typeof globalThis&{__moyuObservationHealth?:{dropped:number;lastFailure:number|null}};
const failures=health.__moyuObservationHealth??={dropped:0,lastFailure:null};
export const observationHealth=()=>({...failures,scope:'仅本进程；重启前丢失量 UNKNOWN'});
export const withObservationStore=<T>(file:string,action:()=>T)=>local.run({...local.getStore(),file},action);
/** Offline evaluators must not pollute or initialize the business observation DB. */
export const withoutObservation=<T>(action:()=>T)=>local.run({...local.getStore(),suppressed:true},action);
function enabled(){return !local.getStore()?.suppressed&&(!!local.getStore()?.file||(!process.env.MOYU_REPORT_TESTING&&process.env.MOYU_E2E!=='1'));}
function write(action:(db:PlatformStore['db'])=>void){
  if(!enabled())return;let store:PlatformStore|undefined;
  try{store=new PlatformStore(local.getStore()?.file,{busyMs:25});action(store.db);}catch{failures.dropped++;failures.lastFailure=Date.now();}finally{try{store?.close();}catch{/* Observations never change the business outcome. */}}
}
export function libraryIdentity(file?:string|null){
  if(!file)return local.getStore()?.libraryId??null;
  try{const marker=path.join(path.dirname(file),'local-library.json');safeFile(marker);return z.object({id:z.uuid()}).passthrough().parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ marker,'utf8'))).id;}catch{return null;}
}
const statuses=['running','success','partial','insufficient','error','cancelled','unknown'] as const;
type Status=typeof statuses[number];
function status(value:unknown):Status {return ({RUNNING:'running',SUCCESS:'success',PARTIAL_SUCCESS:'partial',INSUFFICIENT:'insufficient',FAILED:'error',CANCELLED:'cancelled',completed:'success',failed:'error',interrupted:'cancelled',pending:'running'} as Record<string,Status>)[String(value)]??(statuses.includes(value as Status)?value as Status:'unknown');}
const nameSchema=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
type Event={type?:string;stepId?:string;stage?:string;status?:string;at?:number;elapsedMs?:number;node?:{nodeId:string;name:string;status:string;startedAt:number;endedAt?:number};record?:{id:string;name:string;startedAt:number};id?:string;sources?:Source[];report?:unknown;finishReason?:string};
function finish(runId:string,state:Status,started:number){const end=Date.now();write(db=>{db.prepare('UPDATE observed_runs SET status=?,ended_at=?,elapsed_ms=?,error_code=? WHERE id=? AND ended_at IS NULL').run(state,end,Math.max(0,end-started),state==='error'?'execution_failed':state==='cancelled'?'user_cancelled':state==='unknown'?'stream_unconfirmed':null,runId);db.prepare("UPDATE observed_steps SET status='unknown',error_code=? WHERE run_id=? AND ended_at IS NULL").run(state==='cancelled'?'run_cancelled_without_step_confirmation':'terminal_without_step_confirmation',runId);});}
export function observeEvent(event:unknown){try{observeEventCore(event);}catch{failures.dropped++;failures.lastFailure=Date.now();}}
function observeEventCore(event:unknown){
  const ctx=local.getStore();if(!ctx?.runId||!event||typeof event!=='object')return;
  const e=event as Event;
  let step:{id:string;name:string;kind:string;state:Status;at:number;end?:number}|undefined;
  if(e.type==='step'&&e.stepId&&e.stage)step={id:e.stepId,name:e.stage,kind:'node',state:status(e.status),at:(e.at??Date.now())-(e.elapsedMs??0),end:status(e.status)==='running'?undefined:e.at??Date.now()};
  if(e.type==='graph_node_start'||e.type==='graph_node_end'){const n=e.node;if(n)step={id:n.nodeId,name:n.name,kind:'node',state:status(n.status),at:n.startedAt,end:n.endedAt};}
  if(e.type==='tool_start'&&e.record)step={id:'tool-'+sha(e.record.id),name:e.record.name,kind:'tool',state:'running',at:e.record.startedAt};
  if(step&&nameSchema.safeParse(step.name).success){
    const s=step;if((ctx.steps??0)<300){ctx.steps=(ctx.steps??0)+1;write(db=>{db.prepare('INSERT INTO observed_steps VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET status=excluded.status,ended_at=excluded.ended_at,elapsed_ms=excluded.elapsed_ms,error_code=excluded.error_code').run(ctx.runId!,s.id,s.kind,s.name,s.state,s.at,s.end??null,s.end===undefined?null:Math.max(0,s.end-s.at),s.state==='error'?'stage_failed':null);});}
  }
  if((e.type==='tool_finish'||e.type==='tool_error')&&e.id)write(db=>{db.prepare('UPDATE observed_steps SET status=?,ended_at=?,elapsed_ms=max(0,?-started_at),error_code=? WHERE run_id=? AND id=?').run(e.type==='tool_finish'?'success':'error',Date.now(),Date.now(),e.type==='tool_error'?'tool_failed':null,ctx.runId!,'tool-'+sha(e.id!));});
  if(e.type==='sources'&&Array.isArray(e.sources))recordCitations(e.sources,'source_card');
  if(e.type==='complete'&&e.report) {
    const report=e.report as {references?:SourceRef[];content?:unknown},numbers=new Set<number>();
    function walk(v:unknown,depth=0){if(depth>12||!v||typeof v!=='object')return;if(Array.isArray(v)){v.slice(0,300).forEach(x=>walk(x,depth+1));return;}for(const [key,value] of Object.entries(v)){if(key==='sources'&&Array.isArray(value)){for(const n of value)if(Number.isInteger(n))numbers.add(n);}else walk(value,depth+1);}}
    walk(report.content);recordCitations((report.references??[]).filter(r=>numbers.has(r.number)),'report_citation');
  }
}
type SourceRef={number:number;documentId:string;chunkId:string;version?:number;page?:number};
function recordCitations(sources:SourceRef[],kind:string){const runId=local.getStore()?.runId;if(!runId)return;for(const s of sources.slice(0,20)){if(!z.uuid().safeParse(s.documentId).success||!z.uuid().safeParse(s.chunkId).success)continue;write(db=>db.prepare('INSERT OR IGNORE INTO observed_citations VALUES(?,?,?,?,?,?)').run(runId,s.documentId,s.version??null,s.chunkId,s.page??null,kind));}}
type RunConfig={type:'agent'|'needs'|'reports'|'comparison';engine?:string;store?:{file?:string}|null;runId?:string;injected?:boolean};
function begin(config:RunConfig){
  let id=z.uuid().safeParse(config.runId).success?config.runId!:randomUUID();const at=Date.now(),libraryId=libraryIdentity(config.store?.file),mode=config.injected?'test-adapter':config.engine==='mock'?'mock':config.engine==='deepseek'?'live':'unknown';
  const ctx={...local.getStore(),runId:id,libraryId,parentQuery:undefined,steps:0};
  let accepted=false;
  local.run(ctx,()=>write(db=>{if(Number(db.prepare('SELECT count(*) n FROM observed_runs').get()!.n)>=10000)throw Error('Observation capacity');if(db.prepare('SELECT id FROM observed_runs WHERE id=?').get(id)){id=randomUUID();ctx.runId=id;}db.prepare('INSERT INTO observed_runs VALUES(?,?,?,?,?,?,?,NULL,\'running\',NULL,NULL,NULL,NULL)').run(id,config.type,config.type==='agent'?'langgraph-agent':`langgraph-${config.type}`,mode,libraryId,mode==='live'?MODEL:null,at);accepted=true;}));
  if(!accepted)ctx.runId='';
  return {ctx,id,at};
}
export async function traceTask<T>(config:RunConfig,signal:AbortSignal,action:(emit:(e:unknown)=>void)=>Promise<T>):Promise<T>{
  if(!enabled())return action(()=>{});
  const run=begin(config);
  return local.run(run.ctx,async()=>{try{const value=await action(observeEvent);const outcome=value&&typeof value==='object'&&'status' in value?status(value.status):'success';if(run.ctx.runId)finish(run.id,outcome,run.at);return value;}catch(error){if(run.ctx.runId)finish(run.id,signal.aborted&&signal.reason?.name!=='TimeoutError'?'cancelled':'error',run.at);throw error;}});
}
export async function* traceGenerator<T>(config:RunConfig,signal:AbortSignal,factory:()=>AsyncGenerator<T>):AsyncGenerator<T>{
  if(!enabled()){yield* factory();return;}
  const run=begin(config),iterator=factory();let terminal:Status='unknown';
  try{while(true){const next=await local.run(run.ctx,()=>iterator.next());if(next.done)break;local.run(run.ctx,()=>observeEvent(next.value));const e=next.value as Event;if(e.type==='done')terminal=e.finishReason==='length'?'partial':'success';if(e.type==='error')terminal=signal.aborted&&signal.reason?.name!=='TimeoutError'?'cancelled':'error';yield next.value;}}
  catch(error){terminal=signal.aborted&&signal.reason?.name!=='TimeoutError'?'cancelled':'error';throw error;}
  finally{try{await local.run(run.ctx,()=>iterator.return(undefined));}finally{if(run.ctx.runId)local.run(run.ctx,()=>finish(run.id,signal.aborted&&terminal==='unknown'?(signal.reason?.name==='TimeoutError'?'error':'cancelled'):terminal,run.at));}}
}
export async function traceRetrieval<T>(query:string,topK:number,store:{file?:string;get?:(id:string)=>{version?:number}},profile:string,action:()=>Promise<T>,select:(result:T)=>Source[]):Promise<T>{
  if(!enabled())return action();
  const ctx=local.getStore(),id=randomUUID(),at=Date.now(),libraryId=libraryIdentity(store.file);
  write(db=>{if(Number(db.prepare('SELECT count(*) n FROM retrieval_requests').get()!.n)>=20000)throw Error('Observation capacity');db.prepare('INSERT INTO retrieval_requests VALUES(?,?,?,?,?,?,?,?,?,NULL,\'running\',NULL)').run(id,ctx?.runId??null,ctx?.parentQuery??null,libraryId,sha(query),query.length,profile,topK,at);});
  return local.run({...ctx,libraryId,parentQuery:id},async()=>{
    try{const result=await action(),hits=select(result);const metadata=hits.map(s=>{let version=s.version;try{version??=store.get?.(s.documentId).version;}catch{/* Version removed after retrieval: preserve UNKNOWN. */}return {source:s,version:typeof version==='number'&&Number.isInteger(version)&&version>0?version:null};});write(db=>{db.exec('BEGIN IMMEDIATE');try{for(const [i,{source:s,version}] of metadata.entries()){db.prepare('INSERT INTO retrieval_hits VALUES(?,?,?,?,?,?,?,?,?)').run(id,i+1,s.documentId,version,s.chunkId,s.page??null,s.kind==='document'?null:s.score,s.kind==='document'?'document-evidence':'cosine',sha(s.text));}db.prepare('UPDATE retrieval_requests SET status=?,elapsed_ms=? WHERE id=?').run(hits.length?'success':'empty',Date.now()-at,id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}});return result;}
    catch(error){const cancelled=error instanceof Error&&error.name==='AbortError';write(db=>db.prepare('UPDATE retrieval_requests SET status=?,elapsed_ms=?,error_code=? WHERE id=?').run(cancelled?'cancelled':'error',Math.max(0,Date.now()-at),cancelled?'retrieval_cancelled':'retrieval_failed',id));throw error;}
  });
}
export function recordLifecycle(store:{file?:string},document:{id:string;logicalId?:string},action:string){
  if(!['upload_queued','replacement_queued','reindex_queued','index_success','index_failed','deleted','state_active','state_inactive','state_archived'].includes(action))return;
  const libraryId=libraryIdentity(store.file);if(!libraryId)return;
  write(db=>db.prepare('INSERT INTO asset_changes VALUES(?,?,?,?,?,?)').run(randomUUID(),libraryId,document.id,document.logicalId??null,action,Date.now()));
}
