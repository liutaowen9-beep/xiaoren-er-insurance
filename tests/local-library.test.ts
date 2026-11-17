import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveLocalLibrary } from '../src/lib/rag/local-library';

function fixture(outside = false) {
  mkdirSync('tmp/rag-tests', { recursive: true });
  const root = mkdtempSync(outside ? path.join(tmpdir(), 'xiaoren-er-insurance-library-test-') : path.resolve('tmp/rag-tests/local-library-'));
  writeFileSync(path.join(root, 'local-library.json'), JSON.stringify({ format: 1, purpose: 'moyu-independent-library', root, id: randomUUID() }));
  return root;
}
test('local library is explicit, marker-bound and never selects the default or receipt-bound deployment', () => {
  assert.equal(resolveLocalLibrary(undefined, process.cwd()), null);
  for (const invalid of ['', 'relative', path.resolve('.moyu')]) assert.throws(() => resolveLocalLibrary(invalid, process.cwd()));
  const root = fixture(); assert.equal(resolveLocalLibrary(root, process.cwd()), root);
  writeFileSync(path.join(root, 'deployment.json'), '{}');
  assert.throws(() => resolveLocalLibrary(root, process.cwd()), /部署/);
});
test('local library refuses missing, forged and cross-directory markers', () => {
  const root = fixture();
  writeFileSync(path.join(root, 'local-library.json'), JSON.stringify({ format: 1, purpose: 'moyu-independent-library', root: root + '-other', id: randomUUID() }));
  assert.throws(() => resolveLocalLibrary(root, process.cwd()), /不匹配/);
  writeFileSync(path.join(root, 'local-library.json'), '{}');
  assert.throws(() => resolveLocalLibrary(root, process.cwd()));
});
test('registered fresh library initializes schema 1 through the existing store and rejects an existing schema 0 database', () => {
  const root = fixture(true);
  const run = (code: string) => spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '-e', code], {
    cwd: process.cwd(), env: { ...process.env, MOYU_RAG_LOCAL_ROOT: root, MOYU_RAG_DEPLOYMENT: '', MOYU_RAG_ACCESS: '', DEEPSEEK_API_KEY: '' }, encoding: 'utf8',
  });
  const result = run("const {getStore}=require('./src/lib/rag/store.ts');const s=getStore();if(s.list().length!==0||s.db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('invalid new library');s.close();");
  assert.equal(result.status, 0, result.stderr);
  const reopen = run("const {getStore}=require('./src/lib/rag/store.ts');getStore().close();");
  assert.equal(reopen.status, 0, reopen.stderr);
  const invalid = run("const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(require('node:path').join(process.env.MOYU_RAG_LOCAL_ROOT,'knowledge.sqlite'));db.exec('PRAGMA user_version=0');db.close();const {getStore}=require('./src/lib/rag/store.ts');getStore();");
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /SCHEMA/);
});
