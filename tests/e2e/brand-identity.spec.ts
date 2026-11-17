import {test,expect} from './fixtures';
import {PRODUCT_NAME,LEGACY_PRODUCT_NAMES} from '../../src/lib/product-identity';
import {DEFAULT_BRAND,BRAND_STORAGE_KEY} from '../../src/lib/branding';

test('formal identity, title, manifest, icon and all application destinations remain consistent',async({page,request,isMobile})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  // This traversal verifies shared branding, not business results. Existing
  // module suites exercise successful data operations with detailed fixtures.
  for(const pattern of ['**/api/data-platform/**','**/api/evaluation/**'])await page.route(pattern,route=>route.request().method()==='GET'?route.fulfill({status:503,json:{error:'品牌页首隔离检查：业务数据由模块专项用例验证。'}}):route.fallback());
  await page.route('**/api/evaluation/model-center/**',route=>route.fulfill({json:{items:[],configured:false,total:0}}));
  const pages=['/','/chat','/knowledge','/analysis','/analysis/needs','/analysis/compare','/reports','/architecture','/settings','/data-platform','/data-platform/assets','/data-platform/quality','/data-platform/versions','/data-platform/snapshots','/data-platform/lineage','/data-platform/runs','/data-platform/retrievals','/data-platform/quality-analysis','/evaluation','/evaluation/datasets','/evaluation/runs','/evaluation/rag','/evaluation/agent','/evaluation/model','/evaluation/reports','/evaluation/models','/evaluation/live','/evaluation/live-results','/evaluation/model-compare'];
  for(const url of pages){
    await page.goto(url);await expect(page.locator('h1').first()).toBeVisible();
    await expect(page).toHaveTitle(PRODUCT_NAME+' · '+DEFAULT_BRAND.subtitle);
    const text=await page.locator('body').innerText();for(const old of LEGACY_PRODUCT_NAMES)expect(text).not.toContain(old);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
  const manifest=await request.get('/manifest.webmanifest');expect(manifest.status()).toBe(200);
  const value=await manifest.json();expect(value.name).toBe(PRODUCT_NAME);expect(value.short_name).toBe(PRODUCT_NAME);
  const icon=await request.get('/icon.svg');expect(icon.status()).toBe(200);expect(await icon.text()).toContain('<title>'+PRODUCT_NAME+'</title>');
  await page.goto('/');if(isMobile)await page.getByRole('button',{name:'打开导航',exact:true}).click();
  await expect(page.locator('.suite-brand strong')).toHaveText(PRODUCT_NAME);
});

test('legacy saved brand is displayed compatibly without overwriting user preferences or history',async({page})=>{
  const raw=JSON.stringify({...DEFAULT_BRAND,siteName:LEGACY_PRODUCT_NAMES[0],primary:'#173f35'});
  await page.addInitScript(({key,value})=>localStorage.setItem(key,value),{key:BRAND_STORAGE_KEY,value:raw});
  await page.goto('/settings');await expect(page.getByLabel('网站名称',{exact:false}).first()).toHaveValue(PRODUCT_NAME);
  await expect(page).toHaveTitle(PRODUCT_NAME+' · '+DEFAULT_BRAND.subtitle);
  expect(await page.evaluate(key=>localStorage.getItem(key),BRAND_STORAGE_KEY)).toBe(raw);
  await page.reload();await expect(page.getByLabel('网站名称',{exact:false}).first()).toHaveValue(PRODUCT_NAME);
  expect(await page.evaluate(key=>localStorage.getItem(key),BRAND_STORAGE_KEY)).toBe(raw);
});
