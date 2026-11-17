import 'server-only';
import {toDocx,toPdf} from '../reports/export';
import type {Report} from '../reports/types';
import type {ModelStore} from './store';
import {summarize,DIMENSIONS} from './analysis';
import {ModelError} from './types';
export async function modelReport(store:ModelStore,id:string,format:'docx'|'pdf',signal:AbortSignal){
  const run=store.run(id);if(['pending','running'].includes(run.status))throw new ModelError('请在任务结束后导出。',409);const summary=summarize(run);
  const report:Report={engine:'mock',createdAt:new Date().toISOString(),references:[],limitations:['确定性汇总记录，不额外调用模型；live/Mock 见摘要。','规则匹配不等于语义正确；未标注字段保持 UNKNOWN。','费用为实际用量与价格快照计算值/区间，不是供应商账单；失败或缺用量的调用不可记为零。'],content:{title:'真实模型评测中心 · 评测报告',abstract:`执行方式 ${run.config.mode}；状态 ${run.status}；数据集 ${run.dataset.name} v${run.dataset.version}；案例 ${run.dataset.cases.length}；未知费用尝试 ${summary.unknownCostAttempts}。`,sections:[{heading:'版本与评分依据',paragraphs:[{text:JSON.stringify(run.provenance),sources:[]}]},{heading:'质量规则分',paragraphs:[{text:summary.notice,sources:[]}],table:{columns:['模型','维度','规则分 / 标注样本'],rows:summary.models.flatMap(m=>DIMENSIONS.map(d=>[m.name,d,m.quality[d].value===null?'UNKNOWN':`${m.quality[d].value} / ${m.quality[d].count}`])),sources:[]}},{heading:'性能与费用',paragraphs:summary.models.map(m=>({text:`${m.name}：可见首增量 ${m.firstTextMs.value??'UNKNOWN'} ms；总响应 ${m.latencyMs.value??'UNKNOWN'} ms；Token ${m.tokens.total??'UNKNOWN'}；成本 ${m.cost.usd??'UNKNOWN'} USD；未知费用尝试 ${m.cost.unknownAttempts}。`,sources:[]}))},{heading:'价格来源及版本',paragraphs:run.prices.map(p=>({text:`${p.model} / ${p.version} / ${p.source} / 核验 ${p.observedAt} / 生效时间 ${p.effectiveAt??'UNKNOWN'} / 时段 ${run.config.tariff}`,sources:[]}))}],conclusion:'结论仅适用于当前数据集、样本选择、Prompt、评分规则与模型记录。建议核查原始响应、规则依据与人工标准；不可据此作保险销售承诺。'}};
  const bytes=format==='docx'?await toDocx(report,'evaluation'):await toPdf(report,signal,'evaluation');signal.throwIfAborted();return store.saveReport(id,format,bytes);
}
