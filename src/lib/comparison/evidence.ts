import type { Source } from '../rag/types';
import { FIELDS, type Extraction, type VerifiedFields, type Outcome } from './types';

const norm=(s:string)=>s.normalize('NFKC').replace(/\s+/g,'');
const category=/(两全保险|年金保险|终身寿险|定期寿险|医疗保险|重大疾病保险|意外伤害保险)/;
export function emptyFields(failed=false):VerifiedFields{
  return Object.fromEntries(FIELDS.map(([k])=>[k,{status:failed?'EXTRACTION_FAILED':'NOT_PROVIDED',value:'',quote:'',source:null,evidence:null,note:failed?'模型调用或格式解析失败，未生成本字段结论。':'本次证据未提供。'}])) as VerifiedFields;
}
export function outcome(fields:VerifiedFields):Outcome{
  const values=Object.values(fields),success=values.filter(f=>f.status==='SUCCESS').length;
  if(success===values.length)return 'SUCCESS';
  if(success)return 'PARTIAL_SUCCESS';
  return values.some(f=>f.status==='EXTRACTION_FAILED')?'FAILED':'INSUFFICIENT';
}
export function overall(statuses:Outcome[]):Outcome{
  if(statuses.every(s=>s==='SUCCESS'))return 'SUCCESS';
  if(statuses.some(s=>s==='SUCCESS'||s==='PARTIAL_SUCCESS'))return 'PARTIAL_SUCCESS';
  return statuses.some(s=>s==='FAILED')?'FAILED':'INSUFFICIENT';
}

// Exact explicit identity text only. Never infer a product from its filename.
function identity(sources:Source[],key:'name'|'type'){
  for(const source of sources)for(const line of source.text.split(/\r?\n/).map(s=>s.trim())){
    const explicit=(key==='name'?/(?:产品名称|保险名称)\s*[：:]\s*([^。；\n]{2,80})/:/(?:产品类型|保险类型|保险类别)\s*[：:]\s*([^。；\n]{2,80})/).exec(line);
    if(explicit&&!/未提供|未提及|未列明|不详|未知|待定/.test(explicit[1]))return {status:'SUCCESS' as const,value:explicit[1].trim(),quote:explicit[0],source:source.number};
    if(line.length>100||/[：:]|案例|示例|宣传|建议|客户/.test(line))continue;
    if(/^.{2,80}(?:两全保险|年金保险|终身寿险|定期寿险|医疗保险|重大疾病保险|意外伤害保险)(?:[（(][^）)\n]{1,15}[）)])?$/.test(line)){
      const value=key==='name'?line:category.exec(line)![1];return {status:'SUCCESS' as const,value,quote:line,source:source.number};
    }
  }
}
function classification(key:typeof FIELDS[number][0],value:string,quote:string,context:string){
  const clauses=quote.split(/[，,。；;\n]/).filter(c=>norm(c).includes(norm(value).replace(/[。；;]+$/,'')));
  const q=norm(clauses.join('；'));
  if(key==='insuranceTerm'&&!/(?:保险|保障)(?:期间|期限)|保(?:障)?(?:至|终身|[\d一二三四五六七八九十]+年)/.test(q))return '不能将缴费期间、产品类型或案例年龄直接当作保险期间。';
  if(key==='paymentTerm'&&!/(?:缴费|交费)(?:期间|期限)|(?:交|缴)(?:费)?(?:期|年期)?[：:]?[\d一二三四五六七八九十]+年|[\d一二三四五六七八九十]+年(?:交|缴)|趸交/.test(q))return '未见明确缴费期间；缴费频率、金额或保险期间不能代替缴费期间。';
  if(key==='premium'){
    const premium=/(?:保费|保险费|[年月季](?:交|缴)|趸交|缴费|交费)/;
    if(!clauses.length||clauses.some(c=>!premium.test(c)))return '该金额缺少明确保费语境，不能把保额或保险金当作保费。';
    if(/案例|示例|客户|假设|测算|计划书|\d+\s*(?:周)?岁|先生|女士|演示/.test(context))return '案例或测算中的缴费金额不能当作产品标准费率，需核实适用条件。';
  }
  if(key==='coverage'&&(!/身故|全残|满期|生存|给付|赔付|报销|医疗费用|住院津贴|保险金/.test(q)||/不(?:承担|予|提供|属于|赔)|免责|责任免除/.test(q)))return '宣传语、概括或否定表述不能作为已确认的正向保障责任。';
}

export function auditExtraction(raw:Extraction,sources:Source[],document:{id:string;name:string;version?:number},fallbackIdentity=true):VerifiedFields{
  const result=emptyFields();
  for(const [key] of FIELDS){
    let field=raw[key];
    if(field.status==='NOT_PROVIDED'&&fallbackIdentity&&(key==='name'||key==='type'))field=identity(sources,key)??field;
    if(field.status==='NOT_PROVIDED'){
      if(field.quote||field.source!==null||field.value)result[key]={...emptyFields(true)[key],note:'缺失字段却包含内容或引用，已拒绝不一致的提取。'};
      continue;
    }
    if(field.status==='EXTRACTION_FAILED'){result[key]=emptyFields(true)[key];continue;}
    const source=sources.find(s=>s.number===field.source&&s.documentId===document.id);
    if(!source||!field.quote||!source.text.includes(field.quote)||!field.value||!norm(field.quote).includes(norm(field.value))){result[key]={...emptyFields(true)[key],note:'提取结果或摘录与所属产品原文不匹配，未展示不可靠内容。'};continue;}
    if(/^(?:资料|原文|本资料|产品)?(?:未提供|未提及|未列明|不详|未知|待定)$/.test(norm(field.value))){result[key]={...result[key],note:'本次原文明示该字段未提供。'};continue;}
    const note=classification(key,field.value,field.quote,source.text);
    result[key]={status:note||field.status==='PENDING_VERIFICATION'?'PENDING_VERIFICATION':'SUCCESS',value:note?'':field.value,quote:field.quote,source:source.number,evidence:{documentId:document.id,chunkId:source.chunkId,fileName:document.name,version:document.version??1,...(source.page?{page:source.page}:{})},note:note??(field.status==='PENDING_VERIFICATION'?'原文信息不完整或存在歧义，请人工核实。':'结果与所属产品原文摘录匹配；仍需人工核验语境。')};
  }return result;
}
