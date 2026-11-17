import { build, type BuildResult } from 'esbuild';
import path from 'node:path';
import type { Page } from '@playwright/test';

let compilation: Promise<BuildResult<{ write: false }>> | undefined;
export async function installChartHarness(page: Page) {
  compilation ??= build({ entryPoints: ['tests/e2e/charts-harness.tsx'], bundle: true, splitting: true, format: 'esm', platform: 'browser', outdir: 'tmp/reports/e2e/chart-bundle', entryNames: 'harness', chunkNames: 'chunks/[name]-[hash]', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
  const result = await compilation;
  const outdir = path.resolve('tmp/reports/e2e/chart-bundle');
  const files = new Map(result.outputFiles!.map(file => [path.relative(outdir, file.path).replaceAll('\\', '/'), file]));
  await page.route('**/__e2e/chart-assets/**', async route => {
    const key = new URL(route.request().url()).pathname.split('/__e2e/chart-assets/')[1];
    const file = files.get(key);
    if (!file) return route.fulfill({ status: 404, body: 'Unknown test asset' });
    return route.fulfill({ contentType: key.endsWith('.css') ? 'text/css' : 'text/javascript', body: Buffer.from(file.contents) });
  });
  // Inherit the real application's generated Tailwind/theme CSS, not its routes or data.
  const root = await page.request.get('/');
  const html = await root.text();
  const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^\"]*)"[^>]*>/g)].map(match => `<link rel="stylesheet" href="${match[1].replaceAll('&amp;', '&')}">`).join('');
  await page.route('**/__e2e/charts{,?*}', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<link rel="stylesheet" href="/__e2e/chart-assets/harness.css"></head><body><div id="charts-test-root"></div><script type="module" src="/__e2e/chart-assets/harness.js"></script></body></html>` }));
}
