import 'server-only';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromBuffer } from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MAX_UPLOAD_BYTES, RagError } from './config';
import type { TextSection } from './types';

const allowed: Record<string, string[]> = {
  '.pdf': ['application/pdf'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  '.txt': ['text/plain'], '.md': ['text/markdown', 'text/plain', 'text/x-markdown'],
};
export function validateFile(name: string, mime: string, buffer: Buffer) {
  // Names are display metadata only; user input never becomes a filesystem path.
  const safeName = name.replace(/\\/g, '/').split('/').at(-1)?.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').trim().slice(0, 180) || '未命名';
  const extension = path.extname(safeName).toLowerCase();
  if (!allowed[extension]) throw new RagError('仅支持 PDF、DOCX、TXT、MD 文件。');
  if (buffer.length < 1 || buffer.length > MAX_UPLOAD_BYTES) throw new RagError(`文件不能为空，且不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB。`, 413);
  if (mime && mime !== 'application/octet-stream' && !allowed[extension].includes(mime.toLowerCase())) throw new RagError('文件 MIME 类型与扩展名不匹配。');
  if (extension === '.pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new RagError('文件不是有效的 PDF。');
  if (extension === '.docx' && (buffer.length < 4 || buffer.readUInt16LE(0) !== 0x4b50)) throw new RagError('文件不是有效的 DOCX。');
  if (extension === '.txt' || extension === '.md') decodeText(buffer);
  return { name: safeName, extension };
}

export function cleanText(text: string) { return text.normalize('NFC').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
export function decodeText(buffer: Buffer) {
  let text: string;
  try {
    const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : 'utf-8';
    try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
    catch { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
  } catch { throw new RagError('无法可靠解码文本，请另存为 UTF-8 后重试。'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new RagError('文件包含二进制控制字符，不是可解析的文本。');
  return cleanText(text.replace(/^\ufeff/, ''));
}

async function docxXML(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new RagError('DOCX 压缩包损坏。')); return; }
      let total = 0, count = 0;
      let documentXML: string | undefined;
      const fail = () => { zip.close(); reject(new RagError('DOCX 损坏、加密或解压大小超出限制。')); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        total += entry.uncompressedSize;
        if (++count > 3000 || total > 40 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) { fail(); return; }
        if (entry.fileName !== 'word/document.xml') { zip.readEntry(); return; }
        if (entry.uncompressedSize > 8 * 1024 * 1024) { fail(); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) { fail(); return; }
          const pieces: Buffer[] = []; let size = 0;
          stream.on('data', piece => { size += piece.length; if (size > 8 * 1024 * 1024) { stream.destroy(); fail(); } else pieces.push(piece); });
          stream.on('error', fail);
          stream.on('end', () => { documentXML = Buffer.concat(pieces).toString('utf8'); zip.readEntry(); });
        });
      });
      zip.on('end', () => { zip.close(); if (documentXML) resolve(documentXML); else reject(new RagError('DOCX 缺少正文，或文件格式不正确。')); });
      zip.readEntry();
    });
  });
}

export async function parseDocument(buffer: Buffer, extension: string): Promise<TextSection[]> {
  let sections: TextSection[] = [];
  if (extension === '.txt' || extension === '.md') sections = [{ text: decodeText(buffer) }];
  else if (extension === '.docx') {
    const xml = await docxXML(buffer);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new RagError('DOCX XML 无效或含不支持的实体声明。');
    const nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: false, processEntities: true }).parse(xml);
    const paragraphs: string[] = [];
    function textOf(value: unknown): string {
      if (!Array.isArray(value)) return '';
      return value.map(node => {
        if (!node || typeof node !== 'object') return '';
        return Object.entries(node).map(([key, val]) => key === '#text' ? String(val) : key === 'w:tab' ? ' ' : key === 'w:br' ? '\n' : key === ':@' ? '' : textOf(val)).join('');
      }).join('');
    }
    function visit(value: unknown) {
      if (!Array.isArray(value)) return;
      for (const node of value) for (const [key, val] of Object.entries(node)) {
        if (key === 'w:p') { const text = cleanText(textOf(val)); if (text) paragraphs.push(text); }
        else visit(val);
      }
    }
    visit(nodes); sections = [{ text: paragraphs.join('\n\n') }];
  } else if (extension === '.pdf') {
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // Resolve the installed directory at runtime; Turbopack rewrites require.resolve
      // to a virtual module identifier which cannot be used as a Windows file URL.
      const root = realpathSync(path.join(process.cwd(), 'node_modules', 'pdfjs-dist'));
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(root, 'legacy', 'build', 'pdf.worker.mjs')).href;
      const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, standardFontDataUrl: path.join(root, 'standard_fonts').replace(/\\/g, '/') + '/', cMapUrl: path.join(root, 'cmaps').replace(/\\/g, '/') + '/', cMapPacked: true });
      const pdf = await task.promise;
      try {
        if (pdf.numPages > 300) throw new RagError('PDF 最多支持 300 页，请拆分后上传。');
        for (let page = 1; page <= pdf.numPages; page++) {
          const content = await (await pdf.getPage(page)).getTextContent();
          const text = cleanText(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
          if (text) sections.push({ text, page });
        }
      } finally { await task.destroy(); }
    } catch (e) { if (e instanceof RagError) throw e; throw new RagError('PDF 解析失败，文件可能损坏或已加密，请转为可复制文字的 PDF。'); }
    if (!sections.length) throw new RagError('未提取到 PDF 文本。扫描版/图片型 PDF 暂不支持 OCR，请先识别为文字版。');
  } else throw new RagError('不支持的文档格式。');
  const total = sections.reduce((sum, section) => sum + section.text.length, 0);
  if (!total) throw new RagError('文档没有可索引的文字。');
  if (total > 150000) throw new RagError('文档提取文本超过 150000 字符，请拆分后上传。');
  return sections;
}
