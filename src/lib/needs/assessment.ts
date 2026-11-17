import { z } from 'zod';
import { FIELDS } from '../comparison/types';
import type { Profile, Need } from './types';

export const PROFILE_LABELS={age:'年龄',gender:'性别',family:'家庭情况',children:'子女情况',occupation:'职业情况',personalIncome:'个人年收入',householdIncome:'家庭年收入',annualBudget:'年度保险预算',existingCoverage:'已有保障',needs:'明确需求',notes:'补充要求'} as const;
const field=z.enum(Object.keys(PROFILE_LABELS) as [keyof Profile,...(keyof Profile)[]]);
const text=(max:number)=>z.string().trim().min(1).max(max).refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const basis=z.array(z.object({field,quote:text(80)}).strict()).min(1).max(3);
export const assessmentSchema=z.object({
  summary:text(500),
  hypotheses:z.array(z.object({text:text(240),basis,status:z.literal('PENDING_VERIFICATION')}).strict()).max(4),
  prioritySuggestions:z.array(z.object({category:z.enum(['health','critical','life','accident','pension','education','other']),reason:text(240),basis}).strict()).max(3),
  questions:z.array(text(180)).max(6),
  fieldsToVerify:z.array(z.enum(FIELDS.map(([key])=>key) as [typeof FIELDS[number][0],...typeof FIELDS[number][0][]])).max(10),
}).strict();
export type Assessment=z.infer<typeof assessmentSchema>;
export function validateAssessment(value:Assessment,profile:Profile,needs:Need[]){
  const allowed=new Set(needs.map(n=>n.category));
  for(const item of [...value.hypotheses,...value.prioritySuggestions])for(const proof of item.basis){
    const original=profile[proof.field];
    if(original===undefined||original===''||original==='unspecified'||!String(original).includes(proof.quote))throw new Error('AI 判断缺少真实客户输入依据。');
  }
  if(value.prioritySuggestions.some(p=>!allowed.has(p.category))||new Set(value.prioritySuggestions.map(p=>p.category)).size!==value.prioritySuggestions.length)throw new Error('AI 优先级超出客户明确需求或重复分类。');
  if(/(?:保证|确保|一定)(?:能|会|可以)?(?:承保|收益|赔付|获赔)/.test(JSON.stringify(value)))throw new Error('AI 分析包含不允许的保险承诺。');
  return value;
}
export const EVIDENCE_LABELS={SUCCESS:'已找到原文依据',PENDING_VERIFICATION:'部分找到，需要人工核实',NOT_PROVIDED:'资料未提供',EXTRACTION_FAILED:'无法确认'} as const;
