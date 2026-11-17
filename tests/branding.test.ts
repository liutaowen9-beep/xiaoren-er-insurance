import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandSchema, DEFAULT_BRAND, decodeBrand, serializeBrand, brandPalette, contrast, foregroundFor, BRAND_STORAGE_KEY } from '../src/lib/branding';
import { PRODUCT_NAME, LEGACY_PRODUCT_NAMES, PRODUCT_BRAND_RULE, withProductBrand } from '../src/lib/product-identity';
import { inspectBrand } from '../scripts/check-brand';
import {toDocx,toPdf} from '../src/lib/reports/export';
import type {Report} from '../src/lib/reports/types';
import {parseDocument} from '../src/lib/rag/parse';
import {unzipSync,strFromU8} from 'fflate';
import {PDFDocument} from 'pdf-lib';

test('branding defaults match the product and do not share history or credential storage keys',()=>{
  assert.ok(brandSchema.safeParse(DEFAULT_BRAND).success);
  assert.equal(DEFAULT_BRAND.siteName,'小人儿保险');assert.equal(DEFAULT_BRAND.welcome,'让小人儿给您说道说道');
  assert.notEqual(BRAND_STORAGE_KEY,'moyu-conversations-v1');assert.notEqual(BRAND_STORAGE_KEY,'moyu-theme');
  assert.deepEqual(Object.keys(DEFAULT_BRAND).sort(),['siteName','subtitle','welcome','chatName','knowledgeName','reportName','agentName','primary','secondary','logoText'].sort());
});
test('all website and module labels round trip as display settings without changing internal mode IDs',()=>{
  const custom={...DEFAULT_BRAND,siteName:'我的顾问平台',subtitle:'自定义副标题',welcome:'欢迎回来',chatName:'沟通助手',knowledgeName:'资料馆',reportName:'分析中心',agentName:'任务管家',logoText:'顾问',primary:'#234567',secondary:'#ABCDEF'};
  assert.deepEqual(decodeBrand(serializeBrand(custom)),custom);
  assert.equal(decodeBrand(serializeBrand({...custom,siteName:'  顾问平台  '})).siteName,'顾问平台');
  for(const mode of ['chat','knowledge','agent'])assert.ok(!Object.hasOwn(custom,mode));
});
test('invalid fields, color injection, unbounded storage and control characters are rejected',()=>{
  for(const patch of [{siteName:''},{siteName:'字'.repeat(25)},{chatName:'字'.repeat(17)},{welcome:'字'.repeat(65)},{logoText:'字'.repeat(5)},{primary:'url(x)'},{secondary:'red'},{primary:'#12345Z'},{subtitle:'foo\u0000bar'},{apiKey:'forbidden'},{route:'/api/other'}])assert.throws(()=>serializeBrand({...DEFAULT_BRAND,...patch}));
  assert.throws(()=>decodeBrand('x'.repeat(5001)));assert.throws(()=>decodeBrand('{invalid'));assert.throws(()=>decodeBrand('{"__proto__":{"admin":true}}'));
});
test('restoring defaults returns fresh independent values and ignores no unknown fields',()=>{
  const a=decodeBrand(null),b=decodeBrand(null);a.siteName='临时名称';assert.equal(b.siteName,DEFAULT_BRAND.siteName);assert.equal(decodeBrand(serializeBrand(DEFAULT_BRAND)).siteName,DEFAULT_BRAND.siteName);assert.equal(DEFAULT_BRAND.siteName,'小人儿保险');
});
test('custom color choices retain readable text in light and dark surfaces',()=>{
  for(const primary of ['#ffffff','#000000','#ffff00','#ff0000','#00ff00','#173f35','#808080'])for(const dark of [false,true]){
    const palette=brandPalette({...DEFAULT_BRAND,primary,secondary:primary},dark),bg=dark?'#101b17':'#f7f3ea';
    assert.ok(contrast(primary,foregroundFor(primary))>=4.5);
    assert.ok(contrast(palette['--accent'],bg)>=4.5);
    assert.ok(contrast(palette['--secondary-ink'],bg)>=4.5);
    assert.ok(contrast(palette['--sidebar-gold'],primary)>=4.5);
    assert.equal(palette['--brand-solid'],primary);
  }
});

test('saved legacy display aliases render the current identity without rewriting original settings or storage keys',()=>{
  for(const alias of LEGACY_PRODUCT_NAMES){
    const raw=JSON.stringify({...DEFAULT_BRAND,siteName:alias,chatName:alias,knowledgeName:alias,reportName:alias,agentName:alias,primary:'#123456'});
    const saved=JSON.parse(raw),decoded=decodeBrand(raw);
    assert.equal(decoded.siteName,PRODUCT_NAME);assert.equal(decoded.primary,saved.primary);
    for(const field of ['chatName','knowledgeName','reportName','agentName'] as const)assert.equal(decoded[field],PRODUCT_NAME);
    assert.equal(JSON.parse(serializeBrand(saved)).siteName,PRODUCT_NAME);
    assert.equal(JSON.parse(raw).siteName,alias);
  }
  assert.equal(BRAND_STORAGE_KEY,'moyu-branding-v1');
  assert.equal(decodeBrand(JSON.stringify({...DEFAULT_BRAND,siteName:'自定义工作空间'})).siteName,'自定义工作空间');
});

test('shared model brand rule is idempotent, preserves instructions and does not mutate quoted evidence',()=>{
  const instruction='只输出 JSON，证据必须逐字引用。';
  const branded=withProductBrand(instruction);
  assert.ok(branded.startsWith(PRODUCT_BRAND_RULE));assert.ok(branded.endsWith(instruction));
  assert.equal(withProductBrand(branded),branded);
  assert.ok(PRODUCT_BRAND_RULE.includes(PRODUCT_NAME));assert.ok(PRODUCT_BRAND_RULE.includes('不改写保险产品名称'));
});

test('project-owned source, configuration and docs consistently use the formal identity',()=>{
  const result=inspectBrand();assert.deepEqual(result.findings,[]);assert.ok(result.filesScanned>100);
});

test('editable Word and Chinese PDF carry the formal author/footer and preserve source quotations',async()=>{
  const quote=LEGACY_PRODUCT_NAMES[0];
  const report:Report={engine:'mock',createdAt:new Date().toISOString(),limitations:['合成品牌测试'],references:[],content:{title:'品牌一致性测试报告',abstract:'合成测试摘要',sections:[{heading:'原文保留测试',paragraphs:[{text:quote,sources:[]}]}],conclusion:'仅验证导出，不调用模型。'}};
  const docx=unzipSync(await toDocx(report));
  assert.ok(strFromU8(docx['docProps/core.xml']).includes(PRODUCT_NAME));
  assert.ok(strFromU8(docx['word/footer1.xml']).includes(PRODUCT_NAME));
  assert.ok(strFromU8(docx['word/document.xml']).includes(quote));
  const pdf=await toPdf(report);assert.equal((await PDFDocument.load(pdf)).getAuthor(),PRODUCT_NAME);
  const text=(await parseDocument(pdf,'.pdf')).map(p=>p.text).join('');assert.ok(text.includes(PRODUCT_NAME));assert.ok(text.includes(quote));
});
