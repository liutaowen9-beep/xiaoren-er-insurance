import { test, expect } from './fixtures';

for (const [name, path] of [['home', '/'], ['chat', '/chat'], ['knowledge', '/knowledge'], ['needs', '/analysis/needs'], ['reports', '/reports']] as const) {
  test(`capture ${name} layout for visual review`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(path);
    if (name === 'chat') await expect(page.getByRole('textbox', { name: '输入你的问题' })).toBeEnabled();
    else await expect(page.locator('h1')).toBeVisible();
    if (name === 'knowledge') await expect(page.locator('.document-card')).toHaveCount(3);
    if (name === 'needs') await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeEnabled();
    if (name === 'reports') await expect(page.getByText(/隔离测试知识库 · 2 份有效文档/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
    await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: 'image/png' });
  });
}
