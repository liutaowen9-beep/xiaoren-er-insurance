import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { requireSafe } from './database-audit';
import { implementationFingerprint, historicalImplementationFingerprint, V6_READONLY_BASELINE, readJson, safePath, sha256, within } from './migration-paths';
import { targetIdentity } from './migration-safety';

type Deployment = { root:string; target:string; readOnly:boolean; activated:boolean; codeFingerprint:string; receiptSha256:string };
let cached:Deployment|null|undefined;
function matchesHistoricalFingerprint(expected:string):boolean {
  // Source archives have no legacy Git objects. Unverifiable history must fail
  // closed with the same identity error, never authorize a deployment.
  try{return expected===historicalImplementationFingerprint();}catch{return false;}
}
/** Explicit, receipt-bound candidate deployment. Never permits the old production .moyu path. */
export function getDeployment():Deployment|null {
  if(cached!==undefined)return cached;
  const file=process.env.MOYU_RAG_DEPLOYMENT;
  if(!file){requireSafe(!process.env.MOYU_RAG_ACCESS,'DEPLOYMENT_FILE_REQUIRED');return cached=null;}
  const mode=process.env.MOYU_RAG_ACCESS??'read-only';
  requireSafe(mode==='read-only'||mode==='approved-write','DEPLOYMENT_ACCESS_INVALID');
  const descriptor=z.object({format:z.literal(1),targetId:z.uuid(),root:z.string(),receiptSha256:z.string(),codeFingerprint:z.string(),schemaVersion:z.literal(1)}).strict().parse(readJson(file));
  const root=safePath(descriptor.root);
  requireSafe(safePath(file)===path.join(root,'deployment.json'),'DEPLOYMENT_FILE_LOCATION_INVALID');
  const identity=targetIdentity(root,path.join(root,'data','knowledge.sqlite'));
  const readonlyBridge=mode==='read-only'&&process.env.MOYU_RAG_READONLY_BASELINE===V6_READONLY_BASELINE;
  requireSafe(identity.targetId===descriptor.targetId&&(descriptor.codeFingerprint===implementationFingerprint()||(readonlyBridge&&matchesHistoricalFingerprint(descriptor.codeFingerprint))),'DEPLOYMENT_CODE_OR_TARGET_MISMATCH');
  const receiptFile=path.join(root,'migration-receipt.json');
  requireSafe(sha256(safePath(receiptFile))===descriptor.receiptSha256,'DEPLOYMENT_RECEIPT_HASH_FAILED');
  const receipt=readJson(receiptFile) as Record<string,unknown>;
  requireSafe(receipt.targetId===identity.targetId&&receipt.baselineDigest===identity.baselineDigest&&receipt.backupManifestHash===identity.backupManifestHash&&receipt.schemaVersion===1,'DEPLOYMENT_RECEIPT_MISMATCH');
  const modelFile=path.join(root,'model-files.json');
  requireSafe(sha256(safePath(modelFile))===receipt.modelManifestSha256,'MODEL_MANIFEST_FAILED');
  const models=z.array(z.object({file:z.string(),sha256:z.string()}).strict()).min(1).parse(readJson(modelFile));
  for(const model of models){const file=safePath(path.resolve(root,'data',model.file));requireSafe(within(path.join(root,'data','models'),file)&&sha256(file)===model.sha256,'DEPLOYMENT_MODEL_HASH_FAILED');}
  const activationFile=path.join(root,'activation.json');
  let activated=false;
  if(mode==='approved-write'||existsSync(activationFile)){
    const approval=z.object({targetId:z.uuid(),receiptSha256:z.string(),approvedAt:z.iso.datetime()}).strict().parse(readJson(activationFile));
    requireSafe(approval.targetId===identity.targetId&&approval.receiptSha256===descriptor.receiptSha256,'DEPLOYMENT_WRITE_APPROVAL_FAILED');
    activated=true;
  }
  return cached={root,target:identity.target,readOnly:mode==='read-only',activated,codeFingerprint:descriptor.codeFingerprint,receiptSha256:descriptor.receiptSha256};
}
export function runtimeRequestReason(request:Request):string|null {
  const deployment=getDeployment();
  if(process.env.MOYU_MAINTENANCE==='1'||(deployment&&existsSync(path.join(deployment.root,'.migration.lock'))))return '维护窗口内暂停新请求，请等待维护完成。';
  if(deployment?.readOnly){
    const url=new URL(request.url);
    const reportRead=process.env.MOYU_RAG_READONLY_BASELINE===V6_READONLY_BASELINE&&['GET','POST'].includes(request.method)&&['/api/reports','/api/reports/download'].includes(url.pathname);
    // Chat and registered Agent tools only read the knowledge store. A verified
    // production activation allows these routes without granting any SQLite writes.
    const productionRead=deployment.activated&&process.env.MOYU_RAG_READONLY_BASELINE===V6_READONLY_BASELINE;
    const chatRead=productionRead&&request.method==='POST'&&['/api/chat','/api/agent'].includes(url.pathname);
    const comparisonRead=productionRead&&['GET','POST'].includes(request.method)&&url.pathname==='/api/comparison';
    const readable=reportRead||chatRead||comparisonRead||request.method==='GET'&&/^\/api\/knowledge\/(documents(?:\/[^/]+\/manage)?|sources|readiness)$/.test(url.pathname)||request.method==='POST'&&url.pathname==='/api/knowledge/search';
    if(!readable)return productionRead?'正式知识库以只读方式连接：聊天与检索可用，上传和文档变更尚未开放。':'候选库只读验收中，上传、变更、聊天和 Agent 请求尚未开放。';
  }
  return null;
}
