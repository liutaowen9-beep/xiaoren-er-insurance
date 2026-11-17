import 'server-only';
import { z } from 'zod';
import { authorize } from './api';
import { PlatformStore } from './store';
import { monitorQuery, PlatformAnalytics } from './analytics';
import { PlatformError } from './types';
export type MonitorOperation='lineage'|'runs'|'run'|'run-stats'|'retrievals'|'retrieval'|'retrieval-stats'|'quality-analysis';
export function createMonitorApi(factory=()=>new PlatformStore()){
  return async(request:Request,operation:MonitorOperation,id?:string)=>{
    let store:PlatformStore|undefined;
    try{
      authorize(request);if(request.method!=='GET')throw new PlatformError('观测接口只允许读取。',405);
      const params=new URL(request.url).searchParams;if([...params.keys()].some(k=>params.getAll(k).length>1))throw new PlatformError('不接受重复参数。');
      const q=monitorQuery.parse(Object.fromEntries(params));if(operation==='run'||operation==='retrieval')z.uuid().parse(id);
      store=factory();const analytics=new PlatformAnalytics(store);
      const value=operation==='lineage'?analytics.lineage(q):operation==='runs'?analytics.runList(q):operation==='run'?analytics.runDetail(id!):operation==='run-stats'?analytics.runStats(q):operation==='retrievals'?analytics.retrievalList(q):operation==='retrieval'?analytics.retrievalDetail(id!):operation==='retrieval-stats'?analytics.retrievalStats(q):analytics.quality(q.libraryId);
      return Response.json(value,{headers:{'Cache-Control':'no-store'}});
    }catch(error){return Response.json({error:error instanceof PlatformError?error.message:error instanceof z.ZodError?'观测参数格式不正确。':'观测数据读取失败；不会影响原业务，请检查独立中台备份和迁移状态。'},{status:error instanceof PlatformError?error.status:error instanceof z.ZodError?400:500,headers:{'Cache-Control':'no-store'}});}finally{store?.close();}
  };
}
export const monitorApi=createMonitorApi();
