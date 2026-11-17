import {z} from 'zod';
import {FIELDS} from '../comparison/types';
export const PRODUCT_FIELDS=[...FIELDS,['company','保险公司'],['restrictions','其他重要限制']] as const;
export const PROOF_LABELS={FOUND:'已找到',NOT_FOUND:'未找到（资料不足）',UNCONFIRMED:'无法确认（待核实）'} as const;
export const proofSchema=z.object({value:z.string().max(240),quote:z.string().min(1).max(240),source:z.number().int().min(1).max(5),documentId:z.uuid(),chunkId:z.uuid(),fileName:z.string().max(255),version:z.number().int().positive(),page:z.number().int().positive().optional()}).strict();
export const productFieldSchema=z.object({status:z.enum(['FOUND','NOT_FOUND','UNCONFIRMED']),value:z.string().max(240),conflict:z.boolean(),note:z.string().max(300),proofs:z.array(proofSchema).max(5)}).strict();
export const productEvidenceSchema=z.object({fields:z.object(Object.fromEntries(PRODUCT_FIELDS.map(([k])=>[k,productFieldSchema])) as Record<typeof PRODUCT_FIELDS[number][0],typeof productFieldSchema>).strict()}).strict();
export const productGroupSchema=productEvidenceSchema.extend({id:z.uuid(),displayName:z.string().max(255),documents:z.array(z.object({id:z.uuid(),name:z.string().max(255),version:z.number().int().positive()}).strict()).min(1).max(3),identityConfirmed:z.boolean()}).strict();
export type ProductEvidence=z.infer<typeof productEvidenceSchema>;
export type ProductGroup=z.infer<typeof productGroupSchema>;
export type ProductField=z.infer<typeof productFieldSchema>;
export type Proof=z.infer<typeof proofSchema>;
export function fieldDisplay(field:ProductField){return (field.conflict?'证据冲突，待核实':PROOF_LABELS[field.status])+(field.status==='FOUND'?'：'+field.value:'')+(field.proofs.length?' '+field.proofs.map(p=>`〔${p.source}〕v${p.version}${p.page?' p'+p.page:''}`).join(' '):'');}
