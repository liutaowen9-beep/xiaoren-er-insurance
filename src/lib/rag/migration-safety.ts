import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { auditDatabase, requireSafe } from './database-audit';
import { PROJECT_ROOT, readJson, safePath, sha256, within } from './migration-paths';

export const identitySchema = z.object({ format: z.literal(1), targetId: z.uuid(), root: z.string(), target: z.string(), backup: z.string(), backupManifestHash: z.string().regex(/^[a-f0-9]{64}$/), baselineDigest: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() }).strict();
export type TargetIdentity = z.infer<typeof identitySchema>;
// Accept either complete spelling, never ambiguous aliases or unknown fields.
const manifestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestBytesSchema = z.number().int().nonnegative().safe();
const manifestEntriesSchema = z.array(z.union([
  z.object({ file: z.string(), bytes: manifestBytesSchema, sha256: manifestHashSchema }).strict(),
  z.object({ path: z.string(), size: manifestBytesSchema, sha256: manifestHashSchema }).strict()
    .transform(entry => ({ file: entry.path, bytes: entry.size, sha256: entry.sha256 })),
])).min(1);
function verifiedEntries(value: unknown, root: string) {
  const entries = manifestEntriesSchema.parse(value), names = new Set<string>();
  for (const entry of entries) {
    requireSafe(entry.file.length > 0 && !path.win32.isAbsolute(entry.file) && !path.posix.isAbsolute(entry.file)
      && !entry.file.includes(':') && !entry.file.includes('\0')
      && entry.file.split(/[\\/]/).every(part => part !== '' && part !== '.' && part !== '..'), 'BACKUP_MANIFEST_PATH_FAILED');
    const resolved = path.resolve(root, entry.file), key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    requireSafe(within(root, resolved) && !names.has(key), 'BACKUP_MANIFEST_PATH_FAILED');
    names.add(key);
    const file = safePath(resolved), stat = statSync(file);
    requireSafe(stat.isFile() && stat.size === entry.bytes && sha256(file) === entry.sha256, 'BACKUP_PAYLOAD_HASH_FAILED');
  }
  return entries;
}
export function targetIdentity(rootArg: string, targetArg: string) {
  // Target is checked first, so a live-production attempt never reads the database or a marker.
  const target = safePath(targetArg), root = safePath(rootArg);
  requireSafe(target === path.join(root, 'data', 'knowledge.sqlite'), 'TARGET_LAYOUT_MISMATCH');
  const id = identitySchema.parse(readJson(path.join(root, 'migration-target.json')));
  requireSafe(id.root === root && id.target === target, 'TARGET_IDENTITY_MISMATCH');
  requireSafe(!within(path.join(id.backup, 'payload'), target), 'BACKUP_IS_NOT_A_TARGET');
  return id;
}
export function verifyBackup(backupArg: string, maxAgeHours = 24) {
  const backup = safePath(backupArg);
  const manifestFile = path.join(backup, 'SHA256-MANIFEST.json');
  const manifestHash = sha256(safePath(manifestFile));
  const expected = readFileSync(safePath(path.join(backup, 'SHA256-MANIFEST.sha256')), 'utf8').split(/\s/)[0];
  requireSafe(manifestHash === expected, 'BACKUP_MANIFEST_HASH_FAILED');
  const payload = path.join(backup, 'payload');
  const entries = verifiedEntries(readJson(manifestFile), payload), names = new Set(entries.map(entry => entry.file));
  requireSafe(names.has('.moyu/knowledge.sqlite') && names.has('v6.0-source.zip') && entries.some(e => e.file.startsWith('.moyu/models/')), 'BACKUP_SCOPE_INCOMPLETE');
  const report = z.object({ completedAt: z.string(), checksums: z.literal('PASS'), isolatedRestore: z.literal('PASS'), modelApplicationProbe: z.literal('PASS'), restoreScriptRehearsal: z.literal('PASS'), logicalDataPreservation: z.literal('PASS') }).passthrough().parse(readJson(path.join(backup, 'VERIFICATION-RESULT.json')));
  const controls=verifiedEntries(readJson(path.join(backup,'CONTROL-FILES-SHA256.json')), backup);
  const reportControl=controls.find(entry=>entry.file==='VERIFICATION-RESULT.json');
  requireSafe(reportControl&&sha256(safePath(path.join(backup,reportControl.file)))===reportControl.sha256,'BACKUP_REPORT_HASH_FAILED');
  const age = Date.now() - Date.parse(report.completedAt);
  requireSafe(Number.isFinite(age) && age >= -60000 && age <= maxAgeHours * 3600000, 'BACKUP_STALE_OR_FUTURE');
  const dbFile = safePath(path.join(payload, '.moyu/knowledge.sqlite'));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let audit;
  try { audit = auditDatabase(db); requireSafe(audit.schemaVersion === 0, 'BACKUP_SCHEMA_NOT_ZERO'); } finally { db.close(); }
  return { backup, manifestHash, entries, audit, completedAt: report.completedAt };
}
export const maintenanceSchema = z.object({ format: z.literal(1), targetId: z.uuid(), backupManifestHash: z.string(), operatorConfirmed: z.literal(true), writersStopped: z.literal(true), agentsStopped: z.literal(true), servicesStopped: z.literal(true), sourceUnchangedSinceBackup: z.literal(true), confirmedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), ports: z.array(z.number().int().min(1024).max(65535)).min(2).max(12) }).strict();
export function verifyMaintenance(file: string, id: TargetIdentity) {
  const m = maintenanceSchema.parse(readJson(file)), now = Date.now();
  requireSafe(m.targetId === id.targetId && m.backupManifestHash === id.backupManifestHash, 'MAINTENANCE_TARGET_MISMATCH');
  requireSafe(Date.parse(m.confirmedAt) <= now && now < Date.parse(m.expiresAt) && Date.parse(m.expiresAt) - Date.parse(m.confirmedAt) <= 3600000, 'MAINTENANCE_EXPIRED');
  requireSafe(m.ports.includes(3000) && m.ports.includes(3001), 'MAINTENANCE_PORTS_INCOMPLETE');
  return m;
}
export function windowsCommand(script: string,code='MAINTENANCE_OS_PROBE_FAILED') {
  requireSafe(process.platform === 'win32', 'WINDOWS_HANDLE_PROBE_REQUIRED');
  const systemRoot=process.env.SystemRoot??'C:\\Windows',modules=path.join(systemRoot,'System32/WindowsPowerShell/v1.0/Modules');
  const result = spawnSync(path.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';"+script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000,env:{...process.env,PSModulePath:modules} });
  requireSafe(result.status === 0 && !result.error,code);
}
export function assertQuiescent(target: string, ports: number[]) {
  // A physically isolated test copy does not require stopping the user's live website.
  // This exception can NEVER cover .moyu, external deployment roots, aliases or links.
  const isolatedTest = process.env.MOYU_MIGRATION_TESTING === '1' && within(path.join(PROJECT_ROOT,'tmp/rag-tests'),target) && safePath(target) === path.resolve(target);
  const encoded = Buffer.from(JSON.stringify({ files: [target, target+'-wal', target+'-shm', target+'-journal'].filter(existsSync), project: PROJECT_ROOT, ports:isolatedTest?ports.filter(p=>p!==3000&&p!==3001):ports, pid: process.pid, isolatedTest })).toString('base64');
  windowsCommand(`$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;
    $processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'");
    foreach($p in $processes){if(!$c.isolatedTest -and $p.ProcessId -ne $c.pid -and $p.CommandLine -match 'next[\\/].*(bin|server)|next (dev|start)|next-server'){throw 'Project server still running'}};
    foreach($port in $c.ports){if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw 'Listening port'}};
    foreach($file in $c.files){$s=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);$s.Dispose()}`);
}
export function ownerIsAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
