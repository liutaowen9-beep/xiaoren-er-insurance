import { test as base, expect, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Document, Packer, Paragraph } from 'docx';
import { PDFDocument } from 'pdf-lib';
import { eventSchema as reportEvent, type Report } from '../../src/lib/reports/types';
import { eventSchema as needsEvent, inputSchema as needsInput } from '../../src/lib/needs/types';
import type { KnowledgeDocument, Source } from '../../src/lib/rag/types';

export const MOCK_ANSWER = 'E2E 模拟回复：已收到问题，请核验原始资料。';
export const MOCK_TITLE = 'E2E 自动化模拟报告';
export const MOCK_EVIDENCE = 'E2E 合成条款：仅用于浏览器测试，不构成保险建议。';
export const report: Report = {
  content: { title: MOCK_TITLE, abstract: '这是合成测试报告，不是真实模型分析。', sections: [{ heading: 'E2E 测试结果', paragraphs: [{ text: '仅验证交互和模拟响应展示，不作业务结论。', sources: [] }] }], conclusion: 'E2E 模拟结论：仍需人工核验。' },
  references: [], engine: 'mock', createdAt: '2026-11-05T00:00:00.000Z', limitations: ['E2E 模拟数据，不调用外部模型。'],
};
function document(name: string, state: 'active' | 'inactive' = 'active'): KnowledgeDocument {
  return { id: randomUUID(), name, extension: '.txt', size: 80, hash: 'a'.repeat(64), status: 'ready', chunkCount: 1, createdAt: 1793836800000, error: null, model: 'e2e-mock', dimension: 384, version: 1, state, revision: 1, isCurrent: true };
}
const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
export type AppMock = {
  documents: KnowledgeDocument[];
  posts: { path: string; body: Record<string, unknown> }[];
  uploads: Buffer[];
  chatFailures: number;
  reportMalformed: boolean;
  downloadExpired: boolean;
  needsConnectionFailure: boolean;
  holdChat: boolean;
  releaseChat: () => void;
};

export const test = base.extend<{ app: AppMock }>({
  app: [async ({ context, page }, useApp) => {
    const app: AppMock = { documents: [document('E2E 医疗条款.txt'), document('E2E 家庭责任.txt'), document('E2E 已停用.txt', 'inactive')], posts: [], uploads: [], chatFailures: 0, reportMalformed: false, downloadExpired: false, needsConnectionFailure: false, holdChat: false, releaseChat: () => {} };
    const unexpected: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const source: Source = { number: 1, documentId: app.documents[0].id, chunkId: randomUUID(), fileName: app.documents[0].name, text: MOCK_EVIDENCE, page: 1, score: 0.98, version: 1, state: 'active', isCurrent: true };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      if (url.origin !== 'http://127.0.0.1:3108') {
        unexpected.push(`External request: ${url.origin}`);
        return route.abort('blockedbyclient');
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname, method = request.method();
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      const events = (body: unknown[]) => route.fulfill({ contentType: 'text/event-stream; charset=utf-8', headers: { 'x-moyu-provider': 'e2e-mock' }, body: sse(body) });
      const post = (req: Request) => {
        const body = req.postDataJSON() as Record<string, unknown>;
        app.posts.push({ path, body });
        return body;
      };
      if (path === '/api/chat' && method === 'GET') return json({ configured: true, model: 'e2e-mock' });
      if (path === '/api/knowledge/documents' && method === 'GET') return json({ documents: app.documents, config: { deploymentMode: 'sandbox', maxUploadBytes: 1024 * 1024 } });
      if (path === '/api/knowledge/documents' && method === 'POST') {
        const body = request.postDataBuffer();
        if (!body) throw new Error('Upload request must contain a multipart body');
        app.uploads.push(body);
        const uploaded = document('E2E-upload.txt');
        app.documents.push(uploaded);
        return json({ document: uploaded, duplicate: false }, 202);
      }
      if (path === '/api/knowledge/sources' && method === 'GET') {
        expect(url.searchParams.get('documentId')).toBe(source.documentId);
        expect(url.searchParams.get('chunkId')).toBe(source.chunkId);
        return json({ source });
      }
      if (path === '/api/comparison' && method === 'GET') return json({ documents: app.documents.filter(d => d.state === 'active'), paidEnabled: false });
      if ((path === '/api/chat' || path === '/api/agent') && method === 'POST') {
        const body = post(request);
        if (app.chatFailures-- > 0) return json({ error: 'E2E 模拟服务暂时不可用，请重试。' }, 503);
        if (app.holdChat) await new Promise<void>(resolve => { app.releaseChat = resolve; });
        if (path === '/api/agent') {
          const id = randomUUID();
          return events([
            { type: 'tool_start', record: { id, name: 'calculator', status: 'running', startedAt: Date.now(), inputSummary: 'E2E 模拟输入：50*299*0.85' } },
            { type: 'tool_finish', id, elapsedMs: 10, summary: 'E2E 模拟计算完成', outputSummary: '12707.50' },
            { type: 'delta', text: 'E2E Agent 模拟结果：12707.50 元。' }, { type: 'done', finishReason: 'stop' },
          ]);
        }
        return events([...(body.mode === 'knowledge' ? [{ type: 'sources', sources: [source] }] : []), { type: 'delta', text: MOCK_ANSWER }, { type: 'done', finishReason: 'stop' }]);
      }
      if (path === '/api/reports' && method === 'GET') return json({ paidEnabled: false, knowledge: { mode: 'sandbox', eligible: 2 } });
      if (path === '/api/reports' && method === 'POST') {
        const body = post(request);
        expect(body.engine).toBe('mock');
        const runId = randomUUID(), stepId = randomUUID(), at = Date.now();
        if (app.reportMalformed) return events([{ type: 'complete', runId, report: { invalid: true } }]);
        return events([
          reportEvent.parse({ type: 'step', runId, stepId, stage: 'generate', status: 'running', at }),
          reportEvent.parse({ type: 'step', runId, stepId, stage: 'generate', status: 'success', at: at + 10, elapsedMs: 10 }),
          reportEvent.parse({ type: 'complete', runId, id: randomUUID(), token: 'e'.repeat(64), formats: ['docx', 'pdf'], report }),
        ]);
      }
      if (path === '/api/needs' && method === 'GET') return app.needsConnectionFailure ? json({ error: 'E2E 模拟知识库连接失败' }, 503) : json({ eligible: 2, paidEnabled: false });
      if (path === '/api/needs' && method === 'POST') {
        const body = needsInput.parse(post(request));
        expect(body.engine).toBe('mock');
        return events([
          needsEvent.parse({ type: 'step', stepId: randomUUID(), stage: 'structure', status: 'SUCCESS', at: Date.now(), note: 'E2E 模拟结构化输入' }),
          needsEvent.parse({ type: 'complete', status: 'INSUFFICIENT', aiAnalysis: null, completedAt: Date.now(), needs: [{ category: 'health', quote: '住院医疗费用' }], priorities: [{ needIndex: 0, rank: 1, basis: 'E2E 模拟：依据客户原话，待确认' }], questions: ['E2E：请确认已有保障责任？'], missing: ['E2E：保障额度待确认'], monthlyBudget: '1000.00', candidates: [], report, id: randomUUID(), token: 'e'.repeat(64), formats: ['docx', 'pdf'] }),
        ]);
      }
      if (path === '/api/reports/download' && method === 'POST') {
        const body = post(request);
        expect(body.token).toBe('e'.repeat(64));
        if (app.downloadExpired) return json({ error: 'E2E 模拟下载凭证已过期，请重新生成。' }, 410);
        if (body.format === 'docx') {
          const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(MOCK_TITLE), new Paragraph('E2E synthetic download fixture')] }] }));
          return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: buffer });
        }
        const pdf = await PDFDocument.create();
        pdf.addPage().drawText('E2E synthetic download fixture');
        return route.fulfill({ contentType: 'application/pdf', body: Buffer.from(await pdf.save()) });
      }
      unexpected.push(`${method} ${path}`);
      return json({ error: 'E2E missing mock' }, 501);
    });
    try { await useApp(app); }
    finally {
      app.releaseChat();
      expect(unexpected, 'All business requests must be explicitly mocked').toEqual([]);
      expect(errors, 'No uncaught page errors').toEqual([]);
    }
  }, { auto: true }],
});
export { expect };
