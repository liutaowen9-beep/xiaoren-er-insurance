import 'server-only';
import { randomUUID } from 'node:crypto';
import { cleanText } from './parse';
import { tokenCount } from './embedding';
import { MAX_CHUNKS_PER_DOCUMENT, MODEL_TOKEN_LIMIT, RagError } from './config';
import type { TextChunk, TextSection } from './types';

export async function chunkSections(documentId: string, sections: TextSection[]): Promise<TextChunk[]> {
  const chunks: TextChunk[] = [];
  for (const section of sections) {
    const text = cleanText(section.text);
    let start = 0;
    let title = section.title;
    while (start < text.length) {
      let end = Math.min(start + 700, text.length);
      // Natural boundaries first; token fitting may produce shorter Chinese chunks.
      if (end < text.length) {
        const region = text.slice(start + 400, end);
        const boundary = Math.max(region.lastIndexOf('\n\n'), region.lastIndexOf('。'), region.lastIndexOf('！'), region.lastIndexOf('？'));
        if (boundary >= 0) end = start + 400 + boundary + 1;
      }
      while (await tokenCount(`passage: ${text.slice(start, end)}`) > MODEL_TOKEN_LIMIT) end = start + Math.floor((end - start) * 0.9);
      if (end <= start) throw new RagError('文档存在无法分词的内容。');
      const content = text.slice(start, end).trim();
      const headings = [...content.matchAll(/(?:^|\n)#{1,6}\s+([^\n]+)/g)];
      if (headings.length) title = headings.at(-1)![1].slice(0, 150);
      if (content) chunks.push({ id: randomUUID(), documentId, sequence: chunks.length, text: content, ...(section.page ? { page: section.page } : {}), ...(title ? { title } : {}) });
      if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) throw new RagError(`切片超过 ${MAX_CHUNKS_PER_DOCUMENT} 个，请拆分文档。`);
      if (end >= text.length) break;
      start = Math.max(start + 1, end - Math.min(120, Math.floor((end - start) / 3)));
    }
  }
  return chunks;
}
