import {mkdir,readFile,writeFile,lstat,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const model='Xenova/multilingual-e5-small';
const revision='761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const root=path.resolve('tmp/rag-tests/management/models',model);
const names=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx'];
async function safe(file){
  for(let p=path.resolve(file);p!==path.dirname(p);p=path.dirname(p)){
    const s=await lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(s&&(s.isSymbolicLink()||s.isFile()&&s.nlink!==1))throw new Error('模型路径禁止链接。');
  }
}
await safe(root);
const meta=await fetch(`https://huggingface.co/api/models/${model}/revision/${revision}?blobs=true`,{signal:AbortSignal.timeout(30000)});
if(!meta.ok)throw new Error('无法读取公开模型清单：HTTP '+meta.status);
const manifest=await meta.json();
if(manifest.sha!==revision)throw new Error('模型版本校验失败。');
function valid(bytes,entry){
  if(bytes.length!==entry.size)return false;
  if(entry.lfs?.sha256)return createHash('sha256').update(bytes).digest('hex')===entry.lfs.sha256;
  return typeof entry.blobId==='string'&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===entry.blobId;
}
for(const name of names){
  const entry=manifest.siblings.find(f=>f.rfilename===name);
  if(!entry||!Number.isSafeInteger(entry.size)||entry.size<=0||entry.size>300*1024*1024)throw new Error('模型清单大小异常。');
  const file=path.join(root,name);await safe(file);await mkdir(path.dirname(file),{recursive:true});
  const cached=await readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(cached){if(!valid(cached,entry))throw new Error('已有模型文件校验失败，拒绝覆盖：'+name);console.log(name+' verified (cached)');continue;}
  console.log('Downloading official public resource: '+name+' ('+entry.size+' bytes)');
  const response=await fetch(`https://huggingface.co/${model}/resolve/${revision}/${name}`,{signal:AbortSignal.timeout(180000)});
  if(!response.ok||!response.body)throw new Error('公开模型下载失败：'+name+' HTTP '+response.status);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>entry.size)throw new Error('模型下载超过清单大小。');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);if(!valid(bytes,entry))throw new Error('模型哈希校验失败：'+name);
  const temporary=file+'.partial-'+randomUUID();await writeFile(temporary,bytes,{flag:'wx'});
  try{await safe(file);if(await lstat(file).catch(()=>null))throw new Error('目标在下载过程中出现，拒绝覆盖。');await rename(temporary,file);}catch(e){await unlink(temporary).catch(()=>{});throw e;}
  console.log(name+' verified');
}
console.log('Public embedding model ready. No private database or document was imported.');
