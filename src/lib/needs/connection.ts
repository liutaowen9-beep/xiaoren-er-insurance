import { z } from 'zod';
const schema=z.object({eligible:z.number().int().nonnegative(),paidEnabled:z.boolean()}).strict();
export type ConnectionResult={id:number;data:z.infer<typeof schema>}|{id:number;error:string};
/** Page-scoped cache; reconnection shares work, explicit retry replaces it. */
export function createConnection(fetcher:typeof fetch=fetch){
  type Entry={attempt:number;id:number;abort:AbortController;listeners:Set<(v:ConnectionResult)=>void>;result?:ConnectionResult;timer?:ReturnType<typeof setTimeout>};
  let entry:Entry|undefined,sequence=0;
  const publish=(e:Entry)=>queueMicrotask(()=>{if(entry===e&&!e.abort.signal.aborted&&e.result)for(const fn of e.listeners)fn(e.result);});
  return {subscribe(attempt:number,listener:(v:ConnectionResult)=>void){
    if(!entry||entry.attempt!==attempt||entry.abort.signal.aborted){
      if(entry?.timer)clearTimeout(entry.timer);entry?.abort.abort();
      const e:Entry={attempt,id:++sequence,abort:new AbortController(),listeners:new Set()};entry=e;
      void(async()=>{try{const r=await fetcher('/api/needs',{signal:e.abort.signal,cache:'no-store'}),raw=await r.json();if(!r.ok)throw new Error(typeof raw.error==='string'?raw.error:'知识库连接失败。');const data=schema.parse(raw);if(entry!==e||e.abort.signal.aborted)return;e.result={id:e.id,data};}catch(error){if(entry!==e||e.abort.signal.aborted)return;e.result={id:e.id,error:error instanceof z.ZodError?'知识库响应格式异常。':error instanceof Error?error.message:'知识库连接失败。'};}publish(e);})();
    }
    const e=entry;if(e.timer){clearTimeout(e.timer);e.timer=undefined;}e.listeners.add(listener);if(e.result)publish(e);
    return()=>{e.listeners.delete(listener);if(!e.listeners.size&&!e.result&&!e.timer)e.timer=setTimeout(()=>{e.timer=undefined;if(entry===e&&!e.listeners.size&&!e.result)e.abort.abort();},0);};
  }};
}
