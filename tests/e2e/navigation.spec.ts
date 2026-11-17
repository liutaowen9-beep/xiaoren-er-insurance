import { test, expect } from './fixtures';

test('home renders real navigation and navigates through the sidebar', async ({ page, isMobile }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI 业务工作台');
  if (isMobile) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('navigation', { name: '核心模块' }).getByRole('link', { name: /智能业务分析/ }).click();
  await expect(page).toHaveURL('/analysis');
  await expect(page.getByRole('link', { name: /开始需求分析/ })).toBeVisible();
  await page.getByRole('link', { name: /开始需求分析/ }).click();
  await expect(page).toHaveURL('/analysis/needs');
  await expect(page.getByRole('heading', { name: '客户需求分析 Agent', exact: true })).toBeVisible();
});

test('responsive layout, theme persistence and reduced motion retain navigation', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const previous=await page.locator('html').getAttribute('data-theme');
  const next=previous==='dark'?'light':'dark';
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', next);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', next);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (isMobile) {
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开导航', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '关闭导航', exact: true }).last().click();
    await expect(page.getByRole('button', { name: '打开导航', exact: true })).toHaveAttribute('aria-expanded', 'false');
  }
});

test('an unknown page returns the framework not-found response', async ({ page }) => {
  const response = await page.goto('/e2e-no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/This page could not be found/)).toBeVisible();
});

test('unmocked API requests are refused by the isolated server', async ({ request }) => {
  const health = await request.get('/__e2e_health');
  expect(await health.json()).toEqual({ isolated: true, businessApis: 'blocked' });
  const response = await request.delete('/api/knowledge/documents/e2e-synthetic-id');
  expect(response.status()).toBe(503);
  expect((await response.json()).error).toContain('E2E isolation');
});
