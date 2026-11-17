import { after, NextResponse } from 'next/server';
import { LOCAL_KNOWLEDGE_ROOT, ACTIVE_DEPLOYMENT, EMBEDDING_DIMENSION, EMBEDDING_MODEL, MAX_UPLOAD_BYTES, MIN_SCORE, TOP_K, RagError } from '@/lib/rag/config';
import { getStore } from '@/lib/rag/store';
import { prepareUpload, indexDocument } from '@/lib/rag/service';
import { boundedBody, localOnly, ragResponse, uploadSlot } from '@/lib/rag/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;
export async function GET(request: Request) {
  try {
    localOnly(request);
    return NextResponse.json({ documents: getStore().list(), config: { deploymentMode: ACTIVE_DEPLOYMENT ? ACTIVE_DEPLOYMENT.readOnly ? ACTIVE_DEPLOYMENT.activated ? 'production-read-only' : 'read-only-verification' : 'approved-write' : LOCAL_KNOWLEDGE_ROOT ? 'independent-local' : 'sandbox', maxUploadBytes: MAX_UPLOAD_BYTES, model: EMBEDDING_MODEL, dimension: EMBEDDING_DIMENSION, threshold: MIN_SCORE, topK: TOP_K } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return ragResponse(e); }
}
export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    localOnly(request); release = uploadSlot();
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) throw new RagError('请使用文件上传表单。', 415);
    const bytes = await boundedBody(request, MAX_UPLOAD_BYTES + 65536);
    const form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': request.headers.get('content-type')! }, body: bytes }).formData();
    const file = form.get('file');
    if (!(file instanceof File) || form.getAll('file').length !== 1) throw new RagError('每次请选择一个文件。');
    const result = prepareUpload(file.name, file.type, Buffer.from(await file.arrayBuffer()));
    if (!result.duplicate) after(() => indexDocument(result.document.id).then(() => {}));
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (e) { return ragResponse(e); } finally { release?.(); }
}
