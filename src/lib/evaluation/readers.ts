import 'server-only';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir,mkdtemp,copyFile,rm,readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { safeFile,fingerprints,canonical,sha } from '../data-platform/scanner';
import { PLATFORM_FILE } from '../data-platform/store';
import { resolveSource } from '../data-platform/api';
import { KnowledgeStore } from '../rag/store';
import { retrieve } from '../rag/service';
import { scanKnowledge } from '../data-platform/scanner';
import { EMBEDDING_ID } from '../rag/model-spec';
import { withoutObservation } from '../data-platform/telemetry';
import { EvaluationError,type Reference } from './types';
import type { Observed } from './scoring';

/** SQLite opens only disposable copies; the original DB, WAL and SHM are only read as bytes. */
export async function withDatabaseCopy<T>(file:string,signal:AbortSignal,action:(copy:string,fingerprint:string)=>Promise<T>){
  safeFile(file);const root=path.resolve('tmp/rag-tests/evaluation-copies');safeFile(root,false);await mkdir(root,{recursive:true,mode:0o700});const dir=await mkdtemp(path.join(root,'read-')),copy=path.join(dir,'knowledge.sqlite');
  try{
    const before=await fingerprints(file,signal);await copyFile(file,copy);if(before['-wal']!==null)await copyFile(file+'-wal',copy+'-wal');
    if(sha(await readFile(copy))!==before['']||(before['-wal']!==null&&sha(await readFile(copy+'-wal'))!==before['-wal'])||canonical(before)!==canonical(await fingerprints(file,signal)))throw new EvaluationError('源数据正在变化，本次评测未启动；请稍后重试。',409);
    const result=await action(copy,sha(canonical(before)));signal.throwIfAborted();if(canonical(before)!==canonical(await fingerprints(file,signal)))throw new EvaluationError('评测期间源数据发生变化，结果不发布。',409);return result;
  }finally{await rm(dir,{recursive:true,force:true});}
}
export type RetrievalSession={libraryId:string;corpusHash:string;embedding:string;retriever:string;search:(query:string,k:number,signal:AbortSignal)=>Promise<Reference[]>;validate:(refs:Reference[])=>boolean};
export type Adapters={rag:<T>(signal:AbortSignal,action:(session:RetrievalSession)=>Promise<T>)=>Promise<T>;agent:(id:string,signal:AbortSignal)=>Promise<Observed>};
export const adapters:Adapters={
  rag:async(signal,action)=>{
    if(process.env.MOYU_REPORT_TESTING||process.env.MOYU_E2E==='1')throw new EvaluationError('测试环境禁止默认连接正式知识库，请注入隔离适配器。',403);
    const source=await resolveSource();return withDatabaseCopy(source.file,signal,async(copy)=>{
      const scan=await scanKnowledge(copy,source.libraryId,signal),store=new KnowledgeStore(copy,{readOnly:true});
      try{if(scan.checks.some(c=>c.result==='FAIL'))throw new EvaluationError('知识库完整性检查失败，拒绝作为评测基线。',409);
        return await action({libraryId:source.libraryId,corpusHash:sha(canonical(scan.manifest)),embedding:EMBEDDING_ID,retriever:'rag-retrieve-v5.1-current-version',
          search:async(query,k,s)=>{const hits=await withoutObservation(()=>retrieve(query,k,store,s));return hits.map((h,index)=>({documentId:h.documentId,chunkId:h.chunkId,version:store.get(h.documentId).version!,fileName:h.fileName,page:h.page??null,score:h.score,rank:index+1,textHash:sha(h.text)}));},
          validate:refs=>refs.every(r=>{try{const d=store.get(r.documentId);return store.isEligible(r.documentId)&&d.version===r.version&&(!r.chunkId||!!store.db.prepare('SELECT id FROM chunks WHERE id=? AND document_id=?').get(r.chunkId,r.documentId));}catch{return false;}}),
        });
      }finally{store.close();}
    });
  },
  agent:async(id,signal)=>{
    if(process.env.MOYU_REPORT_TESTING||process.env.MOYU_E2E==='1')throw new EvaluationError('测试环境禁止默认读取正式运行记录。',403);
    if(!existsSync(PLATFORM_FILE))throw new EvaluationError('尚无数据中台观测数据库。',404);
    return withDatabaseCopy(PLATFORM_FILE,signal,async copy=>{
      const db=new DatabaseSync(copy,{readOnly:true});try{db.exec('PRAGMA query_only=ON');if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new EvaluationError('观测数据库完整性失败。',409);
        const row=db.prepare('SELECT * FROM observed_runs WHERE id=?').get(id);if(!row)throw new EvaluationError('未找到指定的真实观测记录。',404);
        if(row.ended_at===null||row.status==='running')throw new EvaluationError('该运行尚未确认完成，不能评测。',409);
        const steps=db.prepare('SELECT kind,name,status,started_at,ended_at,elapsed_ms,error_code FROM observed_steps WHERE run_id=? ORDER BY started_at,id').all(id);
        return {...row,steps} as unknown as Observed;
      }finally{db.close();}
    });
  },
};
export function paidModelAdapter():never{throw new EvaluationError('真实付费模型评测未开放；本阶段只允许离线规则和已授权记录回放。',403);}
