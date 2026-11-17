import Decimal from 'decimal.js';
import type {Price,Usage,Cost,ModelId} from './types';
export const PRICE_SOURCE='https://api-docs.deepseek.com/quick_start/pricing/' as const;
// Official snapshot read 2026-11-12; published effective date is not specified, so it remains null.
export const DEFAULT_PRICES:Price[]=[
  {model:'deepseek-flash',version:'official-2026-11-12-flash',source:PRICE_SOURCE,observedAt:'2026-11-12T00:00:00.000Z',effectiveAt:null,currency:'USD',peak:{hit:'0.006',miss:'0.30',output:'1.20'},offPeak:{hit:'0.003',miss:'0.15',output:'0.60'},verification:'official-snapshot'},
  {model:'deepseek-v4-pro',version:'official-2026-11-12-pro',source:PRICE_SOURCE,observedAt:'2026-11-12T00:00:00.000Z',effectiveAt:null,currency:'USD',peak:{hit:'0.044',miss:'1.32',output:'3.96'},offPeak:{hit:'0.022',miss:'0.66',output:'1.98'},verification:'official-snapshot'},
];
const perM=(n:number,rate:string)=>new Decimal(n).mul(rate).div(1000000);
export const unknownUsage=():Usage=>({input:null,output:null,total:null,cacheHit:null,cacheMiss:null,source:'unknown'});
export function parseUsage(value:unknown):Usage{
  if(!value||typeof value!=='object')return unknownUsage();const v=value as Record<string,unknown>;
  const count=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=10000000?x:null;
  const input=count(v.prompt_tokens),output=count(v.completion_tokens),total=count(v.total_tokens),hit=count(v.prompt_cache_hit_tokens),miss=count(v.prompt_cache_miss_tokens);
  if(input!==null&&output!==null&&total!==null&&input+output!==total)return {...unknownUsage(),warning:'供应商 Token 总数不一致，未用于计费。'};
  const cacheValid=input!==null&&hit!==null&&miss!==null&&hit+miss===input;
  return {input,output,total,cacheHit:cacheValid?hit:null,cacheMiss:cacheValid?miss:null,source:input!==null||output!==null||total!==null?'provider':'unknown',...(!cacheValid&&hit!==null?{warning:'缓存拆分信息不完整或不一致。'}:{})};
}
export function calculateCost(u:Usage,price:Price,tariff:'peak'|'off-peak'|'unknown',modelConfirmed=true):Cost{
  const base={priceVersion:price.version,source:price.source,tariff};
  if(!modelConfirmed||u.input===null||u.output===null||u.source!=='provider')return {...base,usd:null,lowerUSD:null,upperUSD:null,state:'UNKNOWN',reason:!modelConfirmed?'供应商返回的模型身份无法与价格对应。':'缺少供应商实际 Token 用量；未知费用不记为零。'};
  const bands=tariff==='unknown'?[price.offPeak,price.peak]:[tariff==='peak'?price.peak:price.offPeak];
  const costs=bands.flatMap(p=>u.cacheHit!==null&&u.cacheMiss!==null?[perM(u.cacheHit,p.hit).add(perM(u.cacheMiss,p.miss)).add(perM(u.output!,p.output))]:[perM(u.input!,p.hit).add(perM(u.output!,p.output)),perM(u.input!,p.miss).add(perM(u.output!,p.output))]);
  const lower=Decimal.min(...costs).toFixed(12),upper=Decimal.max(...costs).toFixed(12),known=tariff!=='unknown'&&u.cacheHit!==null&&u.cacheMiss!==null;
  return {...base,usd:known?lower:null,lowerUSD:lower,upperUSD:upper,state:known?'USAGE_BASED_ESTIMATE':'RANGE_ONLY',reason:known?'供应商实际用量 × 用户确认时段的版本化价格；不是账单凭证。':'缓存拆分或计费时段未确认，仅展示费用区间。'};
}
export function reserveUSD(inputBytes:number,maxTokens:number,price:Price){return perM(inputBytes+1024,price.peak.miss).add(perM(maxTokens,price.peak.output)).toFixed(12);}
export const MODEL_VERSIONS:Record<ModelId,string>={'deepseek-flash':'DeepSeek-V4.1-Flash-1017','deepseek-v4-pro':'DeepSeek-V4-Pro-0813'};
