import 'server-only';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync,copyFileSync,constants,readdirSync} from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import Decimal from 'decimal.js';
import {safeFile,sha,canonical} from '../data-platform/scanner';
import {ModelError,taskInput,priceSchema,PROMPT,SCORER,type TaskInput,type ModelConfig,type Price,type DatasetSnapshot,type Attempt,type Result} from './types';
import {DEFAULT_PRICES,MODEL_VERSIONS,reserveUSD} from './pricing';
export const MODEL_FILE=path.resolve('tmp/reports/model-center/model-evaluation.sqlite');
const encode=(v:unknown)=>canonical(JSON.parse(JSON.stringify(v)));
export class ModelStore{
  readonly db:DatabaseSync;
  constructor(readonly file=MODEL_FILE,beforeCommit?:()=>void){
    if(path.basename(file)!=='model-evaluation.sqlite')throw new ModelError('必须使用独立模型评测库。');safeFile(file,false);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});this.db=new DatabaseSync(file);this.db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=1000;');
    try{const version=this.db.prepare('PRAGMA user_version').get()!.user_version;if(version===1)return;if(version!==0||this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()!.n)throw new ModelError('未知或非空模型库，拒绝覆盖。',409);
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE models(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE model_prices(id TEXT PRIMARY KEY,model_id TEXT REFERENCES models(id),body TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE model_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,ended_at INTEGER,cancel INTEGER NOT NULL DEFAULT 0,lease TEXT,grant_hash TEXT,grant_expires INTEGER,error TEXT,idempotency TEXT NOT NULL UNIQUE);
        CREATE TABLE model_attempts(id TEXT PRIMARY KEY,run_id TEXT REFERENCES model_runs(id),body TEXT NOT NULL);
        CREATE TABLE model_results(run_id TEXT REFERENCES model_runs(id),model_id TEXT,case_id TEXT,body TEXT NOT NULL,PRIMARY KEY(run_id,model_id,case_id));
        CREATE TABLE model_reports(id TEXT PRIMARY KEY,run_id TEXT REFERENCES model_runs(id),format TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL);
        CREATE TABLE model_audit(id INTEGER PRIMARY KEY,run_id TEXT,action TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE TABLE model_migrations(version INTEGER PRIMARY KEY,at INTEGER NOT NULL,description TEXT NOT NULL);
        INSERT INTO model_migrations VALUES(1,${Date.now()},'new isolated schema; no V10.1/knowledge/platform migration');
        PRAGMA user_version=1;`);
      for(const id of ['deepseek-flash','deepseek-v4-pro'] as const)this.db.prepare('INSERT INTO models VALUES(?,?)').run(id,encode({id,name:id,version:MODEL_VERSIONS[id],provider:'deepseek',enabled:false,revision:1}));
      for(const price of DEFAULT_PRICES)this.db.prepare('INSERT INTO model_prices VALUES(?,?,?,?)').run(price.version,price.model,encode(price),Date.now());beforeCommit?.();this.db.exec('COMMIT');
    }catch(e){try{this.db.exec('ROLLBACK');}catch{/* May fail before transaction. */}this.db.close();throw e;}
  }
  close(){this.db.close();}
  tx<T>(fn:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(id:string,action:string){this.db.prepare('INSERT INTO model_audit(run_id,action,at) VALUES(?,?,?)').run(id,action,Date.now());}
  models():ModelConfig[]{return this.db.prepare('SELECT body FROM models ORDER BY id').all().map(r=>JSON.parse(String(r.body)));}
  model(id:string){const m=this.models().find(m=>m.id===id);if(!m)throw new ModelError('模型不在允许的适配器注册表中。',404);return m;}
  updateModel(id:string,name:string,enabled:boolean,revision:number,version?:string){return this.tx(()=>{const old=this.model(id);if(old.revision!==revision)throw new ModelError('模型配置已变化，请刷新。',409);const m={...old,name,version:version??old.version,enabled,revision:old.revision+1};this.db.prepare('UPDATE models SET body=? WHERE id=?').run(encode(m),id);this.audit(id,'model_configuration_updated');return m;});}
  prices(id:string):Price[]{return this.db.prepare('SELECT body FROM model_prices WHERE model_id=? ORDER BY created_at DESC,rowid DESC').all(id).map(r=>JSON.parse(String(r.body)));}
  addPrice(input:unknown){const p=priceSchema.parse(input);this.model(p.model);if(Date.parse(p.observedAt)>Date.now()+86400000)throw new ModelError('价格核验时间不能位于未来。');this.tx(()=>{if(this.db.prepare('SELECT id FROM model_prices WHERE id=?').get(p.version))throw new ModelError('价格版本已存在，不能覆盖历史。',409);this.db.prepare('INSERT INTO model_prices VALUES(?,?,?,?)').run(p.version,p.model,encode(p),Date.now());this.audit(p.model,'price_version_added');});return p;}
  create(input:TaskInput,dataset:DatasetSnapshot){
    const config=taskInput.parse(input);if(dataset.cases.length<config.caseLimit)throw new ModelError('选择案例数超过数据集实际案例数。');
    return this.tx(()=>{const existing=this.db.prepare('SELECT id,body FROM model_runs WHERE idempotency=?').get(config.idempotencyKey);if(existing){const body=JSON.parse(String(existing.body));if(encode(body.config)!==encode(config)||body.dataset.hash!==dataset.hash)throw new ModelError('幂等键对应不同评测任务。',409);return this.run(String(existing.id));}
      if(Number(this.db.prepare('SELECT count(*) n FROM model_runs').get()!.n)>=10000)throw new ModelError('任务容量达到上限，请先人工备份与归档。',413);
      const models=config.models.map(id=>this.model(id));if(config.mode==='live'&&models.some(m=>!m.enabled))throw new ModelError('请先在模型管理中启用选中的模型。',409);
      const prices=models.map(m=>this.prices(m.id)[0]);if(prices.some(p=>!p))throw new ModelError('模型价格配置缺失。');
      let code='UNKNOWN';try{code=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();}catch{/* Unknown stays unknown. */}
      const source=path.resolve('src/lib/model-center');safeFile(source,false);const sourceHash=sha(canonical(readdirSync(source).filter(f=>f.endsWith('.ts')).sort().map(f=>[f,sha(readFileSync(path.join(source,f)))])));
      const id=randomUUID(),selected={...dataset,cases:dataset.cases.slice(0,config.caseLimit)},system=PROMPT+(config.rubric.format==='json'?' 请返回 JSON 对象。':''),body={config,dataset:selected,models,prices,provenance:{code,sourceHash,scorer:SCORER,promptHash:sha(system),datasetHash:dataset.hash,datasetVersion:dataset.version,selectedCases:selected.cases.map(c=>c.id),rubricHash:sha(encode(config.rubric)),mode:config.mode},system};
      this.db.prepare("INSERT INTO model_runs(id,status,body,created_at,idempotency) VALUES(?,'pending',?,?,?)").run(id,encode(body),Date.now(),config.idempotencyKey);this.audit(id,'created');return this.run(id);
    });
  }
  run(id:string){const row=this.db.prepare('SELECT id,status,body,created_at,started_at,ended_at,cancel,error FROM model_runs WHERE id=?').get(id);if(!row)throw new ModelError('模型评测任务不存在。',404);const body=JSON.parse(String(row.body)) as {config:TaskInput;dataset:DatasetSnapshot;models:ModelConfig[];prices:Price[];provenance:Record<string,unknown>;system:string};const {system,...publicBody}=body;void system;return {...row,id:String(row.id),status:String(row.status),error:row.error===null?null:String(row.error),cancel:Boolean(row.cancel),...publicBody,attempts:this.db.prepare('SELECT body FROM model_attempts WHERE run_id=? ORDER BY rowid').all(id).map(r=>JSON.parse(String(r.body)) as Attempt),results:this.db.prepare('SELECT body FROM model_results WHERE run_id=? ORDER BY model_id,case_id').all(id).map(r=>JSON.parse(String(r.body)) as Result),logs:this.db.prepare('SELECT action,at FROM model_audit WHERE run_id=? ORDER BY id DESC LIMIT 100').all(id)};}
  list(){return this.db.prepare('SELECT id,status,created_at,started_at,ended_at,error FROM model_runs ORDER BY created_at DESC LIMIT 1000').all().map(r=>({id:String(r.id),status:String(r.status),createdAt:Number(r.created_at)}));}
  reservation(id:string){const r=this.run(id);let reserve=new Decimal(0);for(const m of r.models)for(const c of r.dataset.cases)reserve=reserve.add(new Decimal(reserveUSD(Buffer.byteLength(c.question+PROMPT),r.config.maxTokens,r.prices.find(p=>p.model===m.id)!)).mul(1+r.config.retries));return {maximumCalls:r.models.length*r.dataset.cases.length*(1+r.config.retries),reservedEstimateUSD:reserve.toFixed(12),notice:'保守的本地预算预留估算，不是 Token 实测、费用账单或供应商侧硬限额。'};}
  authorize(id:string,budgetUSD:string){return this.tx(()=>{
    const r=this.run(id);if(r.status!=='pending'||r.config.mode!=='live')throw new ModelError('仅未执行的真实任务可以授权。',409);
    if(r.prices.some(p=>Date.now()-Date.parse(p.observedAt)>7*86400000||Date.parse(p.observedAt)>Date.now()+86400000||p.effectiveAt&&Date.parse(p.effectiveAt)>Date.now()))throw new ModelError('价格核验已过期、尚未生效或时间无效，请新增已核实价格版本并新建任务。',409);
    for(const model of r.models){const current=this.model(model.id);if(!current.enabled||current.revision!==model.revision)throw new ModelError('模型配置已变化，请重新创建任务。',409);}
    const plan=this.reservation(id);if(new Decimal(budgetUSD).lt(plan.reservedEstimateUSD))throw new ModelError('预算小于计划中的保守预留估算。');
    const row=this.db.prepare('SELECT body FROM model_runs WHERE id=?').get(id)!;const approved=JSON.parse(String(row.body));approved.provenance={...approved.provenance,approvedBudgetUSD:budgetUSD,approvedMaximumCalls:plan.maximumCalls,approvedAt:new Date().toISOString()};this.db.prepare('UPDATE model_runs SET body=? WHERE id=?').run(encode(approved),id);
    const token=randomBytes(32).toString('hex'),expires=Date.now()+600000;this.db.prepare('UPDATE model_runs SET grant_hash=?,grant_expires=? WHERE id=?').run(sha(token),expires,id);this.audit(id,'paid_and_data_transfer_authorized');return {authorization:token,expires,...plan};
  });}
  claim(id:string,authorization?:string){return this.tx(()=>{
    const r=this.run(id);if(r.status!=='pending'||r.cancel)throw new ModelError('任务不能重复执行或已取消。',409);
    if(this.db.prepare("SELECT id FROM model_runs WHERE status='running'").get())throw new ModelError('已有模型评测正在执行。',409);
    if(r.config.mode==='live'){const grant=this.db.prepare('SELECT grant_hash,grant_expires FROM model_runs WHERE id=?').get(id)!;const expected=String(grant.grant_hash??'');if(!authorization||!Number.isFinite(Number(grant.grant_expires))||Number(grant.grant_expires)<Date.now()||expected.length!==64||!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(sha(authorization),'hex')))throw new ModelError('需要有效、逐次确认的付费与数据发送授权。',403);}
    const lease=randomUUID();this.db.prepare("UPDATE model_runs SET status='running',lease=?,started_at=?,grant_hash=NULL,grant_expires=NULL WHERE id=?").run(lease,Date.now(),id);this.audit(id,'execution_started');return lease;
  });}
  isCancelled(id:string){return this.db.prepare('SELECT cancel FROM model_runs WHERE id=?').get(id)?.cancel===1;}
  cancel(id:string){this.run(id);this.db.prepare("UPDATE model_runs SET cancel=1,grant_hash=NULL,grant_expires=NULL,status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE id=? AND status IN ('pending','running')").run(id);this.audit(id,'cancel_requested');}
  attempt(id:string,lease:string,a:Attempt){this.tx(()=>{if(!this.db.prepare('SELECT id FROM model_runs WHERE id=? AND lease=?').get(id,lease))throw new ModelError('执行租约已失效。',409);this.db.prepare('INSERT INTO model_attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(a.id,id,encode(a));});}
  result(id:string,lease:string,r:Result){if(!this.db.prepare("SELECT id FROM model_runs WHERE id=? AND lease=? AND status='running'").get(id,lease))throw new ModelError('结果对应租约已失效。',409);this.db.prepare('INSERT INTO model_results VALUES(?,?,?,?)').run(id,r.modelId,r.caseId,encode(r));this.audit(id,'case_finished');}
  finish(id:string,lease:string,status:string,error?:string){const changed=this.db.prepare('UPDATE model_runs SET status=?,ended_at=?,error=?,lease=NULL WHERE id=? AND lease=?').run(status,Date.now(),error??null,id,lease);if(changed.changes)this.audit(id,'execution_'+status);}
  recover(){return this.tx(()=>{const rows=this.db.prepare("SELECT id,started_at FROM model_runs WHERE status='running'").all();for(const row of rows)if(Date.now()-Number(row.started_at)>240000){this.db.prepare("UPDATE model_runs SET status='failed',lease=NULL,ended_at=?,error='上次进程中断，费用可能未知；禁止自动重放，请人工核查。' WHERE id=?").run(Date.now(),String(row.id));for(const record of this.db.prepare('SELECT id,body FROM model_attempts WHERE run_id=?').all(String(row.id))){const a=JSON.parse(String(record.body));if(a.status==='running'){a.status='failed';a.errorCode='interrupted_unknown_charge';a.error='进程中断，供应商费用未知；不可自动重放。';this.db.prepare('UPDATE model_attempts SET body=? WHERE id=?').run(encode(a),String(record.id));}}this.audit(String(row.id),'stale_run_marked_failed');}});}
  backup(){const file=path.join(path.dirname(this.file),'backups',randomUUID(),'model-evaluation.sqlite');safeFile(file,false);mkdirSync(path.dirname(file),{recursive:true});this.db.prepare('VACUUM INTO ?').run(file);return {file,hash:sha(readFileSync(file))};}
  integrity(){return {schema:this.db.prepare('PRAGMA user_version').get()!.user_version,integrity:this.db.prepare('PRAGMA integrity_check').get()!.integrity_check,foreignKeys:this.db.prepare('PRAGMA foreign_key_check').all().length};}
  saveReport(id:string,format:string,bytes:Buffer){if(bytes.length>25*1024*1024)throw new ModelError('报告过大。',413);if(Number(this.db.prepare('SELECT count(*) n FROM model_reports WHERE run_id=?').get(id)!.n)>=10)throw new ModelError('每任务最多 10 份报告。',413);const reportId=randomUUID();this.db.prepare('INSERT INTO model_reports VALUES(?,?,?,?,?)').run(reportId,id,format,sha(bytes),bytes);return reportId;}
  report(id:string){const r=this.db.prepare('SELECT * FROM model_reports WHERE id=?').get(id);if(!r||!(r.bytes instanceof Uint8Array))throw new ModelError('报告不存在。',404);if(sha(r.bytes)!==r.hash)throw new ModelError('报告哈希不一致。',409);return r;}
}
export function restoreModelBackup(source:string,target:string,hash:string){safeFile(source);safeFile(target,false);if(existsSync(target)||path.basename(target)!=='model-evaluation.sqlite'||sha(readFileSync(source))!==hash)throw new ModelError('恢复必须使用校验通过的备份及不存在的新目标。');const db=new DatabaseSync(source,{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new ModelError('备份不完整。');}finally{db.close();}mkdirSync(path.dirname(target),{recursive:true});copyFileSync(source,target,constants.COPYFILE_EXCL);}
