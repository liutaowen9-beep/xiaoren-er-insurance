import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {KnowledgeStore} from '../src/lib/rag/store';
import {EMBEDDING_DIMENSION} from '../src/lib/rag/model-spec';
import {searchNeeds,keywordTerms} from '../src/lib/needs/retrieval';
import {retrievalQueries} from '../src/lib/needs/analysis';
import {analyzeCustomer} from '../src/lib/needs/workflow';
import {missingFields} from '../src/lib/comparison/workflow';
import {FIELDS} from '../src/lib/comparison/types';
import {type NeedsEvent} from '../src/lib/needs/types';
const none=async()=>[];
function fixture(){mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/needs-retrieval-'));const store=new KnowledgeStore(path.join(root,'knowledge.sqlite'),{management:true});return {store,add(name='虚构一页纸（星河）.txt',text='产品名称：星河虚构医疗产品。\n产品类型：医疗保险。\n保障责任：报销住院医疗费用。\n保险期间：一年。'){const id=randomUUID(),raw=Buffer.from(text),v=Array(EMBEDDING_DIMENSION).fill(0);v[0]=1;store.insert({id,name,extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,[{id:randomUUID(),documentId:id,text,sequence:0,page:2}],[v]);return id;}};}
test('exact file names, partial product aliases and width variants retrieve actual current chunks',async()=>{
 const f=fixture();try{const id=f.add();for(const q of ['《虚构一页纸（星河）.txt》资料概述','星河保障责任','《星河》保险期间']){const r=await searchNeeds(q,f.store,new AbortController().signal,none);assert.equal(r.sources.length,1);assert.equal(r.sources[0].documentId,id);assert.equal(r.sources[0].page,2);assert.equal(r.sources[0].version,1);assert.ok(r.diagnostic.methods.includes('document-name'));}}finally{f.store.close();}
});
test('responsibility keywords supplement an empty vector result without inventing cosine confidence',async()=>{
 const f=fixture();try{f.add();const r=await searchNeeds('医疗保险 住院费用 保障责任',f.store,new AbortController().signal,none);assert.equal(r.sources.length,1);assert.equal(r.sources[0].score,0);assert.deepEqual(r.diagnostic.methods,['keyword']);assert.ok(keywordTerms('住院医疗费用 保障责任').includes('住院'));}finally{f.store.close();}
});
test('unknown named products and unrelated topics cannot borrow another product as evidence',async()=>{
 const f=fixture();try{f.add();for(const q of ['《没有这款ZZZ》保障责任','火星采矿发动机']){const r=await searchNeeds(q,f.store,new AbortController().signal,none);assert.equal(r.sources.length,0);assert.ok(r.diagnostic.reason);}}finally{f.store.close();}
});
test('inactive, archived and replaced versions are excluded afresh at every execution',async()=>{
 const f=fixture();try{const old=f.add(),other=f.add('虚构另一产品.txt','保障责任：住院医疗费用。');f.store.setState(other,'archived',f.store.get(other).revision!);const raw=Buffer.from('产品名称：星河新版本。保障责任：住院医疗费用。');const next=f.store.replace(old,{name:'虚构一页纸（星河）.txt',extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')},f.store.get(old).revision!);const v=Array(EMBEDDING_DIMENSION).fill(0);v[0]=1;f.store.commitIndex(next.id,[{id:randomUUID(),documentId:next.id,sequence:0,text:raw.toString()}],[v]);const run=()=>searchNeeds('医疗保险 住院费用',f.store,new AbortController().signal,none);let r=await run();assert.deepEqual(r.sources.map(s=>s.documentId),[next.id]);assert.equal(r.sources[0].version,2);f.store.setState(next.id,'inactive',f.store.get(next.id).revision!);r=await run();assert.equal(r.sources.length,0);f.store.setState(next.id,'active',f.store.get(next.id).revision!);assert.equal((await run()).sources.length,1);}finally{f.store.close();}
});
test('retrieval errors and damaged vectors propagate as failures rather than empty success',async()=>{
 const f=fixture();try{f.add();await assert.rejects(searchNeeds('住院',f.store,new AbortController().signal,async()=>{throw new Error('isolated encoder unavailable');}),/encoder unavailable/);f.store.db.prepare('UPDATE chunks SET dimension=3').run();await assert.rejects(searchNeeds('住院',f.store,new AbortController().signal,none),/索引不一致/);}finally{f.store.close();}
});
test('plans retain original product constraints and merged candidates are deduplicated',async()=>{
 assert.deepEqual(retrievalQueries([{category:'other',quote:'火星采矿发动机'}]),['火星采矿发动机']);
 assert.ok(retrievalQueries([{category:'health',quote:'住院医疗'}],'关注《星河》住院医疗费用').every(q=>q.includes('《星河》')));
 const f=fixture();try{const id=f.add();const queries=retrievalQueries([{category:'health',quote:'《星河》住院医疗'}]);assert.ok(queries.every(q=>q.includes('《星河》')));const lexical=await searchNeeds(queries[0],f.store,new AbortController().signal,none);const r=await searchNeeds(queries[0],f.store,new AbortController().signal,async()=>lexical.sources.map(s=>({...s,score:0.91})));assert.equal(r.sources.length,1);assert.equal(r.sources[0].documentId,id);assert.ok(r.diagnostic.methods.includes('vector'));}finally{f.store.close();}
});
test('actual retrieved text reaches product extraction and evidence-linked report through the graph',async()=>{
 const f=fixture(),events:NeedsEvent[]=[];try{f.add();let received=0;const result=await analyzeCustomer({engine:'mock',profile:{needs:'关注《星河》住院医疗费用。'}},{store:f.store,signal:new AbortController().signal,emit:e=>events.push(e),search:async(q,s,signal)=>(await searchNeeds(q,s,signal,none)).sources,productModel:async(_name,sources)=>{received=sources.length;assert.ok(sources[0].text.includes('报销住院医疗费用'));const fields=missingFields();for(const [key,label] of FIELDS){const quote=sources[0].text.split('\n').find(line=>line.startsWith(label+'：'));if(quote)fields[key]={status:'SUCCESS',value:quote,quote,source:sources[0].number};}return fields;}});assert.equal(received,1);assert.equal(result.report.references.length,1);assert.equal(result.candidates[0].product.fields.coverage.status,'SUCCESS');assert.ok(events.some(e=>e.type==='step'&&e.stage==='knowledge_search'&&e.retrieval?.chunks===1));assert.ok(result.retrieval?.length);}finally{f.store.close();}
});
