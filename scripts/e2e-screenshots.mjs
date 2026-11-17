import { spawn } from 'node:child_process';
const stage = process.argv[2];
if (!['before', 'after'].includes(stage)) throw new Error('Use before or after');
const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'visual.spec.ts', ...process.argv.slice(3)], {
  env: { ...process.env, MOYU_E2E_RUN: stage }, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
