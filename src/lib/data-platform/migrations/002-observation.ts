import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeFile, sha } from '../scanner';
import { PlatformError } from '../types';

export const OBSERVATION_SQL=`
CREATE TABLE observed_runs(id TEXT PRIMARY KEY,type TEXT NOT NULL,workflow TEXT NOT NULL,mode TEXT NOT NULL,library_id TEXT,model TEXT,started_at INTEGER NOT NULL,ended_at INTEGER,status TEXT NOT NULL,elapsed_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,error_code TEXT);
CREATE INDEX runs_time ON observed_runs(started_at,type,mode);
CREATE TABLE observed_steps(run_id TEXT NOT NULL REFERENCES observed_runs(id),id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,elapsed_ms INTEGER,error_code TEXT,PRIMARY KEY(run_id,id));
CREATE TABLE retrieval_requests(id TEXT PRIMARY KEY,run_id TEXT REFERENCES observed_runs(id),parent_id TEXT,library_id TEXT,query_hash TEXT NOT NULL,query_length INTEGER NOT NULL,profile TEXT NOT NULL,top_k INTEGER NOT NULL,started_at INTEGER NOT NULL,elapsed_ms INTEGER,status TEXT NOT NULL,error_code TEXT);
CREATE INDEX retrieval_time ON retrieval_requests(started_at,parent_id);
CREATE TABLE retrieval_hits(request_id TEXT NOT NULL REFERENCES retrieval_requests(id),rank INTEGER NOT NULL,document_id TEXT NOT NULL,version INTEGER,chunk_id TEXT NOT NULL,page INTEGER,score REAL,method TEXT NOT NULL,text_hash TEXT NOT NULL,PRIMARY KEY(request_id,rank));
CREATE INDEX hits_chunk ON retrieval_hits(chunk_id,document_id);
CREATE TABLE observed_citations(run_id TEXT NOT NULL REFERENCES observed_runs(id),document_id TEXT NOT NULL,version INTEGER,chunk_id TEXT NOT NULL,page INTEGER,kind TEXT NOT NULL,PRIMARY KEY(run_id,document_id,chunk_id,kind));
CREATE TABLE asset_changes(id TEXT PRIMARY KEY,library_id TEXT NOT NULL,document_id TEXT NOT NULL,logical_id TEXT,action TEXT NOT NULL,at INTEGER NOT NULL);
CREATE TABLE platform_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL,backup_name TEXT NOT NULL,backup_hash TEXT NOT NULL);
PRAGMA user_version=2;`;

/** Only the independent platform DB is migrated; VACUUM INTO produces a SQLite-consistent pre-migration backup. */
export function upgradeObservation(db:DatabaseSync,file:string,fault?:()=>void){
  if(path.basename(file)!=='platform.sqlite')throw new PlatformError('迁移仅允许独立中台文件。');safeFile(file);
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if(version===2)return;
  if(version!==1)throw new PlatformError('观测迁移要求中台 schema 1。',409);
  if(db.prepare('SELECT id FROM scan_locks WHERE expires_at>?').get(Date.now()))throw new PlatformError('扫描正在执行，拒绝中台迁移。',409);
  const dir=path.join(path.dirname(file),'backups');safeFile(dir,false);mkdirSync(dir,{recursive:true,mode:0o700});
  const backup=path.join(dir,`schema1-${Date.now()}-${randomUUID()}.sqlite`);safeFile(backup,false);
  db.prepare('VACUUM INTO ?').run(backup);
  const copy=new DatabaseSync(backup,{readOnly:true});try{if(copy.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||copy.prepare('PRAGMA foreign_key_check').all().length)throw new PlatformError('中台迁移前备份验证失败。',500);}finally{copy.close();}
  const hash=sha(readFileSync(backup));
  writeFileSync(backup+'.json',JSON.stringify({format:1,target:path.resolve(file),from:1,to:2,sha256:hash,createdAt:Date.now()},null,2),{flag:'wx',mode:0o600});
  db.exec('BEGIN IMMEDIATE');
  try{
    // A second process may have migrated after backup; additive migration is never executed twice.
    if(Number(db.prepare('PRAGMA user_version').get()!.user_version)===2){db.exec('COMMIT');return;}
    db.exec(OBSERVATION_SQL);fault?.();
    db.prepare('INSERT INTO platform_migrations VALUES(2,?,?,?)').run(Date.now(),path.basename(backup),hash);
    if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new PlatformError('中台迁移验证失败。',500);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

/** Restore into a NEW target for offline cutover; never overwrite a live or unique valid file. */
export function restoreObservationBackup(backup:string,target:string){
  safeFile(backup);safeFile(backup+'.json');safeFile(target,false);
  if(path.basename(target)!=='platform.sqlite'||existsSync(target))throw new PlatformError('恢复目标必须是尚不存在的独立 platform.sqlite。');
  const receipt=JSON.parse(readFileSync(backup+'.json','utf8'));
  if(receipt.from!==1||receipt.to!==2||receipt.sha256!==sha(readFileSync(backup)))throw new PlatformError('备份清单或哈希不符。');
  const db=new DatabaseSync(backup,{readOnly:true});
  try{
    if(Number(db.prepare('PRAGMA user_version').get()!.user_version)!==1||db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new PlatformError('备份完整性检查失败。');
    mkdirSync(path.dirname(target),{recursive:true,mode:0o700});db.prepare('VACUUM INTO ?').run(target);
  }finally{db.close();}
}
