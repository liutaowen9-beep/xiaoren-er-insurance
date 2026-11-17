import 'server-only';
import { NextResponse } from 'next/server';
import { RagError } from './config';
import { runtimeRequestReason } from './deployment';

const globalLimits = globalThis as typeof globalThis & { __moyuRagRequests?: { time: number; count: number; active: number }; __moyuUploads?: { time: number; count: number; active: number } };
const limits = globalLimits.__moyuRagRequests ??= { time: 0, count: 0, active: 0 };
const uploads = globalLimits.__moyuUploads ??= { time: 0, count: 0, active: 0 };
export function uploadSlot() {
  if (Date.now() - uploads.time > 60000) { uploads.time = Date.now(); uploads.count = 0; }
  if (uploads.count >= 10 || uploads.active >= 1) throw new RagError('上传过于频繁，请稍后重试（每分钟最多 10 次，同时最多 1 次）。', 429);
  uploads.count++; uploads.active++;
  let released = false;
  return () => { if (!released) { released = true; uploads.active--; } };
}
export function localOnly(request: Request) {
  const reason=runtimeRequestReason(request);if(reason)throw new RagError(reason,503);
  const host = request.headers.get('host') || new URL(request.url).host;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new RagError('私有知识库仅支持本机 localhost 访问，暂不支持公开或局域网部署。', 403);
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new RagError('不允许跨站访问私有知识库。', 403);
  if (origin) { try { if (new URL(origin).host !== host) throw new Error(); } catch { throw new RagError('不允许跨站访问私有知识库。', 403); } }
}
export function querySlot() {
  if (Date.now() - limits.time > 60000) { limits.time = Date.now(); limits.count = 0; }
  if (limits.count >= 30 || limits.active >= 2) throw new RagError('知识库查询过于频繁，请稍后重试。', 429);
  limits.count++; limits.active++;
  let released = false;
  return () => { if (!released) { released = true; limits.active--; } };
}
export function validId(id: string) { if (!/^[0-9a-f-]{36}$/.test(id)) throw new RagError('无效的文档编号。'); return id; }
export function ragResponse(error: unknown) { return NextResponse.json({ error: error instanceof RagError ? error.message : '知识库操作失败，请重试；若持续失败，请检查本地数据库与模型缓存。' }, { status: error instanceof RagError ? error.status : 500, headers: { 'Cache-Control': 'no-store' } }); }
export async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit) throw new RagError('请求体超过大小限制。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RagError('请求内容为空。');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RagError('请求体超过大小限制。', 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
