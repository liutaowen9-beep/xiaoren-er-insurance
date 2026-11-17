import 'server-only';
import Decimal from 'decimal.js';
import type { Source } from './types';

export const BUSINESS_RULES = '关键业务字段必须分开：保险期间/保障期限不是缴费期间/缴费年期，年交金额不能证明缴费几年。不得把“保若干年”改成“交若干年”。仅引用当前原文明确写出的字段；未明确提供时写“当前证据未明确提及”，不可由案例、历史回答、常识或预期利益推断。引用必须逐字来自实际原文，保证收益、产品承诺不得从预期演示推导。服务端会另附原文字段摘录，请勿虚构摘录。';
export type Field = 'coveragePeriod' | 'paymentPeriod' | 'annualPremium' | 'minimumPremium' | 'guaranteedYield';
export type BusinessFact = { field: Field; value: string; quote: string; documentId: string; chunkId: string };
type Evidence = Pick<Source, 'documentId' | 'chunkId' | 'text'> & { number?: number };
const numeric = '[0-9０-９一二三四五六七八九十百两〇零]+';
const years = `(${numeric}(?:\\s*[/、，,或至-]\\s*${numeric})*)\\s*年`;
const money = '([0-9０-９]+(?:[.．][0-9０-９]+)?\\s*(?:亿|万|千)?\\s*元?)';
const definitions: [Field, string][] = [
  ['coveragePeriod', `(?:保险期间|保障期间|保险期限|保障期限|保障期|保期)\\s*(?:为|是|[:：]|可选|可选择)?\\s*${years}`],
  ['coveragePeriod', `(?:保|保障)\\s*${years}`],
  ['coveragePeriod', `${years}\\s*(?:[一二三四五六七八九十0-9]+\\s*[个种]\\s*)?(?:保险期间|保障期限|保障期间)`],
  ['paymentPeriod', `(?:缴费期间|缴费期限|缴费年期|交费期间|交费期限|交费年期|缴费期)\\s*(?:为|是|[:：]|可选)?\\s*${years}`],
  ['paymentPeriod', `(?:缴费|交费|缴|交)\\s*${years}`],
  ['paymentPeriod', `${years}\\s*(?:缴|交)(?:费)?`],
  ['annualPremium', `(?:年交|年缴|每年缴纳|每年交纳|年保费)\\s*(?:保费|为|是|[:：])?\\s*${money}`],
  ['minimumPremium', `(?:保费|最低保费|起售保费)\\s*(?:为|是|[:：])?\\s*${money}\\s*(?:起售|起投|起)`],
  ['guaranteedYield', `(?:保证收益率|保证年收益|保证年利率|保证年化收益|保底利率)\\s*(?:为|是|[:：])?\\s*([0-9]+(?:\\.[0-9]+)?%)`],
];
const labels: Record<Field, string> = { coveragePeriod: '保险期间', paymentPeriod: '缴费期间', annualPremium: '年交金额', minimumPremium: '起售保费', guaranteedYield: '保证收益率' };
function chineseNumber(value: string) {
  const s = value.normalize('NFKC').trim();
  if (/^\d+$/.test(s)) return String(Number(s));
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0, 〇: 0 };
  let n = 0, part = 0;
  for (const c of s) { if (c === '十' || c === '百') { n += (part || 1) * (c === '十' ? 10 : 100); part = 0; } else if (c in digits) part = digits[c]; else return s; }
  return String(n + part);
}
function values(field: Field, value: string) {
  if (field === 'coveragePeriod' || field === 'paymentPeriod') return value.match(new RegExp(numeric, 'g'))!.map(chineseNumber);
  if (field === 'guaranteedYield') return [value];
  const normalized = value.normalize('NFKC').replace(/\s|元/g, '');
  try { return [new Decimal(normalized.replace(/[亿万千]/g, '')).mul(normalized.includes('亿') ? 1e8 : normalized.includes('万') ? 1e4 : normalized.includes('千') ? 1e3 : 1).toString()]; } catch { return [normalized]; }
}
function negated(text: string, at: number) { return /(?:未(?:明确)?(?:说明|提供|提及|列明)|不能|不可|不代表|不等于|并非|不是|无依据|假设|如果|假如)[^。；;\n]{0,20}$/.test(text.slice(Math.max(0, at - 28), at)); }
export function businessFacts(evidence: Evidence[]): BusinessFact[] {
  const facts = new Map<string, BusinessFact>();
  for (const source of evidence) for (const [field, pattern] of definitions) {
    for (const match of source.text.matchAll(new RegExp(pattern, 'g'))) {
      if (negated(source.text, match.index!)) continue;
      const lineStart = source.text.lastIndexOf('\n', match.index!) + 1;
      const lineEnd = source.text.indexOf('\n', match.index!);
      const start = Math.max(lineStart, match.index! - 45), end = Math.min(lineEnd < 0 ? source.text.length : lineEnd, Math.max(start + 160, match.index! + match[0].length));
      const quote = source.text.slice(start, end).slice(0, 180);
      const value = match[1].trim();
      if (value.length > 80) continue;
      facts.set(`${source.documentId}:${field}:${value}`, { field, value, quote, documentId: source.documentId, chunkId: source.chunkId });
    }
  }
  return [...facts.values()];
}
export function requestedBusinessFields(question: string): Field[] {
  const fields: Field[] = [];
  if (/保险期间|保障期间|保险期限|保障期限|保多久|保几年|保多少年/.test(question)) fields.push('coveragePeriod');
  if (/缴费期|交费期|缴费年期|交费年期|交几年|缴几年|交多久|缴多久/.test(question)) fields.push('paymentPeriod');
  if (/年交|年缴|年保费|每年.*(?:保费|多少钱)/.test(question)) fields.push('annualPremium');
  if (/起售|起投|最低保费/.test(question)) fields.push('minimumPremium');
  if (/(?:保证|保底|承诺|固定).{0,5}(?:收益|利率|回报)/.test(question)) fields.push('guaranteedYield');
  return fields;
}
export function supportsBusinessQuestion(question: string, evidence: Evidence[]) {
  const requested = requestedBusinessFields(question);
  return !requested.length || businessFacts(evidence).some(f => requested.includes(f.field));
}
export function unsupportedBusinessClaim(text: string, evidence: Evidence[]) {
  text = text.replace(/[*_`]/g, '');
  const trusted = businessFacts(evidence);
  const docs = [...new Set(evidence.map(s => s.documentId))];
  for (const [field, pattern] of definitions) for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
    if (negated(text, match.index!)) continue;
    const claimed = values(field, match[1]);
    // Multi-document prose must not borrow another document's payment/amount facts.
    if (!docs.length || !docs.every(id => claimed.every(v => trusted.some(f => f.documentId === id && f.field === field && values(field, f.value).includes(v))))) return true;
  }
  return false;
}
const escape = (s: string) => s.replace(/[\\`*_\[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');
export function businessEvidenceText(evidence: Evidence[], numbered?: Pick<Source, 'chunkId' | 'number'>[], limit = 12) {
  const facts = businessFacts(evidence);
  if (!facts.length) return '';
  const lines = facts.slice(0, limit).map(f => {
    const number = (numbered ?? evidence).find(s => s.chunkId === f.chunkId)?.number;
    return `- ${labels[f.field]}：原文“${escape(f.quote)}”${number ? `（来源卡片 ${number}）` : ''}`;
  });
  if (!facts.some(f => f.field === 'paymentPeriod')) lines.push('- 缴费期间：当前证据未明确提及，不能由保险期间或年交金额推断。');
  return `\n\n**关键字段原文核对（自动摘录，仍需人工核验）**\n${lines.join('\n')}${facts.length > limit ? '\n- 更多字段未在此展开，请核对全部原文。' : ''}`;
}
export function checkedBusinessText(text: string, evidence: Evidence[]) {
  return unsupportedBusinessClaim(text, evidence) ? '生成内容包含缺少原文支持的关键字段，已拦截；请以实际原文为准。' + businessEvidenceText(evidence, undefined, 6) : text;
}

type TextEvent = { type: 'delta'; text: string } | { type: 'done'; finishReason: string };
export function isExecutionNarration(text: string) {
  return /knowledge_search|document_analyze|calculator|\b(?:tools?|parallel|sequential|concurrent|invoke[ds]?|execut(?:e[ds]?|ion))\b|工具|调用|执行(?:成功|失败|完成|这|该|三|任务)|(?:并行|并发|串行|同时).{0,20}(?:执行|调用|完成|工具|任务)|(?:我|将|会).{0,15}(?:并行|并发|串行|执行)|命中\s*\d+|已(?:检索|查询|计算|分析)/i.test(text);
}
// Sentence/line buffering ensures a split unsupported field never flashes in the UI.
export async function* qualityDeltas(events: AsyncIterable<TextEvent>, evidence: () => Evidence[], agent = false, appendEvidence = false): AsyncGenerator<TextEvent> {
  let pending = '', blocked = false;
  function check(text: string) {
    if (agent && isExecutionNarration(text)) return '';
    if (unsupportedBusinessClaim(text, evidence())) { blocked = true; return ''; }
    return text;
  }
  for await (const event of events) {
    if (event.type === 'delta') {
      pending += event.text;
      if (pending.length > 20000) throw new Error('Quality buffer limit');
      let boundary: number;
      while ((boundary = pending.search(/[。！？；\n]/)) >= 0) {
        const sentence = pending.slice(0, boundary + 1); pending = pending.slice(boundary + 1);
        const safe = check(sentence); if (safe) yield { type: 'delta', text: safe };
      }
    } else {
      const safe = check(pending); if (safe) yield { type: 'delta', text: safe };
      if (blocked) yield { type: 'delta', text: '\n已拦截缺少原文支持的关键字段表述；以下原文核对优先于模型概括。\n' };
      if (appendEvidence) { const quotes = businessEvidenceText(evidence()); if (quotes) yield { type: 'delta', text: quotes }; }
      pending = ''; yield event;
    }
  }
}
