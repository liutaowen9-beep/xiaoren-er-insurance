import { z } from 'zod';
import { localOnly, querySlot, ragResponse } from '@/lib/rag/http';
import { RagError } from '@/lib/rag/config';
import { openAgentStore, readStoredSource } from '@/lib/agent/knowledge';
import { AgentError } from '@/lib/agent/limits';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  let store, release;
  try {
    localOnly(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== 2) throw new RagError('来源请求参数不正确。');
    const parsed = z.object({ documentId: z.uuid(), chunkId: z.uuid() }).strict().safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new RagError('来源编号不正确。');
    release = querySlot(); store = openAgentStore();
    if (!store) throw new RagError('知识库不存在，无法读取来源。', 404);
    const source = readStoredSource(store, parsed.data.documentId, parsed.data.chunkId);
    return Response.json({ source }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return ragResponse(e instanceof AgentError ? new RagError(e.message, e.status) : e); }
  finally { store?.close(); release?.(); }
}
