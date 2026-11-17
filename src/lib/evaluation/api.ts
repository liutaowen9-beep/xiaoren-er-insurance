import 'server-only';
import { z } from 'zod';
import { authorize,resolveSource } from '../data-platform/api';
import { scanKnowledge,sha,canonical } from '../data-platform/scanner';
import { PlatformError } from '../data-platform/types';
import { EvaluationStore,page } from './store';
import { EvaluationError,listQuery,runInput,safeText } from './types';
import { executeEvaluation } from './runner';
import { exportDataset,importDataset } from './import-export';
import { evaluationReport } from './report';
import type { Adapters } from './readers';

async function body(request:Request){const reader=request.body?.getReader();if(!reader)return {};let size=0;const chunks:Uint8Array[]=[];try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1100000){await reader.cancel();throw new EvaluationError('请求超过大小限制。',413);}chunks.push(r.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}finally{reader.releaseLock();}}
export function createEvaluationApi(factory=()=>new EvaluationStore(),transport?:Adapters){
  return async(request:Request,segments:string[])=>{
    let store:EvaluationStore|undefined;
    try{
      authorize(request);if(segments.length>3||segments.some(s=>s.includes('..')))throw new EvaluationError('路径不合法。',404);
      const [section,id,action]=segments,url=new URL(request.url),method=request.method;
      if(id==='import'&&method!=='POST')throw new EvaluationError('导入入口只允许 POST。',405);
      const valid=section==='overview'&&segments.length===1&&method==='GET'||section==='catalog'&&segments.length===1&&method==='GET'||section==='datasets'&&(method==='GET'&&!action||method==='POST'&&(!id||action==='copy'||id==='import')||method==='PUT'&&!!id&&!action||method==='DELETE'&&!!id&&!action)||section==='datasets'&&method==='GET'&&['versions','export'].includes(action)||section==='runs'&&(method==='GET'&&!action||method==='POST'&&(!id||['execute','cancel','review','report'].includes(action)))||section==='reports'&&method==='GET'&&(!id||!action);
      if(!valid)throw new EvaluationError('接口或请求方法不支持。',405);
      if(id&&id!=='import')z.uuid().parse(id);
      if([...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length>1))throw new EvaluationError('不接受重复查询参数。');
      const query=Object.fromEntries(url.searchParams);const q=listQuery.parse(Object.fromEntries(Object.entries(query).filter(([k])=>!['format','version','compare'].includes(k))));
      if(Object.keys(query).some(k=>!['page','pageSize','type','status','q','format','version','compare'].includes(k)))throw new EvaluationError('未知查询参数。');
      const version=query.version?z.coerce.number().int().positive().parse(query.version):undefined;
      let result:unknown;store=factory();
      if(section==='catalog'){
        if(process.env.MOYU_REPORT_TESTING||process.env.MOYU_E2E==='1')throw new EvaluationError('测试环境未接入正式知识库目录。',403);
        const source=await resolveSource(),scan=await scanKnowledge(source.file,source.libraryId,AbortSignal.any([request.signal,AbortSignal.timeout(120000)]));
        result={libraryId:source.libraryId,corpusHash:sha(canonical(scan.manifest)),embedding:scan.manifest.embedding,documents:scan.manifest.versions.filter(v=>v.isCurrent&&scan.manifest.assets.some(a=>a.currentVersionId===v.id&&a.state==='active')).map(v=>({id:v.id,name:v.name,version:v.version,chunks:scan.manifest.members.filter(m=>m.documentId===v.id).map(m=>({id:m.id,page:m.page}))})),notice:'只读来源标注目录；不含文档正文。'};
      }else if(section==='overview'){
        const runs=store.runs();result={datasets:store.datasets().length,runs:runs.length,byStatus:Object.fromEntries(['pending','running','success','partial','failed','cancelled'].map(s=>[s,runs.filter(r=>r.status===s).length])),recent:runs.slice(0,20),integrity:store.integrity(),paidEnabled:false,notice:'技术执行成功不是答案准确率；模型调用默认关闭。'};
      }else if(section==='datasets'){
        if(method==='POST'&&id==='import'){const input=z.object({format:z.enum(['json','csv']),content:z.string().max(1050000),metadata:z.object({name:safeText(100),description:safeText(1000).optional(),dataPolicy:z.enum(['synthetic','deidentified']),libraryId:z.uuid().optional(),corpusHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().optional()}).strict().parse(await body(request));result=store.saveDataset(importDataset(input.content,input.format,input.metadata));}
        else if(method==='POST'&&action==='copy'){const old=store.dataset(id!);result=store.saveDataset({...stripDataset(old),name:(old.name+'（副本）').slice(0,100)});}
        else if(method==='POST')result=store.saveDataset(await body(request));
        else if(method==='PUT'){const input=z.object({expectedHead:z.number().int().positive(),data:z.unknown()}).strict().parse(await body(request));result=store.saveDataset(input.data,id,input.expectedHead);}
        else if(method==='DELETE'){store.archive(id!);result={archived:true,notice:'历史版本与评测结果保留。'};}
        else if(action==='versions')result={items:store.versions(id!)};
        else if(action==='export'){const format=z.enum(['json','csv']).parse(query.format??'json'),data=stripDataset(store.dataset(id!,version));return new Response(exportDataset(data,format),{headers:{'Content-Type':format==='json'?'application/json; charset=utf-8':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="dataset-${id}.${format}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
        else if(id)result=store.dataset(id,version);
        else result=page(store.datasets().filter(d=>String(d.name).includes(q.q)),q.page,q.pageSize);
      }else if(section==='runs'){
        if(method==='POST'&&!id)result=store.createRun(runInput.parse(await body(request)));
        else if(action==='execute')result=await executeEvaluation(store,id!,request.signal,transport);
        else if(action==='cancel'){store.cancel(id!);result=store.run(id!);}
        else if(action==='review'){const input=z.object({caseId:z.uuid(),score:z.number().min(0).max(1),note:safeText(1000).min(1),reviewer:safeText(60).min(1)}).strict().parse(await body(request));store.review(id!,input.caseId,input.score,input.note,input.reviewer);result=store.run(id!);}
        else if(action==='report'){const input=z.object({format:z.enum(['docx','pdf'])}).strict().parse(await body(request));result={id:await evaluationReport(store,id!,input.format,request.signal)};}
        else if(id){const run=store.run(id);if(query.compare){z.uuid().parse(query.compare);const other=store.run(query.compare);const keys=['datasetHash','scorer','knowledge','libraryId','embedding','retriever'];const comparable=run.type===other.type&&run.config.mode===other.config.mode&&run.config.k===other.config.k&&run.config.level===other.config.level&&keys.every(k=>run.provenance[k]===other.provenance[k]);result={comparable,reason:comparable?'相同数据与评分口径；请核对具体模型/运行方式差异。':'数据集、知识库、评测类型或评分配置不同，不可直接比较。',left:run,right:other};}else result={...run,analysis:store.analysis(id),history:store.history(id),logs:store.logs(id)};}
        else result=page(store.runs().filter(r=>(!q.type||r.type===q.type)&&(!q.status||r.status===q.status)),q.page,q.pageSize);
      }else if(section==='reports'){
        if(!id)result=page(store.reports(),q.page,q.pageSize);else{const file=store.artifact(id),format=String(file.format);return new Response(new Uint8Array(file.bytes as Uint8Array),{headers:{'Content-Type':format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf','Content-Disposition':`attachment; filename="evaluation-${id}.${format}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
      }
      return Response.json(result,{headers:{'Cache-Control':'no-store'}});
    }catch(e){return Response.json({error:e instanceof EvaluationError||e instanceof PlatformError?e.message:e instanceof z.ZodError?'输入校验失败：请检查必填字段、ID、版本和敏感信息。':e instanceof SyntaxError?'JSON/CSV 内容格式错误。':'评测操作失败；未返回原始异常或敏感内容。'},{status:e instanceof EvaluationError||e instanceof PlatformError?e.status:e instanceof z.ZodError||e instanceof SyntaxError?400:500,headers:{'Cache-Control':'no-store'}});}finally{store?.close();}
  };
}
function stripDataset(d:ReturnType<EvaluationStore['dataset']>){const {id,version,hash,archived,...data}=d;void id;void version;void hash;void archived;return data;}
export const evaluationApi=createEvaluationApi();
