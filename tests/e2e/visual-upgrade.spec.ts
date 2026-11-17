import {randomUUID} from 'node:crypto';
import {test,expect} from './fixtures';
import {workflowEventSchema} from '../../src/lib/agent/workflow';

test('all nine routes share the dark visual system without viewport overflow',async({page},info)=>{
  for(const path of ['/','/chat','/knowledge','/analysis','/analysis/needs','/analysis/compare','/reports','/architecture','/settings']){
    await page.goto(path);await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
    expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe('#080d19');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    if(['/settings','/architecture','/analysis/compare'].includes(path))await page.screenshot({path:info.outputPath(path.split('/').pop()+'.png'),fullPage:true,animations:'disabled'});
  }
});

test('custom brand, light theme and reset survive navigation and refresh',async({page})=>{
  await page.goto('/settings');
  await page.getByLabel('网站名称', {exact:false}).first().fill('E2E 科技工作台');
  await page.getByRole('textbox',{name:'网站主色色值',exact:true}).fill('#9d4edd');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已保存');await page.reload();
  await expect(page.getByLabel('网站名称',{exact:false}).first()).toHaveValue('E2E 科技工作台');
  await page.locator('.suite-topbar').getByRole('button',{name:'切换主题',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand-solid'))).toBe('#9d4edd');
  await page.goto('/');await expect(page.locator('.suite-brand strong')).toHaveText('E2E 科技工作台');await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.goto('/settings');await page.getByRole('button',{name:'恢复默认设置',exact:true}).click();await page.getByRole('button',{name:'确认恢复默认',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已恢复');
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand-solid'))).toBe('#2563eb');
});

test('actual catalog metrics and reduced-motion forms preserve their data',async({page,app})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/knowledge');
  await expect(page.locator('.document-card')).toHaveCount(app.documents.length);
  const metrics=page.getByRole('region',{name:'知识库实时概况'});
  await expect(metrics.locator('.knowledge-metric').nth(0).locator('strong')).toHaveText('3');
  await expect(metrics.locator('.knowledge-metric').nth(1).locator('strong')).toHaveText('2');
  expect(await page.locator('.document-card').first().evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  await page.goto('/reports');const topic=page.getByRole('textbox',{name:/报告主题/});await topic.fill('E2E 保留表单输入');
  await page.locator('.suite-topbar').getByRole('button',{name:'切换主题',exact:true}).click();await expect(topic).toHaveValue('E2E 保留表单输入');
  await topic.focus();await expect(topic).toBeFocused();
});

function mockWorkflow(result:'success'|'error'|'cancelled'){
 const t=Date.now(),runId=randomUUID(),stepId=randomUUID(),node1=randomUUID(),node2=randomUUID();let sequence=0;
 const base=(type:string,at:number)=>({version:1,runId,eventId:randomUUID(),sequence:++sequence,type,at});
 const node={nodeId:node1,name:'plan_task',status:'running',startedAt:t,retryCount:0,summary:'E2E 合成规划事件，不是真实模型调用'};
 const step={stepId,toolCallId:'e2e_calculator',name:'calculator',status:'pending',queuedAt:t+10,inputSummary:'E2E 合成表达式：50*299*0.85',dependsOn:[],sourceChunkIds:[]};
 const events:unknown[]=[{...base('run_started',t),execution:'serial'},{...base('node_started',t),node},{...base('node_finished',t+10),node:{...node,status:'success',endedAt:t+10,elapsedMs:10}},
 {...base('node_started',t+10),node:{...node,nodeId:node2,previousNodeId:node1,name:'execute_tools',startedAt:t+10}},
 {...base('tool_pending',t+10),step},{...base('tool_started',t+20),step:{...step,status:'running',startedAt:t+20}}];
 if(result!=='cancelled')events.push({...base(result==='success'?'tool_completed':'tool_failed',t+50),step:{...step,status:result,startedAt:t+20,endedAt:t+50,elapsedMs:30,outputSummary:result==='success'?'E2E 合成结果 12707.50':'E2E 合成错误：非法表达式',summary:result==='success'?'E2E 计算器已完成':'E2E 工具失败'}});
 events.push({...base('node_finished',t+60),node:{...node,nodeId:node2,previousNodeId:node1,name:'execute_tools',startedAt:t+10,status:result,endedAt:t+60,elapsedMs:50}},
 {...base(result==='success'?'run_completed':result==='error'?'run_failed':'run_cancelled',t+60),elapsedMs:60});
 return events.map(e=>workflowEventSchema.parse(e));
}

for(const state of ['success','error','cancelled'] as const)test(`workflow ${state} visualizes protocol events and remains collapsible`,async({page},info)=>{
  const events=mockWorkflow(state);
  if(info.project.name==='desktop-chromium')await page.setViewportSize({width:1440,height:1200});
  await page.route('**/api/agent',async route=>{expect(route.request().postDataJSON().mode).toBe('agent');await route.fulfill({contentType:'text/event-stream',body:[...events,{type:'delta',text:'E2E 协议夹具 · 非真实模型。'+state},{type:'done',finishReason:'stop'}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')});});
  await page.goto('/?mode=agent');await page.getByRole('button',{name:/试试：50 件商品/}).click();
  const panel=page.locator('.workflow-panel');await expect(panel).toHaveClass(new RegExp(state));await expect(panel.locator('.workflow-step').last()).toContainText('计算器');
  await expect(panel.locator('.execution-meter')).toHaveAttribute('aria-label',`实际完成 ${state==='success'?1:0} / 1 个工具`);
  await expect(panel.locator('.workflow-graph')).toContainText('LangGraph 实际节点路径');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await panel.locator('.workflow-heading').click();await expect(panel.locator('.workflow-heading')).toHaveAttribute('aria-expanded','false');await expect(panel.locator('.workflow-timeline')).toHaveCount(0);
  await panel.locator('.workflow-heading').click();await expect(panel.locator('.workflow-step')).toHaveCount(3);
  await panel.locator('.workflow-step').last().scrollIntoViewIfNeeded();
  await expect(panel.locator('.workflow-step').last()).toBeInViewport();
  await expect.poll(()=>panel.locator('[id^="workflow-"]').evaluate(el=>(el as HTMLElement).style.height)).toBe('auto');
  await page.screenshot({path:info.outputPath(`workflow-${state}.png`),fullPage:true,animations:'disabled'});
  await page.reload();await expect(page.locator('.workflow-panel')).toHaveClass(new RegExp(state));
});
