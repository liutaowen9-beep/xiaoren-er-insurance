import 'server-only';
import {traceRetrieval} from '../data-platform/telemetry';
import { createHash } from 'node:crypto';
import { retrieve } from '../rag/service';
import { EMBEDDING_DIMENSION, EMBEDDING_ID, MAX_TOTAL_CHUNKS, RagError } from '../rag/config';
import type { KnowledgeStore } from '../rag/store';
import type { Source, KnowledgeDocument } from '../rag/types';

import { retrievalDiagnosticSchema, type RetrievalDiagnostic } from './retrieval-types';
const clean=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\u200b-\u200d\ufeff]/g,'');
const compact=(value:string)=>clean(value).replace(/[\s《》()（）【】\[\]，,。:：？?_-]/g,'');
function aliases(doc:KnowledgeDocument){
  const stem=clean(doc.name).replace(/\.[^.]+$/,'');
  return [...new Set([clean(doc.name),stem,...[...stem.matchAll(/\(([^)]+)\)/g)].map(m=>m[1]),stem.replace(/\d{6,}|\(\d+\)|计划书|产品说明书|新产品一页纸/g,'')].map(compact).filter(s=>s.length>=2&&!/^(?:保险|产品|文档|资料)$/.test(s)))];
}
const responsibility=/医疗保险|医疗费用|医疗|住院|重大疾病|重疾|身故|寿险|意外|养老|年金|教育/g;
const fields=/保障责任|保险期间|缴费期间|投保条件|等待期|免责|保费|保险金/g;
export function keywordTerms(query:string){const q=clean(query);const primary=[...q.matchAll(responsibility)].map(m=>m[0]);return [...new Set(primary.length?primary:[...q.matchAll(fields)].map(m=>m[0]))];}
export function diagnostic(store:KnowledgeStore,query:string,sources:Source[],methods:RetrievalDiagnostic['methods'],reason:string):RetrievalDiagnostic{
  const hits=new Map<string,{name:string;version:number;chunks:number}>();
  for(const source of sources){const doc=store.get(source.documentId),hit=hits.get(doc.id)??{name:doc.name,version:doc.version??1,chunks:0};hit.chunks++;hits.set(doc.id,hit);}
  return retrievalDiagnosticSchema.parse({query,library:'local-'+createHash('sha256').update(store.file).digest('hex').slice(0,12),eligibleDocuments:store.list().filter(d=>store.isEligible(d.id)).length,documents:hits.size,chunks:sources.length,hits:[...hits.values()],methods,reason});
}

/** Needs discovery only: retain the calibrated vector threshold; lexical candidates require actual matching text. */
export async function searchNeeds(query:string,store:KnowledgeStore,signal:AbortSignal,vectorSearch:typeof retrieve=retrieve){
  return traceRetrieval(query,5,store,'needs-hybrid-v1',()=>searchNeedsCore(query,store,signal,vectorSearch),value=>value.sources);
}
async function searchNeedsCore(query:string,store:KnowledgeStore,signal:AbortSignal,vectorSearch:typeof retrieve){
  if(!query.trim()||query.length>2000)throw new RagError('客户需求检索问题不能为空，且不能超过2000字。');
  signal.throwIfAborted();const eligible=store.list().filter(d=>store.isEligible(d.id));const q=compact(query);
  const named=eligible.filter(d=>aliases(d).some(a=>q.includes(a)));
  const explicit=[...query.normalize('NFKC').matchAll(/《([^》]+)》/g)].map(m=>compact(m[1]));
  const explicitMatches=explicit.map(name=>eligible.filter(d=>aliases(d).some(a=>a===name||name.length>=2&&a.includes(name))));
  if(explicitMatches.some(matches=>!matches.length))return {sources:[],diagnostic:diagnostic(store,query,[],[],'指定的产品或文档名称不在当前有效版本中；未使用其他产品代替。')};
  const scope=explicit.length?[...new Set(explicitMatches.flat())]:named;
  const allowed=new Set((scope.length?scope:eligible).map(d=>d.id)),terms=keywordTerms(query);
  const vectors=(await vectorSearch(scope.length?'《'+scope[0].name+'》 '+query:query,5,store,signal)).filter(s=>allowed.has(s.documentId)&&store.isEligible(s.documentId));
  signal.throwIfAborted();
  const docs=new Map(eligible.filter(d=>allowed.has(d.id)).map(d=>[d.id,d]));
  const rows=store.db.prepare('SELECT id,document_id,text,page,title,vector,model,dimension FROM chunks ORDER BY document_id,sequence LIMIT ?').all(MAX_TOTAL_CHUNKS+1) as {id:string;document_id:string;text:string;page:number|null;title:string|null;vector:Uint8Array;model:string;dimension:number}[];
  if(rows.length>MAX_TOTAL_CHUNKS)throw new RagError('知识库切片超过本地检索安全容量，未返回不完整结果。',409);
  const lexical=rows.filter(row=>docs.has(row.document_id)).map(row=>({row,rank:terms.reduce((sum,term)=>sum+(clean(row.text).includes(term)?1:0),0)})).filter(item=>scope.length||item.rank>0).sort((a,b)=>b.rank-a.rank).slice(0,5).map(({row})=>{
    const doc=docs.get(row.document_id)!;
    if(row.model!==EMBEDDING_ID||row.dimension!==EMBEDDING_DIMENSION||row.vector.byteLength!==EMBEDDING_DIMENSION*4)throw new RagError('命中文档的向量索引不一致，不能作为有效资料。',409);
    const values=new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength));
    if(!values.every(Number.isFinite)||Math.abs(Math.hypot(...values)-1)>0.001)throw new RagError('命中文档的向量已损坏，检索未降级为成功。',409);
    return {number:0,documentId:doc.id,chunkId:row.id,fileName:doc.name,text:row.text,score:0,kind:'document' as const,version:doc.version??1,state:doc.state,isCurrent:doc.isCurrent,...(row.page?{page:row.page}:{}),...(row.title?{title:row.title}:{})};
  });
  // Reciprocal-rank fusion orders candidates without inventing cosine scores for keyword matches.
  const fused=new Map<string,{source:Source;rank:number}>();
  for(const list of [vectors,lexical])list.forEach((source,i)=>{const prior=fused.get(source.chunkId);fused.set(source.chunkId,{source:prior?.source??source,rank:(prior?.rank??0)+1/(60+i+1)});});
  const sources=[...fused.values()].sort((a,b)=>b.rank-a.rank).map(v=>v.source).filter(s=>store.isEligible(s.documentId)).slice(0,5).map((s,i)=>({...s,number:i+1,version:store.get(s.documentId).version??1}));
  const methods:RetrievalDiagnostic['methods']=[...(vectors.length?['vector' as const]:[]),...(lexical.length?['keyword' as const]:[]),...(scope.length?['document-name' as const]:[])];
  return {sources,diagnostic:diagnostic(store,query,sources,methods,sources.length?'命中当前有效资料；关键词和相似度只用于候选发现，产品事实仍须原文核验。':!eligible.length?'没有当前有效且索引完成的文档。':'向量检索未通过现有阈值，当前有效原文也未命中责任或字段关键词；未推断相关产品不存在。')};
}
