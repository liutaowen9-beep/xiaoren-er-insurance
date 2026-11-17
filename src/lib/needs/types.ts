import { z } from 'zod';
import { productSchema } from '../comparison/types';
import { reportSchema } from '../reports/types';
import { assessmentSchema } from './assessment';
import { retrievalDiagnosticSchema } from './retrieval-types';
import {productEvidenceSchema,productGroupSchema} from './product-types';
const optionalText=(max:number)=>z.string().trim().max(max).refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v),'含不支持的控制字符').default('');
const amount=z.number().finite().min(0).max(100000000).optional();
export const profileSchema=z.object({age:z.number().int().min(0).max(100).optional(),gender:z.enum(['unspecified','female','male','other']).default('unspecified'),family:optionalText(500),children:optionalText(500),occupation:optionalText(200),personalIncome:amount,householdIncome:amount,annualBudget:amount,existingCoverage:optionalText(1200),needs:optionalText(1200),notes:optionalText(1200)}).strict().refine(v=>Object.values(v).some(x=>typeof x==='number'||typeof x==='string'&&x&&x!=='unspecified'),'至少填写一项客户信息或需求').refine(v=>JSON.stringify(v).length<=5500,'客户信息过长');
export const inputSchema=z.object({profile:profileSchema,engine:z.enum(['mock','deepseek']).default('mock'),consent:z.boolean().default(false)}).strict().refine(v=>v.engine!=='deepseek'||v.consent,'真实分析需要确认资料允许外发并同意付费调用');
export type Profile=z.infer<typeof profileSchema>;
export const TOPICS={health:'住院医疗费用',critical:'重大疾病保障',life:'家庭责任与身故保障',accident:'意外保障',pension:'养老需求',education:'子女教育需求',other:'其他明确需求'} as const;
export const NEED_CATEGORIES=['health','critical','life','accident','pension','education','other'] as const;
type NeedCategory=typeof NEED_CATEGORIES[number];
const categoryKey=(v:string)=>v.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/g,'');
const aliases=new Map<string,NeedCategory>();
for(const category of NEED_CATEGORIES){aliases.set(categoryKey(category),category);aliases.set(categoryKey(TOPICS[category]),category);}
for(const [name,category] of Object.entries({医疗:'health',医疗保障:'health',住院医疗:'health',重疾:'critical',重大疾病:'critical',critical_illness:'critical',寿险:'life',身故保障:'life',家庭责任:'life',意外:'accident',养老:'pension',退休:'pension',教育:'education',子女教育:'education',其他:'other'}) as [string,NeedCategory][])aliases.set(categoryKey(name),category);
const categorySchema=z.preprocess(v=>typeof v==='string'?aliases.get(categoryKey(v))??v:v,z.enum(NEED_CATEGORIES));
const quoteSchema=z.string().trim().min(1).max(240);
// An empty supplemental list adds no evidence; the mandatory primary quote is still validated.
export const needSchema=z.object({category:categorySchema,quote:quoteSchema,quotes:z.preprocess(v=>Array.isArray(v)&&v.length===0?undefined:v,z.array(quoteSchema).min(1).max(12).optional())}).strict();
// Bounded model input may repeat categories; canonical output still has at most 3.
export const needsSchema=z.object({needs:z.array(needSchema).max(12)}).strict();
export type Need=z.infer<typeof needSchema>;
export const prioritySchema=z.object({needIndex:z.number().int().min(0).max(2),rank:z.number().int().min(1).max(3),basis:z.string().max(180)}).strict();
export type Priority=z.infer<typeof prioritySchema>;
export const STAGES=['structure','needs','priority','missing','plan','search','ai_analysis','validate','extract','match','report','export','knowledge_search','calculator'] as const;
export const LABELS:Record<typeof STAGES[number],string>={structure:'结构化客户信息',needs:'分析明确需求',priority:'整理待确认沟通优先级',missing:'识别信息缺口及追问',plan:'制定检索计划',search:'检索当前有效资料',ai_analysis:'DeepSeek 需求判断（待确认）',validate:'核验原文与版本',extract:'提取候选产品字段',match:'分析证据关联与未知项',report:'生成结构化需求报告',export:'导出 Word / PDF',knowledge_search:'工具 · 知识库检索',calculator:'工具 · 预算算术折算'};
export const matchSchema=z.object({needIndex:z.number().int().min(0).max(2),source:z.number().int().min(1).max(5),quote:z.string().max(240),note:z.string().max(300)}).strict();
export const candidateSchema=z.object({product:productSchema,links:z.array(matchSchema).max(3),unknowns:z.array(z.string().max(300)).max(15),budget:z.string().max(300),failure:z.string().max(300).optional(),productEvidence:productEvidenceSchema.optional()}).strict();
export type Candidate=z.infer<typeof candidateSchema>;
export const eventSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('step'),stepId:z.uuid(),stage:z.enum(STAGES),status:z.enum(['RUNNING','SUCCESS','PARTIAL_SUCCESS','INSUFFICIENT','FAILED','CANCELLED']),at:z.number(),elapsedMs:z.number().nonnegative().optional(),retrieval:retrievalDiagnosticSchema.optional(),note:z.string().max(300).optional(),productIndex:z.number().int().min(1).max(3).optional()}).strict(),
  z.object({type:z.literal('complete'),status:z.enum(['PARTIAL_SUCCESS','INSUFFICIENT']),products:z.array(productGroupSchema).max(3).optional(),retrieval:z.array(retrievalDiagnosticSchema).max(12).optional(),aiAnalysis:assessmentSchema.nullable(),completedAt:z.number().int().positive(),needs:z.array(needSchema).max(3),priorities:z.array(prioritySchema).max(3),questions:z.array(z.string().max(180)).max(12),missing:z.array(z.string().max(180)).max(12),monthlyBudget:z.string().max(80).nullable(),candidates:z.array(candidateSchema).max(3),report:reportSchema,id:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),formats:z.array(z.enum(['docx','pdf']))}).strict(),
  z.object({type:z.literal('error'),message:z.string().max(500)}).strict(),
]);
export type NeedsEvent=z.infer<typeof eventSchema>;
export type NeedsResult=Extract<NeedsEvent,{type:'complete'}>;
export const DEMO_PROFILE:Profile={age:34,gender:'female',family:'已婚，夫妻共同承担家庭开支；父母生活独立。',children:'一个8岁的孩子，关注未来教育支出。',occupation:'虚构的软件测试工程师，收入相对稳定。',personalIncome:260000,householdIncome:420000,annualBudget:12000,existingCoverage:'已参加基本医保，有一份意外险，保额和免责条款尚未整理。',needs:'关注住院医疗费用、重大疾病保障和家庭责任。希望先明确已有保障缺口，再核对产品资料。',notes:'完全虚构的面试演示案例，不含真实客户资料。不作承保、收益或保费报价判断。'};
