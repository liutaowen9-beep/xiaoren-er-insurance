import 'server-only';
import {DatabaseSync} from 'node:sqlite';
import {EVALUATION_FILE} from '../evaluation/store';
import {withDatabaseCopy} from '../evaluation/readers';
import {datasetSchema,EvaluationError} from '../evaluation/types';
import {sha} from '../data-platform/scanner';
import type {DatasetSnapshot} from './types';
export async function readDatasets<T>(action:(db:DatabaseSync)=>T,signal:AbortSignal,file=EVALUATION_FILE):Promise<T>{
  if((process.env.MOYU_REPORT_TESTING||process.env.MOYU_E2E==='1')&&file===EVALUATION_FILE)throw new EvaluationError('隔离环境禁止默认读取正式评测数据库。',403);
  return withDatabaseCopy(file,signal,async copy=>{const db=new DatabaseSync(copy,{readOnly:true});try{db.exec('PRAGMA query_only=ON');if(db.prepare('PRAGMA user_version').get()!.user_version!==1||db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new EvaluationError('V10.1 数据集数据库版本或完整性不符合要求。',409);return action(db);}finally{db.close();}});
}
export const datasetList=(signal:AbortSignal,file?:string)=>readDatasets(db=>db.prepare('SELECT id,name,head FROM datasets WHERE archived=0 ORDER BY updated_at DESC LIMIT 1000').all(),signal,file);
export const datasetSnapshot=(id:string,version:number,signal:AbortSignal,file?:string):Promise<DatasetSnapshot>=>readDatasets(db=>{
  const row=db.prepare('SELECT v.body,v.hash,d.archived FROM dataset_versions v JOIN datasets d ON d.id=v.dataset_id WHERE v.dataset_id=? AND v.version=?').get(id,version);
  if(!row||row.archived)throw new EvaluationError('数据集不存在或已归档。',404);
  if(sha(String(row.body))!==row.hash)throw new EvaluationError('数据集版本哈希校验失败。',409);
  const body=datasetSchema.parse(JSON.parse(String(row.body)));return {id,version,hash:String(row.hash),name:body.name,dataPolicy:body.dataPolicy,cases:body.cases};
},signal,file);
