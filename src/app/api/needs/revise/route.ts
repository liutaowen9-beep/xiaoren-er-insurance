import { openAgentStore } from '@/lib/agent/knowledge';
import { boundedBody, localOnly, querySlot, ragResponse } from '@/lib/rag/http';
import { RagError } from '@/lib/rag/config';
import { reviseNeedsReport } from '@/lib/needs/revise';
export const runtime='nodejs';
export async function POST(request:Request){let store,release;try{
  localOnly(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new RagError('请提交 JSON 备注。',415);
  release=querySlot();const input=JSON.parse((await boundedBody(request,12000)).toString('utf8'));store=openAgentStore();if(!store)throw new RagError('知识库不可读取，未修改报告。',503);
  return Response.json(await reviseNeedsReport(input,store,AbortSignal.any([request.signal,AbortSignal.timeout(60000)])),{headers:{'Cache-Control':'no-store'}});
}catch(error){return ragResponse(error instanceof RagError?error:new RagError('报告备注保存失败：请确认下载凭证、备注长度及来源版本仍有效。',409));}finally{store?.close();release?.();}}
