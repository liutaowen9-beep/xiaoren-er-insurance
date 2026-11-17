import 'server-only';
import { EvaluationStore } from './store';
import { adapters,type Adapters,type RetrievalSession } from './readers';
import { scoreRetrieval,scoreAgent,scoreModel } from './scoring';
import { EvaluationError,type CaseResult } from './types';

export function abortable<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason??new DOMException('已取消','AbortError'));signal.addEventListener('abort',abort,{once:true});operation.then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});});
}

export async function executeEvaluation(store:EvaluationStore,id:string,requestSignal:AbortSignal,transport:Adapters=adapters){
  const token=store.claim(id),run=store.run(id),dataset=store.dataset(run.config.datasetId,run.config.version),signal=AbortSignal.any([requestSignal,AbortSignal.timeout(120000)]);
  let failed=0;
  const check=()=>{signal.throwIfAborted();if(store.cancelled(id))throw new DOMException('已取消','AbortError');};
  async function cases(session?:RetrievalSession){
    // Stage all RAG results until source-copy fingerprint validation completes.
    const staged:CaseResult[]=[];
    for(const c of dataset.cases){check();await new Promise<void>(r=>setImmediate(r));check();
      let result:CaseResult;
      try{
        if(run.type==='rag'){
          if(!session)throw new EvaluationError('真实检索适配器缺失。',503);
          if(!dataset.libraryId||dataset.libraryId!==session.libraryId||!dataset.corpusHash||dataset.corpusHash!==session.corpusHash)throw new EvaluationError('数据集知识库稳定 ID 或快照哈希未标注/不匹配，请更新评测标准，不能跨版本评分。',409);
          if(!session.validate([...(c.relevant??[]),...(c.citations??[])]))throw new EvaluationError('标注来源失效、版本错误或切片不属于对应文档。',409);
          const start=performance.now(),hits=await abortable(session.search(c.question,run.config.k,signal),signal);check();
          if(!session.validate(hits))throw new EvaluationError('检索结果包含失效文档，结果不评分。',409);
          result={caseId:c.id,status:'success',metrics:scoreRetrieval(c,hits,run.config.k,run.config.level,performance.now()-start),details:{hits,level:run.config.level,k:run.config.k,method:session.retriever}};
        }else if(run.type==='agent'){
          if(!c.observedRunId)throw new EvaluationError('案例未绑定运行观测 ID。');
          const observed=await abortable(transport.agent(c.observedRunId,signal),signal);check();
          result={caseId:c.id,status:'success',metrics:scoreAgent(c,observed),details:{observedRunId:observed.id,mode:observed.mode,model:observed.model,status:observed.status,steps:observed.steps,inputTokens:observed.input_tokens,outputTokens:observed.output_tokens,errorCode:observed.error_code}};
        }else{
          if(c.response===undefined)throw new EvaluationError('没有离线模型响应；不会自动调用付费接口。');
          result={caseId:c.id,status:'success',metrics:scoreModel(c),details:{model:c.model??'UNKNOWN',modelVersion:c.modelVersion??'UNKNOWN',response:c.response,referenceAnswer:c.referenceAnswer??null,mode:'offline-rules'}};
        }
      }catch(e){if(signal.aborted||store.cancelled(id))throw e;failed++;result={caseId:c.id,status:'failed',metrics:{},details:null,error:e instanceof EvaluationError?e.message:'执行适配器失败；未保存原始异常及敏感上下文。'};}
      check();if(session)staged.push(result);else store.result(id,token,result);
      store.audit(session?'case_scored_awaiting_source_validation':'case_result_saved',id);
    }return staged;
  }
  try{
    if(run.type==='rag'){
      const staged=await transport.rag(signal,async session=>{
        store.provenance(id,token,{knowledge:session.corpusHash,libraryId:session.libraryId,embedding:session.embedding,retriever:session.retriever});return cases(session);
      });check();store.transaction(()=>{for(const row of staged){check();store.db.prepare('INSERT INTO evaluation_results VALUES(?,?,?)').run(id,row.caseId,JSON.stringify(row));}});
    }else await cases();
    check();store.finish(id,token,failed===dataset.cases.length?'failed':failed?'partial':'success');
  }catch(e){const cancelled=requestSignal.aborted||store.cancelled(id),timeout=signal.aborted&&!cancelled;store.finish(id,token,cancelled?'cancelled':'failed',cancelled?'用户已取消，未启动后续案例。':timeout?'评测超时；已有确认案例保留。':e instanceof EvaluationError?e.message:'评测失败，源数据保持不变。');}
  return store.run(id);
}
