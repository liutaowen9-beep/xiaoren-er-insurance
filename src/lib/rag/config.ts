import 'server-only';
import path from 'node:path';
import { existsSync, lstatSync } from 'node:fs';
import { getDeployment } from './deployment';
import { safePath, within } from './migration-paths';
import { resolveLocalLibrary } from './local-library';

function numberSetting(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`知识库配置 ${name} 超出允许范围。`);
  return value;
}
// This development branch deliberately cannot open the production .moyu directory.
export const SANDBOX_ROOT = path.resolve(process.cwd(), 'tmp/rag-tests');
export const LOCAL_KNOWLEDGE_ROOT = resolveLocalLibrary(process.env.MOYU_RAG_LOCAL_ROOT, process.cwd());
if (LOCAL_KNOWLEDGE_ROOT && process.env.MOYU_RAG_DEPLOYMENT) throw new Error('Cannot combine an independent library with a receipt-bound deployment.');
export const ACTIVE_DEPLOYMENT = getDeployment();
export const DATA_DIR = LOCAL_KNOWLEDGE_ROOT ?? (ACTIVE_DEPLOYMENT ? path.dirname(ACTIVE_DEPLOYMENT.target) : path.join(SANDBOX_ROOT, 'management'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const VECTOR_DIR = path.join(DATA_DIR, 'vectors');
export function assertSandboxPath(file: string) {
  const resolved = path.resolve(file);
  const relative = path.relative(SANDBOX_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('隔离安全检查：拒绝访问测试目录之外的数据。');
  let current = resolved;
  while (current !== path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('隔离安全检查：数据路径禁止目录联接或符号链接。');
    current = path.dirname(current);
  }
}
export function assertKnowledgePath(file:string) {
  if(LOCAL_KNOWLEDGE_ROOT && path.resolve(file) === path.join(LOCAL_KNOWLEDGE_ROOT,'knowledge.sqlite')) { safePath(file, false); return; }
  if(ACTIVE_DEPLOYMENT&&path.resolve(file)===ACTIVE_DEPLOYMENT.target){safePath(file);if(existsSync(path.join(ACTIVE_DEPLOYMENT.root,'.migration.lock')))throw new Error('维护锁存在，拒绝建立服务连接。');return;}
  assertSandboxPath(file);
}
export function assertModelCachePath(file:string) {
  if(LOCAL_KNOWLEDGE_ROOT && within(path.join(LOCAL_KNOWLEDGE_ROOT,'models'),path.resolve(file))) { safePath(file); return; }
  if(ACTIVE_DEPLOYMENT&&path.resolve(file)===path.join(DATA_DIR,'models')){safePath(file);return;}
  assertSandboxPath(file);
}
export const MODEL_CACHE = path.join(DATA_DIR, 'models');
export { EMBEDDING_MODEL, EMBEDDING_REVISION, EMBEDDING_ID, EMBEDDING_DIMENSION, MODEL_TOKEN_LIMIT } from './model-spec';
export const MAX_UPLOAD_BYTES = Math.floor(numberSetting('RAG_MAX_UPLOAD_MB', 10, 1, 30) * 1024 * 1024);
export const TOP_K = Math.floor(numberSetting('RAG_TOP_K', 5, 1, 10));
// Calibrated against the Chinese retrieval fixtures; see tests/rag.test.ts and README.
export const MIN_SCORE = numberSetting('RAG_MIN_SCORE', 0.88, 0, 1);
export const MAX_DOCUMENTS = 100;
export const MAX_CHUNKS_PER_DOCUMENT = 200;
export const MAX_TOTAL_CHUNKS = 5000;

export class RagError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
