import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { upgradeObservation } from './migrations/002-observation';
import { canonical, safeFile, sha } from './scanner';
import { manifestSchema, qualitySchema, PlatformError, type Asset, type PageQuery, type Scan, type Snapshot, type Version } from './types';

export const PLATFORM_FILE=path.resolve('tmp/reports/data-platform/platform.sqlite');
export const SCHEMA_SQL=`
CREATE TABLE data_sources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE corpus_snapshots(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES data_sources(id),created_at INTEGER NOT NULL,hash TEXT NOT NULL,manifest TEXT NOT NULL,counts TEXT NOT NULL,changed INTEGER NOT NULL);
CREATE INDEX snapshots_source ON corpus_snapshots(source_id,created_at);
CREATE TABLE assets(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES data_sources(id),external_id TEXT NOT NULL,payload TEXT NOT NULL,missing INTEGER NOT NULL DEFAULT 0,UNIQUE(source_id,external_id));
CREATE TABLE asset_versions(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id),external_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(asset_id,external_id));
CREATE TABLE snapshot_members(snapshot_id TEXT NOT NULL REFERENCES corpus_snapshots(id),chunk_id TEXT NOT NULL,version_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(snapshot_id,chunk_id));
CREATE TABLE quality_rules(id TEXT PRIMARY KEY,name TEXT NOT NULL,version INTEGER NOT NULL);
CREATE TABLE quality_checks(id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL REFERENCES corpus_snapshots(id),rule_id TEXT NOT NULL REFERENCES quality_rules(id),result TEXT NOT NULL CHECK(result IN ('PASS','FAIL','WARNING','UNKNOWN')),payload TEXT NOT NULL);
CREATE INDEX checks_snapshot ON quality_checks(snapshot_id,result);
CREATE TABLE scan_locks(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,expires_at INTEGER NOT NULL);
PRAGMA user_version=1;`;
export function migratePlatform(db:DatabaseSync, beforeCommit?:()=>void){
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if(version===1||version===2){for(const table of ['data_sources','assets','asset_versions','corpus_snapshots','snapshot_members','quality_rules','quality_checks','scan_locks'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new PlatformError('中台结构不匹配，拒绝自动修复。',409);return;}
  if(version!==0)throw new PlatformError('不支持的中台数据库版本，拒绝自动降级。',409);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  if(tables.length)throw new PlatformError('目标不是空的中台数据库，拒绝覆盖。',409);
  db.exec('BEGIN IMMEDIATE');
  try{db.exec(SCHEMA_SQL);beforeCommit?.();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
export const assetKey=(source:string,id:string)=>sha(canonical([source,id]));
export function snapshotDiff(previous:Snapshot|null,current:Snapshot){
  const compare=<T extends {id:string}>(before:T[],after:T[])=>{
    const a=new Map(before.map(v=>[v.id,v])),b=new Map(after.map(v=>[v.id,v]));
    return {added:after.filter(v=>!a.has(v.id)).map(v=>v.id),removed:before.filter(v=>!b.has(v.id)).map(v=>v.id),modified:after.filter(v=>a.has(v.id)&&canonical(a.get(v.id))!==canonical(v)).map(v=>v.id)};
  };
  if(previous&&previous.sourceId!==current.sourceId)throw new PlatformError('不能比较不同知识库的快照。');
  return {previousId:previous?.id??null,currentId:current.id,unchanged:previous?.hash===current.hash,assets:compare(previous?.manifest.assets??[],current.manifest.assets),versions:compare(previous?.manifest.versions??[],current.manifest.versions),chunks:compare(previous?.manifest.members??[],current.manifest.members),stateChanges:current.manifest.assets.filter(a=>previous?.manifest.assets.some(p=>p.id===a.id&&p.state!==a.state)).map(a=>({id:a.id,state:a.state})),notice:'快照是元数据与哈希清单，不包含原文件、正文或向量，不能替代完整备份。'};
}
export class PlatformStore {
  db:DatabaseSync;
  constructor(public file=PLATFORM_FILE,options?:{busyMs:number}){
    if(path.basename(file)!=='platform.sqlite')throw new PlatformError('中台只允许独立的 platform.sqlite 文件。');
    safeFile(file,false);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options?.busyMs===25?25:1000};`);
    try{migratePlatform(this.db);upgradeObservation(this.db,file);}catch(e){this.db.close();throw e;}
  }
  close(){this.db.close();}
  integrity(){return this.db.prepare('PRAGMA integrity_check').get()!.integrity_check==='ok'&&this.db.prepare('PRAGMA foreign_key_check').all().length===0;}
  lease(){
    const token=randomUUID(),now=Date.now();
    const row=this.db.prepare('INSERT INTO scan_locks(id,token,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE scan_locks.expires_at<? RETURNING token').get(token,now+150000,now);
    if(!row)throw new PlatformError('已有扫描任务正在运行，请稍后重试。',409);
    return token;
  }
  release(token:string){this.db.prepare('DELETE FROM scan_locks WHERE token=?').run(token);}
  latest(sourceId?:string){const row=sourceId?this.db.prepare('SELECT id FROM corpus_snapshots WHERE source_id=? ORDER BY rowid DESC LIMIT 1').get(sourceId):this.db.prepare('SELECT id FROM corpus_snapshots ORDER BY rowid DESC LIMIT 1').get();return row?this.snapshot(String(row.id)):null;}
  snapshot(id:string):Snapshot{
    const row=this.db.prepare('SELECT * FROM corpus_snapshots WHERE id=?').get(id);if(!row)throw new PlatformError('快照不存在。',404);
    return {id:String(row.id),sourceId:String(row.source_id),createdAt:Number(row.created_at),hash:String(row.hash),changed:!!row.changed,counts:JSON.parse(String(row.counts)),manifest:JSON.parse(String(row.manifest))};
  }
  publish(scan:Scan,token:string,signal:AbortSignal,beforeCommit?:()=>void){
    signal.throwIfAborted();
    const manifest=manifestSchema.parse(scan.manifest),checks=scan.checks.map(c=>qualitySchema.parse(c)),source=manifest.libraryId,id=randomUUID(),previous=this.latest(source),hash=sha(canonical(manifest));
    const counts={assets:manifest.assets.length,versions:manifest.versions.length,chunks:manifest.members.length,vectors:manifest.versions.reduce((n,v)=>n+v.vectorCount,0),active:manifest.assets.filter(a=>a.state==='active'&&manifest.versions.some(v=>v.id===a.currentVersionId&&v.logicalId===a.id&&v.status==='ready')).length};
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const lease=this.db.prepare('SELECT token,expires_at FROM scan_locks WHERE id=1').get();
      if(lease?.token!==token||Number(lease.expires_at)<Date.now())throw new PlatformError('扫描租约失效，结果未发布。',409);
      this.db.prepare('INSERT INTO data_sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at').run(source,'sqlite-knowledge',scan.capturedAt);
      this.db.prepare('UPDATE assets SET missing=1 WHERE source_id=?').run(source);
      for(const a of manifest.assets){
        const key=assetKey(source,a.id);
        this.db.prepare('INSERT INTO assets VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,missing=0').run(key,source,a.id,JSON.stringify(a));
      }
      for(const v of manifest.versions){if(!manifest.assets.some(a=>a.id===v.logicalId))continue;this.db.prepare('INSERT INTO asset_versions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(assetKey(source,v.id),assetKey(source,v.logicalId),v.id,JSON.stringify(v));}
      this.db.prepare('INSERT INTO corpus_snapshots VALUES(?,?,?,?,?,?,?)').run(id,source,scan.capturedAt,hash,JSON.stringify(manifest),JSON.stringify(counts),previous?.hash===hash?0:1);
      for(const m of manifest.members)this.db.prepare('INSERT INTO snapshot_members VALUES(?,?,?,?)').run(id,m.id,m.documentId,JSON.stringify(m));
      for(const c of checks){this.db.prepare('INSERT INTO quality_rules VALUES(?,?,1) ON CONFLICT(id) DO NOTHING').run(c.rule,c.name);this.db.prepare('INSERT INTO quality_checks VALUES(?,?,?,?,?)').run(randomUUID(),id,c.rule,c.result,JSON.stringify(c));}
      beforeCommit?.();signal.throwIfAborted();
      if(!this.integrity())throw new PlatformError('中台数据库完整性检查失败。',500);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.snapshot(id);
  }
  overview(){
    const s=this.latest();if(!s)return {initialized:false,counts:null,lastScan:null,quality:{PASS:0,FAIL:0,WARNING:0,UNKNOWN:0},anomalies:null,types:[],trend:[]};
    const quality={PASS:0,FAIL:0,WARNING:0,UNKNOWN:0};for(const r of this.db.prepare('SELECT result,count(*) AS n FROM quality_checks WHERE snapshot_id=? GROUP BY result').all(s.id))quality[String(r.result) as keyof typeof quality]=Number(r.n);
    const types=new Map<string,number>();for(const a of s.manifest.assets){const v=s.manifest.versions.find(v=>v.id===a.currentVersionId);const ext=v?.extension??'UNKNOWN';types.set(ext,(types.get(ext)??0)+1);}
    const trend=this.db.prepare('SELECT id,created_at,counts FROM corpus_snapshots WHERE source_id=? ORDER BY rowid DESC LIMIT 20').all(s.sourceId).reverse().map(r=>({id:String(r.id),at:Number(r.created_at),versions:JSON.parse(String(r.counts)).versions as number}));
    return {initialized:true,counts:s.counts,lastScan:s.createdAt,sourceId:s.sourceId,quality,anomalies:quality.FAIL+quality.WARNING+quality.UNKNOWN,types:[...types].map(([name,value])=>({name,value})),trend};
  }
  asset(id:string){const row=this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);if(!row)throw new PlatformError('资产不存在。',404);const a=JSON.parse(String(row.payload)) as Asset;const versions=this.db.prepare('SELECT payload FROM asset_versions WHERE asset_id=?').all(id).map(r=>JSON.parse(String(r.payload)) as Version).sort((a,b)=>b.version-a.version);const current=versions.find(v=>v.id===a.currentVersionId)??null;return {...a,id,externalId:a.id,sourceId:String(row.source_id),state:row.missing?'missing':a.state,name:current?.name??versions[0]?.name??'UNKNOWN',current,versions};}
  assets(q:PageQuery){
    const source=this.latest()?.sourceId;
    const rows=source?this.db.prepare('SELECT id FROM assets WHERE source_id=?').all(source).map(r=>this.asset(String(r.id))):[];
    const filtered=rows.filter(a=>(q.state==='all'||a.state===q.state)&&a.name.toLocaleLowerCase().includes(q.search.toLocaleLowerCase()));
    filtered.sort((a,b)=>{const result=q.sort==='name'?a.name.localeCompare(b.name,'zh-CN'):Number(a[q.sort])-Number(b[q.sort]);return q.order==='asc'?result:-result;});
    return this.page(filtered,q);
  }
  quality(q:PageQuery){const s=this.latest();const rows=s?this.db.prepare('SELECT id,payload FROM quality_checks WHERE snapshot_id=? ORDER BY rowid').all(s.id).map(r=>({id:String(r.id),...JSON.parse(String(r.payload))})):[];return this.page(rows.filter(r=>(q.result==='all'||r.result===q.result)&&`${r.name} ${r.documentName??''}`.includes(q.search)),q);}
  snapshots(q:PageQuery){const rows=this.db.prepare('SELECT id,source_id,created_at,hash,counts,changed FROM corpus_snapshots ORDER BY rowid DESC LIMIT ? OFFSET ?').all(q.pageSize,(q.page-1)*q.pageSize).map(r=>({id:String(r.id),sourceId:String(r.source_id),createdAt:Number(r.created_at),hash:String(r.hash),counts:JSON.parse(String(r.counts)) as Snapshot['counts'],changed:!!r.changed}));return {items:rows,total:Number(this.db.prepare('SELECT count(*) AS n FROM corpus_snapshots').get()!.n),page:q.page,pageSize:q.pageSize};}
  diff(id:string,previousId?:string){const current=this.snapshot(id);let previous:Snapshot|null=null;if(previousId)previous=this.snapshot(previousId);else{const rows=this.db.prepare('SELECT id FROM corpus_snapshots WHERE source_id=? AND rowid<(SELECT rowid FROM corpus_snapshots WHERE id=?) ORDER BY rowid DESC LIMIT 1').get(current.sourceId,id);if(rows)previous=this.snapshot(String(rows.id));}return snapshotDiff(previous,current);}
  private page<T>(items:T[],q:PageQuery){return {items:items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:items.length,page:q.page,pageSize:q.pageSize};}
}
