import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync,mkdtempSync } from 'node:fs';
import path from 'node:path';
import { unzipSync,strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { KnowledgeStore } from '../src/lib/rag/store';
import { EMBEDDING_DIMENSION } from '../src/lib/rag/model-spec';
import { retrieve } from '../src/lib/rag/service';
import { prepareTool } from '../src/lib/agent/tools';
import { missingFields,type ExtractModel } from '../src/lib/comparison/workflow';
import { FIELDS } from '../src/lib/comparison/types';
import { analyzeCustomer,type NeedsOptions } from '../src/lib/needs/workflow';
import { DEMO_PROFILE,inputSchema,profileSchema,eventSchema,needsSchema,type NeedsEvent } from '../src/lib/needs/types';
import { explicitNeeds,validateNeeds,missingInfo,mergeNeeds } from '../src/lib/needs/analysis';
import { readReportDownload } from '../src/lib/reports/storage';
import { reportSchema } from '../src/lib/reports/types';
import { checkDownloadEvidence, references } from '../src/lib/reports/evidence';
import { POST } from '../src/app/api/needs/route';
import { followUpQuestions, prioritizeNeeds } from '../src/lib/needs/analysis';
import { reviseNeedsReport, revisionSchema } from '../src/lib/needs/revise';
import { createConnection, type ConnectionResult } from '../src/lib/needs/connection';

test('model category normalization supports whitespace, case and explicit aliases but rejects unknown categories',()=>{
  for(const category of [' health ','HEALTH','ＨＥＡＬＴＨ','住院医疗费用',' 医疗保障 '])assert.equal(needsSchema.parse({needs:[{category,quote:'住院医疗'}]}).needs[0].category,'health');
  assert.equal(needsSchema.parse({needs:[{category:' Critical_Illness ',quote:'重大疾病'}]}).needs[0].category,'critical');
  assert.ok(!needsSchema.safeParse({needs:[{category:'invented-risk-score',quote:'医疗'}]}).success);
});
test('same-category merge preserves every distinct original quote and its communication priority',()=>{
  const profile=profileSchema.parse({needs:'先核对住院医疗费用，再了解门诊医疗费用，之后讨论养老安排。'});
  const parsed=needsSchema.parse({needs:[{category:'health',quote:'门诊医疗费用'},{category:' HEALTH ',quote:'住院医疗费用',quotes:['住院医疗费用']},{category:'医疗',quote:'门诊医疗费用'},{category:'pension',quote:'养老安排'}]});
  assert.throws(()=>validateNeeds(parsed.needs,profile),/重复分类【住院医疗费用】/);
  const merged=mergeNeeds(parsed.needs,profile);assert.equal(merged.length,2);assert.deepEqual(merged[0].quotes,['住院医疗费用','门诊医疗费用']);assert.equal(merged[0].quote,'住院医疗费用');validateNeeds(merged,profile);
  assert.deepEqual(prioritizeNeeds(merged,profile).map(p=>p.needIndex),[0,1]);
});
test('unsafe same-category evidence and too many categories fail without silently dropping requirements',()=>{
  const profile=profileSchema.parse({needs:'医疗、养老、意外和教育都需要了解。'});
  assert.throws(()=>mergeNeeds(needsSchema.parse({needs:[{category:'health',quote:'医疗'},{category:'health',quote:'不存在的医疗需求'}]}).needs,profile),/【住院医疗费用】.*无法安全合并/);
  assert.throws(()=>mergeNeeds(needsSchema.parse({needs:[{category:'health',quote:'医疗'},{category:'pension',quote:'养老'},{category:'accident',quote:'意外'},{category:'education',quote:'教育'}]}).needs,profile),/超过本次3类上限/);
});
test('merged model output runs normally, exports all quotes and does not accumulate categories across analyses',async()=>{
  const {store}=fixture(2);let calls=0;
  try{
    const profile={needs:'先了解住院医疗，然后核对门诊医疗，再讨论养老。'};
    const first=await analyzeCustomer({profile,engine:'mock'},{...options(store),needsModel:async()=>{calls++;return {needs:[{category:' HEALTH ',quote:'住院医疗'},{category:'health',quote:'门诊医疗'}]};}});
    assert.equal(calls,1);assert.equal(first.needs.length,1);assert.deepEqual(first.needs[0].quotes,['住院医疗','门诊医疗']);assert.ok(first.questions.length);assert.equal(first.priorities.length,1);
    assert.equal(first.report.references.length,2);assert.ok(first.candidates.every(c=>c.links.every(l=>l.needIndex===0&&first.report.references.some(r=>r.number===l.source&&r.documentId===c.product.documentId))));
    const word=readReportDownload({id:first.id,token:first.token,format:'docx'});const xml=strFromU8(unzipSync(word.bytes)['word/document.xml']);assert.match(xml,/住院医疗/);assert.match(xml,/门诊医疗/);
    const second=await analyzeCustomer({profile,engine:'mock'},{...options(store),search:async()=>[],needsModel:async()=>({needs:[{category:'养老',quote:'养老'}]})});
    assert.deepEqual(second.needs.map(n=>n.category),['pension']);assert.deepEqual(first.needs[0].quotes,['住院医疗','门诊医疗']);assert.equal(second.priorities.length,1);
  }finally{store.close();}
});
test('semantic schema failure gets exactly one repair and reports the specific category if repair is unsafe',async()=>{
  const {store}=fixture(0);try{
    let calls=0;const profile={needs:'关注住院医疗和门诊医疗。'};
    const recovered=await analyzeCustomer({profile,engine:'mock'},{...options(store),search:async()=>[],needsModel:async()=>{calls++;return calls===1?{needs:[{category:'health',quote:'不存在的医疗原话'}]}:{needs:[{category:'health',quote:'住院医疗'},{category:' HEALTH ',quote:'门诊医疗'}]};}});
    assert.equal(calls,2);assert.deepEqual(recovered.needs[0].quotes,['住院医疗','门诊医疗']);
    calls=0;const events:NeedsEvent[]=[];
    await assert.rejects(analyzeCustomer({profile,engine:'mock'},{...options(store,events),search:async()=>[],needsModel:async()=>{calls++;return {needs:[{category:'health',quote:'住院医疗'},{category:'health',quote:'伪造医疗原话'}]};}}),/【住院医疗费用】.*一次受控修复重试/);
    assert.equal(calls,2);assert.ok(events.some(e=>e.type==='step'&&e.stage==='needs'&&e.status==='FAILED'));assert.ok(!events.some(e=>e.type==='complete'));
  }finally{store.close();}
});

test('communication priorities preserve user wording order and never infer from income or age',()=>{
  const profile=profileSchema.parse({age:56,needs:'先了解养老，然后关注住院医疗。'}),needs=explicitNeeds(profile);
  assert.deepEqual(needs.map(n=>n.category),['pension','health']);
  const priorities=prioritizeNeeds(needs,profile);assert.deepEqual(priorities.map(p=>p.rank),[1,2]);assert.ok(priorities.every(p=>p.basis.includes('待客户确认')));
  assert.deepEqual(prioritizeNeeds([],profileSchema.parse({age:20,annualBudget:0})),[]);
});
test('missing information generates questions without turning missing coverage into a negative claim',()=>{
  const q=followUpQuestions(profileSchema.parse({needs:'医疗'}));assert.ok(q.some(t=>t.includes('预算')));assert.ok(q.some(t=>t.includes('已有保障')));assert.ok(q.some(t=>t.includes('职业')));assert.ok(q.length<=12);
  assert.ok(followUpQuestions(DEMO_PROFILE).length>=2);
});
test('report notes are editable with a valid token, preserve verified facts and replace earlier notes without changing citations',async()=>{
  const {store}=fixture();try{
    const original=await analyzeCustomer(raw(),options(store));const changed=await reviseNeedsReport({id:original.id,token:original.token,note:'虚构沟通备注：下一次核对职业类别。'},store,new AbortController().signal);
    assert.deepEqual(changed.report.references,original.report.references);assert.deepEqual(changed.report.content.sections.slice(0,-1),original.report.content.sections.slice(0,-1));assert.notEqual(changed.id,original.id);
    const again=await reviseNeedsReport({id:changed.id,token:changed.token,note:'虚构沟通备注：调整下一次沟通时间。'},store,new AbortController().signal);
    const notes=again.report.content.sections.at(-1)!.paragraphs.filter(p=>p.text.startsWith('用户补充（未核验）：'));assert.equal(notes.length,1);assert.deepEqual(notes[0].sources,[]);assert.ok(!JSON.stringify(again.report).includes('下一次核对职业类别'));
    const word=readReportDownload({id:again.id,token:again.token,format:'docx'});assert.match(strFromU8(unzipSync(word.bytes)['word/document.xml']),/调整下一次沟通时间/);
    const pdf=readReportDownload({id:again.id,token:again.token,format:'pdf'});assert.ok((await PDFDocument.load(pdf.bytes)).getPageCount()>0);
    await assert.rejects(reviseNeedsReport({id:original.id,token:'0'.repeat(64),note:'虚构备注'},store,new AbortController().signal));
    store.setState(original.report.references[0].documentId,'inactive',store.get(original.report.references[0].documentId).revision!);
    await assert.rejects(reviseNeedsReport({id:again.id,token:again.token,note:'来源失效不得重新导出'},store,new AbortController().signal));
    assert.ok(!revisionSchema.safeParse({id:original.id,token:original.token,note:'x'.repeat(1201)}).success);
  }finally{store.close();}
});

const settle=()=>new Promise(resolve=>setTimeout(resolve,8));
function connectionFixture(){const calls:{signal:AbortSignal;resolve:(r:Response)=>void;reject:(e:Error)=>void}[]=[];const client=createConnection(((_url:unknown,init:RequestInit)=>new Promise<Response>((resolve,reject)=>calls.push({signal:init.signal!,resolve,reject}))) as typeof fetch);return {client,calls};}
const connectionResponse=(eligible=11)=>Response.json({eligible,paidEnabled:false});
test('Strict Mode replay and unrelated effect reconnections share pending and successful initialization',async()=>{
  const {client,calls}=connectionFixture(),states:ConnectionResult[]=[];client.subscribe(0,()=>assert.fail('unsubscribed callback'))();const stop=client.subscribe(0,v=>states.push(v));assert.equal(calls.length,1);assert.equal(calls[0].signal.aborted,false);calls[0].resolve(connectionResponse());await settle();stop();
  for(let i=0;i<8;i++){const leave=client.subscribe(0,()=>{});await settle();leave();}assert.equal(calls.length,1);assert.equal(states.length,1);
});
test('cancelled initialization can reconnect and manual retry isolates stale responses',async()=>{
  const {client,calls}=connectionFixture(),states:ConnectionResult[]=[];client.subscribe(0,()=>{})();await settle();assert.ok(calls[0].signal.aborted);
  const old=client.subscribe(0,v=>states.push(v));const current=client.subscribe(1,v=>states.push(v));old();calls[2].resolve(connectionResponse(7));await settle();calls[1].resolve(connectionResponse(99));await settle();
  assert.equal(states.length,1);assert.ok('data' in states[0]&&states[0].data.eligible===7);assert.equal(states[0].id,3);current();
});
test('connection failure is not automatically retried and a new page has an independent initializer',async()=>{
  const {client,calls}=connectionFixture(),states:ConnectionResult[]=[];let leave=client.subscribe(0,v=>states.push(v));calls[0].reject(new Error('模拟断网'));await settle();leave();leave=client.subscribe(0,v=>states.push(v));await settle();assert.equal(calls.length,1);assert.ok('error' in states.at(-1)!);leave();
  leave=client.subscribe(1,v=>states.push(v));calls[1].resolve(connectionResponse());await settle();assert.ok('data' in states.at(-1)!);leave();
  const fresh=connectionFixture();fresh.client.subscribe(0,()=>{})();assert.equal(fresh.calls.length,1);await settle();assert.ok(fresh.calls[0].signal.aborted);
});

function fixture(count=2){
  mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/needs-')),store=new KnowledgeStore(path.join(root,'knowledge.sqlite'),{management:true});
  const ids=Array.from({length:count},(_,i)=>{const id=randomUUID(),text=`产品名称：虚构医疗资料${i+1}。\n产品类型：医疗保险。\n保障责任：依照虚构条款报销住院医疗费用。\n保险期间：一年。\n缴费期间：一年。\n产品特点：仅用于自动化测试。`;const raw=Buffer.from(text),v=Array(EMBEDDING_DIMENSION).fill(0);v[0]=1;store.insert({id,name:`虚构医疗${i+1}.txt`,extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,[{id:randomUUID(),documentId:id,sequence:0,text,page:i+1}],[v]);return id;});return {store,ids};
}
const model:ExtractModel=async(_name,sources)=>{const result=missingFields();for(const [key,label] of FIELDS)for(const source of sources){const quote=source.text.split('\n').find(t=>t.startsWith(label+'：'));if(quote){result[key]={status:'SUCCESS',value:quote,quote,source:source.number};break;}}return result;};
const search:NonNullable<NeedsOptions['search']>=async(_q,store)=>{const ids=store.list().filter(d=>store.isEligible(d.id)).map(d=>d.id).slice(0,3);return ids.length?retrieve(`《${store.get(ids[0]).name}》产品概述`,5,{list:()=>store.list().filter(d=>ids.includes(d.id)),get:id=>store.get(id),search:(v,k,t)=>store.search(v,k,t),isEligible:id=>store.isEligible(id),overviewSources:()=>store.overviewSources(ids,5)}):[];};
const raw=()=>({profile:{...DEMO_PROFILE},engine:'mock'});
const options=(store:KnowledgeStore,events:NeedsEvent[]=[]):NeedsOptions=>({store,signal:new AbortController().signal,emit:e=>events.push(e),search,productModel:model});

test('customer normal and partial input validate without requiring all fields; invalid or unconsented paid input is rejected',()=>{
  assert.ok(inputSchema.safeParse(raw()).success);assert.ok(profileSchema.safeParse({needs:'想了解住院医疗'}).success);assert.ok(profileSchema.safeParse({age:0}).success);
  for(const profile of [{},{age:101},{annualBudget:-1},{householdIncome:Infinity},{notes:'x'.repeat(1201)},{needs:'医疗',apiKey:'not permitted'}])assert.ok(!profileSchema.safeParse(profile).success);
  assert.ok(!inputSchema.safeParse({...raw(),engine:'deepseek'}).success);assert.ok(inputSchema.safeParse({...raw(),engine:'deepseek',consent:true}).success);
});

test('needs structure is supported by explicit user words and never inferred from demographics',()=>{
  const needs=explicitNeeds(DEMO_PROFILE);assert.ok(needs.length>0);validateNeeds(needs,DEMO_PROFILE);
  assert.deepEqual(explicitNeeds(profileSchema.parse({age:60,gender:'female'})),[]);
  assert.throws(()=>validateNeeds([{category:'health',quote:'不存在的住院需求'}],DEMO_PROFILE),/偏离/);
  assert.ok(missingInfo(profileSchema.parse({needs:'医疗'})).some(t=>t.includes('预算')));
});

test('LangGraph invokes real calculator and scoped retrieval adapter, links multiple genuine sources and exports editable Word and Chinese PDF',async()=>{
  const {store}=fixture(2),events:NeedsEvent[]=[];
  try{const result=await analyzeCustomer(raw(),options(store,events));assert.equal(result.candidates.length,2);assert.equal(result.status,'PARTIAL_SUCCESS');assert.equal(result.monthlyBudget,'1000.00');assert.equal(result.report.references.length,2);
    assert.ok(events.every(e=>eventSchema.safeParse(e).success));assert.ok(events.some(e=>e.type==='step'&&e.stage==='calculator'&&e.status==='SUCCESS'));assert.ok(events.some(e=>e.type==='step'&&e.stage==='knowledge_search'&&e.status==='SUCCESS'));
    for(const c of result.candidates){assert.ok(c.links.length);assert.match(c.budget,/未知|待核实/);for(const l of c.links)assert.equal(result.report.references.find(r=>r.number===l.source)!.documentId,c.product.documentId);}
    const word=readReportDownload({id:result.id,token:result.token,format:'docx'}),pdf=readReportDownload({id:result.id,token:result.token,format:'pdf'});const xml=strFromU8(unzipSync(word.bytes)['word/document.xml']);assert.match(xml,/w:tbl/);assert.match(xml,/客户基本情况/);assert.match(xml,/信息缺失/);assert.match(xml,/不是保费报价/);
    assert.ok((await PDFDocument.load(pdf.bytes)).getPageCount()>0);const parsed=await(await import('../src/lib/rag/parse')).parseDocument(pdf.bytes,'.pdf');assert.match(parsed.map(p=>p.text).join(''),/客户需求分析报告/);checkDownloadEvidence(store,result.report);
    assert.deepEqual(result.report.content.sections.map(s=>s.heading),['客户基本情况与需求摘要','核心保障需求、预算及约束','信息缺失及待确认事项','候选保险资料与产品匹配分析','产品之间的差异','原文证据与来源','风险提示','后续沟通建议与分析总结']);
  }finally{store.close();}
});

test('existing knowledge_search tool reads actual isolated documents without paying for a model',async()=>{
  const {store,ids}=fixture();try{const tool=prepareTool('knowledge_search',JSON.stringify({query:`《${store.get(ids[0]).name}》产品概述`,topK:5}),{store,allowed:new Set(ids),generate:async()=>{throw new Error('must not call model');}});const out=await tool.execute(new AbortController().signal);assert.ok(out.sources.length);assert.ok(out.sources.every(s=>s.documentId===ids[0]));}finally{store.close();}
});

test('partial profile with no explicit need skips unnecessary retrieval and model product extraction',async()=>{
  const {store}=fixture(),events:NeedsEvent[]=[];try{const result=await analyzeCustomer({profile:{age:35},engine:'mock'},{...options(store,events),needsModel:async()=>{throw new Error('must not infer needs');},search:async()=>{throw new Error('must not search');}});assert.equal(result.status,'INSUFFICIENT');assert.equal(result.candidates.length,0);assert.ok(result.missing.length>1);assert.ok(!events.some(e=>e.type==='step'&&e.stage==='search'));assert.equal(result.report.references.length,0);}finally{store.close();}
});

test('no relevant products gives explicit insufficient report with no fake candidates or references',async()=>{
  const {store}=fixture();try{const result=await analyzeCustomer(raw(),{...options(store),search:async()=>[]});assert.equal(result.status,'INSUFFICIENT');assert.deepEqual(result.candidates,[]);assert.deepEqual(result.report.references,[]);assert.match(result.report.content.abstract,/未找到足够/);}finally{store.close();}
});

test('Mock product fields remain insufficient rather than pretending to recommend a product',async()=>{
  const {store}=fixture();try{const result=await analyzeCustomer(raw(),{...options(store),productModel:undefined});assert.equal(result.status,'INSUFFICIENT');assert.ok(result.candidates.every(c=>!c.links.length));assert.ok(result.candidates.every(c=>c.product.fields.name.status==='NOT_PROVIDED'));}finally{store.close();}
});

test('inactive, archived and old versions are filtered; document changes invalidate existing report downloads',async()=>{
  const {store,ids}=fixture(3);try{store.setState(ids[0],'inactive',store.get(ids[0]).revision!);store.setState(ids[1],'archived',store.get(ids[1]).revision!);const result=await analyzeCustomer(raw(),options(store));assert.ok(result.report.references.every(r=>r.documentId===ids[2]));
    const original=store.get(ids[2]),bytes=Buffer.from('产品名称：虚构新版。\n产品类型：医疗保险。\n保障责任：按测试条款给付住院医疗费用保险金。');const next=store.replace(original.id,{name:'虚构新版.txt',extension:'.txt',raw:bytes,hash:createHash('sha256').update(bytes).digest('hex')},original.revision!);const v=Array(EMBEDDING_DIMENSION).fill(0);v[0]=1;store.commitIndex(next.id,[{id:randomUUID(),documentId:next.id,sequence:0,text:bytes.toString()}],[v]);assert.throws(()=>checkDownloadEvidence(store,result.report),/失效/);
    const updated=await analyzeCustomer(raw(),options(store));assert.ok(updated.report.references.every(r=>r.documentId===next.id&&r.version===2));
  }finally{store.close();}
});

test('unknown product identity, fabricated quotes and unrelated responsibilities cannot become matching evidence',async()=>{
  const {store}=fixture();try{const result=await analyzeCustomer(raw(),{...options(store),productModel:async(...args)=>{const fields=await model(...args) as ReturnType<typeof missingFields>;fields.name={status:'SUCCESS',value:'伪造产品名',quote:'伪造产品名',source:1};return fields;}});assert.equal(result.status,'INSUFFICIENT');assert.ok(result.candidates.every(c=>!c.links.length));assert.ok(!JSON.stringify(result).includes('伪造产品名'));}finally{store.close();}
});

test('malformed model output is bounded and a subsequent retry can recover normally',async()=>{
  const {store}=fixture(),events:NeedsEvent[]=[];let calls=0;try{await assert.rejects(analyzeCustomer(raw(),{...options(store,events),needsModel:async()=>{calls++;return '{broken';}}),/格式校验失败/);assert.equal(calls,2);assert.ok(events.some(e=>e.type==='step'&&e.stage==='needs'&&e.status==='FAILED'));assert.ok(!events.some(e=>e.type==='complete'));const recovered=await analyzeCustomer(raw(),options(store));assert.equal(recovered.status,'PARTIAL_SUCCESS');}finally{store.close();}
});

test('all candidate extraction failures stop report generation instead of exporting empty success',async()=>{
  const {store}=fixture(),events:NeedsEvent[]=[];try{await assert.rejects(analyzeCustomer(raw(),{...options(store,events),productModel:async()=>{throw new Error('simulated failure');}}),/全部失败/);assert.ok(events.some(e=>e.type==='step'&&e.stage==='extract'&&e.status==='FAILED'));assert.ok(!events.some(e=>e.type==='step'&&e.stage==='export'));}finally{store.close();}
});

test('cancellation prevents subsequent tools and report nodes',async()=>{
  const {store}=fixture(),abort=new AbortController(),events:NeedsEvent[]=[];try{await assert.rejects(analyzeCustomer(raw(),{...options(store,events),signal:abort.signal,search:async()=>{abort.abort();return [];}}));assert.ok(events.some(e=>e.type==='step'&&e.status==='CANCELLED'));assert.ok(!events.some(e=>e.type==='step'&&e.stage==='report'));}finally{store.close();}
});

test('API refuses cross-origin, invalid input and unconsented live analysis before touching models',async()=>{
  const request=(url:string,body:unknown)=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await POST(request('https://external.example/api/needs',raw()))).status,403);assert.equal((await POST(request('http://localhost/api/needs',{profile:{}}))).status,400);assert.equal((await POST(request('http://localhost/api/needs',{...raw(),engine:'deepseek',consent:false}))).status,400);
});

test('three candidates and maximum-length valid customer input are retained without silent report truncation',async()=>{
  const {store}=fixture(3);try{const profile={...DEMO_PROFILE,family:'虚构家庭情况。'.repeat(55),children:'虚构子女情况。'.repeat(55),occupation:'虚构职业。'.repeat(30),existingCoverage:'虚构已有保障情况。'.repeat(100),notes:'虚构补充说明。'.repeat(130)};assert.ok(profileSchema.safeParse(profile).success);const result=await analyzeCustomer({profile,engine:'mock'},options(store));assert.equal(result.candidates.length,3);const section=result.report.content.sections.find(s=>s.heading==='候选保险资料与产品匹配分析')!;for(const c of result.candidates)assert.ok(section.paragraphs.some(p=>p.text.includes(c.product.name)));assert.ok(result.report.content.sections[0].paragraphs.some(p=>p.text.includes(profile.notes)));}finally{store.close();}
});


test('download preview trimming matches the persisted schema while full-source SHA-256 remains strict',()=>{
  const {store}=fixture(0);try{const id=randomUUID(),text='字'.repeat(349)+' '+'虚构后续原文',raw=Buffer.from(text),chunk=randomUUID(),v=Array(EMBEDDING_DIMENSION).fill(0);v[0]=1;
    store.insert({id,name:'虚构摘要边界.txt',extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,[{id:chunk,documentId:id,sequence:0,text}],[v]);
    const sources=store.overviewSources([id],1),report=reportSchema.parse({engine:'mock',createdAt:new Date().toISOString(),limitations:[],references:references(store,sources),content:{title:'虚构测试报告',abstract:'边界验证',sections:[{heading:'测试',paragraphs:[{text:'虚构正文',sources:[1]}]}],conclusion:'仅为测试'}});
    assert.equal(report.references[0].excerpt.length,349);checkDownloadEvidence(store,report);
    store.db.prepare('UPDATE chunks SET text=? WHERE id=?').run(text+' ',chunk);
    assert.throws(()=>checkDownloadEvidence(store,report),/证据已变化/);
  }finally{store.close();}
});
