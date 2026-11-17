import { test, expect } from './fixtures';

const assetId='a'.repeat(64),sourceId='11111111-1111-4111-8111-111111111111',versionId='22222222-2222-4222-8222-222222222222',snapshotId='33333333-3333-4333-8333-333333333333';
const version={id:versionId,logicalId:sourceId,version:1,name:'E2E 虚构数据资产.txt',extension:'.txt',size:128,hash:'b'.repeat(64),actualHash:'b'.repeat(64),status:'ready',chunkCount:2,vectorCount:2,declaredChunks:2,model:'e2e-only-model',dimension:384,createdAt:1794182400000,isCurrent:true};
const asset={id:assetId,externalId:sourceId,sourceId,state:'active',currentVersionId:versionId,revision:1,name:version.name,createdAt:version.createdAt,updatedAt:version.createdAt,current:version,versions:[version]};
const counts={assets:1,versions:1,chunks:2,vectors:2,active:1};
const snapshot={id:snapshotId,sourceId,createdAt:version.createdAt,hash:'c'.repeat(64),changed:false,counts,manifest:{format:1,libraryId:sourceId,schema:1,embedding:{model:'e2e-only-model',dimension:384},assets:[],versions:[version],members:[]}};
test.beforeEach(async({page})=>{
  let scanned=false;
  await page.route('**/api/data-platform/**',async route=>{
    const url=new URL(route.request().url()),p=url.pathname,query=url.searchParams;
    const response=(body:unknown,status=200)=>route.fulfill({status,json:body});
    if(p.endsWith('/scans')){scanned=true;return response({snapshot},201);}
    if(p.endsWith('/overview'))return response({initialized:scanned,counts:scanned?counts:null,lastScan:scanned?version.createdAt:null,platformIntegrity:true,sourceId,quality:scanned?{PASS:10,FAIL:0,WARNING:0,UNKNOWN:0}:{PASS:0,FAIL:0,WARNING:0,UNKNOWN:0},anomalies:scanned?0:null,types:scanned?[{name:'.txt',value:1}]:[],trend:scanned?[{id:snapshotId,at:version.createdAt,versions:1}]:[]});
    if(p.endsWith('/assets')){const matched=!query.get('search')||version.name.includes(query.get('search')!);return response({items:scanned&&matched?[asset]:[],total:scanned&&matched?1:0,page:1,pageSize:20});}
    if(p.endsWith('/versions'))return response({items:[version],total:1,currentVersionId:versionId});
    if(p.includes('/assets/'))return response(asset);
    if(p.endsWith('/quality'))return response({items:scanned?[{id:'check-1',rule:'raw_hash',name:'原始文件 SHA-256',objectId:versionId,documentName:version.name,result:'PASS',reason:'合成数据哈希校验',suggestion:'无需操作',checkedAt:version.createdAt}]:[],total:scanned?1:0,page:1,pageSize:20});
    if(p.endsWith('/snapshots'))return response({items:scanned?[snapshot]:[],total:scanned?1:0,page:1,pageSize:20});
    if(p.endsWith('/diff'))return response({previousId:snapshotId,currentId:snapshotId,unchanged:true,assets:{added:[],removed:[],modified:[]},versions:{added:[],removed:[],modified:[]},chunks:{added:[],removed:[],modified:[]},stateChanges:[],notice:'合成元数据，不是备份'});
    if(p.includes('/snapshots/'))return response(snapshot);
    throw Error('Unexpected platform test request');
  });
});
async function scan(page:import('@playwright/test').Page){await page.getByRole('button',{name:'执行只读扫描',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'扫描完成'})).toBeVisible();}
test('overview has honest unknown state, scan updates actual supplied metrics and charts',async({page},info)=>{
  await page.goto('/data-platform');await expect(page.getByRole('heading',{name:'尚未扫描知识库'})).toBeVisible();await expect(page.getByText('统计尚未接入，请执行首次只读扫描。未知数据不会显示为零。')).toBeVisible();await scan(page);await expect(page.getByRole('figure',{name:'数据资产统计',exact:true})).toContainText('数据中台最近成功的只读扫描');for(const title of ['数据资产统计','当前版本文件类型','数据质量状态','扫描时文档版本数量']){const figure=page.getByRole('figure',{name:title,exact:true});await figure.scrollIntoViewIfNeeded();await expect(figure.locator('[data-chart-state]')).toHaveAttribute('data-chart-state','ready');}await page.screenshot({path:info.outputPath('platform-overview.png'),fullPage:true});
});
test('asset search and detail reveal version hashes without source modifications',async({page})=>{
  await page.goto('/data-platform/assets');await scan(page);await expect(page.getByRole('cell',{name:version.name,exact:true})).toBeVisible();await page.getByRole('button',{name:'查看详情',exact:true}).click();await expect(page.getByLabel('资产详情')).toContainText('当前版本');await expect(page.getByLabel('资产详情')).toContainText(version.hash);await page.getByRole('button',{name:'关闭详情'}).click();await page.getByRole('textbox',{name:'搜索文档'}).fill('不存在的虚构资产');await page.getByRole('button',{name:'搜索',exact:true}).click();await expect(page.getByText('没有符合条件的资产。')).toBeVisible();
});
test('quality and version pages preserve provenance and explicit current-version status',async({page})=>{
  await page.goto('/data-platform/quality');await scan(page);await expect(page.getByRole('cell',{name:'PASS · 通过',exact:true})).toBeVisible();await page.getByRole('navigation',{name:'数据中台模块'}).getByRole('link',{name:'数据版本管理'}).click();await page.getByRole('button',{name:'查看详情',exact:true}).click();await expect(page.getByLabel('资产详情')).toContainText('历史版本仅供溯源');
});
test('snapshots show immutable hash and diff instead of claiming a complete backup',async({page},info)=>{
  await page.goto('/data-platform/snapshots');await scan(page);await page.getByRole('button',{name:'查看快照差异'}).click();await expect(page.getByLabel('快照差异',{exact:true})).toContainText('内容未变化');await page.getByText('查看变化标识与哈希清单').click();await expect(page.getByLabel('快照差异',{exact:true})).toContainText(version.hash);await page.screenshot({path:info.outputPath('platform-diff.png'),fullPage:true});
});
test('scan errors remain visible and never create successful metrics',async({page})=>{
  await page.route('**/api/data-platform/scans',route=>route.fulfill({status:409,json:{error:'E2E 知识库正在变化，本次结果未发布。'}}));await page.goto('/data-platform');await page.getByRole('button',{name:'执行只读扫描',exact:true}).click();await expect(page.getByRole('main').getByRole('alert')).toContainText('结果未发布');await expect(page.getByRole('heading',{name:'尚未扫描知识库'})).toBeVisible();
});
test('cancel prevents success display and allows an explicit new scan',async({page})=>{
  let hold=true;await page.route('**/api/data-platform/scans',async route=>{if(hold){await new Promise(r=>setTimeout(r,500));await route.abort().catch(()=>{});}else await route.fallback();});await page.goto('/data-platform');await page.getByRole('button',{name:'执行只读扫描',exact:true}).click();await page.getByRole('button',{name:'取消扫描'}).click();await expect(page.getByRole('main').getByRole('alert')).toContainText('请求取消');hold=false;await scan(page);
});
test('new primary navigation works with mobile theme and reduced motion',async({page,isMobile})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/');if(isMobile)await page.getByRole('button',{name:'打开导航',exact:true}).click();await page.getByRole('navigation',{name:'核心模块'}).getByRole('link',{name:/数据中台/}).click();await expect(page).toHaveURL('/data-platform');await page.getByRole('button',{name:'切换主题',exact:true}).click();await scan(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
