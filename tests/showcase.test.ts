import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { CAPABILITIES, CORE_MODULES, chatEntry } from '../src/lib/showcase';
import { DEFAULT_BRAND, decodeBrand, serializeBrand } from '../src/lib/branding';

test('five core destinations and implemented capability entries retain distinct routes',()=>{
  assert.deepEqual(CORE_MODULES.map(m=>m.href),['/','/knowledge','/analysis','/reports','/architecture']);
  assert.equal(new Set(CORE_MODULES.map(m=>m.id)).size,5);
  assert.equal(CAPABILITIES.find(c=>c.id==='analysis')?.status,'implemented');
  assert.deepEqual(CAPABILITIES.filter(c=>c.status==='implemented').map(c=>c.href),['/?mode=knowledge','/analysis','/?mode=agent','/reports']);
});

test('old root assistant deep links accept only known scalar modes',()=>{
  for(const mode of ['chat','knowledge','agent'])assert.equal(chatEntry(mode),true);
  for(const mode of [undefined,null,'reports','unknown',['agent'],'',{},42])assert.equal(chatEntry(mode),false);
});

test('existing V8 brand preferences round trip without changing routes or overwriting custom subtitle',()=>{
  const saved={...DEFAULT_BRAND,siteName:'演示平台',subtitle:'我的原有副标题',knowledgeName:'我的资料',reportName:'交付中心',agentName:'任务助手'};
  assert.deepEqual(decodeBrand(serializeBrand(saved)),saved);
  assert.equal(DEFAULT_BRAND.subtitle,'AI 保险智能解决方案平台');
  assert.equal(CORE_MODULES.find(m=>m.id==='knowledge')?.href,'/knowledge');
});

function rendered(page:string,mode?:string){
  const script=`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import PageModule from ${JSON.stringify(page)};const Page=typeof PageModule==='function'?PageModule:PageModule.default;import {BrandProvider} from './src/components/brand-provider.tsx';const element=await Page({searchParams:Promise.resolve(${JSON.stringify({mode})})});console.log(renderToStaticMarkup(React.createElement(BrandProvider,null,element)));`;
  return execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8'});
}

test('workbench renders honest portfolio scope, empty activity and five navigation links',()=>{
  const html=rendered('./src/app/page.tsx');
  for(const text of ['AI 保险智能解决方案平台','AI 业务工作台','技术架构展示','客户需求分析 Agent 已接入','当前浏览器还没有可展示的对话记录','V10.2 · 本地 AI 解决方案平台','用于 AI 产品功能展示与技术验证，非保险销售系统或生产环境。'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('面向 AI 售前解决方案顾问面试的技术作品。'));
  assert.ok(!html.includes('documentId'));assert.ok(!html.includes('runId'));
  for(const m of CORE_MODULES)assert.ok(html.includes(`href="${m.href}"`));
});

test('legacy modes render existing chat instead of the workbench; new alias is compatible',()=>{
  for(const mode of ['chat','knowledge','agent']){
    const html=rendered('./src/app/page.tsx',mode);assert.ok(html.includes('chat-mode-tabs'));assert.ok(!html.includes('suite-hero-copy'));
  }
  assert.ok(rendered('./src/app/chat/page.tsx').includes('chat-mode-tabs'));
});

test('analysis page declares unimplemented capabilities and architecture identifies static diagrams',()=>{
  const analysis=rendered('./src/app/analysis/page.tsx');
  for(const text of ['客户需求分析与产品对比已接入','不作自动适合性判断','开始需求分析'])assert.ok(analysis.includes(text));
  assert.ok(analysis.includes('href="/analysis/needs"'));assert.ok(analysis.includes('href="/analysis/compare"'));assert.ok(!analysis.includes('<form'));
  const architecture=rendered('./src/app/architecture/page.tsx');
  for(const text of ['不是伪造的运行日志','knowledge_search','document_analyze','384','未启用'])assert.ok(architecture.includes(text),text);
});
