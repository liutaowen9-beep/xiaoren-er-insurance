import { defineConfig, devices } from '@playwright/test';

const run = process.env.MOYU_E2E_RUN ?? 'latest';
if (!['latest', 'before', 'after'].includes(run)) throw new Error('Invalid E2E artifact set');
const artifacts = `tmp/reports/e2e/${run}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 30_000,
  globalTimeout: 300_000,
  expect: { timeout: 8_000 },
  outputDir: `${artifacts}/results`,
  reporter: [['list'], ['html', { outputFolder: `${artifacts}/html`, open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3108',
    browserName: 'chromium',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 8_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:3108/__e2e_health',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
