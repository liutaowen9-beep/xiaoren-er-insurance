import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { EMBEDDING_ID, EMBEDDING_DIMENSION } from '../rag/model-spec';
import { PlatformError, type Asset, type Version, type Member, type QualityCheck, type Scan } from './types';

export const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function safeFile(file: string, mustExist = true) {
  if (!path.isAbsolute(file) || file.startsWith('\\\\')) throw new PlatformError('必须使用已登记的本机绝对路径。');
  for (let part = path.resolve(file); part !== path.dirname(part); part = path.dirname(part)) {
    if (existsSync(part)) { const s=lstatSync(part); if(s.isSymbolicLink() || (s.isFile() && s.nlink!==1)) throw new PlatformError('拒绝符号链接、目录联接或硬链接。'); }
  }
  if (mustExist && (!existsSync(file) || !lstatSync(file).isFile())) throw new PlatformError('已登记知识库文件不存在。',503);
}
async function fileHash(file: string, signal: AbortSignal) {
  const hash=createHash('sha256');
  for await (const bytes of createReadStream(file,{signal})) hash.update(bytes);
  return hash.digest('hex');
}
export async function fingerprints(file: string, signal: AbortSignal) {
  const result: Record<string,string|null>={};
  for(const suffix of ['', '-wal', '-shm', '-journal']) {
    signal.throwIfAborted(); const target=file+suffix;
    if(!existsSync(target)){result[suffix]=null;continue;}
    safeFile(target); const s=lstatSync(target);
    if(s.size>512*1024*1024) throw new PlatformError('文件超出基础版只读扫描大小上限。',413);
    if(suffix==='-journal' && s.size>0) throw new PlatformError('检测到回滚日志，请等待写入结束后再扫描。',409);
    result[suffix]=await fileHash(target,signal);
  }
  return result;
}
/** No SQLite connection is ever opened on source. WAL recovery/SHM creation is confined to a disposable copy. */
export async function scanKnowledge(file: string, libraryId: string, signal: AbortSignal, scratchRoot=path.resolve('tmp/reports/data-platform/scratch')): Promise<Scan> {
  safeFile(file); safeFile(scratchRoot,false);
  const rel=path.relative(path.dirname(file),scratchRoot);
  if(!rel || (!rel.startsWith('..')&&!path.isAbsolute(rel))) throw new PlatformError('扫描临时目录必须与知识库目录分离。');
  await mkdir(scratchRoot,{recursive:true,mode:0o700});
  const scratch=await mkdtemp(path.join(scratchRoot,'scan-'));
  let db: DatabaseSync|undefined;
  try {
    const before=await fingerprints(file,signal), copy=path.join(scratch,'knowledge.sqlite');
    await copyFile(file,copy);
    if(before['-wal']!==null) await copyFile(file+'-wal',copy+'-wal');
    if(await fileHash(copy,signal)!==before[''] || (before['-wal']!==null&&await fileHash(copy+'-wal',signal)!==before['-wal']))throw new PlatformError('临时副本校验失败，结果未发布。',409);
    if(canonical(before)!==canonical(await fingerprints(file,signal))) throw new PlatformError('知识库在复制期间发生变化，请等待写入结束后重试。',409);
    db=new DatabaseSync(copy,{readOnly:true}); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    signal.throwIfAborted();
    const schema=Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if(schema!==1) throw new PlatformError('只读扫描要求知识库 schema 1；不会自动迁移。',409);
    const checks: QualityCheck[]=[], capturedAt=Date.now();
    const check=(rule:string,name:string,objectId:string,documentName:string|null,result:QualityCheck['result'],reason:string,suggestion?:string)=>checks.push({rule,name,objectId,documentName,result,reason,suggestion:suggestion??(result==='PASS'?'无需修复；请继续保留完整备份。':'请在原知识库管理流程中人工核查；中台不会修复源数据。'),checkedAt:capturedAt});
    check('integrity','数据库完整性',libraryId,null,db.prepare('PRAGMA integrity_check').get()!.integrity_check==='ok'?'PASS':'FAIL','SQLite 完整性检查');
    check('foreign_keys','文档版本关联',libraryId,null,db.prepare('PRAGMA foreign_key_check').all().length?'FAIL':'PASS','文档、版本、切片外键检查');
    const assets=db.prepare('SELECT id,state,current_version_id AS currentVersionId,revision,created_at AS createdAt,updated_at AS updatedAt FROM knowledge_documents ORDER BY id').all() as unknown as Asset[];
    if(assets.length>1000)throw new PlatformError('基础版最多扫描 1000 份逻辑文档。',413);
    const members: Member[]=[], versions: Version[]=[];
    const all=db.prepare('SELECT id,logical_id,version,name,extension,size,hash,status,chunk_count,model,dimension,created_at,length(raw) AS raw_size FROM documents ORDER BY id').all();
    if(all.length>5000)throw new PlatformError('版本数量超出基础版扫描上限。',413);
    for(const row of all) {
      signal.throwIfAborted();
      // Yield between versions so cancellation and timeout can be observed before publication.
      await new Promise<void>(resolve=>setImmediate(resolve));
      const id=String(row.id), name=String(row.name), asset=assets.find(a=>a.id===row.logical_id);
      if(Number(row.size)>30*1024*1024||Number(row.raw_size)>30*1024*1024)throw new PlatformError('原文件超出单文件扫描上限。',413);
      const raw=db.prepare('SELECT raw FROM documents WHERE id=?').get(id)!.raw;
      const actualHash=raw instanceof Uint8Array?sha(raw):'UNKNOWN';
      check('raw_hash','原始文件 SHA-256',id,name,actualHash==='UNKNOWN'?'UNKNOWN':actualHash===row.hash&&raw instanceof Uint8Array&&raw.byteLength===row.size?'PASS':'FAIL',actualHash==='UNKNOWN'?'无法读取原始字节':actualHash===row.hash&&raw instanceof Uint8Array&&raw.byteLength===row.size?'原始文件长度与 SHA-256 一致':'原始文件长度或 SHA-256 与版本记录不一致');
      const rows=db.prepare('SELECT id,sequence,page,text,vector,model,dimension FROM chunks WHERE document_id=? ORDER BY id').all(id);
      if(members.length+rows.length>20000)throw new PlatformError('切片数量超出基础版扫描上限。',413);
      let vectors=0, dimensions=true, models=true, texts=true;
      for(const chunk of rows) {
        const valid=chunk.vector instanceof Uint8Array&&chunk.vector.byteLength>0;
        if(valid)vectors++;
        let valuesValid=false;
        if(valid && chunk.vector instanceof Uint8Array && chunk.vector.byteLength===EMBEDDING_DIMENSION*4){const v=new Float32Array(Uint8Array.from(chunk.vector).buffer);valuesValid=v.every(Number.isFinite)&&Math.abs(Math.hypot(...v)-1)<.001;}
        dimensions&&=valid&&valuesValid&&chunk.dimension===EMBEDDING_DIMENSION;
        models&&=chunk.model===EMBEDDING_ID;
        texts&&=typeof chunk.text==='string'&&chunk.text.trim().length>0;
        members.push({id:String(chunk.id),documentId:id,sequence:Number(chunk.sequence),page:chunk.page===null?null:Number(chunk.page),textHash:typeof chunk.text==='string'?sha(chunk.text):'UNKNOWN',vectorHash:valid?sha(chunk.vector as Uint8Array):'UNKNOWN',model:String(chunk.model),dimension:Number(chunk.dimension),contentEmpty:typeof chunk.text!=='string'||!chunk.text.trim()});
      }
      versions.push({id,logicalId:String(row.logical_id),version:Number(row.version),name,extension:String(row.extension),size:Number(row.size),hash:String(row.hash),actualHash,status:String(row.status),chunkCount:rows.length,vectorCount:vectors,declaredChunks:Number(row.chunk_count),model:row.model===null?null:String(row.model),dimension:row.dimension===null?null:Number(row.dimension),createdAt:Number(row.created_at),isCurrent:asset?.currentVersionId===id});
      check('version_relation','版本归属',id,name,asset?'PASS':'FAIL',asset?'版本关联逻辑文档':'逻辑文档缺失');
      const sequences=rows.map(r=>Number(r.sequence)).sort((a,b)=>a-b);
      check('chunks','切片完整性',id,name,rows.length===row.chunk_count&&texts&&sequences.every((s,i)=>s===i)&&rows.every(r=>r.page===null||Number(r.page)>=1)&&(row.status!=='ready'||rows.length>0)?'PASS':'FAIL','校验声明数量、连续序号、页码、非空正文及 ready 文档切片');
      check('vectors','切片与向量数量',id,name,vectors===rows.length?'PASS':'FAIL',`${rows.length} 个切片，${vectors} 个向量`);
      check('dimension','向量维度与数值',id,name,!rows.length?'UNKNOWN':dimensions&&row.dimension===EMBEDDING_DIMENSION?'PASS':'FAIL',!rows.length?'没有向量可检查':`要求 ${EMBEDDING_DIMENSION} 维、有限数值、归一化`);
      check('model','Embedding 模型',id,name,!rows.length?'UNKNOWN':models&&row.model===EMBEDDING_ID?'PASS':'FAIL',!rows.length?'没有模型记录可确认':'按当前模型修订版、量化和池化规格检查');
      check('status','文档处理状态',id,name,row.status==='ready'?'PASS':row.status==='failed'?'FAIL':'WARNING',row.status==='ready'?'索引完成':`处理状态：${row.status}`);
    }
    for(const asset of assets) {
      const current=versions.filter(v=>v.id===asset.currentVersionId&&v.logicalId===asset.id);
      check('current','当前版本唯一性',asset.id,current[0]?.name??null,current.length===1&&current[0].status==='ready'?'PASS':'FAIL','当前指针必须唯一指向本逻辑文档的 ready 版本');
      check('eligibility','检索有效状态',asset.id,current[0]?.name??null,asset.state==='active'?'PASS':['inactive','archived'].includes(asset.state)?'WARNING':'FAIL',asset.state==='active'?'已启用；仍需有效当前版本':'停用/归档是合法管理状态，默认不参与检索');
    }
    const hashes=new Map<string,number>();versions.forEach(v=>hashes.set(v.hash,(hashes.get(v.hash)??0)+1));
    for(const v of versions)check('duplicate','重复文件',v.id,v.name,(hashes.get(v.hash)??0)>1?'WARNING':'PASS',(hashes.get(v.hash)??0)>1?'存在相同文件哈希；可能为保留的历史版本，需人工确认':'文件哈希唯一');
    const total=Number(db.prepare('SELECT count(*) AS n FROM chunks').get()!.n);
    check('orphan_chunks','切片关联完整性',libraryId,null,total===members.length?'PASS':'FAIL','所有切片均应归属已扫描版本');
    signal.throwIfAborted();
    if(canonical(before)!==canonical(await fingerprints(file,signal)))throw new PlatformError('知识库在扫描期间发生变化，本次结果未发布。',409);
    return {manifest:{format:1,libraryId,schema,embedding:{model:EMBEDDING_ID,dimension:EMBEDDING_DIMENSION},assets,versions,members:members.sort((a,b)=>a.id.localeCompare(b.id,'en')),qualityMetrics:{orphanChunks:total-members.length}},checks,capturedAt,fingerprint:sha(canonical(before))};
  } catch(error) {
    const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
    if(['EBUSY','EACCES','EPERM','ENOENT'].includes(code))throw new PlatformError('知识库文件正在变化、被占用或权限发生变化，扫描未发布；请等待写入结束后重试。',409);
    throw error;
  } finally {db?.close();await rm(scratch,{recursive:true,force:true});}
}
