import 'server-only';
import {randomUUID} from 'node:crypto';
import {ModelStore} from './store';
import {deepSeekAdapter,mockAdapter,AdapterError,type ModelAdapter} from './adapter';
import {ModelError,PROMPT,type Attempt,type ResponseRecord} from './types';
import {calculateCost,unknownUsage} from './pricing';
import {qualityScores} from './scoring';
import {abortable} from '../evaluation/runner';
import Decimal from 'decimal.js';

export async function executeModelRun(store:ModelStore,id:string,requestSignal:AbortSignal,authorization?:string,injected?:ModelAdapter){
  const run=store.run(id);
  if(run.config.mode==='live'&&!injected&&(process.env.MOYU_REPORT_TESTING||process.env.MOYU_E2E==='1'))throw new ModelError('隔离环境禁止真实付费执行。',403);
  store.recover();const lease=store.claim(id,authorization),cancel=new AbortController(),signal=AbortSignal.any([requestSignal,cancel.signal,AbortSignal.timeout(180000)]);
  const poll=setInterval(()=>{if(store.isCancelled(id))cancel.abort(new DOMException('已取消','AbortError'));},150);
  let failures=0,partials=0;
  try{
    for(const model of run.models)for(const c of run.dataset.cases){
      signal.throwIfAborted();if(store.isCancelled(id))throw new DOMException('已取消','AbortError');
      const current=store.model(model.id);if(run.config.mode==='live'&&(!current.enabled||current.revision!==model.revision))throw new ModelError('模型配置变化，后续调用已停止。',409);
      const price=run.prices.find(p=>p.model===model.id)!,adapter=injected??(run.config.mode==='mock'?mockAdapter:deepSeekAdapter);
      for(let attempt=0;attempt<=run.config.retries;attempt++){
        signal.throwIfAborted();const latest=store.model(model.id);if(run.config.mode==='live'&&(!latest.enabled||latest.revision!==model.revision))throw new ModelError('模型已停用或配置变化，未启动后续调用。',409);
        const attemptId=randomUUID(),startedAt=Date.now(),callSignal=AbortSignal.any([signal,AbortSignal.timeout(run.config.timeoutMs)]);let error:AdapterError|null=null,response:ResponseRecord|null=null,partial:ResponseRecord|null=null;
        // Persist before dispatch so process interruption cannot erase a possibly billable attempt.
        store.attempt(id,lease,{id:attemptId,modelId:model.id,caseId:c.id,attempt:attempt+1,status:'running',startedAt,response:null,errorCode:'in_flight',error:'正在调用，尚未确认结果；进程中断时费用可能未知。',cost:calculateCost(unknownUsage(),price,run.config.tariff)});
        try{response=await abortable(Promise.resolve().then(()=>adapter({model,question:c.question,system:PROMPT+(run.config.rubric.format==='json'?' 请返回 JSON 对象。':''),maxTokens:run.config.maxTokens,signal:callSignal,onPartial:r=>{partial=r;}})),callSignal);}catch(e){error=e instanceof AdapterError?e:new AdapterError(callSignal.aborted?'调用已取消或超时。':'模型适配器失败。',callSignal.aborted?(callSignal.reason?.name==='TimeoutError'?'timeout':'cancelled'):'adapter_error',partial);response=error.partial??partial;}
        const confirmed=response?.responseModel===model.id||response?.responseModel?.toLowerCase()===model.version.toLowerCase();
        const record:Attempt={id:attemptId,modelId:model.id,caseId:c.id,attempt:attempt+1,status:error?(signal.aborted?'cancelled':'failed'):response?.finishReason==='length'?'partial':'success',startedAt,response,errorCode:error?.code??null,error:error?.message??null,cost:calculateCost(response?.usage??unknownUsage(),price,run.config.tariff,run.config.mode==='live'&&!!confirmed)};
        store.attempt(id,lease,record);
        // Only an explicit pre-generation 429 may retry. Ambiguous network/timeout failures are never automatically replayed.
        if(error?.retryable&&attempt<run.config.retries&&!signal.aborted&&!store.isCancelled(id)){store.audit(id,'explicit_429_retry');continue;}
        const quality=qualityScores(c,response,run.config.rubric),status=record.status;if(status==='failed'||status==='cancelled')failures++;if(status==='partial')partials++;
        store.result(id,lease,{modelId:model.id,caseId:c.id,attemptId:record.id,status,quality,response,error:record.error});
        const approved=run.provenance.approvedBudgetUSD;
        if(run.config.mode==='live'&&typeof approved==='string'){
          const knownUpper=store.run(id).attempts.reduce((sum,a)=>sum.add(a.cost.upperUSD??0),new Decimal(0));
          if(knownUpper.gt(approved))throw new ModelError('已知用量费用区间超过授权预算，后续调用已停止；已产生费用不可撤回。',409);
        }
        if(signal.aborted||store.isCancelled(id))throw new DOMException('已取消','AbortError');
        if(error&&['network','timeout','adapter_error','not_configured','http_401','http_402'].includes(error.code))throw new ModelError('调用未完成或凭据/余额异常，后续调用已停止；请核查费用与错误后再新建任务。',409);
        break;
      }
    }
    const count=run.models.length*run.dataset.cases.length;store.finish(id,lease,failures===count?'failed':failures||partials?'partial':'success');
  }catch(e){store.finish(id,lease,requestSignal.aborted||cancel.signal.aborted||store.isCancelled(id)?'cancelled':'failed',e instanceof ModelError?e.message:signal.reason?.name==='TimeoutError'?'任务总时限已到，后续调用停止。':'任务已取消或中断；不会自动继续。');}
  finally{clearInterval(poll);}
  return store.run(id);
}
