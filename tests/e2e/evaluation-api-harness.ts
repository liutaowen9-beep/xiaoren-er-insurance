/** IPC-only isolated real API fixture; never exposes a production API or accepts DB paths from the browser. */
import path from 'node:path';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { createEvaluationApi } from '../../src/lib/evaluation/api';
import { EvaluationStore } from '../../src/lib/evaluation/store';

if(!process.send||process.env.MOYU_REPORT_TESTING!=='1')throw Error('Isolated child process required');
mkdirSync('tmp/rag-tests',{recursive:true});
const root=mkdtempSync(path.resolve('tmp/rag-tests/evaluation-browser-origin-'));
const file=path.join(root,'evaluation.sqlite'),handle=createEvaluationApi(()=>new EvaluationStore(file));
type Input={id:number;url:string;method:string;headers:Record<string,string>;body?:string};
process.on('message',async({id,url,method,headers,body}:Input)=>{
  try{
    // Use installed NextRequest: it reproduces Next.js loopback-host normalization, unlike plain Request mocks.
    const request=new NextRequest(url,{method,headers,...(body!==undefined?{body}:{})});
    const response=await handle(request,new URL(url).pathname.split('/').slice(3));
    process.send?.({id,status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers),normalizedUrl:request.url});
  }catch{process.send?.({id,status:500,body:'{"error":"隔离测试服务失败"}',headers:{'content-type':'application/json'}});}
});
process.send({ready:true});
