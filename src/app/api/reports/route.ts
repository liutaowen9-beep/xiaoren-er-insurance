import { randomUUID } from 'node:crypto';
import { boundedBody, localOnly } from '@/lib/rag/http';
import { openAgentStore } from '@/lib/agent/knowledge';
import { generateReport } from '@/lib/reports/workflow';
import { reportInputSchema, reportError, ReportError, type ReportEvent } from '@/lib/reports/types';
import { ACTIVE_DEPLOYMENT } from '@/lib/rag/config';
export const runtime='nodejs';
export const maxDuration=180;
const limits=globalThis as typeof globalThis & {__moyuReports?:{active:number;at:number;count:number}};
function slot(){const s=limits.__moyuReports??={active:0,at:Date.now(),count:0};if(Date.now()-s.at>60000){s.at=Date.now();s.count=0;}if(s.active>=1||s.count>=4)throw new ReportError('报告生成繁忙，每分钟最多 4 次、同时 1 次，请稍后重试。',429);s.active++;s.count++;let done=false;return ()=>{if(!done){done=true;s.active--;}};}
export async function GET(request:Request){try{localOnly(request);const store=process.env.MOYU_REPORT_TESTING==='1'?null:openAgentStore();let eligible=0;try{eligible=store?.list().filter(d=>store.isEligible(d.id)).length??0;}finally{store?.close();}return Response.json({mock:true,paidEnabled:process.env.MOYU_REPORT_ALLOW_PAID==='1',retentionMinutes:60,knowledge:{mode:ACTIVE_DEPLOYMENT?'production-read-only':'sandbox',eligible}},{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({error:'知识库连接校验失败，请检查本地部署配置；不会自动切换空库。'},{status:503});}}
export async function POST(request:Request){
  let release:(()=>void)|undefined;
  try{
    localOnly(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new ReportError('请提交 JSON 格式的报告参数。',415);
    const input=reportInputSchema.parse(JSON.parse((await boundedBody(request,16000)).toString('utf8')));
    if(input.engine==='deepseek'&&process.env.MOYU_REPORT_ALLOW_PAID!=='1')throw new ReportError('真实模型未获服务端授权，请使用 Mock 演示。',403);
    release=slot();const finish=release;release=undefined;const abort=new AbortController(),signal=AbortSignal.any([request.signal,abort.signal]),runId=randomUUID();
    const stream=new ReadableStream<Uint8Array>({start(controller){void(async()=>{
      let store;let closed=false;const send=(event:ReportEvent)=>{if(!closed&&!signal.aborted)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));};
      try{signal.throwIfAborted();store=input.useKnowledge?openAgentStore():null;await generateReport(input,{store,signal,emit:send,runId});}
      catch(e){send({type:'error',runId,message:signal.aborted?'生成已停止。':reportError(e)});}
      finally{store?.close();finish();closed=true;try{controller.close();}catch{/* Client disconnected. */}}
    })();},cancel(){abort.abort();}});
    return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
  }catch(e){release?.();return Response.json({error:reportError(e)},{status:e instanceof ReportError?e.status:400});}
}
