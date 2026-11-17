import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { generateReport, mockReportModel, type ReportModel } from '../src/lib/reports/workflow';
import { reportInputSchema, reportSchema, type Report, type ReportEvent, type Content } from '../src/lib/reports/types';
import { toDocx, toPdf } from '../src/lib/reports/export';
import { REPORT_ROOT, readReportDownload, downloadHeaders, saveReport } from '../src/lib/reports/storage';
import { checkDownloadEvidence } from '../src/lib/reports/evidence';
import { KnowledgeStore } from '../src/lib/rag/store';
import { embedText, getEncoder } from '../src/lib/rag/embedding';
import { parseDocument } from '../src/lib/rag/parse';
import { POST, GET } from '../src/app/api/reports/route';
import { POST as downloadPost } from '../src/app/api/reports/download/route';
import { readSSE } from '../src/lib/sse';

const input={topic:'中文团队协作报告',requirements:'包含中文标题、表格和特殊字符 & < > %。',type:'custom',useKnowledge:false,formats:['docx','pdf'],engine:'mock'} as const;
const request=()=>({...input,formats:[...input.formats]});
const signal=()=>new AbortController().signal;
let result:Extract<ReportEvent,{type:'complete'}>,usedEncoder=false;
const events:ReportEvent[]=[];
after(async()=>{if(usedEncoder)await(await getEncoder()).dispose();});
const noStore={store:null,signal:signal(),emit:(e:ReportEvent)=>events.push(e)};

test('report input rejects empty, overlong, unknown and traversal-style format values',()=>{
  assert.ok(reportInputSchema.safeParse(request()).success);
  for(const invalid of [{...request(),topic:''},{...request(),topic:'字'.repeat(161)},{...request(),requirements:'字'.repeat(2001)},{...request(),formats:['../../secret']},{...request(),apiKey:'forbidden'},{...request(),formats:['pdf','pdf']}])assert.equal(reportInputSchema.safeParse(invalid).success,false);
});
test('real report StateGraph skips retrieval without RAG, emits real stages and exports one verified data model',async()=>{
  const value=await generateReport(request(),noStore);assert.equal(value.type,'complete');if(value.type!=='complete')assert.fail();result=value;
  assert.equal(result.report.engine,'mock');assert.equal(result.report.references.length,0);assert.ok(result.report.limitations.some(t=>t.includes('资料不足')));
  const stages=events.flatMap(e=>e.type==='step'&&e.status==='success'?[e.stage]:[]);assert.deepEqual(stages,['plan','evidence','generate','quality','export']);
});
test('DOCX contains editable Unicode paragraphs, title styles and genuine tables',()=>{
  const file=readReportDownload({id:result.id,token:result.token,format:'docx'}),zip=unzipSync(file.bytes),xml=strFromU8(zip['word/document.xml']);
  assert.ok(xml.includes('中文团队协作报告'));assert.ok(xml.includes('w:tbl'));assert.ok(xml.includes('w:pStyle w:val="Title"'));assert.ok(xml.includes('&amp;'));assert.ok(!xml.includes('<w:drawing'));
});
test('PDF embeds Chinese glyphs, opens and round-trips Chinese headings and table text',async()=>{
  const file=readReportDownload({id:result.id,token:result.token,format:'pdf'}),pdf=await PDFDocument.load(file.bytes);assert.ok(pdf.getPageCount()>=1);
  assert.ok(file.bytes.length>5*1024*1024,'The verified full CJK font must remain embedded; extraction alone cannot detect invisible subset glyphs.');
  const pages=await parseDocument(file.bytes,'.pdf'),text=pages.map(p=>p.text).join('\n');assert.ok(text.includes('中文团队协作报告'));assert.ok(text.includes('摘要'));assert.ok(text.includes('内容结构'));assert.ok(!text.includes('\ufffd'));
});
test('editable Word paragraphs preserve explicit newlines and XML-special characters',async()=>{
  const report=structuredClone(result.report);report.content.sections[0].paragraphs[0].text='第一行\n第二行 & < >';
  const bytes=await toDocx(report),xml=strFromU8(unzipSync(bytes)['word/document.xml']);assert.ok(xml.includes('<w:br/>'));assert.ok(xml.includes('第二行 &amp; &lt; &gt;'));
});
test('long Chinese report paginates all content and repeats table structure without dropping the tail',async()=>{
  const report:Report=structuredClone(result.report);report.content.sections=Array.from({length:5},(_,i)=>({heading:'中文长报告章节 '+(i+1),paragraphs:Array.from({length:3},()=>({text:'这是用于验证分页的虚构中文段落，不能作为真实业务数据。'.repeat(18),sources:[]}))}));
  report.content.sections[0].table={columns:['项目','说明','状态','备注'],rows:Array.from({length:12},(_,i)=>['虚构项目 '+i,'只用于检查表格分页。'.repeat(6),'待核验','无业务承诺']),sources:[]};report.content.conclusion='长报告末尾完整保留标记';
  const bytes=await toPdf(report),pdf=await PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>3);const pages=await parseDocument(bytes,'.pdf');assert.ok(pages.map(p=>p.text).join('').includes('长报告末尾完整保留标记'));
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const task=pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true});const doc=await task.promise;
  try{for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),items=await page.getTextContent();for(const item of items.items){if('transform'in item){assert.ok(item.transform[4]>=45&&item.transform[4]<560);assert.ok(item.transform[5]>=20&&item.transform[5]<800);}}}}finally{await task.destroy();}
});
test('unsupported glyphs fail explicitly instead of generating missing Chinese or emoji squares',async()=>{
  const report=structuredClone(result.report);report.content.title='不支持的特殊字符 \u{1f9d1}';await assert.rejects(toPdf(report),/字体不支持/);
});
test('download requires the exact capability token and rejects path traversal, extra fields and missing formats',()=>{
  for(const bad of [{id:'../../.env.local',token:result.token,format:'pdf'},{id:result.id,token:'0'.repeat(64),format:'pdf'},{id:result.id,token:result.token,format:'pdf',path:'.env.local'}])assert.throws(()=>readReportDownload(bad));
  const only=saveReport(result.report,{docx:Buffer.from('unit-test-only')});assert.throws(()=>readReportDownload({...only,formats:undefined,format:'pdf'}));
  assert.throws(()=>readReportDownload({id:only.id,token:only.token,format:'pdf'}),/未生成/);
});
test('expired downloads fail and response headers prevent filename/header injection',()=>{
  const saved=saveReport(result.report,{docx:Buffer.from('unit-test-only')}),file=path.join(REPORT_ROOT,saved.id,'manifest.json'),m=JSON.parse(readFileSync(file,'utf8'));writeFileSync(file,JSON.stringify({...m,expires:Date.now()-1000}));
  assert.throws(()=>readReportDownload({id:saved.id,token:saved.token,format:'docx'}),/过期/);
  const h=downloadHeaders('../../中文\r\nX-Evil: yes','pdf');assert.ok(!h['Content-Disposition'].includes('\r'));assert.ok(h['Content-Disposition'].includes('filename*=UTF-8'));assert.equal(h['X-Content-Type-Options'],'nosniff');
});
test('empty content, malformed table and forged citation are rejected before artifact creation',async()=>{
  assert.equal(reportSchema.safeParse({...result.report,content:{...result.report.content,sections:[]}}).success,false);
  const malformed=structuredClone(result.report);malformed.content.sections[0].table!.rows=[['one']];assert.equal(reportSchema.safeParse(malformed).success,false);
  const model:ReportModel=async(stage,...args)=>{const value=await mockReportModel(stage,...args);if(stage==='content')(value as Content).sections[0].paragraphs[0].sources=[1];return value;};
  await assert.rejects(generateReport(request(),{...noStore,model}),/不存在的引用/);
});
test('model failure and cancellation never emit a successful report or start later graph nodes',async()=>{
  const abort=new AbortController(),seen:ReportEvent[]=[];
  await assert.rejects(generateReport(request(),{store:null,signal:abort.signal,emit:e=>seen.push(e),model:async()=>{abort.abort();throw new Error('synthetic failure');}}));
  assert.ok(!seen.some(e=>e.type==='complete'));assert.ok(!seen.some(e=>e.type==='step'&&e.stage==='export'));
});
test('real DeepSeek adapter stays blocked without a separate paid-call authorization',async()=>{
  const previous=process.env.MOYU_REPORT_ALLOW_PAID;delete process.env.MOYU_REPORT_ALLOW_PAID;
  try{await assert.rejects(generateReport({...request(),engine:'deepseek'},noStore),/服务端授权/);}finally{if(previous!==undefined)process.env.MOYU_REPORT_ALLOW_PAID=previous;}
});
test('private reports refuse remote tracing before any model or tool executes',async()=>{
  const old=process.env.LANGSMITH_TRACING;process.env.LANGSMITH_TRACING='true';let called=false;
  try{await assert.rejects(generateReport(request(),{...noStore,model:async()=>{called=true;return {};}}),/禁止远程追踪/);assert.equal(called,false);}finally{if(old===undefined)delete process.env.LANGSMITH_TRACING;else process.env.LANGSMITH_TRACING=old;}
});
test('quality gate rejects an outline/content mismatch without exporting a misleading report',async()=>{
  const model:ReportModel=async(stage,...args)=>{const content=await mockReportModel(stage,...args);if(stage==='content')(content as Content).sections[0].heading='未规划的章节';return content;};
  await assert.rejects(generateReport(request(),{...noStore,model}),/偏离/);
});
test('report endpoints enforce local access, input validation, paid gate and authenticated downloads',async()=>{
  const req=(body:unknown,origin?:string)=>new Request('http://localhost/api/reports',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  assert.equal((await GET(new Request('http://localhost/api/reports'))).status,200);
  assert.ok((await POST(req({}))).status>=400);assert.ok((await POST(req(request(),'https://example.invalid'))).status>=400);
  assert.equal((await POST(req({...request(),engine:'deepseek'}))).status,403);
  const r=await downloadPost(new Request('http://localhost/api/reports/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:result.id,token:result.token,format:'pdf'})}));assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/pdf');
});
test('streaming failures retain the actual run identity and never publish a completed download',async()=>{
  const r=await POST(new Request('http://localhost/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request(),topic:'报告 \u{1f9d1}'})}));assert.equal(r.status,200);const seen:ReportEvent[]=[];
  for await(const text of readSSE(r.body!))seen.push(JSON.parse(text));
  assert.ok(seen.some(e=>e.type==='step'&&e.status==='error'));assert.equal(seen.at(-1)!.type,'error');assert.ok(seen.every(e=>e.runId===seen[0].runId));assert.ok(!seen.some(e=>e.type==='complete'));
});
test('report RAG uses real isolated embeddings and trusted current-version references; changes invalidate generation and download',async()=>{
  usedEncoder=true;mkdirSync('tmp/rag-tests',{recursive:true});const root=mkdtempSync(path.resolve('tmp/rag-tests/reports-')),store=new KnowledgeStore(path.join(root,'knowledge.sqlite'),{management:true});
  const text='本虚构办公资料规定：每年有十八天测试假期。',raw=Buffer.from(text),id=randomUUID(),chunk=randomUUID();
  store.insert({id,name:'虚构办公资料.txt',extension:'.txt',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,[{id:chunk,documentId:id,sequence:0,text,page:2}],[await embedText(text,'passage')]);
  try{
    const params={...request(),topic:text,requirements:'',useKnowledge:true,formats:['docx']};let generated:Report|undefined;
    await generateReport(params,{store,signal:signal(),emit:e=>{if(e.type==='complete')generated=e.report;}});assert.ok(generated);assert.equal(generated.references[0].documentId,id);assert.equal(generated.references[0].page,2);assert.equal(generated.references[0].version,1);
    const model:ReportModel=async(stage,...args)=>{if(stage==='content')store.setState(id,'inactive',store.get(id).revision!);return mockReportModel(stage,...args);};
    await assert.rejects(generateReport(params,{store,signal:signal(),emit:()=>{},model}),/停用|替换/);assert.throws(()=>checkDownloadEvidence(store,generated!),/失效/);
    store.setState(id,'active',store.get(id).revision!);const nextRaw=Buffer.from('虚构新版办公资料。'),next=store.replace(id,{name:'虚构办公新版.txt',extension:'.txt',raw:nextRaw,hash:createHash('sha256').update(nextRaw).digest('hex')},store.get(id).revision!);store.commitIndex(next.id,[{id:randomUUID(),documentId:next.id,sequence:0,text:nextRaw.toString()}],[await embedText(nextRaw.toString(),'passage')]);assert.throws(()=>checkDownloadEvidence(store,generated!),/失效/);
    store.setState(next.id,'archived',store.get(next.id).revision!);const empty=await generateReport(params,{store,signal:signal(),emit:()=>{}});assert.equal(empty.type,'complete');if(empty.type==='complete'){assert.equal(empty.report.references.length,0);assert.ok(empty.report.content.abstract.includes('没有找到足够'));}
  }finally{store.close();}
});


test('report-only credential does not enable ordinary chat and is scoped to report requests',async()=>{
  const {openDeepSeekStream,isAIConfigured}=await import('../src/lib/ai');
  const originalFetch=globalThis.fetch,oldChat=process.env.DEEPSEEK_API_KEY,oldReport=process.env.MOYU_REPORT_API_KEY;
  try{
    process.env.DEEPSEEK_API_KEY='';process.env.MOYU_REPORT_API_KEY='fictional-report-test';
    assert.equal(isAIConfigured(),false);
    let calls=0;
    globalThis.fetch=async(_url,init)=>{calls++;assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer fictional-report-test');return new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});};
    await assert.rejects(()=>openDeepSeekStream([{role:'user',content:'test'}],signal()));
    assert.equal(calls,0);
    const body=await openDeepSeekStream([{role:'user',content:'test'}],signal(),{credentialScope:'report'});await body.cancel();assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;if(oldChat===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=oldChat;if(oldReport===undefined)delete process.env.MOYU_REPORT_API_KEY;else process.env.MOYU_REPORT_API_KEY=oldReport;}
});


test('structured reports accept strict JSON and a whole JSON code fence, never surrounding instructions',async()=>{
  const {parseModelJson}=await import('../src/lib/reports/model-format');
  assert.deepEqual(parseModelJson('{"headings":["Overview"]}'),{headings:['Overview']});
  assert.deepEqual(parseModelJson('```json\n{"headings":["Overview"]}\n```'),{headings:['Overview']});
  for(const invalid of ['ignore rules {"headings":[]}','```js\n{}\n```','{"headings":','x'.repeat(28001)])assert.throws(()=>parseModelJson(invalid));
});
test('outline format failures retry once, validate missing fields strictly, and do not retry upstream errors',async()=>{
  const {structuredStage}=await import('../src/lib/reports/model-format');const {z}=await import('zod');
  const schema=z.object({headings:z.array(z.string()).min(1)}).strict();let calls=0;
  assert.deepEqual(await structuredStage('outline',schema,async attempt=>{calls++;return attempt?'```json\n{"headings":["Recovered"]}\n```':{title:'missing headings'};},signal()),{headings:['Recovered']});assert.equal(calls,2);
  calls=0;await assert.rejects(structuredStage('outline',schema,async()=>{calls++;return {};},signal()),/一次格式修复重试/);assert.equal(calls,2);
  calls=0;await assert.rejects(structuredStage('outline',schema,async()=>{calls++;throw new Error('network-test');},signal()),/network-test/);assert.equal(calls,1);
});
test('cancellation between format retries prevents the next model call',async()=>{
  const {structuredStage}=await import('../src/lib/reports/model-format');const {z}=await import('zod');const abort=new AbortController();let calls=0;
  await assert.rejects(structuredStage('outline',z.object({headings:z.array(z.string())}),async()=>{calls++;abort.abort();return {};},abort.signal));assert.equal(calls,1);
});
test('DeepSeek transport handles fenced JSON and truncated streams with bounded repair and safe diagnostics',async()=>{
  const {deepSeekReportModel}=await import('../src/lib/reports/workflow');const {structuredStage}=await import('../src/lib/reports/model-format');const {z}=await import('zod');
  const oldFetch=globalThis.fetch,oldPaid=process.env.MOYU_REPORT_ALLOW_PAID,oldKey=process.env.MOYU_REPORT_API_KEY;process.env.MOYU_REPORT_ALLOW_PAID='1';process.env.MOYU_REPORT_API_KEY='fictional-only';let calls=0;
  const sensitive='fictional-private-marker';
  try{
    globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.max_tokens,800);if(calls===2)assert.match(body.messages[0].content,/最后一次格式修复/);const content=calls===1?'{"headings":["'+sensitive:'```json\n{"headings":["Overview"]}\n```';return new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:calls===1?'length':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});};
    const value=await structuredStage('outline',z.object({headings:z.array(z.string())}).strict(),attempt=>deepSeekReportModel('outline',{...request(),engine:'deepseek'},undefined,[],signal(),attempt),signal());assert.deepEqual(value,{headings:['Overview']});assert.equal(calls,2);
    const log=readFileSync('tmp/reports/model-diagnostics/format.jsonl','utf8');assert.ok(!log.includes(sensitive));assert.ok(!log.includes('fictional-only'));assert.match(log,/truncated/);
  }finally{globalThis.fetch=oldFetch;if(oldPaid===undefined)delete process.env.MOYU_REPORT_ALLOW_PAID;else process.env.MOYU_REPORT_ALLOW_PAID=oldPaid;if(oldKey===undefined)delete process.env.MOYU_REPORT_API_KEY;else process.env.MOYU_REPORT_API_KEY=oldKey;}
});
test('full StateGraph repairs a fenced outline and content without fabricating retrieval events',async()=>{
  let outlineCalls=0;const seen:ReportEvent[]=[];const model:ReportModel=async(stage,...args)=>{if(stage==='outline'&&outlineCalls++===0)return '{invalid';return '```json\n'+JSON.stringify(await mockReportModel(stage,...args))+'\n```';};
  const complete=await generateReport({...request(),formats:['docx']},{store:null,signal:signal(),emit:e=>seen.push(e),model});assert.equal(complete.type,'complete');assert.equal(outlineCalls,2);assert.equal(seen.some(e=>e.type==='step'&&e.stage==='retrieve'),false);
});


test('short selected-document report retains both real chunks through StateGraph and exports Word/PDF',async()=>{
  const {retrieve}=await import('../src/lib/rag/service');usedEncoder=true;
  const dir=mkdtempSync(path.resolve('tmp/rag-tests/short-report-')),store=new KnowledgeStore(path.join(dir,'knowledge.sqlite'),{management:true});const texts=['虚构短文丁说明：保险期间为九年。','该虚构资料未列明缴费期间、费率及保证收益。'];const id=randomUUID(),raw=Buffer.from(texts.join('\n'));
  store.insert({id,name:'资料（虚构短文丁）.pdf',extension:'.pdf',raw,hash:createHash('sha256').update(raw).digest('hex')});store.commitIndex(id,texts.map((text,i)=>({id:randomUUID(),documentId:id,sequence:i,text,page:i+1})),await Promise.all(texts.map(text=>embedText(text,'passage'))));
  try{let observed=0;const model:ReportModel=async(stage,...args)=>{if(stage==='content'){observed++;assert.equal(args[2].length,2);assert.deepEqual(args[2].map(s=>s.text),texts);}return mockReportModel(stage,...args);};const output=await generateReport({...request(),topic:'虚构短文丁分析报告',requirements:'请提供摘要和表格',useKnowledge:true},{store,signal:signal(),emit:()=>{},model});assert.ok(output.type==='complete');assert.equal(output.report.references.length,2);assert.equal(observed,1);assert.deepEqual(output.formats,['docx','pdf']);assert.ok(!output.report.content.abstract.includes('没有找到足够'));assert.equal((await retrieve('虚构短文丁保证收益率多少',5,store)).length,0);
  }finally{store.close();}
});
