import { after, NextResponse } from 'next/server';
import { prepareReindex, deleteDocument, indexDocument } from '@/lib/rag/service';
import { localOnly, ragResponse, validId, uploadSlot } from '@/lib/rag/http';
import { getStore } from '@/lib/rag/store';
import { RagError } from '@/lib/rag/config';

export const runtime = 'nodejs';
export const maxDuration = 600;
type Context = { params: Promise<{ id: string }> };
export async function DELETE(request: Request, context: Context) {
  try {
    localOnly(request);
    const store = getStore(), revision = request.headers.get('if-match');
    if (store.managed && (!revision || !/^\d{1,15}$/.test(revision))) throw new RagError('删除必须提供当前文档版本，请刷新后重试。');
    deleteDocument(validId((await context.params).id), store, revision ? Number(revision) : undefined);
    return NextResponse.json({ deleted: true });
  }
  catch (e) { return ragResponse(e); }
}
export async function POST(request: Request, context: Context) {
  let release: (() => void) | undefined;
  try {
    localOnly(request); release = uploadSlot();
    const id = validId((await context.params).id);
    const candidate = prepareReindex(id);
    after(() => indexDocument(candidate.id).then(() => {}));
    return NextResponse.json({ status: 'queued' }, { status: 202 });
  } catch (e) { return ragResponse(e); } finally { release?.(); }
}
