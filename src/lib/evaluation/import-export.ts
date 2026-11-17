import { datasetSchema,EvaluationError,type Dataset } from './types';
const fields=['id','question','referenceAnswer','relevant','unanswerable','expectedTools','expectedTaskSuccess','observedRunId','response','model','modelVersion','requiredPhrases','tags','difficulty','citations'] as const;
const structured=new Set(['relevant','unanswerable','expectedTools','expectedTaskSuccess','requiredPhrases','tags','citations']);
export function parseCsv(text:string){
  if(Buffer.byteLength(text)>1024*1024)throw new EvaluationError('导入文件超过 1MB。',413);
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
    if(ch==='"'){if(cell||closed)throw new EvaluationError('CSV 引号位置错误。');quoted=true;}
    else if(ch===','||ch==='\n'){row.push(cell);cell='';closed=false;if(ch==='\n'){rows.push(row);row=[];if(rows.length>102)throw new EvaluationError('CSV 案例过多。');}}
    else if(ch==='\r'&&text[i+1]==='\n')continue;
    else{if(closed)throw new EvaluationError('CSV 引号后存在非法字符。');cell+=ch;}
  }if(quoted)throw new EvaluationError('CSV 引号未闭合。');if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
export function exportDataset(data:Dataset,format:'json'|'csv'){
  if(format==='json')return JSON.stringify(data,null,2);
  const escape=(v:string)=>'"'+v.replace(/"/g,'""')+'"';
  // Prefix formula-like cells, including text starting with an apostrophe; import reverses exactly one transport prefix.
  const safe=(v:string)=>/^[=+\-@'\t\r]/.test(v)?"'"+v:v;
  return [fields.join(','),...data.cases.map(c=>fields.map(f=>{const v=c[f];return escape(safe(v===undefined?'':typeof v==='string'?v:JSON.stringify(v)));}).join(','))].join('\r\n');
}
export function importDataset(content:string,format:'json'|'csv',metadata?:{name:string;description?:string;dataPolicy:'synthetic'|'deidentified';libraryId?:string;corpusHash?:string}){
  if(Buffer.byteLength(content)>1024*1024)throw new EvaluationError('导入超过 1MB。',413);
  if(format==='json')return datasetSchema.parse(JSON.parse(content));
  const [headers,...rows]=parseCsv(content.replace(/^\uFEFF/,''));if(!headers?.length||new Set(headers).size!==headers.length||headers.some(h=>!fields.includes(h as typeof fields[number]))||!headers.includes('question')||!headers.includes('id'))throw new EvaluationError('CSV 表头无效、缺失或重复。');
  const cases=rows.map(r=>{if(r.length!==headers.length)throw new EvaluationError('CSV 列数不一致。');return Object.fromEntries(headers.flatMap((f,i)=>{let v=r[i];if(v.startsWith("'")&&/^[=+\-@'\t\r]/.test(v.slice(1)))v=v.slice(1);if(!v)return [];return [[f,structured.has(f)?JSON.parse(v):v]];}));});
  return datasetSchema.parse({...metadata,cases});
}
