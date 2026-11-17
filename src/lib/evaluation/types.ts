import { z } from 'zod';

export class EvaluationError extends Error { constructor(message:string,public status=400){super(message);} }
// Text is deliberately limited to synthetic or explicitly de-identified evaluation material.
export const safeText=(max:number)=>z.string().trim().max(max).refine(v=>!/(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[\w.-]{12,}|-----BEGIN .*PRIVATE KEY|\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(v),'请移除密钥、电话、证件及邮箱等敏感信息。').refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v),'不支持控制字符');
export const referenceSchema=z.object({documentId:z.uuid(),version:z.number().int().positive(),chunkId:z.uuid().optional()}).strict();
export type Reference=z.infer<typeof referenceSchema>;
export const caseSchema=z.object({
  id:z.uuid(),question:safeText(2000).min(1),referenceAnswer:safeText(4000).optional(),
  relevant:z.array(referenceSchema).max(100).optional(),unanswerable:z.boolean().default(false),
  expectedTools:z.array(z.enum(['knowledge_search','calculator','document_analyze'])).max(15).optional(),
  expectedTaskSuccess:z.boolean().optional(),observedRunId:z.uuid().optional(),
  response:safeText(4000).optional(),model:safeText(100).optional(),modelVersion:safeText(100).optional(),
  requiredPhrases:z.array(safeText(200).min(1)).max(20).default([]),tags:z.array(safeText(40)).max(10).default([]),difficulty:z.enum(['easy','medium','hard']).default('medium'),
  // Only supplied citations are scored; retrieval hits are never assumed to have been cited.
  citations:z.array(referenceSchema).max(30).optional(),
}).strict().superRefine((v,ctx)=>{if(v.unanswerable&&v.relevant?.length)ctx.addIssue({code:'custom',message:'无答案标注不能同时包含相关来源。'});});
export const datasetSchema=z.object({name:safeText(100).min(1),description:safeText(1000).default(''),dataPolicy:z.enum(['synthetic','deidentified']),libraryId:z.uuid().optional(),corpusHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),cases:z.array(caseSchema).min(1).max(100)}).strict().superRefine((v,ctx)=>{if(new Set(v.cases.map(c=>c.id)).size!==v.cases.length)ctx.addIssue({code:'custom',message:'案例 ID 重复'});});
export type Dataset=z.infer<typeof datasetSchema>;
export type EvalCase=z.infer<typeof caseSchema>;
export const runInput=z.object({datasetId:z.uuid(),version:z.number().int().positive(),type:z.enum(['rag','agent','model']),k:z.number().int().min(1).max(10).default(5),level:z.enum(['document','chunk']).default('document'),idempotencyKey:z.uuid(),mode:z.enum(['local-retrieval','observation-replay','offline-rules']),}).strict().superRefine((v,ctx)=>{if(({rag:'local-retrieval',agent:'observation-replay',model:'offline-rules'})[v.type]!==v.mode)ctx.addIssue({code:'custom',message:'评测类型与执行方式不一致'});});
export type RunInput=z.infer<typeof runInput>;
export const listQuery=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),type:z.enum(['rag','agent','model']).optional(),status:z.enum(['pending','running','success','partial','failed','cancelled']).optional(),q:safeText(100).default('')}).strict();
export type Metric={value:number|null;denominator:number;definition:string;reason?:string};
export type CaseResult={caseId:string;status:'success'|'failed';metrics:Record<string,Metric>;details:unknown;error?:string};
export const SCORER_VERSION='rules-1';
