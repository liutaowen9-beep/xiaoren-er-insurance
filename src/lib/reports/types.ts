import { z } from 'zod';

export const reportInputSchema = z.object({
  topic: z.string().trim().min(2).max(160), requirements: z.string().trim().max(2000).default(''),
  type: z.enum(['knowledge', 'business', 'comparison', 'custom']), useKnowledge: z.boolean(),
  formats: z.array(z.enum(['docx', 'pdf'])).min(1).max(2).refine(v => new Set(v).size === v.length),
  engine: z.enum(['mock', 'deepseek']).default('mock'),
}).strict();
export type ReportInput = z.infer<typeof reportInputSchema>;
const text = (max: number) => z.string().trim().min(1).max(max).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), '含不支持的控制字符');
export const paragraphSchema = z.object({ text: text(2400), sources: z.array(z.number().int().min(1).max(5)).max(5) }).strict();
export const tableSchema = z.object({ columns: z.array(text(80)).min(2).max(4), rows: z.array(z.array(text(400)).min(2).max(4)).min(1).max(30), sources: z.array(z.number().int().min(1).max(5)).max(5) }).strict().refine(t => t.rows.every(r => r.length === t.columns.length), '表格列数不一致');
export const contentSchema = z.object({
  title: text(160), abstract: text(1800),
  sections: z.array(z.object({ heading: text(120), paragraphs: z.array(paragraphSchema).min(1).max(8), table: tableSchema.optional() }).strict()).min(1).max(8),
  conclusion: text(1800),
}).strict().refine(v => JSON.stringify(v).length <= 28000, '报告过长，请缩小范围');
export const referenceSchema = z.object({ number: z.number().int().min(1).max(5), documentId: z.uuid(), chunkId: z.uuid(), fileName: text(255), version: z.number().int().positive().optional(), page: z.number().int().positive().optional(), excerpt: text(350), evidenceHash:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const reportSchema = z.object({ content: contentSchema, references: z.array(referenceSchema).max(5), engine: z.enum(['mock', 'deepseek']), createdAt: z.iso.datetime(), limitations: z.array(text(500)).max(8) }).strict();
export type Report = z.infer<typeof reportSchema>;
export type Content = z.infer<typeof contentSchema>;
export const STAGES = ['plan', 'retrieve', 'evidence', 'generate', 'quality', 'export'] as const;
export const STAGE_LABELS: Record<typeof STAGES[number], string> = { plan: '规划报告大纲', retrieve: '检索当前知识库', evidence: '校验证据与版本', generate: '生成结构化内容', quality: '检查报告质量', export: '排版与导出' };
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), runId: z.uuid(), stepId: z.uuid(), stage: z.enum(STAGES), status: z.enum(['running', 'success', 'error', 'cancelled']), at: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal('complete'), runId: z.uuid(), id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/), formats: z.array(z.enum(['docx','pdf'])).min(1).max(2), report: reportSchema }).strict(),
  z.object({ type: z.literal('error'), runId: z.uuid(), message: text(500) }).strict(),
]);
export type ReportEvent = z.infer<typeof eventSchema>;
export function reportError(e: unknown) {
  if (e instanceof z.ZodError) return '参数或模型结构化内容不符合要求，请缩短输入后重试。';
  return e instanceof ReportError ? e.message : '报告生成失败，请稍后重试；如持续失败，请检查本地配置。';
}
export class ReportError extends Error { constructor(message: string, public status = 400) { super(message); } }
