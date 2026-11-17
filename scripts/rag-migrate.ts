import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { prepareCandidate, runMigrationTool } from '../src/lib/rag/migration-tool';
import { MigrationSafetyError, requireSafe } from '../src/lib/rag/database-audit';
import { safePath, PROJECT_ROOT } from '../src/lib/rag/migration-paths';

try {
  const {values}=parseArgs({options:{target:{type:'string'},root:{type:'string'},backup:{type:'string'},maintenance:{type:'string'},prepare:{type:'boolean'},execute:{type:'boolean'},recover:{type:'boolean'},'approve-cutover':{type:'string'},fault:{type:'string'},pause:{type:'string'}},strict:true});
  requireSafe(existsSync(path.join(PROJECT_ROOT,'src/lib/rag/migration-tool.ts')),'PROJECT_DIRECTORY_REQUIRED');
  requireSafe(values.target && values.root && values.backup,'EXPLICIT_TARGET_ROOT_BACKUP_REQUIRED');
  safePath(values.target,false);
  requireSafe([values.prepare,values.execute,values.recover,values['approve-cutover']!==undefined].filter(Boolean).length<=1,'CONFLICTING_MODES');
  if(values.fault||values.pause){
    requireSafe(process.env.MOYU_MIGRATION_TESTING==='1'&&values.execute&&!values['approve-cutover'],'FAULT_INJECTION_NOT_AUTHORIZED');
    requireSafe([values.fault,values.pause].filter(Boolean).every(value=>['copied','rebuilt','validated'].includes(value!)),'FAULT_PHASE_INVALID');
  }
  const checkpoint=(phase:string)=>{
    if(values.fault===phase)throw new MigrationSafetyError('INJECTED_FAILURE');
    if(values.pause===phase){console.log(JSON.stringify({event:'paused',phase}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000);throw new MigrationSafetyError('PAUSE_TIMEOUT');}
  };
  const result=values.prepare?prepareCandidate(values.root,values.target,values.backup):runMigrationTool({root:values.root,target:values.target,backup:values.backup,maintenance:values.maintenance,execute:values.execute,recover:values.recover,activate:values['approve-cutover'],checkpoint});
  console.log(JSON.stringify({ok:true,...result}));
} catch(e) {
  console.error(JSON.stringify({ok:false,code:e instanceof MigrationSafetyError?e.code:e instanceof z.ZodError?'DOCUMENT_SCHEMA_INVALID':'MIGRATION_TOOL_FAILED'}));
  process.exitCode=1;
}
