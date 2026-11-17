import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { resolveLocalLibrary } from '../src/lib/rag/local-library';
import { fingerprints, scanKnowledge } from '../src/lib/data-platform/scanner';
import { PlatformStore } from '../src/lib/data-platform/store';

// Explicit opt-in, no source DB connection and no model invocation. Detailed fingerprints stay ignored/local.
async function main(){
if(process.argv[2]!=='--registered-readonly')throw Error('需要显式参数 --registered-readonly；本工具只扫描已登记知识库。');
const config=z.object({root:z.string()}).strict().parse(JSON.parse(readFileSync('tmp/reports/local-knowledge.json','utf8')));
const root=resolveLocalLibrary(config.root,process.cwd());if(!root)throw Error('没有已登记知识库');
const marker=z.object({id:z.uuid()}).passthrough().parse(JSON.parse(readFileSync(path.join(root,'local-library.json'),'utf8')));
const source=path.join(root,'knowledge.sqlite'),signal=AbortSignal.timeout(120000);
const before=await fingerprints(source,signal),store=new PlatformStore(),token=store.lease();
try{
  const scan=await scanKnowledge(source,marker.id,signal),snapshot=store.publish(scan,token,signal);
  const after=await fingerprints(source,signal);assert.deepEqual(after,before);
  const summary={at:new Date().toISOString(),counts:snapshot.counts,sourceSchema:scan.manifest.schema,platformIntegrity:store.integrity(),sourceFingerprintsUnchanged:true,quality:store.overview().quality,notice:'只读源文件；仅写入独立中台元数据，未调用模型。'};
  writeFileSync('tmp/reports/data-platform/readonly-verification.json',JSON.stringify({summary,before,after},null,2),{mode:0o600});
  console.log(JSON.stringify(summary,null,2));
}finally{store.release(token);store.close();}

}
void main().catch(error=>{console.error(error instanceof Error?error.message:"只读验收失败");process.exitCode=1;});
