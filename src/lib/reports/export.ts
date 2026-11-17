import 'server-only';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, Footer, PageNumber, AlignmentType } from 'docx';
import { safePath } from '../rag/migration-paths';
import { reportSchema, ReportError, type Report } from './types';
import { PRODUCT_NAME } from '../product-identity';

const FONT_HASH='faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9';
export function reportFont() {
  try {
    const bytes=readFileSync(safePath(path.resolve('tmp/reports/fonts/NotoSansSC-Regular.otf')));
    if(createHash('sha256').update(bytes).digest('hex')!==FONT_HASH)throw new Error();
    return bytes;
  } catch { throw new ReportError('中文 PDF 字体未安装或校验失败，请运行 pnpm setup:report-font。',503); }
}
const cited=(numbers:number[])=>numbers.length?' 〔'+numbers.join('、')+'〕':'';
const sourceText=(r:Report['references'][number])=>`〔${r.number}〕${r.fileName}${r.version?` · 版本 ${r.version}`:''}${r.page?` · 第 ${r.page} 页`:''}：${r.excerpt}`;
export function reportStrings(report:Report) {
  return [report.content.title,report.content.abstract,...report.limitations,...report.content.sections.flatMap(s=>[s.heading,...s.paragraphs.map(p=>p.text+cited(p.sources)),...(s.table?[...s.table.columns,...s.table.rows.flat()]:[])]),report.content.conclusion,...report.references.map(sourceText)];
}
export async function toDocx(value:Report,presentation:'business'|'evaluation'='business') {
  const report=reportSchema.parse(value),c=report.content;
  const para=(text:string,heading?:typeof HeadingLevel[keyof typeof HeadingLevel])=>new Paragraph({children:text.split(/\r?\n/).map((line,i)=>new TextRun({text:line,...(i?{break:1}:{})})),heading,spacing:{after:100,line:300},keepNext:!!heading});
  const border={style:BorderStyle.SINGLE,size:4,color:'D9D9D9'};
  const children:(Paragraph|Table)[]=[para(c.title,HeadingLevel.TITLE),para(presentation==='evaluation'?'离线评测汇总 · 执行方式以记录为准':report.engine==='mock'?'Mock 演示报告 · 不代表真实 AI 或业务结论':'AI 辅助报告 · 重要结论请人工核验'),para('摘要',HeadingLevel.HEADING_1),para(c.abstract),...report.limitations.map(t=>para('说明：'+t))];
  for(const s of c.sections){children.push(para(s.heading,HeadingLevel.HEADING_1),...s.paragraphs.map(p=>para(p.text+cited(p.sources))));
    if(s.table){const t=s.table,width=Math.floor(9906/t.columns.length);children.push(new Table({width:{size:9906,type:WidthType.DXA},columnWidths:t.columns.map(()=>width),borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},rows:[t.columns,...t.rows].map((cells,index)=>new TableRow({tableHeader:index===0,cantSplit:true,children:cells.map(text=>new TableCell({width:{size:width,type:WidthType.DXA},margins:{top:100,bottom:100,left:100,right:100},shading:index===0?{fill:'F1F3F4'}:undefined,children:[new Paragraph({children:[new TextRun({text,bold:index===0})],spacing:{after:80}})]}))}))}));children.push(para(cited(t.sources)||'表格未引用外部数据。'));}
  }
  children.push(para('结论',HeadingLevel.HEADING_1),para(c.conclusion),para('引用来源',HeadingLevel.HEADING_1),...(report.references.length?report.references.map(r=>para(sourceText(r))):[para('未使用可靠外部来源；资料不足，不能据此作事实性业务判断。')]));
  const doc=new Document({creator:PRODUCT_NAME,title:c.title,description:'基于结构化内容的可编辑报告',styles:{default:{document:{run:{font:'Noto Sans SC',size:22,color:'000000'},paragraph:{spacing:{line:300}}},title:{run:{font:'Noto Sans SC',size:40,bold:true,color:'000000'}},heading1:{run:{font:'Noto Sans SC',size:30,bold:true,color:'000000'}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1000,bottom:1000,left:1000,right:1000}}},footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({children:[PRODUCT_NAME+' · 第 ',PageNumber.CURRENT,' 页']})]})]})},children}]});
  return Packer.toBuffer(doc);
}
export function wrapText(text:string,font:PDFFont,size:number,width:number) {
  const lines:string[]=[];let line='';
  for(const char of text.replace(/\r/g,'').replace(/\t/g,'    ')){
    if(char==='\n'){lines.push(line);line='';continue;}
    if(font.widthOfTextAtSize(line+char,size)>width&&line){lines.push(line);line='';}
    if(font.widthOfTextAtSize(char,size)>width)throw new ReportError('表格列宽不足，请减少列数或缩短内容。');
    line+=char;
  }
  if(line||!lines.length)lines.push(line);return lines;
}
export async function toPdf(value:Report,signal?:AbortSignal,presentation:'business'|'evaluation'='business') {
  const report=reportSchema.parse(value),pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);
  // Full embedding is intentional: CJK fontkit subsets passed extraction but lost
  // visible glyphs in PDF renderers. Do not re-enable subsetting without raster QA.
  const font=await pdf.embedFont(reportFont(),{subset:false}),supported=new Set(font.getCharacterSet());
  for(const text of reportStrings(report))for(const char of text){if(!/[\r\n\t]/.test(char)&&!supported.has(char.codePointAt(0)!))throw new ReportError('报告包含中文字体不支持的字符，请移除 Emoji 或特殊字符后重试。');}
  const W=595.28,H=841.89,M=50,C=W-2*M,bottom=55;let page=pdf.addPage([W,H]),y=H-M;
  function next(){signal?.throwIfAborted();if(pdf.getPageCount()>=60)throw new ReportError('报告超过 60 页上限，请缩小范围。');page=pdf.addPage([W,H]);y=H-M;}
  const ensure=(height:number)=>{if(y-height<bottom)next();};
  function paragraph(text:string,size=11,heading=false){signal?.throwIfAborted();const lines=wrapText(text,font,size,C),lineHeight=size*1.7;ensure(heading?lineHeight*Math.min(lines.length+2,4):lineHeight);for(const line of lines){ensure(lineHeight);page.drawText(line,{x:M,y:y-size,size,font,color:rgb(0,0,0)});y-=lineHeight;}y-=heading?8:10;}
  paragraph(report.content.title,22,true);paragraph(presentation==='evaluation'?'离线评测汇总 · 执行方式以记录为准':report.engine==='mock'?'Mock 演示报告 · 不代表真实 AI 或业务结论':'AI 辅助报告 · 请核验来源',10);paragraph('摘要',15,true);paragraph(report.content.abstract);
  report.limitations.forEach(t=>paragraph('说明：'+t,10));
  for(const s of report.content.sections){paragraph(s.heading,15,true);s.paragraphs.forEach(p=>paragraph(p.text+cited(p.sources)));
    if(s.table){const table=s.table,n=table.columns.length,cw=C/n,pad=6,size=10,lh=15;
      const layout=(row:string[])=>{const cells=row.map(t=>wrapText(t,font,size,cw-pad*2));return {cells,height:Math.max(...cells.map(c=>c.length))*lh+pad*2};};
      const header=layout(table.columns);
      const draw=(row:ReturnType<typeof layout>,isHeader=false)=>{for(let i=0;i<n;i++){page.drawRectangle({x:M+i*cw,y:y-row.height,width:cw,height:row.height,borderWidth:.5,borderColor:rgb(.85,.85,.85),color:isHeader?rgb(.95,.96,.96):rgb(1,1,1)});row.cells[i].forEach((line,j)=>page.drawText(line,{x:M+i*cw+pad,y:y-pad-size-j*lh,size,font,color:rgb(0,0,0)}));}y-=row.height;};
      const rows=table.rows.map(layout);ensure(header.height+rows[0].height);draw(header,true);
      for(const row of rows){signal?.throwIfAborted();if(row.height+header.height>H-M-bottom)throw new ReportError('单个表格行过长，请缩短单元格内容。');if(y-row.height<bottom){next();draw(header,true);}draw(row);}y-=12;paragraph(cited(table.sources)||'表格未引用外部数据。',9);
    }
  }
  paragraph('结论',15,true);paragraph(report.content.conclusion);paragraph('引用来源',15,true);
  if(!report.references.length)paragraph('未使用可靠外部来源；资料不足，不能据此作事实性业务判断。');
  report.references.forEach(r=>paragraph(sourceText(r),10));
  pdf.getPages().forEach((p,i)=>p.drawText(`${PRODUCT_NAME}    ${i+1} / ${pdf.getPageCount()}`,{x:M,y:28,font,size:9,color:rgb(.4,.4,.4)}));
  pdf.setTitle(report.content.title);pdf.setAuthor(PRODUCT_NAME);return Buffer.from(await pdf.save());
}
