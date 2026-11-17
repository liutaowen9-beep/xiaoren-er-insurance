import {test,expect} from './fixtures';
const run='44444444-4444-4444-8444-444444444444',query='55555555-5555-4555-8555-555555555555',asset='a'.repeat(64),now=Date.now();
const runRecord={id:run,type:'agent',workflow:'langgraph-agent',mode:'mock',library_id:null,model:null,started_at:now-20,ended_at:now,status:'success',elapsed_ms:20,input_tokens:null,output_tokens:null,error_code:null};
const request={id:query,run_id:run,parent_id:null,library_id:null,query_hash:'b'.repeat(64),query_length:8,profile:'needs-hybrid-v1',top_k:5,started_at:now-10,elapsed_ms:8,status:'success',error_code:null};
const hit={rank:1,document_id:'66666666-6666-4666-8666-666666666666',version:1,chunk_id:'77777777-7777-4777-8777-777777777777',page:2,score:null,method:'document-evidence',documentName:'E2E 虚构资料',assetId:asset};
test.beforeEach(async({page})=>{
  await page.route('**/api/data-platform/**',route=>{
    const url=new URL(route.request().url()),p=url.pathname,empty=url.searchParams.get('mode')==='live';
    const json=(value:unknown)=>route.fulfill({json:value});
    if(p.endsWith('/runs/stats'))return json({total:empty?0:1,failures:0,failureRate:empty?null:0,settled:empty?0:1,averageMs:empty?null:20,nodes:empty?[]:[{name:'execute_tools',successRate:100}],states:empty?[]:[{name:'success',value:1}],health:{dropped:0},metricDefinition:'E2E 合成夹具；非生产统计。',usage:'UNKNOWN'});
    if(p.endsWith('/runs'))return json({items:empty?[]:[runRecord],total:empty?0:1,page:1,pageSize:20});
    if(p.includes('/runs/'))return json({run:runRecord,steps:[{id:'node-1',run_id:run,kind:'node',name:'execute_tools',status:'success',started_at:now-20,ended_at:now,elapsed_ms:20,error_code:null},{id:'tool-1',run_id:run,kind:'tool',name:'calculator',status:'success',started_at:now-15,ended_at:now-5,elapsed_ms:10,error_code:null}],retrievals:[{id:query}],citations:[],notice:'E2E 合成执行元数据，不保存客户信息。'});
    if(p.endsWith('/retrievals/stats'))return json({total:1,empty:0,errors:0,averageMs:8,documents:[{id:hit.document_id,name:hit.documentName,hits:1}],topK:[{id:query,k:5,returned:1,status:'success'}],trend:[{day:'E2E 测试日',requests:1,empty:0,errors:0}],metricDefinition:'E2E 返回片段次数，不是召回准确率。'});
    if(p.endsWith('/retrievals'))return json({items:[request],total:1,page:1,pageSize:20});
    if(p.includes('/retrievals/'))return json({request,hits:[hit],citations:[],children:[],notice:'E2E 合成来源；未采集实际引用时不能当成没有引用。'});
    if(p.endsWith('/quality-analysis'))return json({initialized:true,score:80,metrics:{documents:1,versions:1,chunks:1,vectors:1,nonRetrievable:1,nonCurrentVersions:0,emptyContentVersions:0,orphanChunks:0,relationFailures:0,integrity:'PASS'},groups:[{name:'检索有效状态',value:1}],trend:[{id:'old',at:now-1000,score:100,checks:5},{id:'new',at:now,score:80,checks:5}],checks:[{name:'检索有效状态',documentName:'E2E 虚构资料',result:'WARNING',reason:'合成归档资料',suggestion:'人工核查，不修改源数据',checkedAt:now}],rule:'quality-pass-rate-v1',formula:'E2E 合成夹具：100 × PASS/(PASS+FAIL+WARNING+UNKNOWN)，等权'});
    if(p.endsWith('/lineage'))return json({initialized:true,assets:[{id:asset,name:'E2E 虚构资料',externalId:hit.document_id}],selectedAsset:asset,nodes:[{id:'doc',kind:'document',label:'E2E 虚构资料',level:0,meta:{state:'active'}},{id:'version',kind:'version',label:'版本1',level:1,meta:{version:1}},{id:'chunk',kind:'chunk',label:'片段1 · 页2',level:2,meta:{page:2,textHash:'c'.repeat(64)}},{id:'vector',kind:'vector',label:'向量384维',level:3,meta:{dimension:384}},{id:'query',kind:'retrieval',label:'E2E 检索',level:4,meta:{requestId:query}}],edges:[{source:'doc',target:'version'},{source:'version',target:'chunk'},{source:'chunk',target:'vector'},{source:'vector',target:'query'}],changes:[],observedDiff:null,truncated:false,totalNodes:5,notice:'E2E 合成元数据；仅验证图形关联，不是业务流量。'});
    throw Error('Unmocked observation request '+p);
  });
});
test('lineage nodes expose real supplied metadata and link into the retrieval record',async({page})=>{
  await page.goto('/data-platform/lineage');await page.getByRole('button',{name:/文本切片/}).click();await expect(page.getByLabel('血缘节点详情')).toContainText('"page": 2');await page.getByRole('button',{name:/实际检索/}).click();await page.getByRole('link',{name:'查看检索详情',exact:true}).click();await expect(page).toHaveURL(new RegExp('/data-platform/retrievals\\?request='));await expect(page.getByLabel('检索详情')).toContainText(hit.documentName);
});
test('run timeline, token UNKNOWN, mode filtering and associated retrieval are usable',async({page})=>{
  await page.goto('/data-platform/runs');await page.getByRole('button',{name:'查看运行',exact:true}).click();await expect(page.getByLabel('运行详情')).toContainText('calculator');await expect(page.getByRole('cell',{name:'UNKNOWN / UNKNOWN + UNKNOWN',exact:true})).toBeVisible();await page.getByRole('link',{name:/关联检索/}).click();await expect(page.getByLabel('检索详情')).toBeVisible();await page.goto('/data-platform/runs');await page.getByRole('combobox',{name:'运行模式',exact:true}).selectOption('live');await expect(page.getByText('尚无已采集的 Agent 运行；不会补造历史记录。')).toBeVisible();
});
test('retrieval hit provenance and quality score formula remain explicit and navigable',async({page})=>{
  await page.goto('/data-platform/retrievals');await page.getByRole('button',{name:'查看检索',exact:true}).click();await expect(page.getByLabel('检索详情')).toContainText('页码 2');await page.getByRole('link',{name:'查看来源血缘'}).click();await expect(page.getByLabel('数据血缘关联图')).toBeVisible();await page.getByRole('navigation',{name:'数据中台模块'}).getByRole('link',{name:'数据质量分析',exact:true}).click();await expect(page.getByText(/E2E 合成夹具：100/).first()).toBeVisible();await expect(page.getByRole('cell',{name:'WARNING',exact:true})).toBeVisible();
});
test('permission failures and empty statistics are not rendered as successful invented records',async({page})=>{
  await page.route('**/api/data-platform/runs?*',route=>route.fulfill({status:403,json:{error:'E2E 无权限'}}));await page.goto('/data-platform/runs');await expect(page.getByRole('main').getByRole('alert')).toContainText('无权限');await expect(page.getByRole('button',{name:'查看运行',exact:true})).toHaveCount(0);
});
test('all new pages render on desktop/mobile, respect reduced motion and have usable charts',async({page},info)=>{
  await page.emulateMedia({reducedMotion:'reduce'});for(const route of ['lineage','runs','retrievals','quality-analysis']){await page.goto('/data-platform/'+route);await expect(page.getByRole('heading',{level:1})).toBeVisible();if(route==='runs'){const figure=page.getByRole('figure',{name:'节点成功率（非答案准确率）',exact:true});await figure.scrollIntoViewIfNeeded();await expect(figure.locator('[data-chart-state]')).toHaveAttribute('data-chart-state','ready');await figure.getByText('查看图表数据',{exact:true}).click();await expect(figure.getByRole('cell',{name:'100',exact:true})).toBeVisible();}expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('observation-'+route+'.png'),fullPage:true});}
});
