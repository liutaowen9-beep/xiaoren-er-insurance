import { openAgentStore } from '@/lib/agent/knowledge';
import { boundedBody, localOnly } from '@/lib/rag/http';
import { RagError } from '@/lib/rag/config';
import { analyzeCustomer } from '@/lib/needs/workflow';
import { inputSchema, type NeedsEvent } from '@/lib/needs/types';
import { ReportError, reportError } from '@/lib/reports/types';
export const runtime='nodejs';
export const maxDuration=180;
const state=globalThis as typeof globalThis & {__moyuNeeds?:{active:number;count:number;at:number}};
function slot(){const s=state.__moyuNeeds??={active:0,count:0,at:Date.now()};if(Date.now()-s.at>60000){s.count=0;s.at=Date.now();}if(s.active||s.count>=4)throw new ReportError('需求分析每分钟最多4次，同时只能运行1次。',429);s.active++;s.count++;let done=false;return()=>{if(!done){done=true;s.active--;}};}
const message=(e:unknown)=>e instanceof RagError?e.message:reportError(e);
export async function GET(request:Request){let store;try{localOnly(request);store=openAgentStore();if(!store)throw new ReportError('当前知识库连接不可用，不会切换空库。',503);return Response.json({eligible:store.list().filter(d=>store!.isEligible(d.id)).length,paidEnabled:process.env.MOYU_REPORT_ALLOW_PAID==='1'&&!!process.env.MOYU_REPORT_API_KEY?.trim()},{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:message(e)},{status:e instanceof ReportError||e instanceof RagError?e.status:503});}finally{store?.close();}}
export async function POST(request:Request){let release:(()=>void)|undefined;
  try{localOnly(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new ReportError('请提交 JSON 客户需求参数。',415);
    const input=inputSchema.parse(JSON.parse((await boundedBody(request,24000)).toString('utf8')));
    if(input.engine==='deepseek'&&process.env.MOYU_REPORT_ALLOW_PAID!=='1')throw new ReportError('真实分析未获服务端授权，请使用 Mock。',403);
    release=slot();const finish=release;release=undefined;const abort=new AbortController(),signal=AbortSignal.any([request.signal,abort.signal]);
    const stream=new ReadableStream<Uint8Array>({start(controller){void(async()=>{let store;const send=(event:NeedsEvent)=>{if(!signal.aborted)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));};try{signal.throwIfAborted();store=openAgentStore();if(!store)throw new ReportError('知识库不可读取，未进行分析。',503);await analyzeCustomer(input,{store,signal,emit:send});}catch(e){send({type:'error',message:message(e)});}finally{store?.close();finish();try{controller.close();}catch{/* Disconnected. */}}})();},cancel(){abort.abort();}});
    return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
  }catch(e){release?.();return Response.json({error:message(e)},{status:e instanceof ReportError||e instanceof RagError?e.status:400});}
}
