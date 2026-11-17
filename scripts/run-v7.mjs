import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
const mode=process.argv[2]??'dev';
if(!['dev','build','start'].includes(mode))throw new Error('Unsupported mode');
// Load the existing server configuration without printing or changing its contents.
const require=createRequire(import.meta.url);
const nextRequire=createRequire(require.resolve('next/package.json'));
nextRequire('@next/env').loadEnvConfig(process.cwd(),mode==='dev',{info(){},error(){}});
const reportKey=process.env.DEEPSEEK_API_KEY?.trim()??'';
const env={...process.env,MOYU_V7_BUILD:'1',MOYU_REPORT_ALLOW_PAID:mode==='build'?'0':'1',MOYU_REPORT_API_KEY:mode==='build'?'':reportKey,DEEPSEEK_API_KEY:mode==='build'?'':reportKey};
delete env.MOYU_RAG_DEPLOYMENT;delete env.MOYU_RAG_ACCESS;
delete env.MOYU_RAG_READONLY_BASELINE;
// A separate explicit registration selects a fresh local library, never changes old receipts.
delete env.MOYU_RAG_LOCAL_ROOT;
const localConnection=path.resolve('tmp/reports/local-knowledge.json');
if(mode!=='build'&&existsSync(localConnection)){
  if(lstatSync(localConnection).isSymbolicLink())throw new Error('Invalid local knowledge connection');
  const config=JSON.parse(readFileSync(localConnection,'utf8'));
  if(Object.keys(config).join(',')!=='root'||typeof config.root!=='string'||!path.isAbsolute(config.root))throw new Error('Invalid local knowledge connection');
  env.MOYU_RAG_LOCAL_ROOT=config.root;
}
const connection=path.resolve('tmp/reports/knowledge-connection.json');
if(!env.MOYU_RAG_LOCAL_ROOT&&mode!=='build'&&process.env.MOYU_V7_KNOWLEDGE!=='sandbox'&&existsSync(connection)){
  if(lstatSync(connection).isSymbolicLink())throw new Error('Knowledge connection must be a regular local file');
  const config=JSON.parse(readFileSync(connection,'utf8'));
  if(Object.keys(config).join(',')!=='deployment'||typeof config.deployment!=='string'||!path.isAbsolute(config.deployment))throw new Error('Invalid knowledge connection');
  env.MOYU_RAG_DEPLOYMENT=config.deployment;
  env.MOYU_RAG_ACCESS='read-only';
  env.MOYU_RAG_READONLY_BASELINE='4243fc5fd1a0386d45d81bdf7e5e85acdc448e01';
}
delete env.MOYU_REPORT_TESTING;delete env.MOYU_MIGRATION_TESTING;
const extra=process.argv.slice(3),args=mode==='build'?['build']:[mode,'--hostname','127.0.0.1',...(extra.length?extra:['--port','3002'])];
const child=spawn(process.execPath,['node_modules/next/dist/bin/next',...args],{env,stdio:'inherit',windowsHide:true});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
