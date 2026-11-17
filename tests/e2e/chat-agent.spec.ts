import { test, expect, MOCK_ANSWER, MOCK_EVIDENCE } from './fixtures';

test('chat sends one request, renders its reply and restores history after refresh', async ({ page, app }) => {
  await page.goto('/chat');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  const input = page.getByRole('textbox', { name: '输入你的问题', exact: true });
  await input.fill('E2E 虚构聊天问题');
  await input.press('Enter');
  await expect(page.locator('.message.assistant .markdown')).toHaveText(MOCK_ANSWER);
  expect(app.posts).toHaveLength(1);
  expect(app.posts[0].body).toMatchObject({ mode: 'chat', messages: [{ role: 'user', content: 'E2E 虚构聊天问题' }] });
  await page.reload();
  await expect(page.locator('.message.user .markdown')).toHaveText('E2E 虚构聊天问题');
  await expect(page.locator('.message.assistant .markdown')).toHaveText(MOCK_ANSWER);
  expect(app.posts).toHaveLength(1);
});

test('chat error allows retry without duplicating the user message', async ({ page, app }) => {
  app.chatFailures = 1;
  await page.goto('/chat');
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('E2E 重试');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'E2E 模拟服务暂时不可用' })).toBeVisible();
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(page.locator('.message.assistant .markdown')).toHaveText(MOCK_ANSWER);
  await expect(page.locator('.message.user')).toHaveCount(1);
  expect(app.posts).toHaveLength(2);
});

test('stop remains usable while a chat response is pending', async ({ page, app }) => {
  app.holdChat = true;
  await page.goto('/chat');
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('E2E 等待后停止');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toHaveCount(0);
});

test('knowledge chat preserves its mode and shows reloadable evidence', async ({ page, app }) => {
  await page.goto('/?mode=knowledge');
  await expect(page.getByRole('button', { name: '我的知识库', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '输入你的问题' }).fill('E2E 检索合成条款');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message.assistant .markdown')).toHaveText(MOCK_ANSWER);
  expect(app.posts[0].body.mode).toBe('knowledge');
  await page.locator('.source-card summary').click();
  await expect(page.locator('.source-card')).toContainText(MOCK_EVIDENCE);
  await page.reload();
  await page.locator('.source-card summary').click();
  await page.getByRole('button', { name: '查看实际来源原文' }).click();
  await expect(page.locator('.source-card')).toContainText(MOCK_EVIDENCE);
});

test('Agent task shows the tool state and result supplied by the mock protocol', async ({ page, app }) => {
  await page.goto('/?mode=agent');
  await expect(page.getByRole('button', { name: 'Agent 工作流', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /试试：50 件商品/ }).click();
  await expect(page.locator('.tool-card.completed')).toContainText('计算器');
  await expect(page.locator('.tool-card.completed')).toContainText('已完成');
  await expect(page.locator('.message.assistant .markdown')).toContainText('E2E Agent 模拟结果：12707.50');
  expect(app.posts[0].path).toBe('/api/agent');
  expect(app.posts[0].body.mode).toBe('agent');
});
