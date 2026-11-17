import 'server-only';
import { z } from 'zod';
import type { AITool } from '../ai';
import type { KnowledgeStore } from '../rag/store';
import type { Source } from '../rag/types';
import { retrieve } from '../rag/service';
import { querySlot } from '../rag/http';
import { RagError } from '../rag/config';
import { calculate } from './calculator';
import { analyzeDocuments, type GenerateSummary } from './document-analysis';
import { AGENT_LIMITS, AgentError, safeSummary, stopCheck } from './limits';
import type { ToolName } from './types';
import { businessFacts } from '../rag/business-evidence';

const schemas = {
  knowledge_search: z.object({ query: z.string().trim().min(1).max(2000), topK: z.number().int().min(1).max(5).optional() }).strict(),
  calculator: z.object({ expression: z.string().trim().min(1).max(240) }).strict(),
  document_analyze: z.object({ documentIds: z.array(z.string().uuid()).min(1).max(3).refine(ids => new Set(ids).size === ids.length), task: z.enum(['summary', 'extract', 'compare']), question: z.string().trim().max(1000).optional() }).strict(),
};
const descriptions = {
  knowledge_search: '检索当前授权知识库，返回真实原文片段和文档ID。适用于文档事实问题；没有结果时明确告知。topK最多5。',
  calculator: '进行安全十进制算术；支持+-*/、括号和百分比，不支持任何代码。计算数值时应优先使用此工具。',
  document_analyze: '分析现有授权文档：summary摘要、extract要点提取、compare文档对比。只接受文档ID，可从目录或检索获得。全文超过36000字符会明确拒绝，较长文本逐段摘要再汇总。',
};
export const AGENT_TOOLS: AITool[] = (Object.keys(schemas) as ToolName[]).map(name => ({ type: 'function', function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name], { target: 'draft-7', io: 'input' }) as Record<string, unknown> } }));
export type ToolContext = { store: KnowledgeStore | null; allowed: ReadonlySet<string>; generate: GenerateSummary };
export type ToolOutcome = { result: unknown; sources: Source[]; summary: string; outputSummary: string };
export function prepareTool(name: string, argumentsJSON: string, context: ToolContext) {
  if (argumentsJSON.length > AGENT_LIMITS.argumentChars) throw new AgentError('工具参数超过安全长度，已拒绝执行。');
  if (!Object.hasOwn(schemas, name)) throw new AgentError('该工具不在白名单中，已拒绝执行。');
  let value: unknown;
  try { value = JSON.parse(argumentsJSON); } catch { throw new AgentError('工具参数不是有效 JSON，已拒绝执行。'); }
  const validated = schemas[name as ToolName].safeParse(value);
  if (!validated.success) throw new AgentError('工具参数不符合安全约束，已拒绝执行。请检查文档ID、任务类型、表达式或检索数量。');
  const toolName = name as ToolName;
  const inputSummary = toolName === 'document_analyze'
    ? (() => { const args = schemas.document_analyze.parse(validated.data); return `分析类型：${args.task}；文档数量：${args.documentIds.length}`; })()
    : safeSummary(JSON.stringify(validated.data));
  return { name: toolName, inputSummary, async execute(signal: AbortSignal): Promise<ToolOutcome> {
    stopCheck(signal);
    try {
      if (toolName === 'calculator') {
        const args = schemas.calculator.parse(validated.data);
        const result = calculate(args.expression);
        stopCheck(signal);
        return { result, sources: [], summary: `结果：${result.result}；金额展示 ${result.roundedAmount}`, outputSummary: safeSummary(JSON.stringify(result), 2000) };
      }
      if (toolName === 'knowledge_search') {
        const args = schemas.knowledge_search.parse(validated.data);
        const release = querySlot();
        try {
          const sources = context.store ? (await retrieve(args.query, args.topK ?? 5, context.store, signal)).filter(source => context.allowed.has(source.documentId)) : [];
          const result = { found: sources.length > 0, sources, businessFacts: businessFacts(sources).slice(0, 12), note: sources.length ? '相关片段不是答案正确性的证明，请以原文为准。' : '当前知识库中没有找到足够的信息。' };
          return { result, sources, summary: sources.length ? `找到 ${sources.length} 个真实片段` : '没有找到足够的信息', outputSummary: `命中 ${sources.length} 个授权片段；原文仅在来源卡片按需查看，不写入执行摘要。` };
        } finally { release(); }
      }
      const args = schemas.document_analyze.parse(validated.data);
      if (!context.store) throw new AgentError('知识库为空，请先上传并完成文档索引。');
      const result = await analyzeDocuments(args, context.store, context.allowed, context.generate, signal);
      stopCheck(signal);
      return { result, sources: result.sources, summary: `已分析 ${result.coverage.documentCount} 份文档、${result.coverage.chunkCount} 个切片，共 ${result.coverage.segments} 段`, outputSummary: `类型：${args.task}；处理 ${result.coverage.inputCharacters} 字符，${result.coverage.segments} 段；${result.coverage.sourcePreviewCount} 个真实来源预览。分析正文不写入执行记录，请核对回答及来源。` };
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof RagError) throw new AgentError(e.message, e.status);
      throw e;
    }
  } };
}
