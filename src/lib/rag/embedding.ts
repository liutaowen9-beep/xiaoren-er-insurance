import 'server-only';
import path from 'node:path';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { assertModelCachePath, EMBEDDING_MODEL, EMBEDDING_DIMENSION, MODEL_CACHE, MODEL_TOKEN_LIMIT, RagError } from './config';

const state = globalThis as typeof globalThis & { __moyuSandboxEncoder?: Promise<FeatureExtractionPipeline>; __moyuSandboxInferenceQueue?: Promise<unknown> };
export async function getEncoder() {
  assertModelCachePath(MODEL_CACHE);
  if (!state.__moyuSandboxEncoder) state.__moyuSandboxEncoder = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.localModelPath = MODEL_CACHE + path.sep;
      const encoder = await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
      if (encoder.tokenizer.model_max_length !== MODEL_TOKEN_LIMIT) throw new Error('Tokenizer mismatch');
      return encoder;
    } catch { state.__moyuSandboxEncoder = undefined; throw new RagError('隔离 Embedding 初始化失败：请把已验证备份中的 models 复制到 tmp/rag-tests/management/models；不要使用生产数据目录。', 503); }
  })();
  return state.__moyuSandboxEncoder;
}

export function normalizeVector(vector: number[]) {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new RagError('Embedding 返回无效向量。', 500);
  return vector.map(v => v / norm);
}
export async function tokenCount(text: string) {
  const encoder = await getEncoder();
  return encoder.tokenizer(text, { truncation: false }).input_ids.dims.at(-1)!;
}
export async function embedText(text: string, kind: 'query' | 'passage') {
  if (await tokenCount(`${kind}: ${text}`) > MODEL_TOKEN_LIMIT) throw new RagError('文本超过本地模型 token 上限，请缩短问题或重新切片。');
  const task = (state.__moyuSandboxInferenceQueue ?? Promise.resolve()).then(async () => {
    try {
      const encoder = await getEncoder();
      const output = await encoder(`${kind}: ${text}`, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data, Number);
      if (vector.length !== EMBEDDING_DIMENSION) throw new RagError('Embedding 实际维度与索引不一致，请重新索引。', 409);
      return normalizeVector(vector);
    } catch (e) { if (e instanceof RagError) throw e; throw new RagError('本地 Embedding 推理失败，请检查模型文件并重新下载。', 503); }
  });
  state.__moyuSandboxInferenceQueue = task.catch(() => {});
  return task;
}

// Long questions are embedded in complete, token-safe spans and averaged.
export async function embedQuery(text: string) {
  const spans: string[] = [];
  while (text.length) {
    let end = Math.min(text.length, 600);
    while (await tokenCount(`query: ${text.slice(0, end)}`) > MODEL_TOKEN_LIMIT) end = Math.floor(end * 0.8);
    if (!end) throw new RagError('问题无法分词，请换一种表述。');
    spans.push(text.slice(0, end)); text = text.slice(end);
  }
  const vectors: number[][] = [];
  for (const span of spans) vectors.push(await embedText(span, 'query'));
  return normalizeVector(Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length));
}
