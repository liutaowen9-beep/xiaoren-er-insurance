import { z } from 'zod';
import { recordLifecycle } from '@/lib/data-platform/telemetry';
import { getStore } from '@/lib/rag/store';
import { boundedBody, localOnly, querySlot, ragResponse, validId } from '@/lib/rag/http';
import { RagError } from '@/lib/rag/config';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  let release;
  try {
    localOnly(request); release = querySlot();
    return Response.json({ versions: getStore().versions(validId((await context.params).id)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return ragResponse(e); } finally { release?.(); }
}
export async function PATCH(request: Request, context: Context) {
  let release;
  try {
    localOnly(request); release = querySlot();
    let value: unknown;
    try { value = JSON.parse((await boundedBody(request, 1024)).toString('utf8')); } catch { throw new RagError('操作参数必须为有效 JSON。'); }
    const parsed = z.object({ state: z.enum(['active', 'inactive', 'archived']), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict().safeParse(value);
    if (!parsed.success) throw new RagError('状态或版本参数无效。');
    const document = getStore().setState(validId((await context.params).id), parsed.data.state, parsed.data.revision);
    recordLifecycle(getStore(),document,'state_'+parsed.data.state);
    return Response.json({ document }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return ragResponse(e); } finally { release?.(); }
}
