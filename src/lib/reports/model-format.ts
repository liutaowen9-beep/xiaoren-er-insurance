import 'server-only';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { safePath } from '../rag/migration-paths';
import { ReportError } from './types';

export class ReportFormatError extends ReportError {
  constructor(public readonly reason: 'json'|'schema'|'truncated'|'oversized') {
    super(`DeepSeek 报告格式错误（${{json:'JSON 无法解析',schema:'字段缺失或结构不符',truncated:'输出被截断',oversized:'输出超过限制'}[reason]}）。`,502);
  }
}
export function parseModelJson(raw:string):unknown {
  if(raw.length>28000)throw new ReportFormatError('oversized');
  const text=raw.trim().replace(/^\uFEFF/,'');
  const fenced=/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  try{return JSON.parse(fenced?fenced[1].trim():text);}catch{throw new ReportFormatError('json');}
}
// Record shape diagnostics, never raw responses, evidence, prompts, keys or identifiers.
export function recordModelDiagnostic(stage:'outline'|'content',attempt:number,raw:string,finish:string,code:string) {
  try {
    const root=safePath(path.resolve('tmp/reports/model-diagnostics'),false);
    mkdirSync(/* turbopackIgnore: true */ root,{recursive:true,mode:0o700});
    const file=safePath(path.join(root,'format.jsonl'),false);
    if(existsSync(/* turbopackIgnore: true */ file)&&statSync(/* turbopackIgnore: true */ file).size>262144)return;
    appendFileSync(/* turbopackIgnore: true */ file,JSON.stringify({at:new Date().toISOString(),stage,attempt,chars:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),finish,code})+'\n',{mode:0o600});
  }catch{/* Diagnostics must not leak exceptions or interfere with report generation. */}
}
export async function structuredStage<T>(stage:'outline'|'content',schema:z.ZodType<T>,work:(attempt:number)=>Promise<unknown>,signal:AbortSignal):Promise<T> {
  for(let attempt=0;attempt<2;attempt++){
    signal.throwIfAborted();
    try {
      const value=await work(attempt);signal.throwIfAborted();
      const parsed=schema.safeParse(typeof value==='string'?parseModelJson(value):value);
      if(!parsed.success)throw new ReportFormatError('schema');
      return parsed.data;
    }catch(e){
      if(!(e instanceof ReportFormatError))throw e;
      if(attempt===1)throw new ReportError(`${stage==='outline'?'DeepSeek 大纲':'DeepSeek 正文'}格式校验失败，已进行一次格式修复重试（${e.reason}）。请缩小报告范围后重试。`,502);
    }
  }
  throw new ReportError('报告格式校验失败。',502);
}
