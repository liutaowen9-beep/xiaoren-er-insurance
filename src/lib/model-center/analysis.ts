import Decimal from 'decimal.js';
import type {ModelStore} from './store';
import type {QualityScores} from './types';
export const DIMENSIONS=['accuracy','completeness','relevance','instruction','format'] as const;
const average=(values:(number|null)[])=>{const known=values.filter((v):v is number=>v!==null&&Number.isFinite(v));return {value:known.length?known.reduce((n,v)=>n+v,0)/known.length:null,count:known.length};};
export function summarize(run:ReturnType<ModelStore['run']>){
  const models=run.models.map(model=>{
    const results=run.results.filter(r=>r.modelId===model.id),attempts=run.attempts.filter(a=>a.modelId===model.id),success=results.filter(r=>r.status==='success').length;
    const scored=Object.fromEntries(DIMENSIONS.map(d=>[d,average(results.map(r=>r.quality[d].value))])) as Record<keyof QualityScores,{value:number|null;count:number}>;
    const unknownCost=attempts.filter(a=>a.cost.usd===null).length,knownCost=attempts.reduce((n,a)=>n.add(a.cost.usd??0),new Decimal(0));
    const sum=(field:'input'|'output'|'total')=>attempts.length&&attempts.every(a=>a.response?.usage[field]!==null&&a.response?.usage[field]!==undefined)?attempts.reduce((n,a)=>n+a.response!.usage[field]!,0):null;
    return {id:model.id,name:model.name,configuredVersion:model.version,mode:run.config.mode,caseCount:results.length,attemptCount:attempts.length,quality:scored,successRate:results.length?success/results.length:null,failureRate:results.length?results.filter(r=>['failed','cancelled'].includes(r.status)).length/results.length:null,firstTextMs:average(results.map(r=>r.response?.firstTextMs??null)),latencyMs:average(results.map(r=>r.response?.elapsedMs??null)),tokens:{input:sum('input'),output:sum('output'),total:sum('total')},cost:{usd:attempts.length&&!unknownCost?knownCost.toFixed(12):null,knownSubtotalUSD:attempts.length?knownCost.toFixed(12):null,unknownAttempts:unknownCost,source:'actual usage × frozen price; estimate, not invoice'}};
  });
  return {models,costUSD:models.length&&models.every(m=>m.cost.usd!==null)?models.reduce((n,m)=>n.add(m.cost.usd!),new Decimal(0)).toFixed(12):null,unknownCostAttempts:models.reduce((n,m)=>n+m.cost.unknownAttempts,0),notice:'五维值为可解释规则代理，非完整语义正确率。未知值不补零；Mock 与 live 不混合。'};
}
export function comparable(a:ReturnType<ModelStore['run']>,b:ReturnType<ModelStore['run']>){
  return a.config.mode===b.config.mode&&a.dataset.hash===b.dataset.hash&&JSON.stringify(a.dataset.cases.map(c=>c.id))===JSON.stringify(b.dataset.cases.map(c=>c.id))&&a.config.maxTokens===b.config.maxTokens&&['promptHash','scorer','rubricHash'].every(k=>a.provenance[k]===b.provenance[k]);
}
