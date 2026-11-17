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
import { compareProducts,scopedAccess,missingFields,verifyExtraction,type ExtractModel } from '../src/lib/comparison/workflow';
import { auditExtraction } from '../src/lib/comparison/evidence';
import { FIELDS,inputSchema,eventSchema,type ComparisonEvent,type ComparisonResult } from '../src/lib/comparison/types';
import { readReportDownload } from '../src/lib/reports/storage';
import { checkDownloadEvidence } from '../src/lib/reports/evidence';
import { POST } from '../src/app/api/comparison/route';

function fixture(count=2,full=false){
  mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/comparison-')),store=new KnowledgeStore(path.join(root,'knowledge.sqlite'),{management:true});
  const ids=Array.from({length:count},(_,i)=>{
    const id=randomUUID(),name=`虚构对比资料${i+1}.txt`,texts=[`产品名称：虚构产品${i+1}。\n产品类型：测试型。\n保障责任：按本测试资料给付身故保险金。\n保险期间：八年。\n缴费期间：四年缴费。`,`投保条件：仅为测试条件。\n等待期：三十天。\n免责条款：资料未提供。\n保费信息：资料未提供。\n产品特点：此为虚构测试资料，不可用于业务。`];
    if(full){texts[1]=texts[1].replace('免责条款：资料未提供。','免责条款：故意伤害不属于本测试责任。').replace('保费信息：资料未提供。','保费信息：本虚构资料列示标准保费每年九百元。');}
    const raw=Buffer.from(texts.join('\n')),v=Array(EMBEDDING_DIMENSION).fill(0);v[0]=1;
    store.insert({id,name,extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')});
    store.commitIndex(id,texts.map((text,j)=>({id:randomUUID(),documentId:id,sequence:j,text,page:j+1})),texts.map(()=>v));return id;
  });return {store,ids};
}
const lookup:typeof retrieve=async(_query,k,scope)=>scope!.overviewSources!(scope!.list().map(d=>d.id),k??3);
const extract:ExtractModel=async(_name,sources)=>{
  const fields=missingFields();for(const [key,label] of FIELDS){for(const source of sources){const quote=source.text.split('\n').find(line=>line.startsWith(label+'：'));if(quote&&!quote.includes('资料未提供')){fields[key]={status:'SUCCESS',value:quote,quote,source:source.number};break;}}}return fields;
};
const input=(ids:string[])=>({documentIds:ids,requirements:'明确区分保险期间与缴费期间',engine:'mock'});
let complete:ComparisonResult;

test('comparison selection rejects duplicates, fewer than two, more than three and arbitrary path fields',()=>{
  const ids=[randomUUID(),randomUUID()];assert.ok(inputSchema.safeParse(input(ids)).success);
  for(const value of [input([]),input([ids[0]]),input([ids[0],ids[0]]),input([...ids,...ids]),{...input(ids),path:'../private'},{...input(ids),requirements:'x'.repeat(1201)}])assert.ok(!inputSchema.safeParse(value).success);
});

test('two product graph isolates evidence, quotes exact business fields and exports real editable DOCX and Chinese PDF',async()=>{
  const {store,ids}=fixture(),events:ComparisonEvent[]=[];
  try{complete=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:e=>events.push(e),retrieve:lookup,model:extract});
    assert.equal(complete.products.length,2);assert.equal(complete.report.references.length,4);
    for(const p of complete.products){assert.equal(p.fields.insuranceTerm.quote,'保险期间：八年。');assert.equal(p.fields.paymentTerm.quote,'缴费期间：四年缴费。');assert.equal(p.fields.premium.status,'NOT_PROVIDED');for(const f of Object.values(p.fields))if(f.source)assert.equal(complete.report.references.find(r=>r.number===f.source)!.documentId,p.documentId);}
    assert.deepEqual(events.filter(e=>e.type==='step'&&e.status==='RUNNING').map(e=>e.type==='step'&&e.stage),['plan','retrieve','extract','verify','retrieve','extract','verify','compare','verify','export']);
    assert.equal(complete.status,'PARTIAL_SUCCESS');assert.ok(events.some(e=>e.type==='step'&&e.status==='PARTIAL_SUCCESS'));assert.ok(events.every(e=>eventSchema.safeParse(e).success));
    const doc=readReportDownload({id:complete.id,token:complete.token,format:'docx'}),pdf=readReportDownload({id:complete.id,token:complete.token,format:'pdf'});
    const xml=strFromU8(unzipSync(doc.bytes)['word/document.xml']);assert.match(xml,/w:tbl/);assert.match(xml,/保险期间：八年/);assert.match(xml,/资料未提供/);
    assert.ok((await PDFDocument.load(pdf.bytes)).getPageCount()>0);
    const parsed=await(await import('../src/lib/rag/parse')).parseDocument(pdf.bytes,'.pdf');assert.match(parsed.map(s=>s.text).join(''),/保险产品资料对比/);
    assert.match(complete.report.content.sections.find(s=>s.heading==='差异观察')!.paragraphs[0].text,/已核验摘录文本相同/);
    checkDownloadEvidence(store,complete.report);
    store.setState(ids[0],'inactive',store.get(ids[0]).revision!);assert.throws(()=>checkDownloadEvidence(store,complete.report),/失效/);
  }finally{store.close();}
});

test('three products retain their own evidence within shared five-reference export limit',async()=>{
  const {store,ids}=fixture(3);try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:()=>{},retrieve:lookup,model:extract});assert.equal(result.products.length,3);assert.equal(result.report.references.length,5);assert.ok(result.products.every(p=>p.sourceCount>=1));assert.equal(result.report.content.sections[0].table!.columns.length,4);}finally{store.close();}
});

test('inactive, archived and superseded product versions never enter scoped retrieval or selection',async()=>{
  const {store,ids}=fixture(3);try{
    store.setState(ids[0],'inactive',store.get(ids[0]).revision!);assert.equal(scopedAccess(store,ids[0]).list().length,0);
    await assert.rejects(compareProducts(input([ids[0],ids[1]]),{store,signal:new AbortController().signal,emit:()=>{},retrieve:lookup}),/有效版本/);
    store.setState(ids[0],'active',store.get(ids[0]).revision!);assert.equal((await retrieve(`《${store.get(ids[0]).name}》产品概述`,3,scopedAccess(store,ids[0]))).length,2);
    store.setState(ids[0],'archived',store.get(ids[0]).revision!);assert.equal(scopedAccess(store,ids[0]).overviewSources!([ids[0]],3).length,0);
    const old=ids[1],raw=Buffer.from('这是虚构的新版本资料。'),newDoc=store.replace(old,{name:'虚构新版.txt',extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')},store.get(old).revision!);const vector=Array(EMBEDDING_DIMENSION).fill(0);vector[0]=1;store.commitIndex(newDoc.id,[{id:randomUUID(),documentId:newDoc.id,sequence:0,text:raw.toString()}],[vector]);
    assert.equal(scopedAccess(store,old).list().length,0);assert.equal(scopedAccess(store,newDoc.id).list().length,1);
    const found=await retrieve('《虚构新版.txt》产品概述',3,scopedAccess(store,newDoc.id));assert.ok(found.every(s=>s.documentId===newDoc.id&&s.version===2));
  }finally{store.close();}
});

test('no evidence skips model, reports insufficient data and never invents references',async()=>{
  const {store,ids}=fixture(),events:ComparisonEvent[]=[];try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:e=>events.push(e),retrieve:async()=>[],model:async()=>{throw new Error('must not call model');}});assert.equal(result.report.references.length,0);assert.ok(result.products.every(p=>Object.values(p.fields).every(f=>f.status==='NOT_PROVIDED')));assert.ok(!events.some(e=>e.type==='step'&&e.stage==='extract'));assert.ok(events.some(e=>e.type==='step'&&e.stage==='retrieve'&&e.status==='INSUFFICIENT'));}finally{store.close();}
});

test('fabricated quotes, cross-product sources and insurance/payment term drift fail closed',()=>{
  const source={number:1,documentId:randomUUID(),chunkId:randomUUID(),fileName:'虚构资料',text:'保八年。',score:1};
  const doc={id:source.documentId,name:source.fileName,version:1};
  const fields=missingFields();fields.paymentTerm={status:'SUCCESS',value:'八年',quote:'保八年。',source:1};
  assert.equal(auditExtraction(fields,[source],doc).paymentTerm.status,'PENDING_VERIFICATION');
  fields.name={status:'SUCCESS',value:'虚构承诺',quote:'虚构承诺',source:1};assert.equal(auditExtraction(fields,[source],doc).name.status,'EXTRACTION_FAILED');
  fields.name={status:'SUCCESS',value:'保八年。',quote:'保八年。',source:2};assert.throws(()=>verifyExtraction(fields,[source]),/原文/);
  fields.name={status:'NOT_PROVIDED',value:'',quote:'不该有的值',source:null};assert.throws(()=>verifyExtraction(fields,[source]),/字段/);
});

test('fenced JSON is parsed and malformed structured outputs receive exactly one format retry',async()=>{
  const {store,ids}=fixture();let calls=0;try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:()=>{},retrieve:lookup,model:async(name,sources,req,signal,attempt)=>{calls++;return attempt?'```json\n'+JSON.stringify(await extract(name,sources,req,signal,attempt))+'\n```':'{invalid';}});assert.equal(result.products.length,2);assert.equal(calls,4);
    calls=0;await assert.rejects(compareProducts(input(ids),{store,signal:new AbortController().signal,emit:()=>{},retrieve:lookup,model:async()=>{calls++;return {};}}),/未生成报告/);assert.equal(calls,4);
  }finally{store.close();}
});

test('source state changes during extraction abort result; cancellation prevents all subsequent nodes',async()=>{
  const {store,ids}=fixture();try{await assert.rejects(compareProducts(input(ids),{store,signal:new AbortController().signal,emit:()=>{},retrieve:lookup,model:async(...args)=>{store.setState(ids[0],'inactive',store.get(ids[0]).revision!);return extract(...args);}}),/停用|失效/);
    store.setState(ids[0],'active',store.get(ids[0]).revision!);const abort=new AbortController(),events:ComparisonEvent[]=[];
    await assert.rejects(compareProducts(input(ids),{store,signal:abort.signal,emit:e=>events.push(e),retrieve:async(...args)=>{abort.abort();return lookup(...args);},model:async()=>{throw new Error('must not execute');}}));assert.ok(!events.some(e=>e.type==='step'&&e.stage==='extract'));assert.ok(events.some(e=>e.type==='step'&&e.status==='CANCELLED'));
  }finally{store.close();}
});

test('comparison API rejects cross-origin, malformed input and unauthorized paid engine before model invocation',async()=>{
  const request=(url:string,value:unknown)=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await POST(request('https://external.example/api/comparison',input([randomUUID(),randomUUID()])))).status,403);
  assert.equal((await POST(request('http://localhost/api/comparison',{documentIds:[]}))).status,400);
  const prev=process.env.MOYU_REPORT_ALLOW_PAID;process.env.MOYU_REPORT_ALLOW_PAID='0';try{assert.equal((await POST(request('http://localhost/api/comparison',{...input([randomUUID(),randomUUID()]),engine:'deepseek'}))).status,403);}finally{if(prev===undefined)delete process.env.MOYU_REPORT_ALLOW_PAID;else process.env.MOYU_REPORT_ALLOW_PAID=prev;}
});

test('quality: both complete products produce SUCCESS in fields, per-product steps, final result and exports',async()=>{
  const {store,ids}=fixture(2,true),events:ComparisonEvent[]=[];
  try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:e=>events.push(e),retrieve:lookup,model:extract});
    assert.equal(result.status,'SUCCESS');assert.match(result.report.content.abstract,/提取成功/);
    for(const p of result.products){assert.equal(p.status,'SUCCESS');for(const f of Object.values(p.fields)){assert.equal(f.status,'SUCCESS');assert.ok(f.value&&f.quote&&f.evidence);assert.equal(f.evidence.documentId,p.documentId);assert.ok(f.evidence.page||f.evidence.chunkId);}}
    assert.ok(events.filter(e=>e.type==='step'&&e.status!=='RUNNING').every(e=>e.type==='step'&&e.status==='SUCCESS'));
    assert.deepEqual(events.filter(e=>e.type==='step'&&e.stage==='extract'&&e.status==='SUCCESS').map(e=>e.type==='step'&&e.productIndex),[1,2]);
    assert.ok(readReportDownload({id:result.id,token:result.token,format:'pdf'}).bytes.length>100);
  }finally{store.close();}
});

test('quality: one complete and one partial product yields PARTIAL_SUCCESS and downloadable report with explicit missing fields',async()=>{
  const {store,ids}=fixture(2,true),events:ComparisonEvent[]=[];
  try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:e=>events.push(e),retrieve:lookup,model:async(...args)=>{const f=await extract(...args) as ReturnType<typeof missingFields>;if(args[0].includes('2'))f.premium=missingFields().premium;return f;}});
    assert.equal(result.products[0].status,'SUCCESS');assert.equal(result.products[1].status,'PARTIAL_SUCCESS');assert.equal(result.status,'PARTIAL_SUCCESS');
    assert.equal(result.products[1].fields.premium.status,'NOT_PROVIDED');assert.match(result.report.content.abstract,/部分成功/);
    assert.ok(events.some(e=>e.type==='step'&&e.stage==='extract'&&e.productIndex===2&&e.status==='PARTIAL_SUCCESS'));
    const xml=strFromU8(unzipSync(readReportDownload({id:result.id,token:result.token,format:'docx'}).bytes)['word/document.xml']);assert.match(xml,/资料未提供/);assert.match(xml,/部分成功/);
  }finally{store.close();}
});

test('quality: one product without evidence remains INSUFFICIENT while the other is independently extracted',async()=>{
  const {store,ids}=fixture(2,true),events:ComparisonEvent[]=[];let calls=0;
  try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:e=>events.push(e),retrieve:async(...args)=>args[2]!.list()[0].id===ids[1]?[]:lookup(...args),model:async(...args)=>{calls++;return extract(...args);}});
    assert.equal(calls,1);assert.equal(result.products[0].status,'SUCCESS');assert.equal(result.products[1].status,'INSUFFICIENT');assert.equal(result.status,'PARTIAL_SUCCESS');
    assert.ok(result.report.references.every(r=>r.documentId===ids[0]));assert.ok(!events.some(e=>e.type==='step'&&e.stage==='extract'&&e.productIndex===2));
  }finally{store.close();}
});

test('quality: malformed model outputs mark FAILED and never export empty data as success',async()=>{
  const {store,ids}=fixture(2,true),events:ComparisonEvent[]=[];let calls=0;
  try{await assert.rejects(compareProducts(input(ids),{store,signal:new AbortController().signal,emit:e=>events.push(e),retrieve:lookup,model:async()=>{calls++;return '{not json';}}),/未生成报告/);
    assert.equal(calls,4);assert.equal(events.filter(e=>e.type==='step'&&e.stage==='extract'&&e.status==='FAILED').length,2);
    assert.ok(!events.some(e=>e.type==='complete'||e.type==='step'&&e.stage==='export'));
  }finally{store.close();}
});

test('quality: one model failure does not discard a different product; failed fields stay explicitly failed',async()=>{
  const {store,ids}=fixture(2,true),events:ComparisonEvent[]=[];
  try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:e=>events.push(e),retrieve:lookup,model:async(...args)=>{if(args[0].includes('1'))throw new Error('simulated provider failure');return extract(...args);}});
    assert.equal(result.status,'PARTIAL_SUCCESS');assert.equal(result.products[0].status,'FAILED');assert.equal(result.products[1].status,'SUCCESS');
    assert.ok(Object.values(result.products[0].fields).every(f=>f.status==='EXTRACTION_FAILED'&&f.evidence===null));
    assert.ok(events.some(e=>e.type==='step'&&e.stage==='extract'&&e.productIndex===1&&e.status==='FAILED'));assert.match(result.report.content.sections[1].paragraphs[0].text,/提取失败/);
    assert.ok(!JSON.stringify(result).includes('simulated provider failure'));
  }finally{store.close();}
});

test('quality: mismatched quote or cross-product reference fails only that field and never exposes invented text',async()=>{
  const {store,ids}=fixture(2,true);
  try{const result=await compareProducts(input(ids),{store,signal:new AbortController().signal,emit:()=>{},retrieve:lookup,model:async(...args)=>{const f=await extract(...args) as ReturnType<typeof missingFields>;if(args[0].includes('2')){f.coverage={status:'SUCCESS',value:'未经证据支持的收益承诺',quote:'未经证据支持的收益承诺',source:1};}return f;}});
    assert.equal(result.status,'PARTIAL_SUCCESS');const f=result.products[1].fields.coverage;assert.equal(f.status,'EXTRACTION_FAILED');assert.equal(f.evidence,null);assert.equal(f.value,'');assert.ok(!JSON.stringify(result).includes('未经证据支持的收益承诺'));
  }finally{store.close();}
});

test('quality: insurance duration, payment duration and frequency are not interchangeable even in the same quote',()=>{
  const text='保险期间八年，缴费期间四年。年交三千元，保八年。',source={number:1,documentId:randomUUID(),chunkId:randomUUID(),fileName:'虚构期限.txt',text,score:1},doc={id:source.documentId,name:source.fileName};
  const f=missingFields();f.insuranceTerm={status:'SUCCESS',value:'四年',quote:'保险期间八年，缴费期间四年。',source:1};f.paymentTerm={status:'SUCCESS',value:'八年',quote:'保险期间八年，缴费期间四年。',source:1};
  const audited=auditExtraction(f,[source],doc);assert.equal(audited.insuranceTerm.status,'PENDING_VERIFICATION');assert.equal(audited.paymentTerm.status,'PENDING_VERIFICATION');assert.equal(audited.paymentTerm.value,'');assert.ok(audited.paymentTerm.evidence);
  f.paymentTerm={status:'SUCCESS',value:'年交三千元',quote:'年交三千元',source:1};assert.equal(auditExtraction(f,[source],doc).paymentTerm.status,'PENDING_VERIFICATION');
  f.paymentTerm={status:'SUCCESS',value:'四年',quote:'缴费期间四年',source:1};assert.equal(auditExtraction(f,[source],doc).paymentTerm.status,'SUCCESS');
});

test('quality: sum insured and customer-case payments are never promoted to confirmed standard premium',()=>{
  const text='标准保费九百元，基本保额十万元。',source={number:1,documentId:randomUUID(),chunkId:randomUUID(),fileName:'虚构金额.txt',text,score:1},doc={id:source.documentId,name:source.fileName};
  const f=missingFields();f.premium={status:'SUCCESS',value:'十万元',quote:'标准保费九百元，基本保额十万元。',source:1};assert.equal(auditExtraction(f,[source],doc).premium.status,'PENDING_VERIFICATION');
  f.premium={status:'SUCCESS',value:'九百元',quote:'标准保费九百元',source:1};assert.equal(auditExtraction(f,[source],doc).premium.status,'SUCCESS');
  const caseSource={...source,text:'客户案例：四十岁客户的投保示例。\n标准保费九百元'};assert.equal(auditExtraction(f,[caseSource],doc).premium.status,'PENDING_VERIFICATION');
});

test('quality: marketing is not coverage and identity fallback requires explicit original text, never filename',()=>{
  const source={number:1,documentId:randomUUID(),chunkId:randomUUID(),fileName:'虚构产品甲两全保险.pdf',text:'稳健增长，让爱长久。',score:1},doc={id:source.documentId,name:source.fileName};
  const f=missingFields();f.coverage={status:'SUCCESS',value:'稳健增长',quote:'稳健增长',source:1};let result=auditExtraction(f,[source],doc);assert.equal(result.coverage.status,'PENDING_VERIFICATION');assert.equal(result.name.status,'NOT_PROVIDED');assert.equal(result.type.status,'NOT_PROVIDED');
  result=auditExtraction(missingFields(),[{...source,text:'虚构产品甲两全保险\n其他虚构内容。'}],doc);assert.equal(result.name.status,'SUCCESS');assert.equal(result.type.value,'两全保险');assert.equal(result.name.evidence!.chunkId,source.chunkId);
});
