import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { KnowledgeStore } from '../src/lib/rag/store';
import { auditDatabase } from '../src/lib/rag/database-audit';
import { prepareCandidate, runMigrationTool } from '../src/lib/rag/migration-tool';
import { safePath, sha256, readJson } from '../src/lib/rag/migration-paths';
import { readStoredSource } from '../src/lib/agent/knowledge';
import { verifyBackup } from '../src/lib/rag/migration-safety';
import { POST as chatPost } from '../src/app/api/chat/route';

mkdirSync('tmp/rag-tests',{recursive:true});
// Only physically isolated targets use test-local OS probes; production gates stay strict.
process.env.MOYU_MIGRATION_TESTING='1';
const base=mkdtempSync(path.resolve('tmp/rag-tests/migration-tools-'));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const save=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value,null,2));
function fixture() {
  const home=path.join(base,randomUUID());mkdirSync(home);
  const backup=path.join(home,'backup'),data=path.join(backup,'payload','.moyu');mkdirSync(path.join(data,'models'),{recursive:true});
  const source=path.join(data,'knowledge.sqlite'),writer=new KnowledgeStore(source);
  const raw=Buffer.from('纯属虚构的迁移测试文档，不对应真实机构或业务。'),id=randomUUID(),chunk=randomUUID();
  writer.insert({id,name:'虚构迁移.txt',extension:'.txt',raw,hash:hash(raw.toString())});
  writer.commitIndex(id,[{id:chunk,documentId:id,sequence:0,text:raw.toString(),page:1}],[Array.from({length:384},(_,i)=>i===0?1:0)]);writer.close();
  const closeJournal=new DatabaseSync(source);closeJournal.exec('PRAGMA journal_mode=DELETE');closeJournal.close();
  writeFileSync(path.join(data,'models','config.json'),'{}');
  writeFileSync(path.join(backup,'payload','v6.0-source.zip'),'unit-test-source-placeholder');
  const files=['.moyu/knowledge.sqlite','.moyu/models/config.json','v6.0-source.zip'];
  save(path.join(backup,'SHA256-MANIFEST.json'),files.map(file=>({file,bytes:readFileSync(path.join(backup,'payload',file)).length,sha256:sha256(path.join(backup,'payload',file))})));
  writeFileSync(path.join(backup,'SHA256-MANIFEST.sha256'),sha256(path.join(backup,'SHA256-MANIFEST.json'))+'  SHA256-MANIFEST.json\n');
  // Deliberately synthetic evidence documents exercise gates, NOT a claim of real model/backup QA.
  save(path.join(backup,'VERIFICATION-RESULT.json'),{completedAt:new Date().toISOString(),checksums:'PASS',isolatedRestore:'PASS',modelApplicationProbe:'PASS',restoreScriptRehearsal:'PASS',logicalDataPreservation:'PASS',unitTestStub:true});
  refreshControls(backup);
  return {home,backup,root:path.join(home,'candidate'),target:path.join(home,'candidate','data','knowledge.sqlite'),id,chunk};
}
function refreshControls(backup:string){const file=path.join(backup,'VERIFICATION-RESULT.json');save(path.join(backup,'CONTROL-FILES-SHA256.json'),[{file:'VERIFICATION-RESULT.json',sha256:sha256(file),bytes:readFileSync(file).length}]);}
type ManifestEntry = {file:string;bytes:number;sha256:string};
function rewriteManifest(backup:string,name:string,change:(entries:ManifestEntry[])=>unknown){
  const file=path.join(backup,name);save(file,change(readJson(file) as ManifestEntry[]));
  if(name==='SHA256-MANIFEST.json')writeFileSync(path.join(backup,'SHA256-MANIFEST.sha256'),sha256(file));
}
for(const payloadAlias of [false,true])for(const controlAlias of [false,true])test(`both manifest spellings validate without rewriting files: payload aliases=${payloadAlias}, control aliases=${controlAlias}`,()=>{
  const f=fixture();
  for(const [name,alias] of [['SHA256-MANIFEST.json',payloadAlias],['CONTROL-FILES-SHA256.json',controlAlias]] as const){
    if(alias)rewriteManifest(f.backup,name,entries=>entries.map(e=>({path:e.file,size:e.bytes,sha256:e.sha256})));
  }
  const before=['SHA256-MANIFEST.json','CONTROL-FILES-SHA256.json'].map(name=>sha256(path.join(f.backup,name)));
  assert.equal(verifyBackup(f.backup).audit.documents,1);
  assert.deepEqual(['SHA256-MANIFEST.json','CONTROL-FILES-SHA256.json'].map(name=>sha256(path.join(f.backup,name))),before);
});
for(const name of ['SHA256-MANIFEST.json','CONTROL-FILES-SHA256.json'])test(`${name} rejects conflicts, malformed entries, duplicate aliases and unsafe paths`,()=>{
  const f=fixture(),original=readJson(path.join(f.backup,name)) as ManifestEntry[];
  const invalid=[
    {...original[0],path:'different-file',size:original[0].bytes},
    {...original[0],path:original[0].file,size:original[0].bytes},
    {path:original[0].file,size:-1,sha256:original[0].sha256},
    {path:original[0].file,size:1.5,sha256:original[0].sha256},
    {path:original[0].file,size:Number.MAX_SAFE_INTEGER+1,sha256:original[0].sha256},
    {path:original[0].file,size:original[0].bytes,sha256:'invalid'},
    {path:original[0].file,bytes:original[0].bytes,sha256:original[0].sha256},
    {...original[0],unknown:true},
    ...['../VERIFICATION-RESULT.json','/absolute','C:\\absolute','\\\\server\\share','file:stream','./VERIFICATION-RESULT.json','folder/../file','folder//file',''].map(file=>({...original[0],file})),
  ];
  for(const entry of invalid){rewriteManifest(f.backup,name,()=>[entry,...original.slice(1)]);assert.throws(()=>verifyBackup(f.backup));}
  rewriteManifest(f.backup,name,()=>[...original,{path:original[0].file.replaceAll('/','\\'),size:original[0].bytes,sha256:original[0].sha256}]);
  assert.throws(()=>verifyBackup(f.backup),/MANIFEST_PATH/);
});
test('control manifest verifies sizes and hashes of every control file, not just the recovery report',()=>{
  const f=fixture(),extra=path.join(f.backup,'extra.json');writeFileSync(extra,'{}');
  const original=readJson(path.join(f.backup,'CONTROL-FILES-SHA256.json')) as ManifestEntry[];
  const entry={path:'extra.json',size:2,sha256:sha256(extra)};
  save(path.join(f.backup,'CONTROL-FILES-SHA256.json'),[...original,entry]);assert.equal(verifyBackup(f.backup).audit.documents,1);
  writeFileSync(extra,'[]');assert.throws(()=>verifyBackup(f.backup),/PAYLOAD_HASH/);
  writeFileSync(extra,'{}');save(path.join(f.backup,'CONTROL-FILES-SHA256.json'),[...original,{...entry,size:3}]);assert.throws(()=>verifyBackup(f.backup),/PAYLOAD_HASH/);
});
function stage(f=fixture()) {prepareCandidate(f.root,f.target,f.backup);return f;}
function maintenance(f:ReturnType<typeof fixture>,ports=[3000,3001]) {
  const m=readJson(path.join(f.root,'maintenance.template.json')) as Record<string,unknown>;
  const file=path.join(f.root,'confirmed-maintenance.json');
  save(file,{...m,operatorConfirmed:true,writersStopped:true,agentsStopped:true,servicesStopped:true,sourceUnchangedSinceBackup:true,confirmedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString(),ports});return file;
}
function audit(file:string){const db=new DatabaseSync(file,{readOnly:true});try{return auditDatabase(db);}finally{db.close();}}
function cli(args:string[],extraEnv:Record<string,string>={}) {
  return spawnSync(process.execPath,['--conditions=react-server','--import','tsx','scripts/rag-migrate.ts',...args],{encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,...extraEnv}});
}
function args(f:ReturnType<typeof fixture>){return ['--root',f.root,'--target',f.target,'--backup',f.backup];}
function childDeployment(f:ReturnType<typeof fixture>,script:string,mode='read-only'){
  return spawnSync(process.execPath,['--conditions=react-server','--import','tsx','-e',script],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,MOYU_RAG_DEPLOYMENT:path.join(f.root,'deployment.json'),MOYU_RAG_ACCESS:mode}});
}

test('CLI requires explicit paths; live production path is rejected before database access, even with execute',()=>{
  assert.notEqual(cli([]).status,0);
  const r=cli(['--target',path.resolve('.moyu/knowledge.sqlite'),'--root',base,'--backup',base,'--execute']);
  assert.notEqual(r.status,0);assert.match(r.stderr,/LIVE_PRODUCTION_PATH_FORBIDDEN/);assert.ok(!r.stderr.includes(' at '));
  assert.throws(()=>safePath('relative.sqlite'),/ABSOLUTE/);
});
test('hardlinks, junctions, aliases and wrong target layouts fail closed',()=>{
  const f=fixture(),original=path.join(f.home,'plain'),alias=path.join(f.home,'hardlink');writeFileSync(original,'virtual');linkSync(original,alias);
  assert.throws(()=>safePath(alias),/HARDLINK/);
  const junction=path.join(f.home,'junction');symlinkSync(f.backup,junction,'junction');assert.throws(()=>safePath(path.join(junction,'payload')),/SYMLINK/);
  assert.throws(()=>prepareCandidate(f.root,path.join(f.home,'wrong.sqlite'),f.backup),/LAYOUT/);
});
test('prepare copies independently; default dry-run changes no target bytes and execute requires fresh maintenance',()=>{
  const f=stage(),before=sha256(f.target),r=cli(args(f));
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.trim()).status,'dry-run');assert.equal(sha256(f.target),before);
  assert.throws(()=>runMigrationTool({...f,execute:true}),/MAINTENANCE_CONFIRMATION/);
  assert.throws(()=>runMigrationTool({...f,execute:true,maintenance:path.join(f.root,'maintenance.template.json')}));
  const file=maintenance(f),m=readJson(file) as Record<string,unknown>;save(file,{...m,expiresAt:new Date(Date.now()-500).toISOString()});
  assert.throws(()=>runMigrationTool({...f,execute:true,maintenance:file}),/EXPIRED/);assert.equal(audit(f.target).schemaVersion,0);
});
test('stale, corrupted and unverified backups are rejected',()=>{
  const f=fixture(),report=path.join(f.backup,'VERIFICATION-RESULT.json');
  const data=readJson(report) as Record<string,unknown>;save(report,{...data,completedAt:new Date(Date.now()-25*3600000).toISOString()});refreshControls(f.backup);
  assert.throws(()=>verifyBackup(f.backup),/STALE/);
  save(report,{...data,modelApplicationProbe:'NOT TESTED'});refreshControls(f.backup);assert.throws(()=>verifyBackup(f.backup));
  save(report,data);refreshControls(f.backup);writeFileSync(path.join(f.backup,'payload','v6.0-source.zip'),'damaged');assert.throws(()=>verifyBackup(f.backup),/PAYLOAD_HASH/);
});
test('actual transaction migration preserves original IDs, raw bytes, chunks, vectors and historic citations; repeat is a no-op',()=>{
  const f=stage(),before=audit(f.target),m=maintenance(f);
  const first=runMigrationTool({...f,execute:true,maintenance:m});assert.equal(first.status,'migrated');assert.equal(audit(f.target).digest,before.digest);
  const s=new KnowledgeStore(f.target);try{
    assert.equal(readStoredSource(s,f.id,f.chunk).documentId,f.id);
    const current=s.get(f.id);s.setState(f.id,'inactive',current.revision!);
    assert.equal(s.search(Array.from({length:384},(_,i)=>i===0?1:0),5,.88).length,0);
  }finally{s.close();}
  assert.equal(runMigrationTool({...f,execute:true,maintenance:m}).status,'already-migrated');
  const reader=new KnowledgeStore(f.target,{readOnly:true});try{assert.equal(reader.get(f.id).state,'inactive');assert.equal(readStoredSource(reader,f.id,f.chunk).chunkId,f.chunk);}finally{reader.close();}
});
for(const phase of ['copied','rebuilt','validated'])test(`injected ${phase} failure fully rolls back original records and schema`,()=>{
  const f=stage(),before=audit(f.target),m=maintenance(f);
  assert.throws(()=>runMigrationTool({...f,execute:true,maintenance:m,checkpoint:p=>{if(p===phase)throw new Error('fictional injected failure');}}),/injected/);
  assert.deepEqual(audit(f.target),before);assert.ok(!existsSync(path.join(f.root,'.migration.lock')));
});
test('occupied SQLite connection and listening port block execution',async()=>{
  const f=stage(),m=maintenance(f),reader=new DatabaseSync(f.target,{readOnly:true});
  try{reader.prepare('SELECT count(*) FROM documents').get();assert.throws(()=>runMigrationTool({...f,execute:true,maintenance:m}),/OS_PROBE/);}finally{reader.close();}
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port;
  try{const withPort=maintenance(f,[3000,3001,port]);assert.throws(()=>runMigrationTool({...f,execute:true,maintenance:withPort}),/OS_PROBE/);}finally{server.close();}
  assert.equal(audit(f.target).schemaVersion,0);
});
test('nonempty WAL/SHM is preserved and blocks writes; unexpected data edits are rejected',()=>{
  const f=stage(),m=maintenance(f),wal=f.target+'-wal';writeFileSync(wal,'fictional unexpected sidecar');
  assert.throws(()=>runMigrationTool({...f,execute:true,maintenance:m}),/NONEMPTY_WAL/);assert.equal(readFileSync(wal,'utf8'),'fictional unexpected sidecar');unlinkSync(wal);
  const db=new DatabaseSync(f.target);db.prepare('UPDATE documents SET name=?').run('虚构外部编辑.txt');db.close();
  assert.throws(()=>runMigrationTool(f),/DIFFERS_FROM_BACKUP/);
});
test('killed migration leaves a visible lock; explicit recovery rolls back hot journal before a new migration',async()=>{
  const f=stage(),m=maintenance(f),before=audit(f.target);
  const child=spawn(process.execPath,['--conditions=react-server','--import','tsx','scripts/rag-migrate.ts',...args(f),'--execute','--maintenance',m,'--pause','rebuilt'],{windowsHide:true,env:{...process.env,MOYU_MIGRATION_TESTING:'1'}});
  let output='';
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Test migration did not reach pause'));},30000);
    child.stdout.on('data',data=>{output+=String(data);if(output.includes('"event":"paused"')){clearTimeout(timeout);resolve();}});
    child.once('exit',code=>{if(!output.includes('"event":"paused"')){clearTimeout(timeout);reject(new Error('Test child exited '+code));}});
  });
  assert.ok(existsSync(path.join(f.root,'.migration.lock')));assert.ok(existsSync(f.target+'-journal'));
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  assert.throws(()=>runMigrationTool(f),/LOCK_EXISTS/);
  assert.equal(runMigrationTool({...f,recover:true,maintenance:m}).status,'recovered');
  assert.deepEqual(audit(f.target),before);
  assert.equal(runMigrationTool({...f,execute:true,maintenance:m}).status,'migrated');
});
test('receipt-bound deployment defaults to read-only and blocks chat/Agent/mutations; explicit cutover is separate',()=>{
  const f=stage(),m=maintenance(f);runMigrationTool({...f,execute:true,maintenance:m});
  const ro=childDeployment(f,`const {getStore}=require('./src/lib/rag/store.ts');const {runtimeRequestReason}=require('./src/lib/rag/deployment.ts');const s=getStore();if(s.list().length!==1)process.exit(2);let blocked=false;try{s.db.exec("UPDATE knowledge_documents SET state='inactive'")}catch{blocked=true}if(!blocked||!runtimeRequestReason(new Request('http://localhost/api/agent',{method:'POST'})))process.exit(3);s.close();console.log('READ_ONLY_PASS')`);
  assert.equal(ro.status,0,ro.stderr);assert.match(ro.stdout,/READ_ONLY_PASS/);
  const missingApproval=childDeployment(f,`require('./src/lib/rag/config.ts')`,'approved-write');assert.notEqual(missingApproval.status,0);
  const id=(readJson(path.join(f.root,'migration-target.json')) as {targetId:string}).targetId;
  assert.equal(runMigrationTool({...f,maintenance:m,activate:id}).status,'activation-approved');
  const active=childDeployment(f,`const {getStore}=require('./src/lib/rag/store.ts');const s=getStore();const d=s.list()[0];s.setState(d.id,'inactive',d.revision);s.close();console.log('VIRTUAL_WRITE_PASS')`,'approved-write');
  assert.equal(active.status,0,active.stderr);assert.match(active.stdout,/VIRTUAL_WRITE_PASS/);
  assert.throws(()=>runMigrationTool(f),/TARGET_ALREADY_ACTIVATED/);
});
test('maintenance mode refuses new ordinary chat requests before any paid transport',async()=>{
  const previous=process.env.MOYU_MAINTENANCE;process.env.MOYU_MAINTENANCE='1';
  try{const result=await chatPost(new Request('http://localhost/api/chat',{method:'POST'}));assert.equal(result.status,503);}
  finally{if(previous===undefined)delete process.env.MOYU_MAINTENANCE;else process.env.MOYU_MAINTENANCE=previous;}
});
test('unknown schema, altered receipt and mistyped fault phases cannot proceed',()=>{
  const f=stage(),m=maintenance(f);
  const invalid=cli([...args(f),'--execute','--fault','typo'],{MOYU_MIGRATION_TESTING:'1'});assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/FAULT_PHASE_INVALID/);
  const db=new DatabaseSync(f.target);db.exec('PRAGMA user_version=9');db.close();
  assert.throws(()=>runMigrationTool({...f,execute:true,maintenance:m}),/SCHEMA_VERSION_UNSUPPORTED/);
  const restoreVersion=new DatabaseSync(f.target);restoreVersion.exec('PRAGMA user_version=0');restoreVersion.close();
  runMigrationTool({...f,execute:true,maintenance:m});
  const receipt=path.join(f.root,'migration-receipt.json'),value=readJson(receipt) as Record<string,unknown>;
  save(receipt,{...value,targetId:randomUUID()});
  const result=childDeployment(f,`require('./src/lib/rag/config.ts')`);assert.notEqual(result.status,0);
});


test('V7 read-only bridge enables report retrieval but never database mutations or ordinary Agent calls',()=>{
  const f=stage(),m=maintenance(f);runMigrationTool({...f,execute:true,maintenance:m});
  const script=`process.env.MOYU_RAG_READONLY_BASELINE='4243fc5fd1a0386d45d81bdf7e5e85acdc448e01';const {getStore}=require('./src/lib/rag/store.ts');const {runtimeRequestReason}=require('./src/lib/rag/deployment.ts');const s=getStore();if(runtimeRequestReason(new Request('http://localhost/api/reports',{method:'POST'})))process.exit(2);if(!runtimeRequestReason(new Request('http://localhost/api/agent',{method:'POST'}))||!runtimeRequestReason(new Request('http://localhost/api/comparison',{method:'POST'})))process.exit(3);let blocked=false;try{s.db.exec("UPDATE knowledge_documents SET state='inactive'")}catch{blocked=true}if(!blocked)process.exit(4);s.close();console.log('BRIDGE_READONLY_PASS')`;
  const ro=childDeployment(f,script);assert.equal(ro.status,0,ro.stderr);assert.match(ro.stdout,/BRIDGE_READONLY_PASS/);
});
test('V7 baseline opt-in cannot bypass a forged deployment fingerprint',()=>{
  const f=stage(),m=maintenance(f);runMigrationTool({...f,execute:true,maintenance:m});const descriptor=path.join(f.root,'deployment.json');save(descriptor,{...readJson(descriptor) as object,codeFingerprint:'0'.repeat(64)});
  const result=childDeployment(f,`process.env.MOYU_RAG_READONLY_BASELINE='4243fc5fd1a0386d45d81bdf7e5e85acdc448e01';require('./src/lib/rag/config.ts')`);assert.notEqual(result.status,0);assert.match(result.stderr,/DEPLOYMENT_CODE_OR_TARGET_MISMATCH/);
});


test('activated production read-only bridge permits chat and Agent reads while all document writes remain blocked',()=>{
  const f=stage(),m=maintenance(f);runMigrationTool({...f,execute:true,maintenance:m});const id=(readJson(path.join(f.root,'migration-target.json')) as {targetId:string}).targetId;runMigrationTool({...f,maintenance:m,activate:id});
  const script=`process.env.MOYU_RAG_READONLY_BASELINE='4243fc5fd1a0386d45d81bdf7e5e85acdc448e01';const {getStore}=require('./src/lib/rag/store.ts');const {getDeployment,runtimeRequestReason}=require('./src/lib/rag/deployment.ts');const s=getStore();if(!getDeployment().activated||!getDeployment().readOnly)process.exit(2);for(const p of ['/api/chat','/api/agent','/api/reports','/api/knowledge/search','/api/comparison'])if(runtimeRequestReason(new Request('http://localhost'+p,{method:'POST'})))process.exit(3);for(const method of ['POST','DELETE','PATCH','PUT'])if(!runtimeRequestReason(new Request('http://localhost/api/knowledge/documents',{method})))process.exit(4);let blocked=false;try{s.db.exec("UPDATE knowledge_documents SET state='inactive'")}catch{blocked=true}if(!blocked||runtimeRequestReason(new Request('http://localhost/api/comparison'))||!runtimeRequestReason(new Request('http://localhost/api/comparison',{method:'DELETE'})))process.exit(5);process.env.MOYU_MAINTENANCE='1';if(!runtimeRequestReason(new Request('http://localhost/api/chat',{method:'POST'})))process.exit(6);s.close();console.log('ACTIVATED_READS_ONLY_PASS')`;
  const ro=childDeployment(f,script);assert.equal(ro.status,0,ro.stderr);assert.match(ro.stdout,/ACTIVATED_READS_ONLY_PASS/);
});
test('invalid production activation is rejected even for read-only access',()=>{
  const f=stage(),m=maintenance(f);runMigrationTool({...f,execute:true,maintenance:m});save(path.join(f.root,'activation.json'),{targetId:randomUUID(),receiptSha256:'0'.repeat(64),approvedAt:new Date().toISOString()});const result=childDeployment(f,`require('./src/lib/rag/config.ts')`);assert.notEqual(result.status,0);assert.match(result.stderr,/DEPLOYMENT_WRITE_APPROVAL_FAILED/);
});
test('activated read-only chat and Agent reach input validation without paid HTTP',()=>{
  const f=stage(),m=maintenance(f);runMigrationTool({...f,execute:true,maintenance:m});const id=(readJson(path.join(f.root,'migration-target.json')) as {targetId:string}).targetId;runMigrationTool({...f,maintenance:m,activate:id});
  const script=`process.env.MOYU_RAG_READONLY_BASELINE='4243fc5fd1a0386d45d81bdf7e5e85acdc448e01';globalThis.fetch=async()=>{throw Error('Paid HTTP forbidden')};(async()=>{for(const p of ['chat','agent']){const {POST}=require('./src/app/api/'+p+'/route.ts');const r=await POST(new Request('http://localhost/api/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[]})}));if(r.status!==400)process.exit(3)}console.log('ENTRY_VALIDATION_PASS')})()`;
  const result=childDeployment(f,script);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/ENTRY_VALIDATION_PASS/);
});
