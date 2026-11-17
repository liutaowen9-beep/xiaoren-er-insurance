import 'server-only';
import path from 'node:path';
import { readdirSync,readFileSync } from 'node:fs';
import { safeFile,sha,canonical } from '../data-platform/scanner';
/** Source only: excludes env files, databases, reports, model weights and business documents. */
export function evaluationSourceHash(){
  const files:string[]=[];
  function visit(dir:string){safeFile(path.resolve(dir),false);for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Source link refused');if(e.isDirectory())visit(f);else if(/\.tsx?$/.test(e.name)){safeFile(path.resolve(f));files.push(f);}}}
  for(const dir of ['src/lib/evaluation','src/lib/rag','src/lib/agent','src/lib/needs','src/lib/reports','src/lib/comparison'])visit(dir);
  return sha(canonical(files.sort().map(f=>[f.replaceAll('\\','/'),sha(readFileSync(f))])));
}
