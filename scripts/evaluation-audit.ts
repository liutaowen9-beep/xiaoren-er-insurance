/** Explicit local-only read audit. Never calls a paid model, KnowledgeStore on source, or business write APIs. */
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
async function main(){
  const registration=JSON.parse(readFileSync('tmp/reports/local-knowledge.json','utf8'));
  if(typeof registration.root!=='string')throw Error('Registered library missing');
  process.env.MOYU_RAG_LOCAL_ROOT=registration.root;
  const {resolveSource}=await import('../src/lib/data-platform/api');
  const {scanKnowledge,fingerprints,sha,canonical}=await import('../src/lib/data-platform/scanner');
  const {adapters,withDatabaseCopy}=await import('../src/lib/evaluation/readers');
  const {PLATFORM_FILE}=await import('../src/lib/data-platform/store');
  const {EvaluationStore}=await import('../src/lib/evaluation/store');
  const {file,libraryId}=await resolveSource(),signal=AbortSignal.timeout(120000),before=await fingerprints(file,signal);
  const scan=await scanKnowledge(file,libraryId,signal),counts={documents:scan.manifest.assets.length,versions:scan.manifest.versions.length,chunks:scan.manifest.members.length,vectors:scan.manifest.members.filter(c=>c.vectorHash!=='UNKNOWN').length};
  const current=scan.manifest.versions.filter(v=>v.isCurrent&&scan.manifest.assets.some(a=>a.currentVersionId===v.id&&a.state==='active'));
  const retrieval=await adapters.rag(signal,async session=>{
    const results=[];for(const doc of current.slice(0,2)){const hits=await session.search('总结'+doc.name,5,signal);results.push({hitCount:hits.length,expectedDocumentHit:hits.some(h=>h.documentId===doc.id),allVersionsValid:session.validate(hits)});}
    return {modelNotCalled:true,scope:'真实本地检索冒烟检查，不是带标注的质量评分或模型回答验收',corpusHash:session.corpusHash,results};
  });
  const observation=await withDatabaseCopy(PLATFORM_FILE,signal,async copy=>{const db=new DatabaseSync(copy,{readOnly:true});try{const row=db.prepare("SELECT id FROM observed_runs WHERE ended_at IS NOT NULL AND status<>'running' ORDER BY started_at DESC LIMIT 1").get();return {count:Number(db.prepare('SELECT count(*) n FROM observed_runs').get()!.n),sampleId:row?String(row.id):null};}finally{db.close();}});
  let replay:{status:string;stepCount:number;sourceMode:string}|null=null;
  if(observation.sampleId){const observed=await adapters.agent(observation.sampleId,signal);replay={status:observed.status,stepCount:observed.steps.length,sourceMode:observed.mode};}
  const after=await fingerprints(file,signal);if(canonical(before)!==canonical(after))throw Error('Source changed; audit not passed');
  const store=new EvaluationStore();let integrity;try{integrity=store.integrity();}finally{store.close();}
  const result={at:new Date().toISOString(),counts,knowledgeIntegrity:scan.checks.find(c=>c.rule==='integrity')?.result,sourceUnchanged:true,sourceFingerprint:sha(canonical(after)),retrieval,agentReplay:{availableRecords:observation.count,result:replay,status:replay?'PASS':'NOT TESTED-no-existing-terminal-record'},evaluationIntegrity:integrity};
  mkdirSync('tmp/reports/evaluation',{recursive:true});writeFileSync(path.resolve('tmp/reports/evaluation/read-only-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Read-only evaluation audit failed. No raw source/error content printed.');process.exitCode=1;});
