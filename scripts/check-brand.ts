import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {LEGACY_PRODUCT_NAMES,PRODUCT_NAME,PRODUCT_PACKAGE} from '../src/lib/product-identity';

export function inspectBrand(root=process.cwd()) {
  // Public archives intentionally have no Git history. Inspect source files
  // directly and never walk dependencies, credentials or runtime/user data.
  const omitted=new Set(['.git','node_modules','.next','.next-v7','.next-e2e','.moyu','tmp','uploads','data','models','vectors','storage','.cache','coverage','dist','build','out','test-results','playwright-report']);
  const files:string[]=[];
  function visit(relative:string){
    for(const entry of readdirSync(path.join(root,relative),{withFileTypes:true})){
      if(omitted.has(entry.name)||entry.name.startsWith('.env')&&entry.name!=='.env.example'||/\.(?:log|tsbuildinfo|sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|onnx(?:_data)?)$/.test(entry.name))continue;
      const file=path.join(relative,entry.name),absolute=path.join(root,file);
      if(lstatSync(absolute).isSymbolicLink())throw new Error('Brand check refuses source symlinks.');
      if(entry.isDirectory())visit(file);else if(entry.isFile())files.push(file.replace(/\\/g,'/'));
    }
  }
  visit('');files.sort();
  const findings:{file:string;reason:string}[]=[];
  const technicalCompatibilityFiles:string[]=[];
  let textFiles=0;
  for(const file of files){
    if(LEGACY_PRODUCT_NAMES.some(name=>file.includes(name)))findings.push({file,reason:'旧品牌文件路径'});
    const bytes=readFileSync(path.join(root,file));if(bytes.includes(0))continue;textFiles++;
    const text=bytes.toString('utf8');
    if(LEGACY_PRODUCT_NAMES.some(name=>text.includes(name)))findings.push({file,reason:'旧品牌展示文字'});
    if(/\bmoyu\b|MOYU_|__moyu|x-moyu/i.test(text))technicalCompatibilityFiles.push(file);
  }
  const pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
  if(pkg.name!==PRODUCT_PACKAGE)findings.push({file:'package.json',reason:'包名与正式品牌不一致'});
  return {product:PRODUCT_NAME,filesScanned:files.length,textFilesScanned:textFiles,findings,technicalCompatibilityFiles};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const result=inspectBrand();console.log(JSON.stringify(result,null,2));if(result.findings.length)process.exitCode=1;
}
