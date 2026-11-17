import { z } from 'zod';
import { reportSchema } from '../reports/types';

export const FIELDS = [
  ['name','产品名称'],['type','产品类型'],['coverage','保障责任'],['insuranceTerm','保险期间'],
  ['paymentTerm','缴费期间'],['eligibility','投保条件'],['waiting','等待期'],
  ['exclusions','免责条款'],['premium','保费信息'],['features','产品特点'],
] as const;
export const FIELD_STATUSES=['SUCCESS','NOT_PROVIDED','PENDING_VERIFICATION','EXTRACTION_FAILED'] as const;
export const OUTCOMES=['SUCCESS','PARTIAL_SUCCESS','INSUFFICIENT','FAILED'] as const;
export const STATUS_LABELS={RUNNING:'运行中',SUCCESS:'成功',PARTIAL_SUCCESS:'部分成功',INSUFFICIENT:'资料不足',FAILED:'失败',CANCELLED:'已取消',NOT_PROVIDED:'资料未提供',PENDING_VERIFICATION:'待核实',EXTRACTION_FAILED:'提取失败'} as const;
// Accept the previous model spelling, but expose only canonical statuses to the UI.
const legacyStatuses:Partial<Record<string,typeof FIELD_STATUSES[number]>>={provided:'SUCCESS',verify:'PENDING_VERIFICATION',missing:'NOT_PROVIDED'};
const rawFieldSchema=z.object({status:z.enum([...FIELD_STATUSES,'provided','verify','missing']),value:z.string().trim().max(240).optional(),quote:z.string().trim().max(240),source:z.number().int().min(1).max(5).nullable()}).strict().transform(f=>({...f,status:legacyStatuses[f.status]??f.status as typeof FIELD_STATUSES[number],value:f.value??f.quote}));
export const extractionSchema=z.object(Object.fromEntries(FIELDS.map(([key])=>[key,rawFieldSchema])) as Record<typeof FIELDS[number][0],typeof rawFieldSchema>).strict();
export type Extraction=z.infer<typeof extractionSchema>;
export const fieldSchema=z.object({status:z.enum(FIELD_STATUSES),value:z.string().max(240),quote:z.string().max(240),source:z.number().int().min(1).max(5).nullable(),note:z.string().max(180),evidence:z.object({documentId:z.uuid(),chunkId:z.uuid(),fileName:z.string().max(255),version:z.number().int().positive(),page:z.number().int().positive().optional()}).strict().nullable()}).strict();
export const verifiedFieldsSchema=z.object(Object.fromEntries(FIELDS.map(([key])=>[key,fieldSchema])) as Record<typeof FIELDS[number][0],typeof fieldSchema>).strict();
export type VerifiedFields=z.infer<typeof verifiedFieldsSchema>;
export type Outcome=typeof OUTCOMES[number];
export const inputSchema=z.object({documentIds:z.array(z.uuid()).min(2).max(3).refine(a=>new Set(a).size===a.length,'请选择不同文档'),requirements:z.string().trim().max(1200).default(''),engine:z.enum(['mock','deepseek']).default('mock')}).strict();
export type ComparisonInput=z.infer<typeof inputSchema>;
export const productSchema=z.object({documentId:z.uuid(),name:z.string().max(255),version:z.number().int().positive(),status:z.enum(OUTCOMES),fields:verifiedFieldsSchema,sourceCount:z.number().int().min(0).max(5)}).strict();
export type Product=z.infer<typeof productSchema>;
export const STAGES=['plan','retrieve','extract','compare','verify','export'] as const;
export const LABELS:Record<typeof STAGES[number],string>={plan:'规划比较维度',retrieve:'分别检索产品资料',extract:'逐产品结构化提取',compare:'整理字段差异',verify:'核验原文与当前版本',export:'生成 Word / PDF'};
export const eventSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('step'),stepId:z.uuid(),stage:z.enum(STAGES),productIndex:z.number().int().min(1).max(3).optional(),status:z.enum(['RUNNING',...OUTCOMES,'CANCELLED']),at:z.number(),elapsedMs:z.number().nonnegative().optional(),note:z.string().max(180).optional()}).strict(),
  z.object({type:z.literal('complete'),status:z.enum(['SUCCESS','PARTIAL_SUCCESS','INSUFFICIENT']),id:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),formats:z.array(z.enum(['docx','pdf'])),products:z.array(productSchema).min(2).max(3),report:reportSchema}).strict(),
  z.object({type:z.literal('error'),message:z.string().max(500)}).strict(),
]);
export type ComparisonEvent=z.infer<typeof eventSchema>;
export type ComparisonResult=Extract<ComparisonEvent,{type:'complete'}>;
