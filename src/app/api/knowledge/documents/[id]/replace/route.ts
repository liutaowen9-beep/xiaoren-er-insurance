import { after } from 'next/server';
import { boundedBody, localOnly, ragResponse, uploadSlot, validId } from '@/lib/rag/http';
import { MAX_UPLOAD_BYTES, RagError } from '@/lib/rag/config';
import { indexDocument, prepareReplacement } from '@/lib/rag/service';

export const runtime = 'nodejs';
export const maxDuration = 600;
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  let release;
  try {
    localOnly(request); release = uploadSlot();
    const type = request.headers.get('content-type');
    if (!type?.startsWith('multipart/form-data;')) throw new RagError('请使用文件上传表单。', 415);
    const bytes = await boundedBody(request, MAX_UPLOAD_BYTES + 65536);
    const form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': type }, body: bytes }).formData();
    const file = form.get('file'), revisionText = form.get('revision');
    if (!(file instanceof File) || form.getAll('file').length !== 1 || form.getAll('revision').length !== 1 || typeof revisionText !== 'string' || !/^\d{1,15}$/.test(revisionText)) throw new RagError('请选择一个文件并提供有效的文档版本号。');
    const result = prepareReplacement(validId((await context.params).id), file.name, file.type, Buffer.from(await file.arrayBuffer()), Number(revisionText));
    if (!result.duplicate) after(() => indexDocument(result.document.id).then(() => {}));
    return Response.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (e) { return ragResponse(e); } finally { release?.(); }
}
