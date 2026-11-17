import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, renameSync, statSync, statfsSync } from 'node:fs';
import { auditDatabase, requireSafe } from './database-audit';
import { migrateSchema } from './schema-migration';
import { safePath, within, PROJECT_ROOT, readJson, sha256, implementationFingerprint } from './migration-paths';
import { assertQuiescent, ownerIsAlive, targetIdentity, verifyBackup, verifyMaintenance, windowsCommand, type TargetIdentity } from './migration-safety';

function writeNew(file: string, value: unknown) { writeFileSync(file, JSON.stringify(value, null, 2)+'\n', { flag: 'wx', mode: 0o600 }); }
function privateDirectory(root: string) {
  mkdirSync(root, { recursive: true });
  requireSafe(process.platform === 'win32', 'WINDOWS_PRIVATE_ACL_REQUIRED');
  const encoded = Buffer.from(root).toString('base64');
  const ps = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;foreach($id in @($me,'S-1-5-18','S-1-5-32-544')){$s=New-Object Security.Principal.SecurityIdentifier($id);$r=New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $a`;
  windowsCommand(ps,'PRIVATE_ACL_FAILED');
}
export function prepareCandidate(rootArg: string, targetArg: string, backupArg: string) {
  const target = safePath(targetArg, false), root = safePath(rootArg, false);
  requireSafe(target === path.join(root,'data','knowledge.sqlite'), 'TARGET_LAYOUT_MISMATCH');
  requireSafe(!existsSync(root), 'STAGING_ROOT_EXISTS');
  requireSafe(!within(root, PROJECT_ROOT) && (!within(PROJECT_ROOT, root) || within(path.join(PROJECT_ROOT,'tmp/rag-tests'), root)), 'STAGING_ROOT_UNSAFE');
  const backup = verifyBackup(backupArg);
  requireSafe(!within(backup.backup, root) && !within(root, backup.backup), 'STAGING_OVERLAPS_BACKUP');
  const disk = statfsSync(path.dirname(root));
  const size = backup.entries.filter(e => e.file.startsWith('.moyu/')).reduce((n,e) => n+e.bytes,0);
  requireSafe(disk.bavail*disk.bsize > size*4+100000000, 'DISK_SPACE_LOW');
  privateDirectory(root); mkdirSync(path.join(root,'data'));
  for (const entry of backup.entries.filter(e => e.file.startsWith('.moyu/'))) {
    const source = safePath(path.join(backup.backup,'payload',entry.file));
    const output = safePath(path.join(root,'data',entry.file.slice('.moyu/'.length)), false);
    mkdirSync(path.dirname(output), { recursive:true }); copyFileSync(source,output,constants.COPYFILE_EXCL);
    requireSafe(sha256(output) === entry.sha256, 'STAGING_COPY_HASH_FAILED');
  }
  writeNew(path.join(root,'model-files.json'), backup.entries.filter(e=>e.file.startsWith('.moyu/models/')).map(e=>({file:e.file.slice('.moyu/'.length),sha256:e.sha256})));
  const id: TargetIdentity = { format:1,targetId:randomUUID(),root,target,backup:backup.backup,backupManifestHash:backup.manifestHash,baselineDigest:backup.audit.digest,createdAt:new Date().toISOString() };
  writeNew(path.join(root,'migration-target.json'),id);
  writeNew(path.join(root,'maintenance.template.json'),{ format:1,targetId:id.targetId,backupManifestHash:id.backupManifestHash,operatorConfirmed:false,writersStopped:false,agentsStopped:false,servicesStopped:false,sourceUnchangedSinceBackup:false,confirmedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString(),ports:[3000,3001] });
  return { status:'prepared',schemaVersion:0,documents:backup.audit.documents,chunks:backup.audit.chunks,productionSourceOpened:false };
}
function bindBackup(id: TargetIdentity, backupArg: string) {
  const backup=verifyBackup(backupArg);
  requireSafe(backup.backup === id.backup && backup.manifestHash === id.backupManifestHash && backup.audit.digest === id.baselineDigest,'BACKUP_TARGET_MISMATCH');
  return backup;
}
function seal(id: TargetIdentity, audit: ReturnType<typeof auditDatabase>) {
  const receiptFile=path.join(id.root,'migration-receipt.json'),fingerprint=implementationFingerprint();
  if (!existsSync(receiptFile)) writeNew(receiptFile,{ format:1,targetId:id.targetId,backupManifestHash:id.backupManifestHash,baselineDigest:id.baselineDigest,codeFingerprint:fingerprint,modelManifestSha256:sha256(path.join(id.root,'model-files.json')),schemaVersion:1,documents:audit.documents,chunks:audit.chunks,completedAt:new Date().toISOString() });
  const receipt=readJson(receiptFile) as Record<string,unknown>;
  requireSafe(receipt.targetId===id.targetId && receipt.baselineDigest===audit.digest && receipt.codeFingerprint===fingerprint,'RECEIPT_MISMATCH');
  const deployment=path.join(id.root,'deployment.json');
  if (!existsSync(deployment)) writeNew(deployment,{ format:1,targetId:id.targetId,root:id.root,receiptSha256:sha256(receiptFile),codeFingerprint:fingerprint,schemaVersion:1 });
  const descriptor=readJson(deployment) as Record<string,unknown>;
  requireSafe(descriptor.targetId===id.targetId&&descriptor.root===id.root&&descriptor.receiptSha256===sha256(receiptFile)&&descriptor.codeFingerprint===fingerprint&&descriptor.schemaVersion===1,'DEPLOYMENT_DESCRIPTOR_MISMATCH');
}
export type ToolOptions={root:string;target:string;backup:string;maintenance?:string;execute?:boolean;recover?:boolean;activate?:string;checkpoint?:(phase:string)=>void};
export function runMigrationTool(options:ToolOptions) {
  const id=targetIdentity(options.root,options.target);
  requireSafe(!existsSync(path.join(id.root,'activation.json')),'TARGET_ALREADY_ACTIVATED');
  const backup=bindBackup(id,options.backup);
  const lock=path.join(id.root,'.migration.lock');
  const mutating=options.execute || options.recover || options.activate !== undefined;
  let ports:number[]=[3000,3001];
  if (mutating) {
    requireSafe(options.maintenance,'MAINTENANCE_CONFIRMATION_REQUIRED');
    const maintenance=verifyMaintenance(options.maintenance,id);
    requireSafe(Date.parse(maintenance.confirmedAt)>=Date.parse(backup.completedAt),'MAINTENANCE_PREDATES_BACKUP');
    ports=maintenance.ports;
    assertQuiescent(id.target,ports);
  }
  if (options.recover) {
    requireSafe(existsSync(lock),'RECOVERY_LOCK_MISSING');
    const old=readJson(lock) as {pid?:number;targetId?:string};
    requireSafe(old.targetId===id.targetId && Number.isSafeInteger(old.pid) && Number(old.pid)>0 && !ownerIsAlive(Number(old.pid)),'RECOVERY_OWNER_NOT_CONFIRMED_DEAD');
    // Opening RW here is explicit recovery: SQLite, not this tool, rolls back its hot journal.
    const db=new DatabaseSync(id.target);
    try {const audit=auditDatabase(db);requireSafe(audit.digest===id.baselineDigest,'RECOVERY_DATA_CHANGED');if(audit.schemaVersion===1)seal(id,audit);}
    finally {db.close();}
    renameSync(lock,lock+'.recovered-'+randomUUID());
    return {status:'recovered',productionSourceOpened:false};
  }
  requireSafe(!existsSync(lock),'MIGRATION_LOCK_EXISTS');
  if (!mutating) {
    assertQuiescent(id.target,ports);
    const db=new DatabaseSync(id.target,{readOnly:true});
    try {const audit=auditDatabase(db);requireSafe(audit.digest===id.baselineDigest,'TARGET_DIFFERS_FROM_BACKUP');return {status:audit.schemaVersion===1?'already-migrated':'dry-run',...audit,productionSourceOpened:false,connectionProbe:'no-open-handles-observed',wal:existsSync(id.target+'-wal'),shm:existsSync(id.target+'-shm'),maintenanceVerified:false};}
    finally {db.close();}
  }
  const beforeStat=statSync(id.target),fd=openSync(lock,'wx');
  writeFileSync(fd,JSON.stringify({pid:process.pid,targetId:id.targetId,startedAt:new Date().toISOString()}));
  let db:DatabaseSync|undefined;
  try {
    assertQuiescent(id.target,ports);
    for(const suffix of ['-wal','-shm'])if(existsSync(id.target+suffix))requireSafe(statSync(safePath(id.target+suffix)).size===0,'NONEMPTY_WAL_OR_SHM_REQUIRES_NEW_SNAPSHOT');
    const current=statSync(id.target);requireSafe(current.ino===beforeStat.ino&&current.dev===beforeStat.dev,'TARGET_FILE_ID_CHANGED');
    db=new DatabaseSync(id.target);db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE');
    const before=auditDatabase(db);requireSafe(before.digest===id.baselineDigest,'TARGET_DIFFERS_FROM_BACKUP');
    if(options.activate!==undefined){
      requireSafe(options.activate===id.targetId&&before.schemaVersion===1,'CUTOVER_APPROVAL_MISMATCH');
      seal(id,before);
      writeNew(path.join(id.root,'activation.json'),{targetId:id.targetId,receiptSha256:sha256(path.join(id.root,'migration-receipt.json')),approvedAt:new Date().toISOString()});
      return {status:'activation-approved',schemaVersion:1,productionSourceOpened:false};
    }
    const result=migrateSchema(db,options.checkpoint,true);
    seal(id,result.after);
    return {status:result.status,schemaVersion:1,documents:result.after.documents,chunks:result.after.chunks,vectors:result.after.vectors,legacyDataPreserved:result.before.digest===result.after.digest,productionSourceOpened:false};
  } finally {db?.close();closeSync(fd);unlinkSync(lock);}
}
