import 'server-only';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PlatformStore } from './store';
import { scanKnowledge } from './scanner';
import { pageSchema, scanInput, PlatformError } from './types';

export function authorize(request:Request){
  const url=new URL(request.url),host=request.headers.get('host')??url.host;
  const local=/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
  if(!local.test(host)||!local.test(url.host)||request.headers.get('sec-fetch-site')==='cross-site')throw new PlatformError('数据中台仅允许本机同源访问。',403);
  // NextRequest normalizes loopback URL hostnames to localhost. Host retains the browser's
  // actual authority: require an exact Origin match against that validated local Host,
  // not against the normalized URL. Never trust X-Forwarded-Host or equate browser origins.
  let expected:URL;
  try{expected=new URL(`${url.protocol}//${host}`);if(expected.port!==url.port)throw Error();}catch{throw new PlatformError('拒绝不一致的请求主机或端口。',403);}
  const origin=request.headers.get('origin');if(origin){try{if(new URL(origin).origin!==expected.origin)throw Error();}catch{throw new PlatformError('拒绝跨站访问。',403);}}
}
export async function resolveSource(){
  // Reuse the same validated configuration as chat/RAG; do not instantiate KnowledgeStore.
  const {DATA_DIR,LOCAL_KNOWLEDGE_ROOT,assertKnowledgePath}=await import('../rag/config');
  if(!LOCAL_KNOWLEDGE_ROOT)throw new PlatformError('只读扫描需要已登记的独立知识库稳定 ID；不会自动连接候选或测试库。',503);
  const file=path.join(DATA_DIR,'knowledge.sqlite');assertKnowledgePath(file);
  const marker=z.object({id:z.uuid()}).passthrough().parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ path.join(DATA_DIR,'local-library.json'),'utf8')));
  return {file,libraryId:marker.id};
}
export type Operation='overview'|'assets'|'asset'|'versions'|'quality'|'scans'|'snapshots'|'snapshot'|'diff';
export function createApi(storeFactory=()=>new PlatformStore(),sourceFactory=resolveSource){
  return async(request:Request,operation:Operation,id?:string)=>{
    let store:PlatformStore|undefined,token:string|undefined;
    try{
      authorize(request);
      if(request.method!==(operation==='scans'?'POST':'GET'))throw new PlatformError('请求方法不允许。',405);
      const params=Object.fromEntries(new URL(request.url).searchParams);
      const from=operation==='diff'?z.object({from:z.uuid().optional()}).strict().parse(params).from:undefined;
      const q=pageSchema.parse(operation==='diff'?{}:params);
      if(['asset','versions'].includes(operation))z.string().regex(/^[a-f0-9]{64}$/).parse(id);
      if(['snapshot','diff'].includes(operation))z.uuid().parse(id);
      if(operation==='scans'){
        const reader=request.body?.getReader();let text='';
        try{if(reader){const chunks:Uint8Array[]=[];let size=0;while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>2048){await reader.cancel();throw new PlatformError('扫描参数过大。',413);}chunks.push(r.value);}text=Buffer.concat(chunks).toString('utf8');}}finally{reader?.releaseLock();}
        scanInput.parse(JSON.parse(text||'{}'));
      }
      store=storeFactory();
      let result:unknown;
      switch(operation){
        case 'overview':result={...store.overview(),platformIntegrity:store.integrity()};break;
        case 'assets':result=store.assets(q);break;
        case 'asset':result=store.asset(id!);break;
        case 'versions':{const a=store.asset(id!);result={...paginate(a.versions,q.page,q.pageSize),currentVersionId:a.currentVersionId};break;}
        case 'quality':result=store.quality(q);break;
        case 'snapshots':result=store.snapshots(q);break;
        case 'snapshot':{const s=store.snapshot(id!);result={...s,manifest:{...s.manifest,members:s.manifest.members.slice((q.page-1)*q.pageSize,q.page*q.pageSize)},memberTotal:s.manifest.members.length,page:q.page,pageSize:q.pageSize,notice:'元数据快照不是完整备份。'};break;}
        case 'diff':result=store.diff(id!,from);break;
        case 'scans':{
          token=store.lease();const source=await sourceFactory();
          const signal=AbortSignal.any([request.signal,AbortSignal.timeout(120000)]);
          const scan=await scanKnowledge(source.file,source.libraryId,signal);
          signal.throwIfAborted();const s=store.publish(scan,token,signal);const {manifest,...summary}=s;void manifest;result={snapshot:summary};break;
        }
      }
      return Response.json(result,{status:operation==='scans'?201:200,headers:{'Cache-Control':'no-store'}});
    }catch(e){
      const aborted=e instanceof Error&&e.name==='AbortError',timeout=e instanceof Error&&e.name==='TimeoutError';
      const message=e instanceof PlatformError?e.message:e instanceof z.ZodError?'请求参数不符合要求。':e instanceof SyntaxError?'请求 JSON 格式无效。':aborted?'扫描已取消，未发布结果。':timeout?'扫描超时，未发布结果。':'中台操作失败，已有扫描记录保持不变；请检查本地文件权限和数据库。';
      return Response.json({error:message},{status:e instanceof PlatformError?e.status:e instanceof z.ZodError||e instanceof SyntaxError?400:aborted?499:timeout?408:500,headers:{'Cache-Control':'no-store'}});
    }finally{if(store){try{if(token)store.release(token);}finally{store.close();}}}
  };
}
function paginate<T>(items:T[],page:number,pageSize:number){return {items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize};}
export const platformApi=createApi();
