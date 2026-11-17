import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEGACY_SCHEMA_SQL, MIGRATION_COPY_SQL, MIGRATION_REBUILD_SQL } from '../src/lib/rag/schema-sql';
import { EMBEDDING_DIMENSION, EMBEDDING_ID } from '../src/lib/rag/model-spec';
import { canonical, fingerprints, scanKnowledge, sha } from '../src/lib/data-platform/scanner';
import { assetKey, migratePlatform, PlatformStore, snapshotDiff } from '../src/lib/data-platform/store';
import { createApi } from '../src/lib/data-platform/api';
import { pageSchema } from '../src/lib/data-platform/types';

function fixture(){
  mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/platform-')),file=path.join(root,'source','knowledge.sqlite'),libraryId=randomUUID();
  mkdirSync(path.dirname(file));
  const db=new DatabaseSync(file);db.exec(LEGACY_SCHEMA_SQL+MIGRATION_COPY_SQL+MIGRATION_REBUILD_SQL);
  const platform=new PlatformStore(path.join(root,'catalog','platform.sqlite'));
  const signal=new AbortController().signal;
  function add(name='虚构测试资料.txt',state='active',version=1,logicalId=randomUUID()){
    const id=randomUUID(),raw=Buffer.from('虚构隔离文档，不是真实业务资料。'+name+version),now=Date.now();
    db.prepare('INSERT OR IGNORE INTO knowledge_documents(id,state,current_version_id,revision,created_at,updated_at) VALUES(?,?,NULL,0,?,?)').run(logicalId,state,now,now);
    db.prepare('INSERT INTO documents(id,logical_id,version,name,extension,size,hash,status,chunk_count,created_at,raw,model,dimension) VALUES(?,?,?,?,?,?,?,\'ready\',1,?,?,?,?)').run(id,logicalId,version,name,'.txt',raw.length,sha(raw),now,raw,EMBEDDING_ID,EMBEDDING_DIMENSION);
    const vector=new Float32Array(384);vector[0]=1;
    db.prepare('INSERT INTO chunks VALUES(?,?,0,?,2,NULL,?,?,?)').run(randomUUID(),id,'虚构隔离切片，产品字段待核实。',Buffer.from(vector.buffer),EMBEDDING_ID,384);
    db.prepare('UPDATE knowledge_documents SET current_version_id=?,revision=revision+1 WHERE id=?').run(id,logicalId);
    return {id,logicalId,raw};
  }
  const scan=()=>scanKnowledge(file,libraryId,signal,path.join(root,'scratch'));
  const publish=async()=>{const token=platform.lease();try{return platform.publish(await scan(),token,signal);}finally{platform.release(token);}};
  const close=async()=>{db.close();platform.close();await rm(root,{recursive:true,force:true});};
  return {root,file,libraryId,db,platform,signal,add,scan,publish,close};
}

test('platform initializes seven metadata tables plus lease table independently and idempotently',async()=>{
  const f=fixture();try{assert.equal(f.platform.integrity(),true);assert.equal(f.platform.db.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(f.platform.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()!.n,15);migratePlatform(f.platform.db);assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n,0);assert.equal(f.platform.overview().counts,null);}finally{await f.close();}
});
test('platform migration rolls back DDL and version on injected failure; future schema is rejected',()=>{
  const db=new DatabaseSync(':memory:');try{assert.throws(()=>migratePlatform(db,()=>{throw Error('injected');}));assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,0);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()!.n,0);migratePlatform(db);db.exec('PRAGMA user_version=99');assert.throws(()=>migratePlatform(db),/版本/);}finally{db.close();}
});
test('migration refuses non-platform schema and opening a knowledge filename',()=>{
  const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE unrelated(id TEXT)');assert.throws(()=>migratePlatform(db),/拒绝覆盖/);assert.throws(()=>new PlatformStore(path.resolve('knowledge.sqlite')),/独立/);}finally{db.close();}
});
test('scan hashes actual original bytes and chunks, preserves pages and stores no document bodies/vectors',async()=>{
  const f=fixture();try{const d=f.add();const scan=await f.scan();assert.equal(scan.manifest.versions[0].actualHash,sha(d.raw));assert.equal(scan.manifest.members[0].page,2);assert.equal(scan.manifest.members[0].textHash.length,64);assert.ok(scan.checks.every(c=>c.result==='PASS'));const s=await f.publish();const serialized=canonical(s.manifest);assert.ok(!serialized.includes(d.raw.toString()));assert.ok(!serialized.includes('虚构隔离切片'));assert.ok(!serialized.includes('"vector":'));assert.equal(f.platform.overview().counts?.vectors,1);}finally{await f.close();}
});
test('source database, nonempty WAL and SHM stay byte-identical while committed WAL rows are read',async()=>{
  const f=fixture();try{f.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');f.add();assert.ok(readFileSync(f.file+'-wal').length>0);const before=await fingerprints(f.file,f.signal);const scan=await f.scan();assert.equal(scan.manifest.versions.length,1);assert.deepEqual(await fingerprints(f.file,f.signal),before);}finally{await f.close();}
});
test('concurrent writes in isolated WAL source reject an unstable capture instead of publishing mixed state',async()=>{
  const f=fixture();let timer:ReturnType<typeof setInterval>|undefined;try{f.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');f.add();timer=setInterval(()=>f.db.exec('UPDATE knowledge_documents SET revision=revision+1'),1);await assert.rejects(()=>f.scan(),/变化|校验/);assert.equal(f.platform.latest(),null);}finally{if(timer)clearInterval(timer);await f.close();}
});
test('metadata validation refuses private body fields; malformed stored hashes are visible quality failures',async()=>{
  const f=fixture();try{const d=f.add();f.db.prepare("UPDATE documents SET hash='damaged' WHERE id=?").run(d.id);const scan=await f.scan(),token=f.platform.lease();const poisoned={...scan,manifest:{...scan.manifest,text:'must not persist'}};assert.throws(()=>f.platform.publish(poisoned,token,f.signal));assert.equal(f.platform.latest(),null);f.platform.publish(scan,token,f.signal);assert.ok(f.platform.overview().quality.FAIL>0);f.platform.release(token);}finally{await f.close();}
});
test('unchanged repeat scans retain distinct immutable snapshots and stable manifest hash',async()=>{
  const f=fixture();try{f.add();const a=await f.publish(),b=await f.publish();assert.notEqual(a.id,b.id);assert.equal(a.hash,b.hash);assert.equal(b.changed,false);assert.equal(f.platform.assets(pageSchema.parse({})).total,1);assert.equal(f.platform.snapshots(pageSchema.parse({})).total,2);assert.equal(f.platform.diff(b.id).unchanged,true);assert.deepEqual(f.platform.snapshot(a.id),a);}finally{await f.close();}
});
test('versions and snapshots detect replacement, text changes, state changes, additions and deletion',async()=>{
  const f=fixture();try{const old=f.add();const a=await f.publish();const replacement=f.add('虚构新版本.txt','active',2,old.logicalId);f.db.prepare("UPDATE knowledge_documents SET state='inactive' WHERE id=?").run(old.logicalId);const extra=f.add('虚构新增.txt');const b=await f.publish();const diff=snapshotDiff(a,b);assert.equal(diff.versions.added.length,2);assert.equal(diff.stateChanges.length,1);const asset=f.platform.asset(assetKey(f.libraryId,old.logicalId));assert.equal(asset.current?.id,replacement.id);assert.equal(asset.versions.filter(v=>v.isCurrent).length,1);assert.equal(asset.versions.length,2);f.db.prepare('UPDATE knowledge_documents SET current_version_id=NULL WHERE id=?').run(extra.logicalId);f.db.prepare('DELETE FROM chunks WHERE document_id=?').run(extra.id);f.db.prepare('DELETE FROM documents WHERE id=?').run(extra.id);f.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(extra.logicalId);const c=await f.publish();assert.equal(f.platform.diff(c.id).assets.removed.length,1);assert.equal(f.platform.snapshot(a.id).manifest.versions.length,1);assert.equal(f.platform.assets(pageSchema.parse({state:'missing'})).total,1);}finally{await f.close();}
});
test('quality identifies tampering, missing vectors/chunks, wrong model and dimensions, and unknown empty index',async()=>{
  const f=fixture();try{const d=f.add();f.db.prepare("UPDATE documents SET raw=?,hash=?,chunk_count=2 WHERE id=?").run(Buffer.from('tampered'),'bad-hash',d.id);f.db.prepare("UPDATE chunks SET vector=?,dimension=2,model='wrong' WHERE document_id=?").run(Buffer.alloc(8),d.id);let s=await f.scan();for(const rule of ['raw_hash','chunks','dimension','model'])assert.equal(s.checks.find(c=>c.rule===rule)!.result,'FAIL');f.db.exec("UPDATE chunks SET vector=X''");s=await f.scan();assert.equal(s.checks.find(c=>c.rule==='vectors')!.result,'FAIL');f.db.prepare('DELETE FROM chunks').run();s=await f.scan();assert.equal(s.checks.find(c=>c.rule==='dimension')!.result,'UNKNOWN');assert.equal(s.checks.find(c=>c.rule==='model')!.result,'UNKNOWN');}finally{await f.close();}
});
test('duplicate files and archived/inactive states produce warnings, not fabricated validity',async()=>{
  const f=fixture();try{const a=f.add('虚构重复.txt','inactive'),b=f.add('虚构重复.txt','archived');const s=await f.scan();assert.equal(a.raw.equals(b.raw),true);assert.equal(s.checks.filter(c=>c.rule==='duplicate'&&c.result==='WARNING').length,2);assert.equal(s.checks.filter(c=>c.rule==='eligibility'&&c.result==='WARNING').length,2);await f.publish();assert.equal(f.platform.overview().counts?.active,0);}finally{await f.close();}
});
test('broken current-version ownership fails even when the foreign key target exists',async()=>{
  const f=fixture();try{const a=f.add(),b=f.add('虚构另一个产品.txt');f.db.prepare('UPDATE knowledge_documents SET current_version_id=? WHERE id=?').run(b.id,a.logicalId);const s=await f.scan();assert.equal(s.checks.find(c=>c.rule==='current'&&c.objectId===a.logicalId)?.result,'FAIL');}finally{await f.close();}
});
test('transaction publication failure preserves previous assets, quality and snapshot count',async()=>{
  const f=fixture();try{f.add();const first=await f.publish(),token=f.platform.lease(),scan=await f.scan();try{assert.throws(()=>f.platform.publish(scan,token,f.signal,()=>{throw Error('fault');}));}finally{f.platform.release(token);}assert.equal(f.platform.snapshots(pageSchema.parse({})).total,1);assert.deepEqual(f.platform.latest(),first);assert.equal(f.platform.integrity(),true);}finally{await f.close();}
});
test('scan lease prevents duplicate submission across connections and protects stale publishers',async()=>{
  const f=fixture(),other=new PlatformStore(f.platform.file);try{f.add();const scan=await f.scan(),token=f.platform.lease();assert.throws(()=>other.lease(),/正在运行/);f.platform.db.prepare('UPDATE scan_locks SET expires_at=0').run();const next=other.lease();assert.throws(()=>f.platform.publish(scan,token,f.signal),/租约/);other.release(next);f.platform.release(token);}finally{other.close();await f.close();}
});
test('cancelled or timed-out scan publishes nothing and subsequent scan remains possible',async()=>{
  const f=fixture();try{f.add();const c=new AbortController();c.abort();await assert.rejects(()=>scanKnowledge(f.file,f.libraryId,c.signal,path.join(f.root,'scratch')));const scan=await f.scan(),token=f.platform.lease();assert.throws(()=>f.platform.publish(scan,token,c.signal));f.platform.release(token);assert.equal(f.platform.latest(),null);await new Promise(r=>setTimeout(r,5));await assert.rejects(()=>scanKnowledge(f.file,f.libraryId,AbortSignal.timeout(1),path.join(f.root,'scratch')));await f.publish();assert.equal(f.platform.snapshots(pageSchema.parse({})).total,1);}finally{await f.close();}
});
test('missing, corrupt, schema-zero and rollback-journal source fails without creating source files',async()=>{
  const f=fixture();try{await assert.rejects(()=>scanKnowledge(path.join(f.root,'absent.sqlite'),f.libraryId,f.signal));assert.equal(existsSync(path.join(f.root,'absent.sqlite')),false);const corrupt=path.join(path.dirname(f.file),'corrupt.sqlite');writeFileSync(corrupt,'not SQLite');await assert.rejects(()=>scanKnowledge(corrupt,f.libraryId,f.signal,path.join(f.root,'scratch')));const legacy=path.join(path.dirname(f.file),'legacy.sqlite'),db=new DatabaseSync(legacy);db.exec(LEGACY_SCHEMA_SQL);db.close();await assert.rejects(()=>scanKnowledge(legacy,f.libraryId,f.signal,path.join(f.root,'scratch')),/schema 1/);writeFileSync(f.file+'-journal','pending');await assert.rejects(()=>f.scan(),/回滚日志/);}finally{await f.close();}
});
test('asset catalog search, state filtering, sort and SQL snapshot pagination retain actual counts',async()=>{
  const f=fixture();try{f.add('A-虚构.txt');f.add('B-虚构.txt','archived');const a=await f.publish();await f.publish();assert.equal(f.platform.assets(pageSchema.parse({state:'archived'})).total,1);assert.equal(f.platform.assets(pageSchema.parse({search:'不存在'})).total,0);assert.equal(f.platform.assets(pageSchema.parse({sort:'name',order:'asc',pageSize:1})).items[0].name,'A-虚构.txt');assert.equal(f.platform.snapshots(pageSchema.parse({page:2,pageSize:1})).items[0].id,a.id);}finally{await f.close();}
});
test('cancellation during publication rolls back metadata and snapshots atomically',async()=>{
  const f=fixture();try{f.add();const scan=await f.scan(),token=f.platform.lease(),c=new AbortController();assert.throws(()=>f.platform.publish(scan,token,c.signal,()=>c.abort()));assert.equal(f.platform.latest(),null);assert.equal(f.platform.db.prepare('SELECT count(*) n FROM assets').get()!.n,0);f.platform.release(token);}finally{await f.close();}
});
test('symbolic source paths are refused before SQLite access',async()=>{
  const f=fixture();try{const alias=path.join(f.root,'alias');symlinkSync(f.root,alias,'junction');await assert.rejects(()=>scanKnowledge(path.join(alias,'knowledge.sqlite'),f.libraryId,f.signal,path.join(f.root,'scratch')),/链接/);}finally{await f.close();}
});
test('API rejects nonlocal/cross-origin, invalid pagination, arbitrary paths and malformed JSON before scanning',async()=>{
  const api=createApi(()=>{throw Error('must not open');});
  for(const req of [new Request('http://example.com/api/data-platform/overview'),new Request('http://localhost/api/data-platform/overview',{headers:{Origin:'http://evil.test'}})])assert.equal((await api(req,'overview')).status,403);
  assert.equal((await api(new Request('http://localhost/api/data-platform/assets?pageSize=101'),'assets')).status,400);
  assert.equal((await api(new Request('http://localhost/api/data-platform/assets'),'asset','../../private')).status,400);
  for(const body of ['{','{"path":"C:/private"}'])assert.equal((await api(new Request('http://localhost/api/data-platform/scans',{method:'POST',body}),'scans')).status,400);
});
test('API read/list/version/snapshot/diff endpoints paginate and report actual metadata',async()=>{
  const f=fixture();try{const a=f.add();const s=await f.publish();const api=createApi(()=>new PlatformStore(f.platform.file),async()=>({file:f.file,libraryId:f.libraryId}));
    for(const op of ['overview','assets','asset','versions','quality','snapshots','snapshot','diff'] as const){const id=op==='asset'||op==='versions'?assetKey(f.libraryId,a.logicalId):s.id;const r=await api(new Request('http://localhost/api/data-platform/'+op+(op==='diff'?'':'?pageSize=1')),op,id);assert.equal(r.status,200,op);}
    const response=await api(new Request('http://localhost/api/data-platform/diff'),'diff',s.id);assert.equal(response.status,200);assert.equal((await response.json()).previousId,null);
    const bad=await api(new Request('http://localhost/api/data-platform/assets'),'asset','a'.repeat(64));assert.equal(bad.status,404);
  }finally{await f.close();}
});
test('API scan success and failure release lease without exposing private paths or raw exceptions',async()=>{
  const f=fixture();try{f.add();const api=createApi(()=>new PlatformStore(f.platform.file),async()=>({file:f.file,libraryId:f.libraryId}));const r=await api(new Request('http://localhost/api/data-platform/scans',{method:'POST',body:'{}'}),'scans');assert.equal(r.status,201);const fail=createApi(()=>new PlatformStore(f.platform.file),async()=>{throw Error('private path and exception');});const err=await fail(new Request('http://localhost/api/data-platform/scans',{method:'POST',body:'{}'}),'scans');assert.equal(err.status,500);assert.ok(!(await err.text()).includes('private path'));assert.equal(f.platform.snapshots(pageSchema.parse({})).total,1);const token=f.platform.lease();f.platform.release(token);}finally{await f.close();}
});
