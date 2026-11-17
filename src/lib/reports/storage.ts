import 'server-only';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { safePath, within } from '../rag/migration-paths';
import { windowsCommand } from '../rag/migration-safety';
import { reportSchema, ReportError, type Report } from './types';
export const REPORT_ROOT=path.resolve(/* turbopackIgnore: true */ 'tmp/reports',process.env.MOYU_REPORT_TESTING==='1'?`test-jobs/${process.pid}`:'jobs');
const MAX_FILE=20*1024*1024,TTL=60*60*1000;
const authSchema=z.object({id:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),format:z.enum(['docx','pdf'])}).strict();
const metadata=z.object({id:z.uuid(),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),expires:z.number().int().positive(),formats:z.array(z.enum(['docx','pdf'])).min(1).max(2),report:reportSchema}).strict();
const hash=(s:string)=>createHash('sha256').update(s).digest();
let secured=false;
function initialize(){
  safePath(REPORT_ROOT,false);mkdirSync(/* turbopackIgnore: true */ REPORT_ROOT,{recursive:true,mode:0o700});
  if(!secured&&process.platform==='win32'){
    const encoded=Buffer.from(REPORT_ROOT).toString('base64');
    // DACL only: Set-Acl can request SACL privileges on a repeat run on Windows.
    windowsCommand(`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$ids=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544');$exe=Join-Path $env:SystemRoot 'System32/icacls.exe';& $exe $p /inheritance:r >$null;if($LASTEXITCODE -ne 0){throw 'ACL failed'};foreach($id in $ids){& $exe $p /grant:r ('*'+$id+':(OI)(CI)F') >$null;if($LASTEXITCODE -ne 0){throw 'ACL failed'}};$acl=Get-Acl -LiteralPath $p;if(!$acl.AreAccessRulesProtected){throw 'ACL inheritance'};foreach($r in $acl.Access){$sid=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid -notin $ids -or $r.AccessControlType -ne 'Allow'){throw 'Unexpected ACL'}}`,'REPORT_DIRECTORY_PERMISSIONS_FAILED');
  }
  secured=true;
  for(const name of readdirSync(/* turbopackIgnore: true */ REPORT_ROOT).slice(0,100)){
    if(!z.uuid().safeParse(name).success)continue;
    const dir=path.join(REPORT_ROOT,name);if(lstatSync(/* turbopackIgnore: true */ dir).isSymbolicLink())continue;
    try { const file=safePath(path.join(dir,'manifest.json'));if(statSync(/* turbopackIgnore: true */ file).size>200000)continue;const m=metadata.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ file,'utf8')));if(m.id===name&&m.expires<Date.now()&&within(REPORT_ROOT,safePath(dir)))rmSync(/* turbopackIgnore: true */ dir,{recursive:true}); } catch {/* Unknown files are never removed. */}
  }
  if(readdirSync(/* turbopackIgnore: true */ REPORT_ROOT).length>=50)throw new ReportError('报告临时存储已满，请清理已下载的报告后重试。',429);
}
export function saveReport(report:Report,files:Partial<Record<'docx'|'pdf',Buffer>>){
  reportSchema.parse(report);initialize();const id=randomUUID(),token=randomBytes(32).toString('hex'),dir=path.join(REPORT_ROOT,id);
  const formats=(['docx','pdf'] as const).filter(f=>files[f]);if(!formats.length)throw new ReportError('没有可保存的导出文件。');
  if(formats.some(f=>!files[f]!.length||files[f]!.length>MAX_FILE))throw new ReportError('导出文件超过 20MB 限制。');
  safePath(dir,false);mkdirSync(/* turbopackIgnore: true */ dir,{mode:0o700});
  for(const f of formats)writeFileSync(/* turbopackIgnore: true */ path.join(dir,'report.'+f),files[f]!,{flag:'wx',mode:0o600});
  const record=metadata.parse({id,tokenHash:hash(token).toString('hex'),expires:Date.now()+TTL,formats,report});
  writeFileSync(/* turbopackIgnore: true */ path.join(dir,'manifest.json'),JSON.stringify(record),{flag:'wx',mode:0o600});return {id,token,formats};
}
export function readReportDownload(value:unknown){
  const auth=authSchema.parse(value),dir=path.join(REPORT_ROOT,auth.id);
  if(!existsSync(/* turbopackIgnore: true */ dir))throw new ReportError('报告不存在或已过期，请重新生成。',404);
  const file=safePath(path.join(dir,'manifest.json'));if(statSync(/* turbopackIgnore: true */ file).size>200000)throw new ReportError('报告元数据异常。',409);
  const m=metadata.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ file,'utf8')));
  if(m.id!==auth.id||!timingSafeEqual(hash(auth.token),Buffer.from(m.tokenHash,'hex')))throw new ReportError('没有此报告的下载权限。',403);
  if(Date.now()>m.expires)throw new ReportError('下载已过期，请重新生成报告。',410);
  if(!m.formats.includes(auth.format))throw new ReportError('本次未生成此格式。',404);
  const target=safePath(path.join(dir,'report.'+auth.format));if(!within(REPORT_ROOT,target)||statSync(/* turbopackIgnore: true */ target).size>MAX_FILE)throw new ReportError('导出文件异常。',409);
  return {bytes:readFileSync(/* turbopackIgnore: true */ target),report:m.report,format:auth.format};
}
export function downloadHeaders(title:string,format:'docx'|'pdf'){
  const safe=title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').slice(0,70).trim().replace(/[. ]+$/,'')||'报告';
  return {'Content-Type':format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="xiaoren-er-insurance-report.${format}"; filename*=UTF-8''${encodeURIComponent(safe+'.'+format).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
}
