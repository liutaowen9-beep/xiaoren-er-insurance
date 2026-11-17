import 'server-only';
import { z } from 'zod';
import type { KnowledgeStore } from '../rag/store';
import { checkDownloadEvidence } from '../reports/evidence';
import { readReportDownload, saveReport } from '../reports/storage';
import { reportSchema } from '../reports/types';
import { toDocx, toPdf } from '../reports/export';

export const revisionSchema=z.object({id:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),note:z.string().trim().min(1).max(1200).refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))}).strict();
export async function reviseNeedsReport(raw:unknown,store:KnowledgeStore,signal:AbortSignal){
  const input=revisionSchema.parse(raw),saved=readReportDownload({id:input.id,token:input.token,format:'docx'});
  // Editing user notes never edits model facts or assigns citations to new claims.
  if(saved.report.content.title!=='客户需求分析报告')throw new Error('只能修改客户需求分析报告的沟通备注。');
  const report=reportSchema.parse({...saved.report,createdAt:new Date().toISOString(),content:{...saved.report.content,sections:saved.report.content.sections.map((s,i)=>i!==saved.report.content.sections.length-1?s:{...s,paragraphs:[...s.paragraphs.filter(p=>!p.text.startsWith('用户补充（未核验）：')),{text:'用户补充（未核验）：以下为用户编辑的沟通备注，不作为保险产品事实或核验结论。\n'+input.note,sources:[]}]})}});
  const check=()=>{signal.throwIfAborted();checkDownloadEvidence(store,report);};
  check();const docx=await toDocx(report);check();const pdf=await toPdf(report,signal);check();
  return {...saveReport(report,{docx,pdf}),report};
}
