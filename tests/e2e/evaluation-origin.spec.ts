import { spawn,type ChildProcess } from 'node:child_process';
import { test as base,expect } from './fixtures';

type Output={id:number;status:number;body:string;headers:Record<string,string>;normalizedUrl:string};
type BrowserEvidence={url:string;method:string;origin:string|undefined;host:string;referer:string|undefined;contentType:string|undefined;status:number;response:string;normalizedUrl:string};
type Harness={request:(url:string,method:string,headers:Record<string,string>,body?:string)=>Promise<Output>;evidence:BrowserEvidence[]};
const test=base.extend<{realEvaluation:Harness}>({
  realEvaluation:[async({page},useHarness,info)=>{
    const env={...process.env,MOYU_REPORT_TESTING:'1',MOYU_E2E:'1',DEEPSEEK_API_KEY:'',MOYU_REPORT_API_KEY:'',MOYU_REPORT_ALLOW_PAID:'0'};
    for(const key of Object.keys(env))if(/^MOYU_(?:RAG_|MIGRATION_|MAINTENANCE|V7_)/.test(key))delete env[key as keyof typeof env];
    const child:ChildProcess=spawn(process.execPath,['--conditions=react-server','--import','tsx','tests/e2e/evaluation-api-harness.ts'],{env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    const pending=new Map<number,{resolve:(v:Output)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let sequence=0;
    const ready=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离评测 API 启动超时')),10000);child.on('message',(m:Output&{ready?:boolean})=>{if(m.ready){clearTimeout(timer);resolve();return;}const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);p.resolve(m);}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);if(code)reject(Error('隔离评测 API 提前退出'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('隔离评测 API 已结束'));}pending.clear();});});
    const harness:Harness={evidence:[],request:(url,method,headers,body)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('隔离评测请求超时'));},10000);pending.set(id,{resolve,reject,timer});child.send({id,url,method,headers,body});})};
    try{
      await ready;
      await page.route('**/api/evaluation/**',async route=>{
        const request=route.request(),headers=await request.allHeaders(),host=headers.host??new URL(request.url()).host;
        const result=await harness.request(request.url(),request.method(),{...headers,host},request.postData()??undefined);
        harness.evidence.push({url:request.url(),method:request.method(),origin:headers.origin,host,referer:headers.referer,contentType:headers['content-type'],status:result.status,response:request.method()==='POST'?result.body:'[metadata omitted]',normalizedUrl:result.normalizedUrl});
        await route.fulfill({status:result.status,headers:result.headers,body:result.body});
      });
      await useHarness(harness);
    }finally{
      await info.attach('actual-browser-origin-requests',{body:JSON.stringify(harness.evidence,null,2),contentType:'application/json'});
      // Only the child created by this fixture is stopped; isolated DBs remain under the ignored test directory.
      child.kill();
    }
  },{auto:true}],
});

test('same-origin browser create persists across refresh and repeated creation follows existing rules',async({page,realEvaluation})=>{
  await page.goto('/evaluation/datasets');await page.getByRole('button',{name:'填入合成示例'}).click();await expect(page.getByLabel('数据集 JSON')).toContainText('合成中文');
  await page.getByRole('button',{name:'创建数据集',exact:true}).click();await expect(page.getByRole('cell',{name:'合成中文离线规则示例',exact:true})).toBeVisible();
  const evidence=realEvaluation.evidence.find(r=>r.method==='POST');expect(evidence).toMatchObject({url:'http://127.0.0.1:3108/api/evaluation/datasets',origin:'http://127.0.0.1:3108',host:'127.0.0.1:3108',contentType:'application/json',status:200});expect(new URL(evidence!.normalizedUrl).hostname).toBe('localhost');
  await page.reload();await expect(page.getByRole('cell',{name:'合成中文离线规则示例',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'填入合成示例'}).click();await page.getByRole('button',{name:'创建数据集',exact:true}).click();await expect(page.getByRole('cell',{name:'合成中文离线规则示例',exact:true})).toHaveCount(2);
});
test('invalid JSON is blocked locally and missing fields rejected by actual API without losing valid data',async({page,realEvaluation})=>{
  await page.goto('/evaluation/datasets');await page.getByLabel('数据集 JSON').fill('{invalid');await page.getByRole('button',{name:'创建数据集',exact:true}).click();await expect(page.getByRole('main').getByRole('alert')).toBeVisible();expect(realEvaluation.evidence.filter(r=>r.method==='POST')).toHaveLength(0);
  await page.getByLabel('数据集 JSON').fill('{"name":"合成缺字段"}');await page.getByRole('button',{name:'创建数据集',exact:true}).click();await expect(page.getByRole('main').getByRole('alert')).toContainText('输入校验失败');expect(realEvaluation.evidence.find(r=>r.method==='POST')?.status).toBe(400);
  await page.getByRole('button',{name:'填入合成示例'}).click();await page.getByRole('button',{name:'创建数据集',exact:true}).click();await expect(page.getByRole('cell',{name:'合成中文离线规则示例',exact:true})).toBeVisible();
});
test('real security handler rejects foreign origins alias mismatch wrong ports and forged forwarding headers',async({page,realEvaluation})=>{
  await page.goto('/evaluation/datasets');
  const url='http://127.0.0.1:3108/api/evaluation/datasets';
  for(const origin of ['https://evil.example','http://localhost:3108','http://127.0.0.1:3002','null']){
    const r=await realEvaluation.request(url,'POST',{host:'127.0.0.1:3108',origin,'content-type':'application/json','x-forwarded-host':'evil.example'},'{invalid');expect(r.status).toBe(403);
  }
  const legitimate=await realEvaluation.request(url,'POST',{host:'127.0.0.1:3108',origin:'http://127.0.0.1:3108','content-type':'application/json'},'{invalid');expect(legitimate.status).toBe(400);
  const local=await realEvaluation.request('http://localhost:3108/api/evaluation/datasets','POST',{host:'localhost:3108',origin:'http://localhost:3108','content-type':'application/json'},'{invalid');expect(local.status).toBe(400);
});
