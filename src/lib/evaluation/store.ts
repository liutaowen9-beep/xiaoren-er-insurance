import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { existsSync,mkdirSync,copyFileSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { safeFile,sha,canonical } from '../data-platform/scanner';
import { datasetSchema,runInput,EvaluationError,SCORER_VERSION,type RunInput,type CaseResult } from './types';
import { aggregate } from './scoring';
import { evaluationSourceHash } from './provenance';
import { analyzeResults } from './analysis';

export const EVALUATION_FILE=path.resolve('tmp/reports/evaluation/evaluation.sqlite');
type Row=Record<string,unknown>;
const encode=(value:unknown)=>canonical(JSON.parse(JSON.stringify(value)));
export class EvaluationStore {
  readonly db:DatabaseSync;
  constructor(readonly file=EVALUATION_FILE,options?:{beforeMigrationCommit?:()=>void}){
    if(path.basename(file)!=='evaluation.sqlite')throw new EvaluationError('评测库必须使用独立 evaluation.sqlite 文件。');
    safeFile(file,false);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
    try{this.migrate(options?.beforeMigrationCommit);}catch(e){this.db.close();throw e;}
  }
  migrate(beforeCommit?:()=>void){
    const version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if(version===1)return;if(version!==0)throw new EvaluationError('未知评测数据库版本，拒绝自动迁移。',409);
    if(this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()!.n)throw new EvaluationError('非空未知结构，拒绝覆盖。',409);
    try{this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE datasets(id TEXT PRIMARY KEY,name TEXT NOT NULL,head INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE dataset_versions(dataset_id TEXT REFERENCES datasets(id),version INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(dataset_id,version));
      CREATE TABLE evaluation_cases(dataset_id TEXT,version INTEGER,id TEXT,body TEXT NOT NULL,PRIMARY KEY(dataset_id,version,id),FOREIGN KEY(dataset_id,version) REFERENCES dataset_versions(dataset_id,version));
      CREATE TABLE evaluation_runs(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,version INTEGER NOT NULL,type TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,config TEXT NOT NULL,provenance TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,ended_at INTEGER,lease TEXT,cancel INTEGER NOT NULL DEFAULT 0,error TEXT,idempotency TEXT UNIQUE NOT NULL,FOREIGN KEY(dataset_id,version) REFERENCES dataset_versions(dataset_id,version));
      CREATE TABLE evaluation_results(run_id TEXT REFERENCES evaluation_runs(id),case_id TEXT,body TEXT NOT NULL,PRIMARY KEY(run_id,case_id));
      CREATE TABLE evaluation_metrics(run_id TEXT REFERENCES evaluation_runs(id),name TEXT,body TEXT NOT NULL,PRIMARY KEY(run_id,name));
      CREATE TABLE evaluation_reports(id TEXT PRIMARY KEY,run_id TEXT REFERENCES evaluation_runs(id),format TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE human_reviews(id TEXT PRIMARY KEY,run_id TEXT,case_id TEXT,score REAL NOT NULL,note TEXT NOT NULL,reviewer TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(run_id,case_id) REFERENCES evaluation_results(run_id,case_id));
      CREATE TABLE audit_events(id INTEGER PRIMARY KEY,action TEXT NOT NULL,object_id TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE evaluation_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL,description TEXT NOT NULL);
      INSERT INTO evaluation_migrations VALUES(1,${Date.now()},'empty independent database initialization; rollback restores verified backup to NEW target');
      CREATE INDEX evaluation_runs_created ON evaluation_runs(created_at);
      PRAGMA user_version=1;`);beforeCommit?.();this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  close(){this.db.close();}
  transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(action:string,id:string){this.db.prepare('INSERT INTO audit_events(action,object_id,at) VALUES(?,?,?)').run(action,id,Date.now());}
  saveDataset(input:unknown,id:string=randomUUID(),expectedHead?:number){
    const data=datasetSchema.parse(input);return this.transaction(()=>{
      const current=this.db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
      if(current&&(current.archived||expectedHead!==current.head))throw new EvaluationError('数据集已变化或已归档，请刷新后重试。',409);
      if(!current&&expectedHead!==undefined)throw new EvaluationError('数据集不存在。',404);
      const version=current?Number(current.head)+1:1,at=Date.now();
      if(!current)this.db.prepare('INSERT INTO datasets VALUES(?,?,?,0,?,?)').run(id,data.name,version,at,at);
      else this.db.prepare('UPDATE datasets SET name=?,head=?,updated_at=? WHERE id=?').run(data.name,version,at,id);
      const body=encode(data),hash=sha(body);
      this.db.prepare('INSERT INTO dataset_versions VALUES(?,?,?,?,?)').run(id,version,hash,body,at);
      for(const c of data.cases)this.db.prepare('INSERT INTO evaluation_cases VALUES(?,?,?,?)').run(id,version,c.id,encode(c));
      this.audit('dataset_version_created',id);return {id,version,hash,...data};
    });
  }
  dataset(id:string,version?:number){
    const d=this.db.prepare('SELECT * FROM datasets WHERE id=?').get(id);if(!d)throw new EvaluationError('数据集不存在。',404);
    const row=this.db.prepare('SELECT * FROM dataset_versions WHERE dataset_id=? AND version=?').get(id,version??Number(d.head));if(!row)throw new EvaluationError('数据集版本不存在。',404);
    const body=String(row.body);if(sha(body)!==row.hash)throw new EvaluationError('数据集版本哈希不一致。',409);
    return {id,version:Number(row.version),hash:String(row.hash),archived:!!d.archived,...datasetSchema.parse(JSON.parse(body))};
  }
  versions(id:string){this.dataset(id);return this.db.prepare('SELECT version,hash,created_at FROM dataset_versions WHERE dataset_id=? ORDER BY version DESC').all(id);}
  archive(id:string){this.dataset(id);this.transaction(()=>{this.db.prepare('UPDATE datasets SET archived=1 WHERE id=?').run(id);this.audit('dataset_archived',id);});}
  datasets(){return this.db.prepare('SELECT d.*,v.hash FROM datasets d JOIN dataset_versions v ON v.dataset_id=d.id AND v.version=d.head WHERE d.archived=0 ORDER BY updated_at DESC LIMIT 1000').all();}
  createRun(input:RunInput){
    const data=runInput.parse(input),dataset=this.dataset(data.datasetId,data.version);if(dataset.archived)throw new EvaluationError('已归档数据集不能新建任务。',409);
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM evaluation_runs WHERE idempotency=?').get(data.idempotencyKey);
      if(existing){if(existing.config!==encode(data))throw new EvaluationError('重复键对应不同任务。',409);return this.run(String(existing.id));}
      if(Number(this.db.prepare('SELECT count(*) n FROM evaluation_runs').get()!.n)>=10000)throw new EvaluationError('评测历史达到基础版容量，请先单独备份和规划归档。',413);
      const id=randomUUID();let code='UNKNOWN';try{code=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();}catch{/* Unknown must remain unknown. */}
      const provenance={code,sourceHash:evaluationSourceHash(),codeState:'source-hash-includes-uncommitted-code',datasetHash:dataset.hash,datasetVersion:data.version,scorer:SCORER_VERSION,promptVersion:data.type==='agent'?'UNKNOWN-original-observed-prompt': 'not-applicable-no-generation',originalWorkflowVersion:data.type==='agent'?'UNKNOWN-not-in-original-observation':null,knowledge:dataset.corpusHash??null,libraryId:dataset.libraryId??null};
      this.db.prepare('INSERT INTO evaluation_runs(id,dataset_id,version,type,mode,status,config,provenance,created_at,idempotency) VALUES(?,?,?,?,?,\'pending\',?,?,?,?)').run(id,data.datasetId,data.version,data.type,data.mode,encode(data),encode(provenance),Date.now(),data.idempotencyKey);
      this.audit('run_created',id);return this.run(id);
    });
  }
  run(id:string){const row=this.db.prepare('SELECT * FROM evaluation_runs WHERE id=?').get(id);if(!row)throw new EvaluationError('评测任务不存在。',404);return {...row,id:String(row.id),status:String(row.status),type:String(row.type),error:row.error===null?null:String(row.error),config:JSON.parse(String(row.config)) as RunInput,provenance:JSON.parse(String(row.provenance)) as Record<string,unknown>,results:this.db.prepare('SELECT body FROM evaluation_results WHERE run_id=? ORDER BY case_id').all(id).map(r=>JSON.parse(String(r.body)) as CaseResult),metrics:Object.fromEntries(this.db.prepare('SELECT name,body FROM evaluation_metrics WHERE run_id=?').all(id).map(r=>[String(r.name),JSON.parse(String(r.body))])),reviews:this.db.prepare('SELECT * FROM human_reviews WHERE run_id=? ORDER BY created_at DESC').all(id)};}
  runs(){return this.db.prepare('SELECT id,dataset_id,version,type,mode,status,created_at,started_at,ended_at,error FROM evaluation_runs ORDER BY created_at DESC LIMIT 1000').all();}
  logs(id:string){return this.db.prepare('SELECT action,at FROM audit_events WHERE object_id=? ORDER BY id DESC LIMIT 200').all(id);}
  analysis(id:string){return analyzeResults(this.run(id).results);}
  history(id:string){
    const run=this.run(id),rows=this.db.prepare('SELECT id,config,provenance,created_at,status FROM evaluation_runs WHERE dataset_id=? AND version=? AND type=? AND mode=? AND status IN (\'success\',\'partial\') ORDER BY created_at DESC LIMIT 40').all(run.config.datasetId,run.config.version,run.config.type,run.config.mode);
    return rows.filter(row=>{const c=JSON.parse(String(row.config)),p=JSON.parse(String(row.provenance));return c.k===run.config.k&&c.level===run.config.level&&['datasetHash','scorer','knowledge','libraryId','embedding','retriever'].every(k=>p[k]===run.provenance[k]);}).reverse().map(row=>({id:String(row.id),at:Number(row.created_at),status:String(row.status),metrics:Object.fromEntries(this.db.prepare('SELECT name,body FROM evaluation_metrics WHERE run_id=?').all(String(row.id)).map(m=>[String(m.name),JSON.parse(String(m.body))]))}));
  }
  claim(id:string){return this.transaction(()=>{
    const at=Date.now();this.db.prepare("UPDATE evaluation_runs SET status='failed',error='执行中断或租约过期，请新建任务；已有案例保留。',ended_at=?,lease=NULL WHERE status='running' AND started_at<?").run(at,at-180000);
    if(this.db.prepare("SELECT id FROM evaluation_runs WHERE status='running'").get())throw new EvaluationError('已有评测正在运行。',409);
    const token=randomUUID();if(!this.db.prepare("UPDATE evaluation_runs SET status='running',started_at=?,lease=? WHERE id=? AND status='pending' AND cancel=0").run(at,token,id).changes)throw new EvaluationError('任务已执行、取消或不存在，不能重复启动。',409);
    this.audit('run_started',id);return token;
  });}
  cancelled(id:string){return this.db.prepare('SELECT cancel FROM evaluation_runs WHERE id=?').get(id)?.cancel===1;}
  cancel(id:string){this.transaction(()=>{this.run(id);this.db.prepare("UPDATE evaluation_runs SET cancel=1,status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE id=? AND status IN ('pending','running')").run(id);this.audit('run_cancel_requested',id);});}
  result(id:string,token:string,result:CaseResult){this.transaction(()=>{if(this.db.prepare("SELECT id FROM evaluation_runs WHERE id=? AND lease=? AND status='running' AND cancel=0").get(id,token)===undefined)throw new EvaluationError('执行已取消或租约失效。',409);this.db.prepare('INSERT INTO evaluation_results VALUES(?,?,?)').run(id,result.caseId,encode(result));});}
  provenance(id:string,token:string,metadata:Record<string,unknown>){const r=this.run(id);this.db.prepare('UPDATE evaluation_runs SET provenance=? WHERE id=? AND lease=?').run(encode({...r.provenance,...metadata}),id,token);}
  finish(id:string,token:string,status:string,error?:string){this.transaction(()=>{const rows=this.run(id).results,metrics=aggregate(rows);for(const [name,value]of Object.entries(metrics))this.db.prepare('INSERT OR REPLACE INTO evaluation_metrics VALUES(?,?,?)').run(id,name,encode(value));this.db.prepare('UPDATE evaluation_runs SET status=?,ended_at=?,error=?,lease=NULL WHERE id=? AND lease=?').run(status,Date.now(),error??null,id,token);this.audit('run_'+status,id);});}
  review(runId:string,caseId:string,score:number,note:string,reviewer:string){this.transaction(()=>{
    const run=this.run(runId),result=run.results.find(c=>c.caseId===caseId);
    if(!result)throw new EvaluationError('案例结果不存在。',404);
    if(['running','pending'].includes(run.status))throw new EvaluationError('请等待任务终态后再复核。',409);
    if(run.type==='agent'&&score!==0&&score!==1)throw new EvaluationError('Agent 任务正确性复核必须为 0 或 1；不能用分数推断任务已完成。');
    this.db.prepare('INSERT INTO human_reviews VALUES(?,?,?,?,?,?,?)').run(randomUUID(),runId,caseId,score,note,reviewer,Date.now());
    if(run.type==='agent'){
      result.metrics.taskCorrect={value:score,denominator:1,definition:'人工逐案例二元任务完成正确性复核；采用最新复核，历史复核仍保留'};
      this.db.prepare('UPDATE evaluation_results SET body=? WHERE run_id=? AND case_id=?').run(encode(result),runId,caseId);
      for(const [name,value]of Object.entries(aggregate(this.run(runId).results)))this.db.prepare('INSERT OR REPLACE INTO evaluation_metrics VALUES(?,?,?)').run(runId,name,encode(value));
    }
    this.audit('human_review_added',runId);
  });}
  report(id:string,format:string,bytes:Buffer){if(bytes.length>25*1024*1024)throw new EvaluationError('导出文件过大。',413);const reportId=randomUUID();this.transaction(()=>{if(Number(this.db.prepare('SELECT count(*) n FROM evaluation_reports WHERE run_id=?').get(id)!.n)>=10)throw new EvaluationError('每次评测最多保留 10 份导出，请下载已有报告。',413);this.db.prepare('INSERT INTO evaluation_reports VALUES(?,?,?,?,?,?)').run(reportId,id,format,sha(bytes),bytes,Date.now());this.audit('report_created',reportId);});return reportId;}
  artifact(id:string){const row=this.db.prepare('SELECT * FROM evaluation_reports WHERE id=?').get(id);if(!row||!(row.bytes instanceof Uint8Array))throw new EvaluationError('报告不存在。',404);if(sha(row.bytes)!==row.hash)throw new EvaluationError('报告校验失败。',409);return row;}
  reports(){return this.db.prepare('SELECT id,run_id,format,hash,created_at FROM evaluation_reports ORDER BY created_at DESC LIMIT 1000').all();}
  integrity(){return {integrity:this.db.prepare('PRAGMA integrity_check').get()!.integrity_check,foreignKeys:this.db.prepare('PRAGMA foreign_key_check').all().length,schema:this.db.prepare('PRAGMA user_version').get()!.user_version};}
  backup(){const target=path.join(path.dirname(this.file),'backups',randomUUID(),'evaluation.sqlite');safeFile(target,false);mkdirSync(path.dirname(target),{recursive:true,mode:0o700});this.db.prepare('VACUUM INTO ?').run(target);const check=new DatabaseSync(target,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)throw new EvaluationError('备份验证失败。');}finally{check.close();}return {file:target,hash:sha(readFileSync(target))};}
}
// Rollback never overwrites an existing DB: stop the evaluation service, restore to a NEW directory, verify, then explicitly switch deployment.
export function restoreEvaluation(backup:string,target:string,hash:string){safeFile(backup);safeFile(target,false);if(existsSync(target)||path.basename(target)!=='evaluation.sqlite'||sha(readFileSync(backup))!==hash)throw new EvaluationError('恢复目标已存在或备份校验失败。',409);const db=new DatabaseSync(backup,{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new EvaluationError('备份结构不完整。');}finally{db.close();}mkdirSync(path.dirname(target),{recursive:true});copyFileSync(backup,target);}
export function page<T>(items:T[],p:number,size:number){return {items:items.slice((p-1)*size,p*size),total:items.length,page:p,pageSize:size};}
export type EvaluationRow=Row;
