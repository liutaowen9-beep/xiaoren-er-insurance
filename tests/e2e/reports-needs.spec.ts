import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { test, expect, MOCK_TITLE } from './fixtures';

test('report form submits mock data, renders workflow and downloads valid Word/PDF files', async ({ page, app }) => {
  await page.goto('/reports');
  await page.getByRole('textbox', { name: '报告主题', exact: true }).fill('E2E 自动化报告请求');
  await page.getByRole('button', { name: '生成报告', exact: true }).click();
  await expect(page.getByRole('heading', { name: MOCK_TITLE, exact: true })).toBeVisible();
  await expect(page.locator('.report-progress')).toContainText('1/1 步完成');
  expect(app.posts[0].body).toMatchObject({ topic: 'E2E 自动化报告请求', engine: 'mock', useKnowledge: false });
  for (const format of ['docx', 'pdf']) {
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: format === 'docx' ? '下载 Word' : '下载 PDF', exact: true }).click();
    const download = await waiting;
    expect(download.suggestedFilename()).toBe(`${MOCK_TITLE}.${format}`);
    expect(await download.failure()).toBeNull();
    const file = await download.path();
    expect(file).not.toBeNull();
    const bytes = await readFile(file!);
    if (format === 'docx') expect(strFromU8(unzipSync(bytes)['word/document.xml'])).toContain(MOCK_TITLE);
    else expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  }
  await page.reload();
  await expect(page.getByRole('button', { name: '下载 Word', exact: true })).toHaveCount(0);
});

test('invalid report stream does not expose a successful report or download', async ({ page, app }) => {
  app.reportMalformed = true;
  await page.goto('/reports');
  await page.getByRole('button', { name: '生成报告', exact: true }).click();
  await expect(page.getByRole('region', { name: '报告工作区' }).getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '下载 Word', exact: true })).toHaveCount(0);
  app.reportMalformed = false;
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(page.getByRole('heading', { name: MOCK_TITLE, exact: true })).toBeVisible();
});

test('expired report downloads show a recoverable error', async ({ page, app }) => {
  await page.goto('/reports');
  await page.getByRole('button', { name: '生成报告', exact: true }).click();
  await expect(page.getByRole('heading', { name: MOCK_TITLE, exact: true })).toBeVisible();
  app.downloadExpired = true;
  await page.getByRole('button', { name: '下载 PDF', exact: true }).click();
  await expect(page.getByRole('region', { name: '报告工作区' }).getByRole('alert')).toContainText('E2E 模拟下载凭证已过期');
  await expect(page.getByRole('button', { name: '下载 PDF', exact: true })).toBeEnabled();
});

test('customer needs validates blank input then processes a fictional profile', async ({ page, app }) => {
  await page.goto('/analysis/needs');
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('请至少填写一项客户信息');
  expect(app.posts).toHaveLength(0);
  await page.getByRole('button', { name: '填入虚构案例', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: /客户年龄/ })).toHaveValue('34');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.getByRole('heading', { name: '完整分析报告', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '客户需求分析结果' })).toContainText('住院医疗费用');
  expect(app.posts[0].body).toMatchObject({ engine: 'mock', consent: false, profile: { age: 34 } });
  await page.reload();
  await expect(page.getByRole('heading', { name: '完整分析报告', exact: true })).toHaveCount(0);
});

test('needs connection failure blocks generation and supports explicit retry', async ({ page, app }) => {
  app.needsConnectionFailure = true;
  await page.goto('/analysis/needs');
  await expect(page.getByRole('status').filter({ hasText: 'E2E 模拟知识库连接失败' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
  app.needsConnectionFailure = false;
  await page.getByRole('button', { name: '重试知识库连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeEnabled();
});
