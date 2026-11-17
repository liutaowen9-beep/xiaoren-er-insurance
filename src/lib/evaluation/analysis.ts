import type { CaseResult } from './types';
import { aggregate } from './scoring';
export function analyzeResults(results:CaseResult[]){
  const groups=new Map<string,CaseResult[]>(),failures=new Map<string,number>();
  for(const result of results){
    const d=result.details as {model?:string;modelVersion?:string;mode?:string;errorCode?:string}|null;
    const group=`${d?.model??'UNKNOWN'} / ${d?.modelVersion??'UNKNOWN'} / ${d?.mode??'unknown'}`;
    groups.set(group,[...(groups.get(group)??[]),result]);
    if(result.status==='failed'||d?.errorCode){const reason=d?.errorCode??'case_execution_failed';failures.set(reason,(failures.get(reason)??0)+1);}
  }
  return {modelGroups:[...groups].map(([name,rows])=>({name,count:rows.length,metrics:aggregate(rows)})),failures:[...failures].map(([name,value])=>({name,value})),notice:'分组来自记录的模型标识；离线响应不代表本系统运行过该模型。不同案例集合不能作公平模型能力排名。'};
}
