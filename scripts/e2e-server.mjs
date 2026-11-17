import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Dedicated build and ports. Never load run-v7's private library connections.
const env = { ...process.env, MOYU_E2E: '1', NEXT_TELEMETRY_DISABLED: '1' };
delete env.NO_COLOR;
for (const key of Object.keys(env)) {
  if (/^(DEEPSEEK_|MOYU_(RAG_|REPORT_|MIGRATION_|V7_|MAINTENANCE))/.test(key)) env[key] = '';
}
Object.assign(env, {
  DEEPSEEK_API_KEY: '', MOYU_REPORT_API_KEY: '', MOYU_REPORT_ALLOW_PAID: '0',
  MOYU_RAG_DEPLOYMENT: '', MOYU_RAG_ACCESS: '',
});
const next = 'node_modules/next/dist/bin/next';
let child;
let proxy;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  proxy?.close();
  child?.kill();
}
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('exit', stop);

async function assertFree(port) {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => socket.close(resolve));
}
try {
  await assertFree(3108);
  await assertFree(3109);
  const libraries = path.resolve('tmp/reports/e2e-environments');
  mkdirSync(libraries, { recursive: true });
  const library = mkdtempSync(path.join(libraries, 'empty-library-'));
  writeFileSync(path.join(library, 'local-library.json'), JSON.stringify({ format: 1, purpose: 'moyu-independent-library', root: library, id: randomUUID() }), { flag: 'wx' });
  env.MOYU_RAG_LOCAL_ROOT = library;
  const originalTypes = readFileSync('next-env.d.ts');
  let buildCode;
  try {
    child = spawn(process.execPath, [next, 'build'], { env, stdio: 'inherit', windowsHide: true });
    buildCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally {
    // Next rewrites this generated path for its build. Restore only that known change.
    const current = readFileSync('next-env.d.ts', 'utf8');
    const normalize = text => text.replaceAll('\r\n', '\n').replace(/\.next(?:-v7|-e2e)?\/(?:dev\/)?types\//g, '.next/types/');
    if (normalize(current) === normalize(originalTypes.toString())) writeFileSync('next-env.d.ts', originalTypes);
  }
  if (buildCode !== 0) throw new Error(`E2E production build failed (${buildCode})`);
  child = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', '3109'], { env, stdio: 'inherit', windowsHide: true });
  child.once('exit', code => { if (!stopping) { stop(); process.exit(code || 1); } });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch('http://127.0.0.1:3109/', { signal: AbortSignal.timeout(500) })).ok; } catch { /* Wait for this child, not an existing user server. */ }
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error('E2E Next server did not become ready');
  proxy = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1:3108').pathname);
    response.setHeader('X-Moyu-E2E-Isolated', '1');
    if (pathname === '/__e2e_health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"isolated":true,"businessApis":"blocked"}');
      return;
    }
    // Even a missing mock, APIRequestContext or MCP request cannot reach business APIs.
    if (/^\/api(?:\/|$)/i.test(pathname) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"error":"E2E isolation: business API requires an explicit browser mock"}');
      return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: 3109, method: request.method, path: request.url, headers: { ...request.headers, host: '127.0.0.1:3109' } }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('E2E upstream unavailable'); });
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => proxy.once('error', reject).listen(3108, '127.0.0.1', resolve));
  console.log('E2E isolated UI server: http://127.0.0.1:3108 (all business APIs blocked)');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop();
  process.exitCode = 1;
}
