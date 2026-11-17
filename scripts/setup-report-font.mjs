import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root=path.resolve('tmp/reports/fonts');
for (let part=root;part!==path.dirname(part);part=path.dirname(part)) {const s=await lstat(part).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(s?.isSymbolicLink())throw new Error('字体目录禁止符号链接');}
await mkdir(root,{recursive:true});
const files=[['NotoSansSC-Regular.otf','SubsetOTF/SC/NotoSansSC-Regular.otf','faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9'],['Noto-CJK-LICENSE.txt','LICENSE','6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2']];
for(const [name,remote,hash] of files){
  const existing=await lstat(path.join(root,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(existing&&(existing.isSymbolicLink()||existing.nlink!==1||!existing.isFile()))throw new Error('字体文件路径不安全');
  let bytes;try{bytes=await readFile(path.join(root,name));}catch{/* Download only this public, licensed font. */}
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==hash){
    const r=await fetch('https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/'+remote,{signal:AbortSignal.timeout(60000)});
    if(!r.ok)throw new Error('公开字体下载失败，请稍后重试 pnpm setup:report-font');
    bytes=Buffer.from(await r.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('字体版本哈希变化，已拒绝保存；请人工核对 Noto CJK 版本与 OFL 授权');
    await writeFile(path.join(root,name),bytes);
  }
  console.log(name+' verified');
}
