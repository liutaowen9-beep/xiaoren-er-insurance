import type { EvalCase,Reference,Metric } from './types';
const metric=(value:number|null,denominator:number,definition:string,reason?:string):Metric=>({value,denominator,definition,...(reason?{reason}:{})});
export const key=(v:Reference,level:'document'|'chunk')=>`${v.documentId}@${v.version}${level==='chunk'?':'+(v.chunkId??'UNKNOWN'):''}`;
export function scoreRetrieval(c:EvalCase,hits:Reference[],k:number,level:'document'|'chunk',elapsed:number){
  const unique=[...new Set(hits.map(h=>key(h,level)))].slice(0,k),gold=c.relevant;
  const valid=!!gold?.length&&(level==='document'||gold.every(g=>g.chunkId));
  const expected=new Set(gold?.map(g=>key(g,level))),matched=unique.filter(h=>expected.has(h)),rank=unique.findIndex(h=>expected.has(h));
  const unknown='缺少该层级的非空相关性标注；无答案案例单独统计，不将空 gold 视为全部正确。';
  const citations=c.citations?.map(h=>key(h,level));
  return {
    recall:metric(valid?matched.length/expected.size:null,valid?expected.size:0,'去重命中相关单元数 / 标注相关单元数',valid?undefined:unknown),
    precision:metric(valid?matched.length/k:null,valid?k:0,'去重命中相关单元数 / 配置 K（不足 K 不补造结果）',valid?undefined:unknown),
    hitRate:metric(valid?Number(matched.length>0):null,valid?1:0,'前 K 是否至少命中一个相关单元',valid?undefined:unknown),
    mrr:metric(valid?(rank<0?0:1/(rank+1)):null,valid?1:0,'首个相关单元排名倒数',valid?undefined:unknown),
    citationPrecision:metric(valid&&citations?.length?citations.filter(h=>expected.has(h)).length/citations.length:null,valid?citations?.length??0:0,'已标注实际引用中属于 gold 的比例；不把检索结果当引用','未提供实际引用时不可计算'),
    latencyMs:metric(elapsed,1,'单次本地实际检索耗时（毫秒）'),emptyRate:metric(Number(hits.length===0),1,'实际检索结果为空的案例比例'),
    unanswerableEmpty:metric(c.unanswerable?Number(hits.length===0):null,c.unanswerable?1:0,'标注无答案案例是否返回空；不代表生成答案正确'),
  };
}
type Step={kind:string;name:string;status:string;elapsed_ms:number|null;error_code?:string|null};
export type Observed={id:string;status:string;mode:string;model:string|null;elapsed_ms:number|null;input_tokens:number|null;output_tokens:number|null;error_code:string|null;steps:Step[];[key:string]:unknown};
export function scoreAgent(c:EvalCase,run:Observed){
  const known=(kind:string)=>run.steps.filter(s=>s.kind===kind&&['success','error'].includes(s.status));
  const nodes=known('node'),tools=known('tool'),expected=c.expectedTools;
  const calls=run.steps.filter(s=>s.kind==='tool').map(s=>s.name),same=expected!==undefined&&[...calls].sort().join('|')===[...expected].sort().join('|');
  const terminal=['success','error','partial','cancelled','insufficient'].includes(run.status);
  return {runSuccess:metric(terminal?Number(run.status==='success'):null,terminal?1:0,'实际运行技术完成状态，不是任务正确性'),taskCorrect:metric(null,0,'需要任务答案标准或人工复核；期望成功标记不能证明实际任务正确','未进行任务语义核验'),nodeSuccess:metric(nodes.length?nodes.filter(s=>s.status==='success').length/nodes.length:null,nodes.length,'已确认终态节点成功数 / 已确认终态节点数'),toolSuccess:metric(tools.length?tools.filter(s=>s.status==='success').length/tools.length:null,tools.length,'已确认终态工具成功数 / 已确认终态工具数'),toolCorrect:metric(expected!==undefined?Number(same):null,expected!==undefined?1:0,'实际工具名称多重集与人工标注预期多重集完全相等；不检验参数语义'),latencyMs:metric(run.elapsed_ms,run.elapsed_ms===null?0:1,'原始观测记录运行耗时'),timeout:metric(run.error_code?.includes('timeout')?1:run.status==='success'?0:null,run.error_code?.includes('timeout')||run.status==='success'?1:0,'仅明确超时错误码或成功记录可判定；普通失败无法推断超时')};
}
const normalize=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
export function scoreModel(c:EvalCase){
  const answer=c.response;
  return {exactMatch:metric(answer!==undefined&&c.referenceAnswer!==undefined?Number(normalize(answer)===normalize(c.referenceAnswer)):null,answer!==undefined&&c.referenceAnswer!==undefined?1:0,'NFKC 与空白规范化后的精确字符串匹配，不是语义准确率'),ruleCoverage:metric(answer!==undefined&&c.requiredPhrases.length?c.requiredPhrases.filter(p=>normalize(answer).includes(normalize(p))).length/c.requiredPhrases.length:null,answer!==undefined?c.requiredPhrases.length:0,'人工指定必需短语覆盖率；不等于完整答案正确率'),latencyMs:metric(null,0,'离线输入没有可信计时，无法计算'),tokens:metric(null,0,'未由真实提供方响应获取 usage'),cost:metric(null,0,'没有可信账单或计费版本，不估算为零')};
}
export function aggregate(rows:{metrics:Record<string,Metric>}[]){
  const result:Record<string,Metric>={};
  for(const name of new Set(rows.flatMap(r=>Object.keys(r.metrics)))){const values=rows.map(r=>r.metrics[name]).filter(m=>m?.value!==null&&m?.value!==undefined);result[name]=metric(values.length?values.reduce((n,m)=>n+m.value!,0)/values.length:null,values.length,'可计算案例的宏平均；'+(values[0]?.definition??'没有可计算记录'),values.length?undefined:'无可计算案例');}
  return result;
}
