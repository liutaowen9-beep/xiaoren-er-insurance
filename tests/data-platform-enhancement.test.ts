import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,writeFileSync,readdirSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SCHEMA_SQL,PlatformStore} from '../src/lib/data-platform/store';
import {upgradeObservation,restoreObservationBackup} from '../src/lib/data-platform/migrations/002-observation';
import {withObservationStore,traceTask,traceGenerator,traceRetrieval,recordLifecycle,observationHealth} from '../src/lib/data-platform/telemetry';
import {PlatformAnalytics,monitorQuery} from '../src/lib/data-platform/analytics';
import {createMonitorApi} from '../src/lib/data-platform/monitor-api';
import {scanKnowledge,fingerprints,sha} from '../src/lib/data-platform/scanner';
import {KnowledgeStore} from '../src/lib/rag/store';
import {retrieve} from '../src/lib/rag/service';
import {searchNeeds} from '../src/lib/needs/retrieval';
import {runAgent} from '../src/lib/agent/orchestrator';
import {generateReport} from '../src/lib/reports/workflow';
import {analyzeCustomer} from '../src/lib/needs/workflow';

const signal=()=>new AbortController().signal;
function fixture(){
  mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/observation-')),source=path.join(root,'source');mkdirSync(source);
  const libraryId=randomUUID();writeFileSync(path.join(source,'local-library.json'),JSON.stringify({id:libraryId}));
  const knowledge=new KnowledgeStore(path.join(source,'knowledge.sqlite'),{management:true}),platform=new PlatformStore(path.join(root,'meta','platform.sqlite'));
  function add(name='虚构产品资料.txt'){
    const id=randomUUID(),raw=Buffer.from('产品名称：虚构医疗产品。保障责任：住院医疗费用报销。保险期间：一年。');knowledge.insert({id,name,extension:'.txt',raw,hash:sha(raw)});
    const vector=Array(384).fill(0);vector[0]=1;knowledge.commitIndex(id,[{id:randomUUID(),documentId:id,sequence:0,text:raw.toString(),page:2}],[vector]);return id;
  }
  async function scan(){const token=platform.lease();try{return platform.publish(await scanKnowledge(knowledge.file,libraryId,signal(),path.join(root,'scratch')),token,signal());}finally{platform.release(token);}}
  const analytics=new PlatformAnalytics(platform),observe=<T>(fn:()=>T)=>withObservationStore(platform.file,fn);
  const close=async()=>{knowledge.close();platform.close();await rm(root,{recursive:true,force:true});};
  return {root,source,libraryId,knowledge,platform,analytics,add,scan,observe,close};
}
test('schema 1→2 backup, traceable receipt, repeated upgrade and restored schema 1 preserve existing metadata',async()=>{
  mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/platform-upgrade-')),file=path.join(root,'platform.sqlite'),db=new DatabaseSync(file);
  try{db.exec(SCHEMA_SQL);db.prepare('INSERT INTO data_sources VALUES(?,?,?)').run('synthetic-source','sqlite-knowledge',1);upgradeObservation(db,file);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(db.prepare('SELECT count(*) n FROM data_sources').get()!.n,1);assert.equal(db.prepare('SELECT count(*) n FROM platform_migrations').get()!.n,1);upgradeObservation(db,file);assert.equal(readdirSync(path.join(root,'backups')).filter(f=>f.endsWith('.sqlite')).length,1);const backup=path.join(root,'backups',readdirSync(path.join(root,'backups')).find(f=>f.endsWith('.sqlite'))!);const target=path.join(root,'restore','platform.sqlite');restoreObservationBackup(backup,target);const restored=new DatabaseSync(target,{readOnly:true});try{assert.equal(restored.prepare('PRAGMA user_version').get()!.user_version,1);assert.equal(restored.prepare('SELECT count(*) n FROM data_sources').get()!.n,1);}finally{restored.close();}assert.throws(()=>restoreObservationBackup(backup,target),/尚不存在/);}finally{db.close();await rm(root,{recursive:true,force:true});}
});
test('injected observation migration failure rolls back DDL, version and preserves the verified backup',async()=>{
  mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/platform-upgrade-fault-')),file=path.join(root,'platform.sqlite'),db=new DatabaseSync(file);
  try{db.exec(SCHEMA_SQL);assert.throws(()=>upgradeObservation(db,file,()=>{throw Error('fault');}));assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,1);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='observed_runs'").get()!.n,0);assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.ok(readdirSync(path.join(root,'backups')).some(f=>f.endsWith('.sqlite')));upgradeObservation(db,file);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);}finally{db.close();await rm(root,{recursive:true,force:true});}
});
test('real run boundaries capture actual nodes/tools and never persist customer inputs or event summaries',async()=>{
  const f=fixture();try{const runId=randomUUID(),stepId=randomUUID();const marker='PRIVATE-CUSTOMER-13812345678';await f.observe(()=>traceTask({type:'needs',engine:'mock',store:f.knowledge,runId},signal(),async emit=>{emit({type:'step',stepId,stage:'search',status:'RUNNING',at:Date.now(),note:marker});emit({type:'step',stepId,stage:'search',status:'SUCCESS',at:Date.now(),elapsedMs:1,note:marker});return {status:'PARTIAL_SUCCESS'};}));const run=f.analytics.runDetail(runId);assert.equal(run.run.status,'partial');assert.equal(run.steps.length,1);assert.equal(run.run.input_tokens,null);assert.equal(run.run.model,null);assert.ok(!JSON.stringify(run).includes(marker));assert.equal(f.analytics.runStats(monitorQuery.parse({})).failureRate,0);}finally{await f.close();}
});
test('failure, cancellation, interrupted stream and stale running states never become false success',async()=>{
  const f=fixture();try{await assert.rejects(()=>f.observe(()=>traceTask({type:'agent',engine:'mock'},signal(),async()=>{throw Error('secret stack');})));const c=new AbortController();await assert.rejects(()=>f.observe(()=>traceTask({type:'needs',engine:'mock'},c.signal,async()=>{c.abort();throw c.signal.reason;})));await f.observe(async()=>{for await(const e of traceGenerator({type:'agent',engine:'mock'},signal(),async function*(){yield {type:'status'};})){void e;}});const states=f.analytics.runList(monitorQuery.parse({})).items.map(r=>r.status);assert.ok(states.includes('error'));assert.ok(states.includes('cancelled'));assert.ok(states.includes('unknown'));assert.ok(!JSON.stringify(f.analytics.runList(monitorQuery.parse({}))).includes('secret stack'));}finally{await f.close();}
});
test('observer database failure cannot change a business return value or emitted events',async()=>{
  const f=fixture();try{const bad=path.join(f.root,'bad');mkdirSync(bad);const file=path.join(bad,'platform.sqlite');writeFileSync(file,'damaged');const before=observationHealth().dropped;const result=await withObservationStore(file,()=>traceTask({type:'needs',engine:'mock'},signal(),async emit=>{emit({type:'step',stepId:randomUUID(),stage:'search',status:'SUCCESS',at:Date.now()});return 42;}));assert.equal(result,42);assert.ok(observationHealth().dropped>before);}finally{await f.close();}
});
test('concurrent AsyncLocalStorage scopes isolate different runs, modes and retrieval identities',async()=>{
  const f=fixture();try{f.add();await f.observe(()=>Promise.all(['mock','deepseek'].map(engine=>traceTask({type:'needs',engine,store:f.knowledge},signal(),async()=>{await searchNeeds('住院医疗',f.knowledge,signal(),async()=>[]);return {status:'SUCCESS'};}))));const runs=f.analytics.runList(monitorQuery.parse({}));assert.equal(runs.total,2);assert.notEqual(runs.items[0].id,runs.items[1].id);assert.equal(f.analytics.runList(monitorQuery.parse({mode:'mock'})).total,1);const requests=f.analytics.retrievalList(monitorQuery.parse({}));assert.equal(new Set(requests.items.map(r=>r.run_id)).size,2);assert.ok(requests.items.every(r=>r.library_id===f.libraryId));}finally{await f.close();}
});
test('actual scoped SQLite retrieval retains real hits, page/version and nested hybrid requests are not double-counted',async()=>{
  const f=fixture();try{f.add();await f.scan();await searchNeeds('《虚构产品资料.txt》概览',f.knowledge,signal(),retrieve);const before=await fingerprints(f.knowledge.file,signal());await f.observe(()=>traceTask({type:'needs',engine:'mock',store:f.knowledge},signal(),async()=>{const result=await searchNeeds('《虚构产品资料.txt》概览',f.knowledge,signal(),retrieve);assert.ok(result.sources.length);return {status:'PARTIAL_SUCCESS'};}));const requests=f.analytics.retrievalList(monitorQuery.parse({}));assert.equal(requests.total,1);const detail=f.analytics.retrievalDetail(requests.items[0].id);assert.ok(detail.hits.length);assert.equal(detail.hits[0].page,2);assert.equal(detail.hits[0].version,1);assert.equal(detail.children.length,1);assert.equal(detail.hits[0].score,null);assert.deepEqual(await fingerprints(f.knowledge.file,signal()),before);}finally{await f.close();}
});
test('query text is hashed, no-result/errors are distinct and unhit documents never enter lineage',async()=>{
  const f=fixture();try{f.add();await f.scan();const query='测试隐私13812345678与secret-token';await f.observe(async()=>{await traceRetrieval(query,5,f.knowledge,'test-profile',async()=>[],v=>v);await assert.rejects(()=>traceRetrieval(query,5,f.knowledge,'test-profile',async()=>{throw Error('sensitive body');},()=>[]));});const rows=f.analytics.retrievalList(monitorQuery.parse({}));assert.equal(rows.total,2);assert.ok(rows.items.some(r=>r.status==='empty'));assert.ok(rows.items.some(r=>r.status==='error'));assert.ok(!JSON.stringify(rows).includes(query));assert.ok(rows.items.every(r=>r.query_hash===sha(query)));assert.ok(!f.analytics.lineage(monitorQuery.parse({})).nodes.some(n=>n.kind==='retrieval'));}finally{await f.close();}
});
test('real evidence builds document/version/chunk/vector/retrieval lineage; clicks use safe metadata only',async()=>{
  const f=fixture();try{const id=f.add();await f.scan();await f.observe(()=>searchNeeds('住院医疗',f.knowledge,signal(),async()=>[]));const graph=f.analytics.lineage(monitorQuery.parse({}));for(const kind of ['document','version','chunk','vector','retrieval'])assert.ok(graph.nodes.some(n=>n.kind===kind),kind);assert.ok(graph.edges.every(e=>graph.nodes.some(n=>n.id===e.source)&&graph.nodes.some(n=>n.id===e.target)));assert.ok(!JSON.stringify(graph).includes('产品名称：虚构医疗产品'));assert.equal(graph.changes.length,0);f.observe(()=>recordLifecycle(f.knowledge,{id},'reindex_queued'));assert.equal(f.analytics.lineage(monitorQuery.parse({})).changes[0].action,'reindex_queued');}finally{await f.close();}
});
test('quality scoring uses all statuses including unknown and reports old/empty/orphan metadata honestly',async()=>{
  const f=fixture();try{const first=f.add();await f.scan();assert.equal(f.analytics.quality().score,100);f.knowledge.db.prepare("UPDATE knowledge_documents SET state='archived'").run();f.knowledge.db.prepare('DELETE FROM chunks WHERE document_id=?').run(first);await f.scan();const q=f.analytics.quality();assert.ok(q.score!==null&&q.score<100);assert.equal(q.metrics?.nonRetrievable,1);assert.equal(q.metrics?.emptyContentVersions,1);assert.equal(q.metrics?.orphanChunks,0);assert.ok(q.checks.some(c=>c.result==='UNKNOWN'));assert.equal(q.trend.length,2);assert.ok(q.formula.includes('UNKNOWN'));}finally{await f.close();}
});
test('source scope prevents cloned external IDs from linking to another library',async()=>{
  const f=fixture();try{f.add();await f.scan();await f.observe(()=>traceRetrieval('test',5,{},'test-profile',async()=>[{number:1,documentId:randomUUID(),chunkId:randomUUID(),fileName:'not persisted',text:'not persisted',score:.9}],v=>v));assert.ok(!f.analytics.lineage(monitorQuery.parse({})).nodes.some(n=>n.kind==='retrieval'));assert.equal(f.analytics.retrievalList(monitorQuery.parse({})).items[0].library_id,null);}finally{await f.close();}
});
test('monitor API rejects remote, cross-site, invalid IDs, duplicate filters and arbitrary paths',async()=>{
  const api=createMonitorApi(()=>{throw Error('not opened');});assert.equal((await api(new Request('http://remote.test/api'),'runs')).status,403);assert.equal((await api(new Request('http://localhost/api',{headers:{origin:'http://evil.test'}}),'runs')).status,403);for(const url of ['http://localhost/api?pageSize=101','http://localhost/api?path=C:/private','http://localhost/api?page=1&page=2'])assert.equal((await api(new Request(url),'runs')).status,400);assert.equal((await api(new Request('http://localhost/api'),'run','../private')).status,400);
});
test('all monitor APIs have empty states, bounded pagination and unknown metrics instead of synthetic scores',async()=>{
  const f=fixture();try{const api=createMonitorApi(()=>new PlatformStore(f.platform.file));for(const op of ['runs','run-stats','retrievals','retrieval-stats','quality-analysis','lineage'] as const){const r=await api(new Request('http://localhost/api'),op);assert.equal(r.status,200);const value=await r.json();if(op==='run-stats'){assert.equal(value.averageMs,null);assert.equal(value.failureRate,null);}if(op==='quality-analysis')assert.equal(value.score,null);}assert.equal((await api(new Request('http://localhost/api'),'run',randomUUID())).status,404);}finally{await f.close();}
});
test('real LangGraph calculator execution reaches observer without changing the original stream',async()=>{
  const f=fixture();try{let call=0;const events:unknown[]=[];const requestModel=async()=>{const message=call++===0?{tool_calls:[{index:0,id:'calculation',type:'function',function:{name:'calculator',arguments:'{"expression":"20*399*0.9"}'}}]}:{content:'结果为7182。'};return new ReadableStream<Uint8Array>({start(c){const enc=new TextEncoder();c.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:message,finish_reason:null}]})+'\n\n'));c.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:{},finish_reason:call===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n'));c.close();}});};await f.observe(async()=>{for await(const e of runAgent([{role:'user',content:'计算20*399*0.9'}],{store:null,signal:signal(),requestModel,graphEvents:true}))events.push(e);});assert.ok(events.some(e=>(e as {type:string}).type==='done'));const run=f.analytics.runList(monitorQuery.parse({})).items[0],detail=f.analytics.runDetail(run.id);assert.equal(run.status,'success');assert.ok(detail.steps.some(s=>s.name==='calculator'&&s.status==='success'));assert.ok(detail.steps.some(s=>s.kind==='node'));assert.equal(run.mode,'test-adapter');}finally{await f.close();}
});
test('real report graph records completed steps and actual adopted citations without storing private excerpts',async()=>{
  const f=fixture();try{f.add();const report=await f.observe(()=>generateReport({topic:'《虚构产品资料.txt》概览',type:'knowledge',requirements:'只总结依据',useKnowledge:true,formats:['docx']},{store:f.knowledge,signal:signal(),emit:()=>{},model:async(stage,input,outline,sources)=>stage==='outline'?{headings:['资料摘要']}:{title:'虚构报告',abstract:'虚构报告摘要',sections:[{heading:'资料摘要',paragraphs:[{text:'资料有住院医疗费用信息。',sources:sources.map(s=>s.number)}]}],conclusion:'请核实条款'}}));assert.ok(report);const run=f.analytics.runList(monitorQuery.parse({})).items[0];const detail=f.analytics.runDetail(run.id);assert.ok(detail.steps.length>0);assert.ok(detail.citations.length>0);assert.ok(!JSON.stringify(detail).includes('产品名称：虚构医疗产品')); }finally{await f.close();}
});
test('customer-needs graph records actual insufficient/partial outcome without inventing product evidence',async()=>{
  const f=fixture();try{const result=await f.observe(()=>analyzeCustomer({profile:{needs:'了解医疗保障'},engine:'mock'},{store:f.knowledge,signal:signal(),emit:()=>{},search:async()=>[]}));const run=f.analytics.runList(monitorQuery.parse({})).items[0];assert.equal(run.type,'needs');assert.equal(run.status,result.status==='INSUFFICIENT'?'insufficient':'partial');assert.ok(f.analytics.runDetail(run.id).steps.some(s=>s.name==='search'));assert.equal(f.analytics.retrievalList(monitorQuery.parse({})).total,0);}finally{await f.close();}
});
test('deleted assets retain historical lineage and operation history without becoming current evidence',async()=>{
  const f=fixture();try{const id=f.add();const before=await f.scan(),external=before.manifest.assets[0].id;f.knowledge.delete(id,f.knowledge.get(id).revision);f.observe(()=>recordLifecycle(f.knowledge,{id},'deleted'));await f.scan();const history=f.analytics.lineage(monitorQuery.parse({assetId:assetKeyForTest(f.libraryId,external)}));assert.equal(history.historical,true);assert.ok(history.nodes.some(n=>n.kind==='document'));assert.ok(history.changes.some(c=>c.action==='deleted'));assert.ok(history.notice?.includes('历史快照'));}finally{await f.close();}
});
function assetKeyForTest(source:string,id:string){return sha(JSON.stringify([source,id]));}
