import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
import { installChartHarness } from './charts-harness-route';

test.beforeEach(async ({ page, app }) => {
  app.documents[0].chunkCount = 7; app.documents[1].chunkCount = 3; app.documents[2].chunkCount = 0;
  await installChartHarness(page);
});
const ready = async (page: import('@playwright/test').Page) => expect(page.locator('[data-chart-state]')).toHaveAttribute('data-chart-state', 'ready');

test('seven modular engines render and preserve supplied values and provenance', async ({ page }, info) => {
  await page.goto('/__e2e/charts');
  for (const kind of ['bar', 'line', 'pie', 'gauge', 'radar', 'heatmap', 'sankey']) {
    await page.getByRole('combobox', { name: '图表类型' }).selectOption(kind);
    await ready(page);
    await expect(page.locator('[data-chart-surface]')).toHaveCount(1);
    await expect(page.locator('[data-chart-surface] canvas').first()).toBeVisible();
    await expect(page.getByRole('figure', { name: `E2E ${kind}`, exact: true })).toContainText('Playwright 合成夹具，非生产统计');
    const state = await page.evaluate(() => window.__chartProbe.read());
    expect(state?.width).toBeGreaterThan(0);
    expect(state?.height).toBeGreaterThan(0);
    expect(state?.series[0].type).toBe(kind);
    expect(state?.animation).toBe(false);
    if (kind === 'bar' || kind === 'line') expect(state?.series[0].data).toEqual([7, 3, 0]);
    if (kind === 'gauge') expect(state?.series[0].data).toMatchObject([{ value: 7 }]);
    await page.screenshot({ path: info.outputPath(`chart-${kind}.png`), fullPage: true });
  }
});

test('empty, loading, error and unconnected states do not invent zero metrics', async ({ page }) => {
  await page.goto('/__e2e/charts'); await ready(page);
  for (const [value, text] of [['empty', '暂无数据'], ['loading', '正在加载图表数据…'], ['error', 'E2E 模拟接口错误'], ['unconnected', '指标未接入']]) {
    await page.getByRole('combobox', { name: '数据状态' }).selectOption(value);
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(page.locator('[data-chart-surface]')).toHaveCount(0);
  }
  await page.getByRole('combobox', { name: '数据状态' }).selectOption('ready'); await ready(page);
});

test('container resize and theme changes update the live instance', async ({ page }) => {
  await page.goto('/__e2e/charts'); await ready(page);
  const original = await page.evaluate(() => window.__chartProbe.read());
  await page.getByRole('button', { name: '改变容器宽度' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__chartProbe.read()))?.width).toBeLessThan(original!.width);
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__chartProbe.read()))?.background).not.toBe(original?.background);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('external filtering, native clicks, keyboard selection and null gaps preserve data', async ({ page }) => {
  await page.goto('/__e2e/charts'); await ready(page);
  const [x, y] = await page.evaluate(() => window.__chartProbe.point());
  await page.locator('[data-chart-surface]').click({ position: { x, y } });
  await expect(page.getByLabel('选择事件')).toContainText('E2E 医疗条款.txt');
  await page.getByText('查看图表数据', { exact: true }).click();
  const choose = page.getByRole('button', { name: '选择 切片数量 · E2E 家庭责任.txt', exact: true });
  await choose.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('选择事件')).toContainText('E2E 家庭责任.txt');
  await page.evaluate(() => window.__chartProbe.toggleLegend());
  await expect(page.getByLabel('图例事件')).toContainText('"切片数量":false');
  await page.getByRole('combobox', { name: '图表类型' }).selectOption('line'); await ready(page);
  await page.getByRole('button', { name: '缺失值夹具' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__chartProbe.read()))?.series[0].data).toEqual([7, null, 0]);
  await page.getByRole('button', { name: '筛选第一份' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__chartProbe.read()))?.series[0].data).toEqual([7]);
});

test('unmount disposes the instance and remount remains usable', async ({ page }) => {
  await page.goto('/__e2e/charts'); await ready(page);
  await page.evaluate(() => window.__chartProbe.remember());
  await page.getByRole('button', { name: '切换图表挂载' }).click();
  expect(await page.evaluate(() => window.__chartProbe.disposed())).toBe(true);
  await page.getByRole('button', { name: '切换图表挂载' }).click(); await ready(page);
  await page.evaluate(() => window.__chartProbe.remember());
  await page.getByRole('button', { name: '离开测试页面' }).click();
  await expect(page).toHaveURL('/');
});

test('offscreen and zero-width charts initialize only after becoming visible', async ({ page }) => {
  await page.goto('/__e2e/charts?hidden=1');
  await expect(page.locator('[data-chart-surface]')).toHaveCount(1);
  await expect(page.locator('[data-chart-surface] canvas')).toHaveCount(0);
  await page.getByRole('button', { name: '切换容器可见' }).click(); await ready(page);
  await page.goto('/__e2e/charts?below=1');
  await expect(page.locator('[data-chart-surface]')).toHaveCount(1);
  await expect(page.locator('[data-chart-surface] canvas')).toHaveCount(0);
  await page.locator('[data-chart-surface]').scrollIntoViewIfNeeded(); await ready(page);
});

test('cyclic flow is rejected without changing its supplied links', async ({ page }) => {
  await page.goto('/__e2e/charts');
  await page.getByRole('combobox', { name: '图表类型' }).selectOption('sankey'); await ready(page);
  await page.getByRole('button', { name: '循环流转夹具' }).click();
  await expect(page.getByRole('alert')).toContainText('无环流转');
  await expect(page.locator('[data-chart-surface]')).toHaveCount(0);
});

test('evaluation data requires metric definition, dataset version and run provenance', async ({ page }) => {
  await page.goto('/__e2e/charts?incomplete=1');
  await expect(page.getByRole('alert')).toContainText('评测图表缺少口径、数据集版本或评测记录');
  await expect(page.locator('[data-chart-surface]')).toHaveCount(0);
});

test('chart exports valid PNG/JPEG and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/__e2e/charts'); await ready(page);
  expect((await page.evaluate(() => window.__chartProbe.read()))?.animation).toBe(false);
  for (const format of ['PNG', 'JPEG']) {
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: `导出 ${format}`, exact: true }).click();
    const download = await waiting; expect(await download.failure()).toBeNull();
    const bytes = await readFile((await download.path())!);
    expect(bytes.length).toBeGreaterThan(100);
    if (format === 'PNG') expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    else expect([...bytes.subarray(0, 2)]).toEqual([255, 216]);
  }
});
