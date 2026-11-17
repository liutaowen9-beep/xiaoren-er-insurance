import {scoreModel} from '../evaluation/scoring';
import type {EvalCase} from '../evaluation/types';
import type {Quality,QualityScores,Rubric,ResponseRecord} from './types';
const result=(basis:string,checks:{rule:string;passed:boolean}[]):Quality=>({value:checks.length?checks.filter(c=>c.passed).length/checks.length:null,state:checks.length?'SCORED':'UNKNOWN',basis,checks});
export function qualityScores(c:EvalCase,response:ResponseRecord|null,r:Rubric):QualityScores{
  const unavailable=!response||response.redacted;
  const text=response?.answer??'',normalized=text.normalize('NFKC').replace(/\s+/g,' ').trim();
  const accuracy=unavailable?null:scoreModel({...c,response:text}).exactMatch.value;
  let parsed:Record<string,unknown>|null=null;try{const value=JSON.parse(text);if(value&&typeof value==='object'&&!Array.isArray(value))parsed=value;}catch{/* Explicit format failure is scored below. */}
  return {
    accuracy:result(unavailable?'响应缺失或被脱敏，不评分。':'参考答案规范化后的精确匹配规则，不是完整语义准确率；需要人工复核。',accuracy===null?[]:[{rule:'与参考答案精确匹配',passed:accuracy===1}]),
    completeness:result('数据集人工指定 requiredPhrases 的覆盖率；没有标注时未知。',unavailable?[]:c.requiredPhrases.map(p=>({rule:'包含必需信息：'+p,passed:normalized.includes(p.normalize('NFKC'))}))),
    relevance:result('人工标注主题词覆盖，仅为相关性规则代理，不是语义裁判。',unavailable?[]:r.relevanceTerms.map(p=>({rule:'主题词：'+p,passed:normalized.includes(p.normalize('NFKC'))}))),
    instruction:result('逐项检查人工要求，未配置要求则未知。',unavailable?[]:[...r.mustInclude.map(p=>({rule:'必须包含：'+p,passed:text.includes(p)})),...r.forbidden.map(p=>({rule:'禁止出现：'+p,passed:!text.includes(p)})),...(r.maxChars?[{rule:'最多 '+r.maxChars+' 字符',passed:text.length<=r.maxChars}]:[])]),
    format:result(r.format==='json'?'必须为 JSON 对象，并包含声明字段；不推断字段语义。':'必须为非空文本。',unavailable?[]:r.format==='json'?[{rule:'合法 JSON 对象',passed:!!parsed},...r.jsonKeys.map(p=>({rule:'JSON 字段：'+p,passed:!!parsed&&Object.hasOwn(parsed,p)}))]:[{rule:'非空文本',passed:!!text.trim()}]),
  };
}
