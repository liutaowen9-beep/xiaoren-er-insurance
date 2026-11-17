import 'server-only';
import {z} from 'zod';
import {authorize} from '../data-platform/api';
import {PlatformError} from '../data-platform/types';
import {safeText} from '../evaluation/types';
import {ModelStore} from './store';
import {taskInput,modelId,priceSchema,ModelError} from './types';
import {configured,type ModelAdapter} from './adapter';
import {datasetList,datasetSnapshot} from './datasets';
import {executeModelRun} from './runner';
import {summarize,comparable} from './analysis';
import {modelReport} from './report';
type Options={factory?:()=>ModelStore;datasetFile?:string;adapter?:ModelAdapter;isConfigured?:()=>boolean};
async function readBody(request:Request){const reader=request.body?.getReader();if(!reader)return {};const chunks:Uint8Array[]=[];let size=0;try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>65536){await reader.cancel();throw new ModelError('参数超过 64KB。',413);}chunks.push(r.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}finally{reader.releaseLock();}}
export function createModelApi(options:Options={}){
  return async(request:Request,segments:string[])=>{
    let store:ModelStore|undefined;
    try{
      authorize(request);if(segments.length>3)throw new ModelError('路径不合法。',404);const [section,id,action]=segments,method=request.method,url=new URL(request.url);
      const allowed=section==='models'&&(!id&&method==='GET'||id&&!action&&method==='POST'||id&&action==='prices'&&['GET','POST'].includes(method))||section==='datasets'&&!id&&method==='GET'||section==='runs'&&(!id&&['GET','POST'].includes(method)||id&&!action&&method==='GET'||id&&['authorize','execute','cancel','report'].includes(action)&&method==='POST')||section==='compare'&&!id&&method==='GET'||section==='reports'&&id&&!action&&method==='GET';
      if(!allowed)throw new ModelError('模型中心接口或方法不支持。',405);
      if(section==='models'&&id)modelId.parse(id);if((section==='runs'||section==='reports')&&id)z.uuid().parse(id);
      if([...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length>1))throw new ModelError('拒绝重复查询参数。');
      const q=z.object({page:z.coerce.number().int().min(1).max(1000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),mode:z.enum(['live','mock']).optional(),status:z.enum(['pending','running','success','partial','failed','cancelled']).optional(),left:z.uuid().optional(),right:z.uuid().optional()}).strict().parse(Object.fromEntries(url.searchParams));
      store=options.factory?.()??new ModelStore();let value:unknown;
      if(section==='models'){
        if(!id)value={items:store.models().map(m=>({...m,prices:store!.prices(m.id)})),configured:options.isConfigured?.()??configured(),endpoint:'https://api.deepseek.com/chat/completions',liveAuthorizationRequired:true,integrity:store.integrity()};
        else if(action==='prices'){
          if(method==='GET')value={items:store.prices(id)};else{const input=z.object({price:priceSchema,acknowledgeSource:z.literal(true)}).strict().parse(await readBody(request));if(input.price.model!==id)throw new ModelError('价格与模型不一致。');value=store.addPrice({...input.price,verification:'user-confirmed'});}
        }else{const input=z.object({name:safeText(100).min(1),enabled:z.boolean(),revision:z.number().int().positive(),version:safeText(120).min(1).optional()}).strict().parse(await readBody(request));value=store.updateModel(id,input.name,input.enabled,input.revision,input.version);}
      }else if(section==='datasets')value={items:await datasetList(request.signal,options.datasetFile)};
      else if(section==='runs'){
        if(!id&&method==='POST'){const input=taskInput.parse(await readBody(request)),snapshot=await datasetSnapshot(input.datasetId,input.version,request.signal,options.datasetFile);value=store.create(input,snapshot);}
        else if(!id){const all=store.list().filter(r=>!q.status||r.status===q.status);const items=all.map(r=>{const run=store!.run(r.id);return {...r,mode:run.config.mode,dataset:run.dataset.name,models:run.models.map(m=>m.name)};}).filter(r=>!q.mode||r.mode===q.mode);value={items:items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:items.length,page:q.page,pageSize:q.pageSize};}
        else if(action==='authorize'){
          const input=z.object({confirmation:z.literal('确认调用付费模型'),acceptDataTransfer:z.literal(true),budgetUSD:z.string().regex(/^\d{1,2}(?:\.\d{1,6})?$/).refine(v=>Number(v)>0&&Number(v)<=5)}).strict().parse(await readBody(request));
          if(!(options.isConfigured?.()??configured()))throw new ModelError('服务端未配置 DEEPSEEK_API_KEY。',503);
          const run=store.run(id),fresh=await datasetSnapshot(run.dataset.id,run.dataset.version,request.signal,options.datasetFile);if(fresh.hash!==run.dataset.hash)throw new ModelError('数据集版本已变化，授权被拒绝。',409);
          value=store.authorize(id,input.budgetUSD);
        }else if(action==='execute'){
          const input=z.object({authorization:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(await readBody(request));const run=store.run(id);
          if(run.config.mode==='live'){const fresh=await datasetSnapshot(run.dataset.id,run.dataset.version,request.signal,options.datasetFile);if(fresh.hash!==run.dataset.hash)throw new ModelError('数据集版本与授权不匹配。',409);}
          value=await executeModelRun(store,id,request.signal,input.authorization,options.adapter);
        }else if(action==='cancel'){store.cancel(id);value=store.run(id);}
        else if(action==='report'){const input=z.object({format:z.enum(['docx','pdf'])}).strict().parse(await readBody(request));value={id:await modelReport(store,id,input.format,request.signal)};}
        else{const run=store.run(id);const history=store.list().filter(r=>['success','partial','failed','cancelled'].includes(r.status)).slice(0,40).map(r=>store!.run(r.id)).filter(r=>comparable(run,r)).reverse().map(r=>{const summary=summarize(r),values=summary.models.map(m=>m.latencyMs.value).filter((v):v is number=>v!==null);return {id:r.id,costUSD:summary.costUSD,latencyMs:values.length?values.reduce((n,v)=>n+v,0)/values.length:null};});value={...run,summary:summarize(run),reservation:store.reservation(id),history};}
      }else if(section==='compare'){
        if(!q.left||!q.right)throw new ModelError('请选择两个任务。');const a=store.run(q.left),b=store.run(q.right);value={comparable:comparable(a,b),reason:comparable(a,b)?'同一数据集、样本选择、Prompt、参数与规则；仍需核对真实版本与价格。':'执行方式、数据集、样本、Prompt 或评分配置不同，不可直接排名。',left:{run:a,summary:summarize(a)},right:{run:b,summary:summarize(b)}};
      }else if(section==='reports'){
        const r=store.report(id!);return new Response(new Uint8Array(r.bytes as Uint8Array),{headers:{'Content-Type':r.format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="model-evaluation-${id}.${r.format}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      return Response.json(value,{headers:{'Cache-Control':'no-store'}});
    }catch(e){return Response.json({error:e instanceof ModelError||e instanceof PlatformError?e.message:e instanceof z.ZodError?'模型评测参数无效，请核查必填字段、范围与敏感内容。':e instanceof SyntaxError?'JSON 格式错误。':'模型评测操作失败，未输出原始异常或敏感信息。'},{status:e instanceof ModelError||e instanceof PlatformError?e.status:e instanceof z.ZodError||e instanceof SyntaxError?400:500,headers:{'Cache-Control':'no-store'}});}finally{store?.close();}
  };
}
export const modelCenterApi=createModelApi();
