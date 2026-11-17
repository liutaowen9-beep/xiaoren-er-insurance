import { TOPICS, type Need, type Profile, type Candidate, type Priority } from './types';
import { FIELDS, STATUS_LABELS, type Product } from '../comparison/types';
import { ReportError } from '../reports/types';

export const TOPIC_WORDS:Record<Need['category'],RegExp>={health:/住院|医疗/,critical:/重疾|重大疾病/,life:/家庭责任|身故|寿险/,accident:/意外/,pension:/养老|退休/,education:/教育|子女教育/,other:/.+/};
export function explicitNeeds(profile:Profile):Need[]{
  const result:Need[]=[];for(const category of Object.keys(TOPICS) as Need['category'][]){if(category==='other')continue;const match=TOPIC_WORDS[category].exec(profile.needs);if(match)result.push({category,quote:match[0]});}
  if(!result.length&&profile.needs)result.push({category:'other',quote:profile.needs.slice(0,240)});return result.sort((a,b)=>profile.needs.indexOf(a.quote)-profile.needs.indexOf(b.quote)).slice(0,3);
}
export function prioritizeNeeds(needs:Need[],profile:Profile):Priority[]{
  return needs.map((n,needIndex)=>({needIndex,position:profile.needs.indexOf(n.quote)})).sort((a,b)=>a.position-b.position).map((n,i)=>({needIndex:n.needIndex,rank:i+1,basis:'依据客户原话出现顺序整理沟通顺序，待客户确认；不是风险评分或投保优先级。'}));
}
export function followUpQuestions(p:Profile):string[]{
  const questions:string[]=[];
  if(p.age===undefined)questions.push('客户年龄或年龄区间是多少？用于后续核对原文投保条件。');
  if(!p.family)questions.push('哪些家庭成员依赖客户收入？目前承担哪些明确的家庭责任？');
  if(!p.children)questions.push('是否存在需要考虑的子女责任或教育计划？未提供不等于没有。');
  if(!p.occupation)questions.push('客户从事什么职业，是否有需要核实的职业类别限制？');
  if(p.householdIncome===undefined)questions.push('可用于长期规划的家庭年收入范围是多少？');
  if(p.annualBudget===undefined)questions.push('可持续承担的年度保险预算及缴费安排是什么？');
  if(!p.existingCoverage)questions.push('已有保障的责任、保额、期限和免责分别是什么？');
  if(!p.needs)questions.push('客户最希望先解决哪一项问题？请用自己的话按关注顺序描述。');
  questions.push('请客户确认关注点的先后顺序，并补充尚未明确的特殊要求。','后续如何取得完整条款、适用费率和本人授权的投保条件核验资料？');
  return questions;
}
export function validateNeeds(needs:Need[],profile:Profile){
  for(const n of needs)for(const quote of [n.quote,...(n.quotes??[])])if(!profile.needs.includes(quote)||!TOPIC_WORDS[n.category].test(quote))throw new ReportError(`【${TOPICS[n.category]}】原话证据偏离客户明确输入或分类，无法安全合并。`,409);
  const repeated=[...new Set(needs.filter((n,i)=>needs.findIndex(other=>other.category===n.category)!==i).map(n=>TOPICS[n.category]))];
  if(repeated.length)throw new ReportError(`需求结构包含重复分类【${repeated.join('、')}】，必须合并原话证据后再分析。`,409);
}
export function mergeNeeds(needs:Need[],profile:Profile):Need[]{
  const grouped=new Map<Need['category'],string[]>();
  for(const need of needs){
    validateNeeds([need],profile);
    const quotes=grouped.get(need.category)??[];
    for(const quote of [need.quote,...(need.quotes??[])])if(!quotes.includes(quote))quotes.push(quote);
    if(quotes.length>12||quotes.join('\n').length>1800)throw new ReportError(`【${TOPICS[need.category]}】同类原话证据超过安全容量，无法无损合并；请分批分析。`,409);
    grouped.set(need.category,quotes);
  }
  if(grouped.size>3)throw new ReportError(`需求涉及${grouped.size}类【${[...grouped.keys()].map(k=>TOPICS[k]).join('、')}】，超过本次3类上限；请分批分析，不会丢弃任何分类。`,409);
  const result=[...grouped].map(([category,quotes])=>{
    quotes.sort((a,b)=>profile.needs.indexOf(a)-profile.needs.indexOf(b));
    return {category,quote:quotes[0],...(quotes.length>1?{quotes}:{} )};
  }).sort((a,b)=>profile.needs.indexOf(a.quote)-profile.needs.indexOf(b.quote));
  validateNeeds(result,profile);return result;
}
export function missingInfo(p:Profile){
  const missing:string[]=[];
  if(p.age===undefined)missing.push('年龄未提供，不判断投保年龄条件。');
  if(!p.family)missing.push('家庭责任与依赖关系未说明。');
  if(!p.children)missing.push('子女情况未说明，不推断是否有子女。');
  if(!p.occupation)missing.push('职业及职业风险未说明。');
  if(p.householdIncome===undefined)missing.push('家庭年收入未提供，不自行估算。');
  if(p.annualBudget===undefined)missing.push('年度保险预算未提供，不能判断预算约束。');
  if(!p.existingCoverage)missing.push('已有保障未提供，不能确认实际保障缺口。');
  if(!p.needs)missing.push('主要需求未明确，先补充关注的问题。');
  missing.push('健康告知、完整保障条款、现有保额及具体费率适用条件需后续授权核实；本工具不进行核保或投保决策。');return missing;
}
export const retrievalQueries=(needs:Need[],original='')=>[...new Set(needs.flatMap(n=>n.category==='other'?[original||n.quote]:[original||n.quote,(original||n.quote)+' '+({health:'医疗保险 住院费用 保障责任',critical:'重大疾病保险 保障责任',life:'人寿保险 身故保险金 保障责任',accident:'意外保险 保障责任',pension:'养老年金保险 保险期间',education:'教育年金保险 保险期间',other:'保险产品 保障责任 保险期间'}[n.category])]))].slice(0,6);
export function matchCandidate(product:Product,needs:Need[],profile:Profile):Candidate{
  const links:Candidate['links']=[],coverage=product.fields.coverage;
  if(product.fields.name.status==='SUCCESS'&&product.fields.type.status==='SUCCESS'&&coverage.status==='SUCCESS'&&coverage.source)needs.forEach((n,i)=>{if(n.category!=='other'&&TOPIC_WORDS[n.category].test(coverage.value))links.push({needIndex:i,source:coverage.source!,quote:coverage.quote,note:`资料中已核验的责任表述与“${TOPICS[n.category]}”存在字面关联，仅作为待核实线索；不表示适合客户、覆盖完整需求或保证承保。`});});
  const unknowns=FIELDS.filter(([key])=>product.fields[key].status!=='SUCCESS').map(([key,label])=>`${label}：${STATUS_LABELS[product.fields[key].status]}。`);
  for(let i=0;i<needs.length;i++)if(!links.some(l=>l.needIndex===i))unknowns.push(`${TOPICS[needs[i].category]}：本次未找到可核验的对应责任关联，不能判定产品覆盖该需求。`);
  unknowns.push('未核实完整免责、投保资格及客户适用条件，不作适合/不适合的最终判断。');
  const budget=profile.annualBudget===undefined?'年度预算未提供，预算适配未知。':product.fields.premium.status!=='SUCCESS'?'客户已给定年度预算，但资料中缺少可核验的保费信息，预算适配未知。':'虽有保费摘录，但未确认该客户的费率与缴费条件，预算适配仍待核实；不能将案例金额视为标准费率。';
  return {product,links,unknowns:unknowns.slice(0,15),budget};
}
