import { NextResponse } from 'next/server';
import { boundedBody, localOnly, querySlot, ragResponse } from '@/lib/rag/http';
import { retrieve } from '@/lib/rag/service';
import { RagError, TOP_K } from '@/lib/rag/config';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    localOnly(request); release = querySlot();
    let body;
    try { body = JSON.parse((await boundedBody(request, 16000)).toString('utf8')); } catch (e) { if (e instanceof RagError) throw e; throw new RagError('请求必须是有效 JSON。'); }
    if (typeof body?.query !== 'string') throw new RagError('请输入检索问题。');
    const sources = await retrieve(body.query, body.topK ?? TOP_K, undefined, request.signal);
    return NextResponse.json({ sources }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return ragResponse(e); } finally { release?.(); }
}
