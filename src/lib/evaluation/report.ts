import 'server-only';
import type { EvaluationStore } from './store';
import type { Report } from '../reports/types';
import { toDocx,toPdf } from '../reports/export';
import { EvaluationError } from './types';
export async function evaluationReport(store:EvaluationStore,id:string,format:'docx'|'pdf',signal?:AbortSignal){
  const run=store.run(id);if(['pending','running'].includes(run.status))throw new EvaluationError('评测尚未结束。',409);
  const metrics=Object.entries(run.metrics).map(([name,value])=>{const m=value as {value:number|null;denominator:number;definition:string};return `${name}：${m.value===null?'无法计算':m.value.toFixed(4)}；可计算案例 ${m.denominator}；${m.definition}`;});
  const report:Report={engine:'mock',createdAt:new Date().toISOString(),references:[],limitations:['本报告由已保存的评测记录确定性汇总，没有调用大模型。','离线规则命中率和自动化测试通过率均不等于 AI 语义正确率。','未获得可信 usage 和计费记录时 Token、成本均为未知。'],content:{title:'小人儿保险 AI 评测报告',abstract:`评测类型 ${run.type}；执行方式 ${run.config.mode}；状态 ${run.status}；数据集版本 ${run.config.version}。`,sections:[{heading:'版本与可追溯信息',paragraphs:[{text:JSON.stringify(run.provenance),sources:[]}]},{heading:'指标与评分口径',paragraphs:(metrics.length?metrics:['暂无可计算指标。']).slice(0,8).map(text=>({text,sources:[]}))},{heading:'案例结果与人工复核',paragraphs:[{text:`案例共 ${run.results.length}；失败 ${run.results.filter(r=>r.status==='failed').length}；人工复核 ${run.reviews.length}。完整案例、来源 ID、版本和节点轨迹请在评测任务详情查看。`,sources:[]}],...(run.results.length?{table:{columns:['案例','状态','说明'],rows:run.results.slice(0,30).map(r=>[r.caseId,r.status,r.error??'详见评测任务原始结果；不以成功状态代替答案正确。']),sources:[]}}:{})}],conclusion:'请结合评测数据集标注、知识库快照和人工复核使用本报告；跨数据集或不同知识库版本的指标不能直接解释为能力提升。'}};
  const bytes=format==='docx'?await toDocx(report,'evaluation'):await toPdf(report,signal,'evaluation');signal?.throwIfAborted();return store.report(id,format,bytes);
}
