import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { needsJson, deepSeekAssessment } from '../src/lib/needs/models';
import { assessmentSchema, validateAssessment, EVIDENCE_LABELS } from '../src/lib/needs/assessment';
import { analyzeCustomer, type NeedsOptions } from '../src/lib/needs/workflow';
import { KnowledgeStore } from '../src/lib/rag/store';
import { EMBEDDING_DIMENSION } from '../src/lib/rag/model-spec';
import { missingFields } from '../src/lib/comparison/workflow';
import { FIELDS } from '../src/lib/comparison/types';
import { DEMO_PROFILE, needsSchema, type NeedsEvent } from '../src/lib/needs/types';
import { mergeNeeds } from '../src/lib/needs/analysis';
import { readReportDownload } from '../src/lib/reports/storage';
import { checkDownloadEvidence } from '../src/lib/reports/evidence';

const assessment=()=>({summary:'客户明确关注医疗费用，需要核实已有责任和可用资料。',hypotheses:[{text:'已有保障责任和具体保额仍需核实，不能确认保障缺口。',basis:[{field:'existingCoverage',quote:'基本医保'}],status:'PENDING_VERIFICATION'}],prioritySuggestions:[{category:'health',reason:'建议先确认客户最关注的医疗费用问题，沟通顺序待确认。',basis:[{field:'needs',quote:'医疗费用'}]}],questions:['已有保障包含哪些医疗责任？'],fieldsToVerify:['coverage','insuranceTerm','paymentTerm','premium']});
const profile={...DEMO_PROFILE,needs:'关注医疗费用，需要核对已有保障。'};
const input=()=>({profile,engine:'deepseek',consent:true});
test('an empty optional quote list preserves the mandatory customer evidence and does not trigger a format retry',()=>{
  const value=needsSchema.parse({needs:[{category:'health',quote:'医疗费用',quotes:[]}]});
  const merged=mergeNeeds(value.needs,profile);assert.equal(merged.length,1);assert.equal(merged[0].quote,'医疗费用');
  assert.throws(()=>mergeNeeds(needsSchema.parse({needs:[{category:'health',quote:'并非客户原话',quotes:[]}]}).needs,profile),/原话|需求/);
});
function stream(content:unknown){return new Response('data: '+JSON.stringify({choices:[{delta:{content:typeof content==='string'?content:JSON.stringify(content)}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}
async function mocked<T>(respond:(body:Record<string,unknown>,init:RequestInit)=>Response|Promise<Response>,work:()=>Promise<T>){
  const original=globalThis.fetch,allow=process.env.MOYU_REPORT_ALLOW_PAID,key=process.env.MOYU_REPORT_API_KEY;
  process.env.MOYU_REPORT_ALLOW_PAID='1';process.env.MOYU_REPORT_API_KEY='isolated-test-credential';
  globalThis.fetch=(async(url:unknown,init:RequestInit)=>{
    assert.equal(String(url),'https://api.deepseek.com/chat/completions');
    const body=JSON.parse(String(init.body));assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.stream,true);assert.deepEqual(body.response_format,{type:'json_object'});
    return respond(body,init);
  }) as typeof fetch;
  try{return await work();}finally{globalThis.fetch=original;if(allow===undefined)delete process.env.MOYU_REPORT_ALLOW_PAID;else process.env.MOYU_REPORT_ALLOW_PAID=allow;if(key===undefined)delete process.env.MOYU_REPORT_API_KEY;else process.env.MOYU_REPORT_API_KEY=key;}
}
function fixture(){mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/needs-ai-')),store=new KnowledgeStore(path.join(root,'knowledge.sqlite'),{management:true});const id=randomUUID(),text='产品名称：虚构医疗演示产品。\n产品类型：医疗保险。\n保障责任：依条款报销住院医疗费用。\n保险期间：一年。\n缴费期间：一年。\n投保条件：18至60岁。\n产品特点：仅供隔离测试。',raw=Buffer.from(text),vector=Array(EMBEDDING_DIMENSION).fill(0);vector[0]=1;store.insert({id,name:'虚构测试资料.txt',extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,[{id:randomUUID(),documentId:id,sequence:0,text,page:1}],[vector]);return {store,id};}
const search:NonNullable<NeedsOptions['search']>=async(_query,store)=>store.overviewSources(store.list().filter(d=>store.isEligible(d.id)).map(d=>d.id),5);
function transport(body:Record<string,unknown>){
  const messages=body.messages as {role:string;content:string}[],data=JSON.parse(messages.at(-1)!.content);
  if(data.untrusted_needs!==undefined)return stream({needs:[{category:'health',quote:'医疗费用'}]});
  if(data.explicit_needs!==undefined)return stream(assessment());
  const fields=missingFields();for(const [key,label] of FIELDS)for(const source of data.untrusted_evidence){const quote=source.text.split('\n').find((s:string)=>s.startsWith(label+'：'));if(quote){fields[key]={status:'SUCCESS',value:quote,quote,source:source.number};break;}}
  return stream(fields);
}

test('DeepSeek adapter requests strict JSON and preserves safe success data',async()=>{
  await mocked(()=>stream({ok:true}),async()=>assert.deepEqual(await needsJson([{role:'user',content:'虚构测试'}],new AbortController().signal,100),{ok:true}));
});
test('assessment prompt shares canonical product field identifiers with the validator',async()=>{
  await mocked(body=>{const prompt=JSON.stringify(body.messages);assert.ok(prompt.includes('eligibility'));assert.ok(!prompt.includes('/conditions/'));return stream(assessment());},async()=>{await deepSeekAssessment(profile,[{category:'health',quote:'医疗费用'}],new AbortController().signal,0);});
});
test('invalid key returns a friendly 401 without raw upstream details or retries',async()=>{
  let calls=0;await mocked(()=>{calls++;return new Response('private-upstream-body',{status:401});},async()=>{
    await assert.rejects(needsJson([],new AbortController().signal,100),(e:unknown)=>e instanceof Error&&'status' in e&&e.status===401&&/密钥无效/.test(e.message)&&!e.message.includes('private-upstream-body'));
  });assert.equal(calls,1);
});
test('model timeout is a friendly 504 and user cancellation remains a cancellation',async()=>{
  for(const [name,status] of [['TimeoutError',504],['AbortError',499]] as const){
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(new DOMException('simulated',name)),5);
    try{await mocked((_body,init)=>new Promise((_resolve,reject)=>{const signal=init.signal!;if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),async()=>{await assert.rejects(needsJson([],abort.signal,100),(e:unknown)=>e instanceof Error&&'status' in e&&e.status===status);});}finally{clearTimeout(timer);}
  }
});
test('AI judgment must cite real customer input and never presents a guaranteed insurance outcome',()=>{
  const valid=assessmentSchema.parse(assessment());assert.equal(validateAssessment(valid,profile,[{category:'health',quote:'医疗费用'}]),valid);
  assert.throws(()=>validateAssessment({...valid,hypotheses:[{...valid.hypotheses[0],basis:[{field:'annualBudget',quote:'999999'}]}]},profile,[{category:'health',quote:'医疗费用'}]),/依据/);
  assert.throws(()=>validateAssessment({...valid,summary:'保证承保'},profile,[{category:'health',quote:'医疗费用'}]),/承诺/);
  assert.throws(()=>validateAssessment(valid,profile,[]),/明确需求/);
});
test('real transport path with mocked DeepSeek runs graph, field audit, evidence-linked exports and separated judgment layers',async()=>{
  const {store}=fixture(),events:NeedsEvent[]=[];let calls=0;
  try{await mocked(body=>{calls++;return transport(body);},async()=>{
    const start=Date.now(),result=await analyzeCustomer(input(),{store,signal:new AbortController().signal,emit:e=>events.push(e),search});
    assert.equal(calls,3);assert.ok(result.aiAnalysis);assert.ok(result.completedAt>=start);assert.equal(result.report.engine,'deepseek');assert.equal(result.report.references.length,1);checkDownloadEvidence(store,result.report);
    const fields=result.candidates[0].product.fields;assert.equal(fields.coverage.status,'SUCCESS');assert.ok(fields.coverage.evidence);assert.equal(fields.premium.status,'NOT_PROVIDED');assert.equal(EVIDENCE_LABELS[fields.premium.status],'资料未提供');
    assert.ok(events.some(e=>e.type==='step'&&e.stage==='ai_analysis'&&e.status==='SUCCESS'));assert.ok(JSON.stringify(result.report).includes('客户填写（未经独立核实）'));assert.ok(JSON.stringify(result.report).includes('AI 摘要（待复核'));
    for(const format of ['docx','pdf'] as const)assert.ok(readReportDownload({id:result.id,token:result.token,format}).bytes.length>100);
    const next=await analyzeCustomer({profile:{age:30},engine:'mock'},{store,signal:new AbortController().signal,emit:()=>{}});assert.equal(next.aiAnalysis,null);assert.equal(next.needs.length,0);assert.equal(calls,3);
  });}finally{store.close();}
});
test('no related evidence retains customer AI judgment but generates no false product or citation',async()=>{
  const {store}=fixture();let calls=0;try{await mocked(body=>{calls++;return transport(body);},async()=>{const result=await analyzeCustomer(input(),{store,signal:new AbortController().signal,emit:()=>{},search:async()=>[]});assert.ok(result.aiAnalysis);assert.equal(result.candidates.length,0);assert.equal(result.report.references.length,0);assert.equal(result.status,'INSUFFICIENT');assert.equal(calls,2);});}finally{store.close();}
});
test('invalid JSON is repaired once then fails without a false complete event',async()=>{
  const {store}=fixture(),events:NeedsEvent[]=[];let calls=0;try{await mocked(()=>{calls++;return stream('not-json');},async()=>assert.rejects(analyzeCustomer(input(),{store,signal:new AbortController().signal,emit:e=>events.push(e),search}),/一次受控修复/));assert.equal(calls,2);assert.ok(!events.some(e=>e.type==='complete'));}finally{store.close();}
});
test('invalidated evidence fails the actual AI node and cannot enter a finished report',async()=>{
  const {store,id}=fixture(),events:NeedsEvent[]=[];try{
    await assert.rejects(analyzeCustomer({profile,engine:'mock'},{store,signal:new AbortController().signal,emit:e=>events.push(e),search,assessmentModel:async()=>{store.setState(id,'inactive',store.get(id).revision!);return assessment();}}),/失效|停用/);
    assert.ok(events.some(e=>e.type==='step'&&e.stage==='ai_analysis'&&e.status==='FAILED'));assert.ok(!events.some(e=>e.type==='complete'));
  }finally{store.close();}
});
