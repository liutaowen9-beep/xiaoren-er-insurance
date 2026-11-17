import { localOnly, querySlot, ragResponse } from '@/lib/rag/http';
import { LOCAL_KNOWLEDGE_ROOT, ACTIVE_DEPLOYMENT } from '@/lib/rag/config';
import { getStore } from '@/lib/rag/store';
import { schemaVersion } from '@/lib/rag/database-audit';

export const runtime='nodejs';
export async function GET(request:Request){
  let release;
  try{
    localOnly(request);release=querySlot();const store=getStore();
    return Response.json({ready:true,mode:ACTIVE_DEPLOYMENT?ACTIVE_DEPLOYMENT.readOnly?ACTIVE_DEPLOYMENT.activated?'production-read-only':'read-only-verification':'approved-write':LOCAL_KNOWLEDGE_ROOT?'independent-local':'sandbox',schemaVersion:schemaVersion(store.db),documents:store.list().length,chunks:store.countChunks(),codeFingerprint:ACTIVE_DEPLOYMENT?.codeFingerprint,receiptSha256:ACTIVE_DEPLOYMENT?.receiptSha256},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return ragResponse(e);}finally{release?.();}
}
