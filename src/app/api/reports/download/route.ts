import { boundedBody, localOnly } from '@/lib/rag/http';
import { openAgentStore } from '@/lib/agent/knowledge';
import { checkDownloadEvidence } from '@/lib/reports/evidence';
import { readReportDownload, downloadHeaders } from '@/lib/reports/storage';
import { reportError, ReportError } from '@/lib/reports/types';
export const runtime='nodejs';
export async function POST(request:Request){let store;
  try{localOnly(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new ReportError('下载参数必须是 JSON。',415);
    const result=readReportDownload(JSON.parse((await boundedBody(request,2000)).toString('utf8')));
    if(result.report.references.length){store=openAgentStore();checkDownloadEvidence(store,result.report);}
    return new Response(new Uint8Array(result.bytes),{headers:downloadHeaders(result.report.content.title,result.format)});
  }catch(e){return Response.json({error:reportError(e)},{status:e instanceof ReportError?e.status:400});}finally{store?.close();}
}
