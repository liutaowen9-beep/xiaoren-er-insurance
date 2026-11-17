import { openAgentStore } from '@/lib/agent/knowledge';
import { boundedBody, localOnly } from '@/lib/rag/http';
import { RagError } from '@/lib/rag/config';
import { compareProducts } from '@/lib/comparison/workflow';
import { inputSchema, type ComparisonEvent } from '@/lib/comparison/types';
import { ReportError, reportError } from '@/lib/reports/types';
export const runtime='nodejs';
export const maxDuration=180;
const state=globalThis as typeof globalThis & {__moyuComparison?:{active:number;count:number;at:number}};
function slot(){const s=state.__moyuComparison??={active:0,count:0,at:Date.now()};if(Date.now()-s.at>60000){s.count=0;s.at=Date.now();}if(s.active||s.count>=4)throw new ReportError('产品对比每分钟最多4次，同时只能运行1次。',429);s.active++;s.count++;let done=false;return()=>{if(!done){done=true;s.active--;}};}
const message=(e:unknown)=>e instanceof RagError?e.message:reportError(e);
export async function GET(request:Request){let store;try{localOnly(request);store=openAgentStore();if(!store)throw new ReportError('当前正式知识库连接不可用，不会切换空库。',503);return Response.json({documents:store.list().filter(d=>store!.isEligible(d.id)).map(d=>({id:d.id,name:d.name,version:d.version??1,state:'active',status:'ready'})),paidEnabled:process.env.MOYU_REPORT_ALLOW_PAID==='1'},{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:message(e)},{status:e instanceof ReportError||e instanceof RagError?e.status:503});}finally{store?.close();}}
export async function POST(request:Request){let release:(()=>void)|undefined;
  try{localOnly(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new ReportError('请提交 JSON 对比参数。',415);
    const input=inputSchema.parse(JSON.parse((await boundedBody(request,12000)).toString('utf8')));
    if(input.engine==='deepseek'&&process.env.MOYU_REPORT_ALLOW_PAID!=='1')throw new ReportError('真实对比未获服务端授权，请先使用 Mock。',403);
    release=slot();const finish=release;release=undefined;const abort=new AbortController(),signal=AbortSignal.any([request.signal,abort.signal]);
    const stream=new ReadableStream<Uint8Array>({start(controller){void(async()=>{let store;const send=(event:ComparisonEvent)=>{if(!signal.aborted)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));};try{signal.throwIfAborted();store=openAgentStore();if(!store)throw new ReportError('当前知识库不可读取，不会创建空库。',503);await compareProducts(input,{store,signal,emit:send});}catch(e){send({type:'error',message:message(e)});}finally{store?.close();finish();try{controller.close();}catch{/* Client disconnected. */}}})();},cancel(){abort.abort();}});
    return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
  }catch(e){release?.();return Response.json({error:message(e)},{status:e instanceof ReportError||e instanceof RagError?e.status:400});}
}
