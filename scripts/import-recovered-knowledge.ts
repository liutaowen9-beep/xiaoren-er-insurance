import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LOCAL_KNOWLEDGE_ROOT } from '../src/lib/rag/config';
import { getStore } from '../src/lib/rag/store';
import { prepareUpload, indexDocument } from '../src/lib/rag/service';

async function main() {
if (!LOCAL_KNOWLEDGE_ROOT) throw new Error('必须选择已登记的独立新知识库，不能导入旧部署库。');
const input = process.argv[2];
if (!input || !path.isAbsolute(input)) throw new Error('必须明确指定恢复清单绝对路径。');
const manifest = z.object({ files: z.array(z.object({ current: z.boolean(), file: z.string(), originalName: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()) }).passthrough().parse(JSON.parse(readFileSync(input, 'utf8')));
const parent = path.dirname(input);
const files = manifest.files.filter(f => f.current).map(entry => {
  const file = path.resolve(parent, entry.file), relative = path.relative(parent, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('恢复文件路径越界。');
  const bytes = readFileSync(file);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('恢复文件校验失败。');
  return { ...entry, bytes };
});
const store = getStore();
try {
  for (const [i, file] of files.entries()) {
    const uploaded = prepareUpload(file.originalName, '', file.bytes, store);
    const result = uploaded.duplicate ? uploaded.document : await indexDocument(uploaded.document.id, store);
    if (result.status !== 'ready') throw new Error(`文档 ${i + 1} 索引失败：${result.error}`);
    console.log(JSON.stringify({ imported: i + 1, total: files.length, chunks: result.chunkCount, status: result.status }));
  }
  console.log(JSON.stringify({ documents: store.list().length, chunks: store.countChunks(), dimension: 384 }));
} finally { store.close(); }

}
void main().catch(error => { console.error(error instanceof Error ? error.message : '导入失败'); process.exitCode = 1; });
