import 'server-only';
import {createHash} from 'node:crypto';
import {readSSE} from '../sse';
import {withProductBrand} from '../product-identity';
import {upstreamError} from '../ai';
import {parseUsage,unknownUsage} from './pricing';
import type {ModelConfig,ResponseRecord} from './types';
export type ModelRequest={model:ModelConfig;question:string;system:string;maxTokens:number;signal:AbortSignal;onPartial?:(record:ResponseRecord)=>void};
export type ModelAdapter=(input:ModelRequest)=>Promise<ResponseRecord>;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export function redact(text:string){return text.replace(/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[\w.-]{12,}|\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[已脱敏]');}
export class AdapterError extends Error{constructor(message:string,public code:string,public partial:ResponseRecord|null=null,public retryable=false){super(message);}}
export const configured=()=>!!process.env.DEEPSEEK_API_KEY?.trim();
export function createDeepSeekAdapter(fetcher:typeof fetch=(...args)=>fetch(...args),credential=()=>process.env.DEEPSEEK_API_KEY?.trim()):ModelAdapter{
  return async input=>{
    const key=credential();if(!key)throw new AdapterError('服务端尚未配置 DEEPSEEK_API_KEY。','not_configured');
    const start=performance.now();let first:number|null=null,answer='',finish='',usage=unknownUsage(),model:string|null=null,created:number|null=null,done=false;
    const snapshot=():ResponseRecord=>({answer:redact(answer),answerHash:hash(answer),redacted:redact(answer)!==answer,finishReason:finish||'interrupted',firstTextMs:first,elapsedMs:Math.max(0,performance.now()-start),usage,responseModel:model,providerCreated:created});
    try{
      const response=await fetcher('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({model:input.model.id,messages:[{role:'system',content:withProductBrand(input.system)},{role:'user',content:input.question}],thinking:{type:'disabled'},stream:true,stream_options:{include_usage:true},max_tokens:input.maxTokens,temperature:0}),signal:input.signal,redirect:'error',cache:'no-store'});
      if(!response.ok){await response.body?.cancel();const e=upstreamError(response.status);throw new AdapterError(e.message,'http_'+response.status,null,response.status===429);}
      if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();throw new AdapterError('模型响应不是预期的流式格式。','invalid_content_type');}
      for await(const frame of readSSE(response.body)){
        input.signal.throwIfAborted();
        if(frame==='[DONE]'){done=true;break;}
        let value;try{value=JSON.parse(frame);}catch{throw new AdapterError('模型流式 JSON 无效。','invalid_json',snapshot());}
        if(!value||typeof value!=='object'||value.error)throw new AdapterError('供应商返回异常事件。','provider_error',snapshot());
        if(typeof value.model==='string'&&value.model.length<=120)model=redact(value.model);
        if(typeof value.created==='number'&&Number.isSafeInteger(value.created))created=value.created;
        if(value.usage)usage=parseUsage(value.usage);
        const choice=value.choices?.[0],text=choice?.delta?.content;
        // Hidden reasoning is neither persisted nor displayed.
        if(typeof text==='string'&&text){if(first===null&&text.trim())first=performance.now()-start;answer+=text;if(answer.length>12000){answer=answer.slice(0,12000);throw new AdapterError('模型输出超过本地长度上限，已保留受限片段。','output_limit',snapshot());}}
        if(typeof choice?.finish_reason==='string')finish=choice.finish_reason;
        if(answer)input.onPartial?.(snapshot());
      }
      if(!done||!answer.trim()||!['stop','length'].includes(finish))throw new AdapterError('回复未完整结束或没有有效内容。','incomplete',snapshot());
      return snapshot();
    }catch(e){
      if(e instanceof AdapterError)throw e;
      const partial=answer||usage.source==='provider'?snapshot():null;
      if(input.signal.aborted)throw new AdapterError(input.signal.reason?.name==='TimeoutError'?'模型调用超时，已保留收到的结果。':'模型调用已取消。',input.signal.reason?.name==='TimeoutError'?'timeout':'cancelled',partial);
      throw new AdapterError('连接模型失败或流提前中断；不会记录原始异常或凭据。','network',partial);
    }
  };
}
export const deepSeekAdapter=createDeepSeekAdapter();
export const mockAdapter:ModelAdapter=async input=>{input.signal.throwIfAborted();const start=performance.now(),answer='[Mock] 合成响应：资料不足，请核实原文。';return {answer,answerHash:hash(answer),redacted:false,finishReason:'stop',firstTextMs:null,elapsedMs:performance.now()-start,usage:unknownUsage(),responseModel:'mock-fixture',providerCreated:null};};
