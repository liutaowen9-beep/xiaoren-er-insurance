import { test, expect } from './fixtures';

test('knowledge page uploads a synthetic file and refreshes the catalog', async ({ page, app }) => {
  await page.goto('/knowledge');
  await expect(page.getByRole('heading', { name: '我的知识库', exact: true })).toBeVisible();
  await expect(page.locator('.document-card')).toHaveCount(3);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await (await chooser).setFiles({ name: 'E2E-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E synthetic policy: no real customer data.') });
  await expect(page.getByRole('status').filter({ hasText: '上传成功' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'E2E-upload.txt', exact: true })).toBeVisible();
  expect(app.uploads).toHaveLength(1);
  expect(app.uploads[0].toString()).toContain('E2E synthetic policy');
});

test('knowledge state filter and comparison document selection use the catalog', async ({ page }) => {
  await page.goto('/knowledge');
  await page.getByRole('combobox', { name: '文档范围', exact: true }).selectOption('inactive');
  await expect(page.locator('.document-card')).toHaveCount(1);
  await expect(page.locator('.document-card')).toContainText('E2E 已停用.txt');
  await page.goto('/analysis/compare');
  const start = page.getByRole('button', { name: /开始产品对比/ });
  await expect(start).toBeDisabled();
  await page.getByRole('checkbox', { name: /E2E 医疗条款/ }).check();
  await expect(start).toBeDisabled();
  await page.getByRole('checkbox', { name: /E2E 家庭责任/ }).check();
  await expect(start).toBeEnabled();
  await expect(start).toContainText('2/3');
  await expect(page.getByRole('checkbox')).toHaveCount(2);
});
