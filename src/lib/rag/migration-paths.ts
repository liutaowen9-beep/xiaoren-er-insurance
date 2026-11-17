import path from 'node:path';
import { existsSync, lstatSync, realpathSync, readFileSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { requireSafe } from './database-audit';
import { execFileSync } from 'node:child_process';

export const PROJECT_ROOT = path.resolve(/* turbopackIgnore: true */ process.cwd());
export function within(root: string, candidate: string) { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
/** Reject the original live data path before stat/open; never a production override flag. */
export function safePath(input: string, mustExist = true): string {
  requireSafe(path.isAbsolute(input) && !input.startsWith('\\\\'), 'ABSOLUTE_LOCAL_PATH_REQUIRED');
  const resolved = path.resolve(input);
  requireSafe(!within(path.join(PROJECT_ROOT, '.moyu'), resolved), 'LIVE_PRODUCTION_PATH_FORBIDDEN');
  let part = resolved;
  while (part !== path.dirname(part)) {
    if (existsSync(part)) {
      const stat = lstatSync(part);
      requireSafe(!stat.isSymbolicLink(), 'SYMLINK_OR_JUNCTION_FORBIDDEN');
      if (stat.isFile()) requireSafe(stat.nlink === 1, 'HARDLINK_FORBIDDEN');
    }
    part = path.dirname(part);
  }
  if (mustExist) { requireSafe(existsSync(resolved), 'PATH_MISSING'); requireSafe(path.relative(resolved, realpathSync(resolved)) === '', 'CANONICAL_PATH_MISMATCH'); }
  return resolved;
}
export function sha256(file: string) {
  const hash = createHash('sha256'), fd = openSync(/* turbopackIgnore: true */ file, 'r'), buffer = Buffer.alloc(1048576);
  try { let length; while ((length = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
export function readJson(file: string): unknown { return JSON.parse(readFileSync(/* turbopackIgnore: true */ safePath(file), 'utf8')); }
export function implementationFingerprint() {
  const files = ['package.json','pnpm-lock.yaml','next.config.ts','scripts/rag-migrate.ts',...readdirSync(/* turbopackIgnore: true */ path.join(PROJECT_ROOT,'src'),{recursive:true}).filter(file=>typeof file==='string'&&/\.(ts|tsx|css)$/.test(file)).map(file=>'src/'+String(file).replace(/\\/g,'/'))].sort();
  return createHash('sha256').update(files.map(file => file+':'+sha256(path.join(/* turbopackIgnore: true */ PROJECT_ROOT,file))).join('\n')).digest('hex');
}
// An explicit read-only bridge; never authorizes V7 writes against a V6 receipt.
export const V6_READONLY_BASELINE = '4243fc5fd1a0386d45d81bdf7e5e85acdc448e01';
export function historicalImplementationFingerprint() {
  const git=(args:string[])=>execFileSync('git',args,{cwd:PROJECT_ROOT,windowsHide:true,maxBuffer:16*1024*1024});
  requireSafe(git(['rev-parse','v6.0-rag-management-stable^{commit}']).toString().trim()===V6_READONLY_BASELINE,'READONLY_BASELINE_TAG_MISMATCH');
  const files=['package.json','pnpm-lock.yaml','next.config.ts','scripts/rag-migrate.ts',...git(['ls-tree','-r','--name-only',V6_READONLY_BASELINE,'--','src']).toString().trim().split('\n').filter(f=>/\.(ts|tsx|css)$/.test(f))].sort();
  return createHash('sha256').update(files.map(file=>{
    // Git stores LF; the Windows receipt hashes checkout bytes. Only line endings
    // come from the checkout; executable content always comes from the pinned Git object.
    let bytes=git(['show',`${V6_READONLY_BASELINE}:${file}`]);
    const local=path.join(PROJECT_ROOT,file);
    if(existsSync(local)&&readFileSync(/* turbopackIgnore: true */ local).includes(Buffer.from('\r\n')))bytes=Buffer.from(bytes.toString('utf8').replace(/\r?\n/g,'\r\n'));
    return file+':'+createHash('sha256').update(bytes).digest('hex');
  }).join('\n')).digest('hex');
}
