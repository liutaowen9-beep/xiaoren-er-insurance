import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { KnowledgeStore } from '../src/lib/rag/store';
import { prepareUpload, indexDocument, retrieve } from '../src/lib/rag/service';
import { getEncoder } from '../src/lib/rag/embedding';
import { planQuery } from '../src/lib/rag/query-plan';
import { BUSINESS_RULES, businessFacts, businessEvidenceText, unsupportedBusinessClaim, checkedBusinessText, qualityDeltas, isExecutionNarration } from '../src/lib/rag/business-evidence';
import { ragMessages, NO_EVIDENCE } from '../src/lib/rag/prompt';
import { analyzeDocuments } from '../src/lib/agent/document-analysis';
import { runAgent, type ModelTransport } from '../src/lib/agent/orchestrator';
import { observeRun } from '../src/lib/agent/observe';
import { applyWorkflowEvent, type WorkflowRun } from '../src/lib/agent/workflow';
import { restoreHistory, serializeHistory } from '../src/lib/chat-history';
import { POST as chatPOST } from '../src/app/api/chat/route';
import type { Source } from '../src/lib/rag/types';
import type { AgentEvent } from '../src/lib/agent/types';

// All names, amounts and periods below are invented regression fixtures, not private documents.
// Isolated test corpus: no .env file, production writes, or paid fetch.
process.env.DEEPSEEK_API_KEY = '';
mkdirSync('tmp/rag-tests', { recursive: true });
const root = mkdtempSync(path.resolve('tmp/rag-tests/quality-'));
const writer = new KnowledgeStore(path.join(root, 'knowledge.sqlite'));
let reader: KnowledgeStore, mainId: string, otherId: string;
const globals = globalThis as typeof globalThis & { __moyuKnowledgeStore?: KnowledgeStore };
const sample = '投保年龄为出生满42日至62周岁。\n保险期间可选3/7/11/13年，提供多种保障期限选择。\n客户案例：年交23万，保11年。\n保费4万起售；生存至期满按合同约定给付，预期分红不是保证收益。';
function source(text = sample, documentId = 'doc-a', chunkId = 'chunk-a'): Source { return { number: 1, documentId, chunkId, fileName: '测试资料', text, score: 0.9 }; }
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
function wire(calls: ReturnType<typeof call>[] = [], text = '') {
  const events = [{ choices: [{ delta: { content: text, ...(calls.length ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : {}) } }] }, { choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }];
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n')); c.close(); } });
}
function textOf(events: AgentEvent[]) { return events.filter(e => e.type === 'delta').map(e => e.type === 'delta' ? e.text : '').join(''); }
async function collect(model: ModelTransport) {
  const events: AgentEvent[] = [];
  for await (const e of runAgent([{ role: 'user', content: '完成任务' }], { store: reader, signal: new AbortController().signal, requestModel: model })) events.push(e);
  return events;
}
after(async () => { reader?.close(); writer.close(); delete globals.__moyuKnowledgeStore; await (await getEncoder()).dispose(); });

test('metadata query decomposition is generic, scoped, bounded and never substitutes title for evidence', () => {
  const docs = [{ id: 'a', name: '方案（虚构样本丙）.pdf', status: 'ready' as const }, { id: 'b', name: '要点（虚构样本乙）.txt', status: 'ready' as const }];
  const p = planQuery('虚构样本丙有哪些保障期限？', docs);
  assert.deepEqual([...p.allowed!], ['a']); assert.equal(p.queries.length, 2); assert.equal(p.queries[1], '有哪些保障期限?');
  assert.equal(planQuery('虚构样本乙', docs).queries.length, 0);
  assert.equal(planQuery('《不存在的文件》有哪些期限？', docs).queries.length, 0);
  assert.deepEqual([...planQuery('《虚构样本丙》有哪些保障期限？', docs).allowed!], ['a']);
  assert.equal(planQuery('如何请假？', docs).allowed, undefined);
  assert.equal(planQuery('问题', []).queries.length, 0);
});
test('business field ledger distinguishes coverage, payment duration and premium with exact source quotes', () => {
  const facts = businessFacts([source()]);
  assert.ok(facts.some(f => f.field === 'coveragePeriod' && f.value === '11'));
  assert.ok(facts.some(f => f.field === 'annualPremium' && f.value === '23万'));
  assert.ok(!facts.some(f => f.field === 'paymentPeriod'));
  for (const fact of facts) { assert.ok(sample.includes(fact.quote)); assert.equal(fact.chunkId, 'chunk-a'); }
  const rendered = businessEvidenceText([source()]);
  assert.match(rendered, /当前证据未明确提及/); assert.match(rendered, /来源卡片 1/);
});
test('unsupported payment-period paraphrases, markdown and Chinese numerals are rejected without fixed product values', () => {
  for (const [amount, years] of [['23', '11'], ['37', '9'], ['26', '12']]) {
    const evidence = [source(`案例：年交${amount}万，保${years}年。`)];
    for (const claim of [`年交${amount}万元，交${years}年。`, `缴费期间：${years}年。`, `**缴费期间**：${years}年。`, `${years}年交。`]) assert.ok(unsupportedBusinessClaim(claim, evidence), claim);
    assert.equal(unsupportedBusinessClaim(`年交${amount}万元，保${years}年。`, evidence), false);
    assert.ok(!checkedBusinessText(`交${years}年。`, evidence).includes(`交${years}年`));
  }
  assert.ok(unsupportedBusinessClaim('缴费期间为五年。', [source()]));
  assert.equal(unsupportedBusinessClaim('不能说交11年。', [source()]), false);
});
test('explicit payment periods remain legal and different documents cannot borrow each other facts', () => {
  const a = source('保险期间为9年，缴费期间为3年，年交37万元。', 'a');
  assert.equal(unsupportedBusinessClaim('缴费期间为三年，年交370000元。', [a]), false);
  assert.ok(unsupportedBusinessClaim('保3年。', [a]));
  const b = source('保险期间为11年，年交20万元。', 'b', 'chunk-b');
  assert.ok(unsupportedBusinessClaim('缴费期间为3年。', [a, b]));
  assert.ok(!businessFacts([source('原文未提及缴费期间为11年。')]).some(f => f.field === 'paymentPeriod'));
  const separated = businessFacts([source('缴费期间11年，保险期间10年。')]);
  assert.ok(!separated.some(f => f.field === 'coveragePeriod' && f.value === '11'));
  assert.ok(separated.some(f => f.field === 'coveragePeriod' && f.value === '10'));
});
test('split dangerous claims and unsupported execution narration never flash in streamed output', async () => {
  async function* events() {
    for (const text of ['我会并', '行执行这些工具。\n', '客户年交23万元、', '交11', '年。\n', '保险期间为11年。']) yield { type: 'delta' as const, text };
    yield { type: 'done' as const, finishReason: 'stop' };
  }
  const seen: string[] = [];
  for await (const e of qualityDeltas(events(), () => [source()], true, true)) if (e.type === 'delta') seen.push(e.text);
  assert.ok(seen.every(t => !t.includes('并行') && !t.includes('交11年')));
  assert.match(seen.join(''), /已拦截/); assert.match(seen.join(''), /保11年/); assert.match(seen.join(''), /当前证据未明确提及/);
  for (const text of ['工具均已执行成功', 'I will run tools in parallel.', '我会串行调用它们', '我会先执行知识库检索、文档摘要和数值计算三项操作。', '命中1个片段']) assert.equal(isExecutionNarration(text), true);
  assert.equal(isExecutionNarration('合计12707.50元。'), false);
});
test('RAG prompts and schema-independent source evidence require critical field separation', () => {
  const messages = ragMessages([{ role: 'user', content: '能否认定交11年？' }], [source()]);
  assert.ok(messages[0].content.includes(BUSINESS_RULES));
  assert.match(messages.at(-1)!.content, /extracted_fields_for_cross_check/);
  assert.ok(!businessFacts([source('保证现金价值23万元，预期年化单利1.23%。')]).some(f => f.field === 'guaranteedYield'));
});
test('independent real Chinese corpus is indexed without production writes', async () => {
  for (const [name, text] of [
    ['产品资料（虚构样本甲）.txt', sample],
    ['资料（虚构样本乙）.txt', '投保可选择保险期间7/9年。客户案例年交37万，保9年。缴费期间为3年。保费20万起售。'],
    ['技术方案（虚构样本丁）.md', '# 数据备份\n每天凌晨执行备份，保留七天，恢复前校验内容摘要。'],
  ]) {
    const prepared = prepareUpload(name, 'text/plain', Buffer.from(text), writer);
    const doc = await indexDocument(prepared.document.id, writer); assert.equal(doc.status, 'ready');
    if (name.includes('虚构样本甲')) mainId = doc.id; if (name.includes('虚构样本乙')) otherId = doc.id;
  }
  reader = new KnowledgeStore(path.join(root, 'knowledge.sqlite'), { readOnly: true });
});
test('natural, synonymous, unanswered and distracting queries use actual Chinese embeddings and exact source IDs', async () => {
  const cases: [string, string | null][] = [
    ['虚构样本甲提供哪些保险期间可选？', mainId], ['虚构样本甲可以保几年？', mainId],
    ['虚构样本甲有哪些保障期限可以选择？', mainId], ['虚构样本乙提供哪些保险期间可选？', otherId],
    ['虚构样本乙的缴费期间是几年？', otherId], ['虚构样本甲的缴费期间是几年？', null],
    ['虚构样本甲保证年收益多少？', null], ['虚构样本甲理赔多久到账？', null],
    ['虚构样本甲支持比特币支付吗？', null], ['月球距离地球多远？', null],
    ['怎样制作意大利披萨？', null], ['《不存在的产品》提供哪些保障？', null],
  ];
  for (const [query, expected] of cases) {
    const sources = await retrieve(query, 2, reader);
    if (!expected) assert.equal(sources.length, 0, query);
    else { assert.equal(sources[0]?.documentId, expected, query); assert.ok(sources[0].score >= 0.88); for (const s of sources) { const row = reader.db.prepare('SELECT text FROM chunks WHERE id=? AND document_id=?').get(s.chunkId, s.documentId) as { text: string }; assert.equal(row.text, s.text); } }
  }
});
test('unanswered RAG route returns no sources and makes no generation request', async t => {
  globals.__moyuKnowledgeStore = writer;
  const mock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Paid calls prohibited'); });
  const response = await chatPOST(new Request('http://localhost/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'knowledge', messages: [{ role: 'user', content: '虚构样本甲的缴费期间是几年？' }] }) }));
  const wire = await response.text(); assert.match(wire, /"sources":\[\]/); assert.ok(wire.includes(NO_EVIDENCE)); assert.equal(mock.mock.callCount(), 0);
});
test('RAG stream blocks malicious generation and appends only actual original field quotes', async t => {
  globals.__moyuKnowledgeStore = writer; process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
  t.mock.method(globalThis, 'fetch', async () => new Response(wire([], '年交23万元、交11年。'), { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await chatPOST(new Request('http://localhost/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'knowledge', messages: [{ role: 'user', content: '虚构样本甲提供哪些保险期间可选？' }] }) }));
  const output = await response.text(); assert.ok(!output.includes('交11年')); assert.ok(output.includes('保11年')); assert.match(output, /未明确提及/);
  process.env.DEEPSEEK_API_KEY = '';
});
test('document summaries are checked before they can contaminate later tool results', async () => {
  const result = await analyzeDocuments({ documentIds: [mainId], task: 'summary' }, reader, new Set([mainId]), async () => '年交23万元、交11年。', new AbortController().signal);
  assert.ok(!result.analysis.includes('交11年')); assert.match(result.analysis, /已拦截/); assert.ok(result.businessFacts.every(f => result.sources.some(s => s.chunkId === f.chunkId && s.text.includes(f.quote))));
});
test('Agent hides fictional planning and checks final critical fields against actual successful sources', async () => {
  let round = 0;
  const events = await collect(async (messages, _signal, options) => {
    if (!options?.tools) return wire([], '客户年交23万元，保11年。');
    assert.match(messages[1].content, /serial/);
    if (!round++) return wire([call('doc1', 'document_analyze', { documentIds: [mainId], task: 'summary' }), call('calc2', 'calculator', { expression: '50*299*0.85' })], '我会并行执行这两个工具。');
    assert.match(messages[1].content, /"status":"success"/);
    return wire([], '工具均已执行成功。年交23万元、交11年。合计12707.50元。');
  });
  const text = textOf(events); assert.ok(!text.includes('并行')); assert.ok(!text.includes('工具均已执行成功')); assert.ok(!text.includes('交11年')); assert.match(text, /保11年/); assert.match(text, /12707.50/);
  assert.deepEqual(events.filter(e => e.type === 'tool_start').map(e => e.type === 'tool_start' ? e.record.id : ''), ['doc1', 'calc2']);
});
test('cancelling an entered document tool aborts its model stream and prevents the next same-round tool', async () => {
  const abort = new AbortController(); let entered!: () => void; const active = new Promise<void>(resolve => { entered = resolve; });
  let modelCalls = 0, summaryAborted = false, run: WorkflowRun | undefined; const events: AgentEvent[] = [];
  const cancel = active.then(() => abort.abort());
  const model: ModelTransport = async (_messages, signal, options) => {
    modelCalls++;
    if (options?.tools) return wire([call('doc_running', 'document_analyze', { documentIds: [mainId], task: 'summary' }), call('must_not_start', 'calculator', { expression: '2+2' })]);
    return new ReadableStream({ start(controller) {
      const stop = () => { summaryAborted = true; controller.error(signal.reason); };
      signal.addEventListener('abort', stop, { once: true }); entered();
    } });
  };
  for await (const event of observeRun(runAgent([{ role: 'user', content: '先分析再计算' }], { store: reader, signal: abort.signal, requestModel: model }), abort.signal)) { events.push(event); if ('runId' in event) run = applyWorkflowEvent(run, event); }
  await cancel; assert.equal(summaryAborted, true); assert.equal(modelCalls, 2); assert.equal(run!.status, 'cancelled'); assert.equal(run!.steps[0].status, 'cancelled');
  assert.equal(events.filter(e => e.type === 'tool_start').length, 0); // observeRun consumes legacy internal events
  assert.equal(run!.steps.length, 1); assert.ok(!JSON.stringify(run).includes('must_not_start'));
  const history = [{ id: randomUUID(), title: '取消', updatedAt: Date.now(), mode: 'agent' as const, messages: [{ id: randomUUID(), role: 'assistant' as const, content: '', mode: 'agent' as const, workflow: run }] }];
  const restored = restoreHistory(serializeHistory(history)); assert.equal(restored[0].messages[0].workflow!.steps[0].status, 'cancelled');
});


test('explicit short-document overviews share real evidence across retrieval, chat streaming and LangGraph',async t=>{
  const store=new KnowledgeStore(path.join(root,'short-overview/knowledge.sqlite'),{management:true});
  const texts=['本虚构样本的保险期间为九年，具体责任以实际条款为准。','本虚构样本仅说明文档用途，没有提供缴费期间或收益承诺。'];
  const raw=Buffer.from(texts.join('\n')),id=randomUUID();const ids:string[]=[randomUUID(),randomUUID()];
  store.insert({id,name:'方案（虚构短文甲）.pdf',extension:'.pdf',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,texts.map((text,i)=>({id:ids[i],documentId:id,sequence:i,text,page:i+1})),await Promise.all(texts.map(text=>import('../src/lib/rag/embedding').then(m=>m.embedText(text,'passage')))));
  const previous=globals.__moyuKnowledgeStore,oldKey=process.env.DEEPSEEK_API_KEY;
  try{
    for(const query of ['虚构短文甲','虚构短文甲．ＰＤＦ','请介绍虚构短文甲','《方案（虚构短文甲）．ＰＤＦ》分析报告']){
      const found=await retrieve(query,5,store);assert.equal(found.length,2);assert.ok(found.every(s=>s.documentId===id&&s.kind==='document'&&s.score===0));assert.deepEqual(found.map(s=>s.text),texts);
    }
    assert.equal((await retrieve('虚构短文甲保证年收益率是多少？',5,store)).length,0);
    assert.equal((await retrieve('《不存在的测试文件》总结',5,store)).length,0);
    assert.equal((await retrieve('遥远星系的人口普查结果是什么？',5,store)).length,0);
    globals.__moyuKnowledgeStore=store;process.env.DEEPSEEK_API_KEY='fictional-test-key';let modelCalls=0;
    t.mock.method(globalThis,'fetch',async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{modelCalls++;const sent=JSON.parse(String(init?.body));const evidence=JSON.parse(sent.messages.at(-1).content).untrusted_evidence;assert.deepEqual(evidence.map((s:{text:string})=>s.text),texts);return new Response(wire([],'可以根据这份文档提供有限摘要，未提供的字段不能推断。'),{headers:{'Content-Type':'text/event-stream'}});});
    const response=await chatPOST(new Request('http://localhost/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'knowledge',messages:[{role:'user',content:'请介绍虚构短文甲'}]})}));assert.equal(response.status,200);assert.equal(response.headers.get('X-Moyu-Evidence-Count'),'2');
    const {readChatReply}=await import('../src/lib/chat-stream');let answer='';let citations:Source[]=[];await readChatReply(response.body!,text=>answer+=text,sources=>citations=sources);assert.match(answer,/有限摘要/);assert.equal(citations.length,2);assert.equal(modelCalls,1);
    let turns=0;const events:AgentEvent[]=[];
    for await(const e of runAgent([{role:'user',content:'请介绍虚构短文甲'}],{store,signal:new AbortController().signal,requestModel:async messages=>{if(!turns++)return wire([call('overview_call','knowledge_search',{query:'请介绍虚构短文甲'})]);const result=JSON.parse(messages.at(-1)!.content);assert.equal(result.found,true);assert.deepEqual(result.sources.map((s:Source)=>s.text),texts);return wire([],'仅根据已提供原文做有限概述。');}}))events.push(e);
    assert.ok(events.some(e=>e.type==='sources'&&e.sources.length===2));assert.match(textOf(events),/有限概述/);
    for(const state of ['inactive','archived'] as const){store.setState(id,state,store.get(id).revision!);assert.equal((await retrieve('请介绍虚构短文甲',5,store)).length,0);store.setState(id,'active',store.get(id).revision!);assert.equal((await retrieve('请介绍虚构短文甲',5,store)).length,2);}
    const replacementRaw=Buffer.from('虚构新版仅供测试。'),next=store.replace(id,{name:'方案（虚构短文甲）.pdf',extension:'.pdf',raw:replacementRaw,hash:createHash('sha256').update(replacementRaw).digest('hex')},store.get(id).revision!);const replacementChunk=randomUUID();store.commitIndex(next.id,[{id:replacementChunk,documentId:next.id,sequence:0,text:replacementRaw.toString()}],[await import('../src/lib/rag/embedding').then(m=>m.embedText(replacementRaw.toString(),'passage'))]);
    const current=await retrieve('请介绍虚构短文甲',5,store);assert.equal(current.length,1);assert.equal(current[0].documentId,next.id);assert.ok(!ids.includes(current[0].chunkId));
  }finally{globals.__moyuKnowledgeStore=previous;if(oldKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=oldKey;store.close();}
});
test('document overview classification never turns unrelated named questions into source citations',()=>{
 const docs=[{id:'fake-a',name:'计划（虚构长文乙）．ＰＤＦ',status:'ready' as const}];
 assert.equal(planQuery('《计划（虚构长文乙）.pdf》总结',docs).overview,true);
 for(const question of ['虚构长文乙保证收益率是多少','虚构长文乙火星人口','虚构长文乙缴费期间几年'])assert.notEqual(planQuery(question,docs).overview,true);
});


test('long-document factual search retains calibrated semantic scoring and bounded overview coverage',async()=>{
  const {embedText,embedQuery}=await import('../src/lib/rag/embedding');const {MIN_SCORE}=await import('../src/lib/rag/config');
  const store=new KnowledgeStore(path.join(root,'long-overview/knowledge.sqlite'),{management:true}),id=randomUUID();const text='保险期间可选3/7/11/13年，提供多种保障期限选择。';const raw=Buffer.from(Array(8).fill(text).join('\n')),vector=await embedText(text,'passage');
  store.insert({id,name:'计划（虚构长文乙）.txt',extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,Array.from({length:8},(_,sequence)=>({id:randomUUID(),documentId:id,sequence,text})),Array.from({length:8},()=>vector));
  try{const direct=store.search(await embedQuery('有哪些保险期间可选？'),5,MIN_SCORE);const found=await retrieve('虚构长文乙有哪些保险期间可选？',5,store);assert.ok(direct.length>0);assert.ok(found.length>0);assert.ok(found.every(s=>s.documentId===id&&s.score>=MIN_SCORE&&s.kind!=='document'));const overview=await retrieve('虚构长文乙分析报告',5,store);assert.equal(overview.length,5);assert.ok(overview.every(s=>s.kind==='document'));assert.equal(store.countChunks(),8);}finally{store.close();}
});
