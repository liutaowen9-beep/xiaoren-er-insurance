import 'server-only';
import type {Source} from '../rag/types';
import {auditExtraction,outcome} from '../comparison/evidence';
import {extractionSchema,FIELDS,type Extraction,type Product} from '../comparison/types';
import {PRODUCT_FIELDS,productEvidenceSchema,productGroupSchema,type ProductEvidence,type ProductGroup,type ProductField,type Proof} from './product-types';
import {ReportError} from '../reports/types';
export const needsExtractionSchema=extractionSchema.extend({company:extractionSchema.shape.name.optional(),restrictions:extractionSchema.shape.name.optional()});
type Raw=ReturnType<typeof needsExtractionSchema.parse>;
const norm=(s:string)=>s.normalize('NFKC').replace(/\s+/g,'');
const productType='(?:两全保险|年金保险|终身寿险|定期寿险|医疗保险|重大疾病保险|意外伤害保险)';
const empty=():ProductField=>({status:'NOT_FOUND',value:'',conflict:false,proofs:[],note:'本次有效原文未提供，资料不足，不代表产品不存在该责任。'});
const validValue=(s:string)=>s.length>=2&&s.length<=240&&!/未提供|未提及|未知|不详|待核实|计划书|建议书|演示|示例|假设/.test(s);
function proof(source:Source,value:string,quote:string):Proof{return {value,quote,source:source.number,documentId:source.documentId,chunkId:source.chunkId,fileName:source.fileName,version:source.version??1,...(source.page?{page:source.page}:{})};}
function explicit(sources:Source[],labels:string[]){
 const proofs:Proof[]=[];for(const source of sources)for(const label of labels)for(const match of source.text.matchAll(new RegExp('(?:'+label+')\\s*[：:]\\s*([^\\n。；;]{2,100})','g'))){const value=match[1].trim();if(validValue(value))proofs.push(proof(source,value,match[0]));}return unique(proofs);
}
function unique(proofs:Proof[]){const result=proofs.filter((p,i)=>proofs.findIndex(q=>q.chunkId===p.chunkId&&norm(q.value)===norm(p.value))===i);if(result.length>5)throw new ReportError('单字段原文证据超过安全容量，请缩小资料范围；未丢弃冲突证据。',409);return result;}
function fromProofs(proofs:Proof[],note='原文明确标注，仍需人工核对完整条款。'):ProductField{
 proofs=unique(proofs);if(!proofs.length)return empty();const conflict=new Set(proofs.map(p=>norm(p.value))).size>1;
 return {status:conflict?'UNCONFIRMED':'FOUND',value:conflict?'':proofs[0].value,conflict,proofs,note:conflict?'有效资料存在不同原文值，未自动选择任何结论。':note};
}
function names(sources:Source[]){
 const result=explicit(sources,['产品名称','保险名称','险种名称']).filter(p=>!/(?:有限公司|保险公司|计划)$/.test(p.value));
 for(const source of sources)for(const line of source.text.split(/\r?\n/).map(s=>s.trim())){
  if(line.length>100||/[：:]|客户|案例|简称|销售|公司|以下简称/.test(line))continue;
  const title=new RegExp('^([\\p{Script=Han}A-Za-z0-9· \\t]{2,50}'+productType+'(?:[（(][^）)\\n]{1,15}[）)])?)(?:产品说明书|保险条款)?$','u').exec(line);
  if(title)result.push(proof(source,title[1],line));
 }
 return unique(result);
}
const labels:Record<typeof FIELDS[number][0],string[]>={name:['产品名称','保险名称','险种名称'],type:['产品类型','保险类型','保险类别'],coverage:['保障责任','保险责任'],insuranceTerm:['保险期间','保险期限','保障期间'],paymentTerm:['缴费期间','缴费期限','交费期间'],eligibility:['投保条件','投保年龄'],waiting:['等待期'],exclusions:['免责条款','责任免除'],premium:['标准保费','标准保险费'],features:['产品特点']};

export function verifyProduct(raw:Raw,sources:Source[],document:{id:string;name:string;version?:number},enabled=true){
 // Identity is derived from the selected document text, never a filename or customer input.
 const own=sources.filter(s=>s.documentId===document.id).map(s=>{if(document.version&&s.version&&document.version!==s.version)throw new ReportError('产品证据版本与当前文档版本不符，未进入核验。',409);return {...s,fileName:document.name,version:document.version??s.version??1};}),name=fromProofs(enabled?names(own):[]);const input:Extraction={...raw};
 if(!enabled){const fields=auditExtraction(raw,own,document,false);return {fields,profile:productEvidenceSchema.parse({fields:Object.fromEntries(PRODUCT_FIELDS.map(([k])=>[k,empty()]))}),status:outcome(fields)};}
 if(name.status==='FOUND'&&['NOT_PROVIDED','EXTRACTION_FAILED'].includes(raw.name.status)){const p=name.proofs[0];input.name={status:'SUCCESS',value:p.value,quote:p.quote,source:p.source};}
 if(name.status==='FOUND'&&['NOT_PROVIDED','EXTRACTION_FAILED'].includes(raw.type.status)){const p=name.proofs[0],kind=new RegExp(productType).exec(p.value);if(kind)input.type={status:'SUCCESS',value:kind[0],quote:p.quote,source:p.source};}
 const fields=auditExtraction(input,own,document,true);
 const result=Object.fromEntries(PRODUCT_FIELDS.map(([k])=>[k,empty()])) as ProductEvidence['fields'];
 for(const [key] of FIELDS){const f=fields[key];result[key]={status:f.status==='SUCCESS'?'FOUND':f.status==='NOT_PROVIDED'?'NOT_FOUND':'UNCONFIRMED',value:f.status==='SUCCESS'?f.value:'',conflict:false,note:f.note,proofs:f.evidence&&f.quote&&f.source?[proof(own.find(s=>s.chunkId===f.evidence!.chunkId)!,f.value||f.quote,f.quote)]:[]};
  const marked=explicit(own,labels[key]);if(new Set(marked.map(p=>norm(p.value))).size>1){result[key]=fromProofs(marked);fields[key]={...fields[key],status:'PENDING_VERIFICATION',value:'',note:result[key].note};}
  const q=f.quote;
  const reason=key==='waiting'&&!/等待期|观察期/.test(q)?'未见等待期语境，不能将犹豫期等其他期限当作等待期。':key==='eligibility'&&(!/投保|被保险人|年龄|周岁/.test(q)||/案例|示例|假设|测算|先生|女士/.test(q))?'投保条件或客户案例语境不完整，不能确认标准投保条件。':key==='exclusions'&&!/责任免除|免责|不承担|不予|不给付|不赔/.test(q)?'未见明确免责条款语境。':key==='type'&&!new RegExp(productType).test(f.value)?'产品类别尚不明确，不能仅凭宣传属性推定险种。':key==='coverage'&&/案例|示例|假设|演示|测算/.test(q)?'案例演示不能直接作为产品标准保障责任。':'';
  if(f.status==='SUCCESS'&&reason&&!result[key].conflict){result[key]={...result[key],status:'UNCONFIRMED',value:'',note:reason};fields[key]={...fields[key],status:'PENDING_VERIFICATION',value:'',note:reason};}
 }
 if(name.status==='FOUND'||name.conflict)result.name=name;
 else if(result.name.status==='FOUND'&&(!new RegExp(productType).test(result.name.value)||/计划书|有限公司|保险公司/.test(result.name.value)))result.name={...result.name,status:'UNCONFIRMED',value:'',note:'摘录未能证明正式产品名称，不能把计划书或公司名称当成产品名称。'};
 // A document containing multiple explicit product identities is not a safe single-product scope.
 if(result.name.conflict){for(const [key] of FIELDS){fields[key]={...fields[key],status:'PENDING_VERIFICATION',value:'',note:'同一资料出现多个产品身份，不能确认字段归属。'};if(key!=='name')result[key]={...result[key],status:'UNCONFIRMED',value:'',note:'资料含多个产品身份，字段归属待核实。'};}}
 else if(result.name.status!=='FOUND')fields.name={...fields.name,status:'PENDING_VERIFICATION',value:'',note:result.name.note};
 result.company=fromProofs(explicit(own,['保险公司','承保公司','保险人']).filter(p=>/(?:保险|人寿).*(?:有限公司|公司)$/.test(p.value)));
 const companyProofs=[...result.company.proofs];
 for(const source of own){
  for(const match of source.text.matchAll(/[“「"](?:我们|本公司)[”」"]\s*指\s*([^，。,；;\n]{2,60}(?:保险)(?:股份)?有限公司)/g))companyProofs.push(proof(source,match[1].trim(),match[0]));
  for(const line of source.text.split(/\r?\n/).map(s=>s.trim()))if(/^[\p{Script=Han}A-Za-z0-9· \t]{2,50}保险(?:股份)?有限公司$/u.test(line))companyProofs.push(proof(source,line,line));
 }
 result.company=fromProofs(companyProofs);
 result.restrictions=fromProofs(explicit(own,['其他重要限制','重要限制','特别约定']));
 for(const key of ['company','restrictions'] as const){const f=raw[key];if(f&&f.status!=='NOT_PROVIDED'){
  const source=own.find(s=>s.number===f.source);if(source&&f.quote&&source.text.includes(f.quote)&&f.value&&norm(f.quote).includes(norm(f.value))){
   const p=proof(source,f.value,f.quote);const valid=key==='company'?/(?:保险公司|承保公司|保险人)\s*[：:]/.test(f.quote)&&/(?:有限公司|公司)/.test(f.value):/重要限制|特别约定/.test(f.quote);
   const collected=fromProofs([...result[key].proofs,p]);result[key]=valid&&f.status==='SUCCESS'?collected:{...collected,status:'UNCONFIRMED',value:'',note:'模型摘录虽存在，字段语境或完整性仍待人工核实。'};
  }else if(!result[key].proofs.length)result[key]={...empty(),status:'UNCONFIRMED',note:'提取内容与本产品原文不符，未采信。'};
 }}
 if(result.name.conflict)for(const key of ['company','restrictions'] as const)result[key]={...result[key],status:'UNCONFIRMED',value:'',note:'多个产品身份，字段归属无法确认。'};
 const profile=productEvidenceSchema.parse({fields:result});return {fields,profile,status:outcome(fields)};
}

export function groupProducts(items:{product:Product;productEvidence?:ProductEvidence}[]):ProductGroup[]{
 const groups=new Map<string,{product:Product;profile:ProductEvidence}[]>();
 for(const item of items){if(!item.productEvidence)continue;const f=item.productEvidence.fields;
  const key=f.name.status==='FOUND'&&f.company.status==='FOUND'?norm(f.company.value)+'\0'+norm(f.name.value):item.product.documentId;
  const group=groups.get(key)??[];group.push({product:item.product,profile:item.productEvidence});groups.set(key,group);
 }
 return [...groups.values()].map(items=>{
  const fields=Object.fromEntries(PRODUCT_FIELDS.map(([key])=>{const all=items.map(item=>item.profile.fields[key]),proofs=unique(all.flatMap(f=>f.proofs));let merged=fromProofs(proofs);
   if(all.some(f=>f.conflict)||new Set(proofs.map(p=>norm(p.value))).size>1)merged={...merged,status:'UNCONFIRMED',value:'',conflict:true,note:'同一产品的有效资料出现不同字段值，须人工核实。'};
   else if(!all.some(f=>f.status==='FOUND')&&all.some(f=>f.status==='UNCONFIRMED'))merged={...merged,status:'UNCONFIRMED',value:'',note:all.find(f=>f.status==='UNCONFIRMED')!.note};
   return [key,merged];})) as ProductEvidence['fields'];
  const first=items[0].product;return productGroupSchema.parse({id:first.documentId,fields,identityConfirmed:fields.name.status==='FOUND',displayName:fields.name.status==='FOUND'?fields.name.value:first.name.slice(0,230)+'（产品名称待核实）',documents:items.map(i=>({id:i.product.documentId,name:i.product.name,version:i.product.version}))});
 });
}
