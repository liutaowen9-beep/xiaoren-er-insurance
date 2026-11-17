import type { KnowledgeDocument } from './types';

// Use only names already authorized by the store. Names select documents, never answer facts.
export function planQuery(question: string, documents: Pick<KnowledgeDocument, 'id' | 'name' | 'status'>[]) {
  const ready = documents.filter(d => d.status === 'ready');
  if (!ready.length) return { allowed: undefined, queries: [] as string[] };
  const clean = (s: string) => s.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').toLocaleLowerCase().trim();
  const q = clean(question);
  const explicit = [...q.matchAll(/《([^》]+)》/g)].map(m => m[1]);
  const aliasesFor=(d:Pick<KnowledgeDocument,'name'>)=>{
    const full=clean(d.name),stem=full.replace(/\.[^.]+$/,''),extension=full.slice(stem.length);
    const base=[stem,...[...stem.matchAll(/\(([^)]+)\)/g)].map(m=>m[1])]
      .filter(a=>a.length>=2&&/[\p{L}]/u.test(a)&&!/^(?:草稿|副本|修订版|最终版|产品)$/.test(a));
    return [...new Set([full,...base,...base.map(a=>a+extension)])];
  };
  const matches = ready.flatMap(d => {
    const aliases = aliasesFor(d);
    const mentioned = aliases.filter(a => q.includes(a) || explicit.some(e => e === clean(d.name)));
    return mentioned.length ? [{ id: d.id, aliases: mentioned }] : [];
  });
  if (explicit.length && explicit.some(e => !ready.some(d => aliasesFor(d).includes(e)))) {
    return { allowed: new Set<string>(), queries: [] as string[] };
  }
  if (!matches.length) return { allowed: undefined, queries: [question.trim()] };
  let body = q;
  for (const alias of [...new Set(matches.flatMap(m => m.aliases))].sort((a, b) => b.length - a.length)) body = body.split(alias).join(' ');
  body = body.replace(/[《》“”"()]/g, ' ').replace(/\s+/g, ' ').trim();
  // Only document-selection/overview wording qualifies. A factual or unrelated
  // question must still pass semantic retrieval and business-evidence checks.
  const overviewBody=body.replace(/请帮我|帮我|请问|请|生成|撰写|写|整理|分析|总结|报告|摘要|概述|概览|介绍|主要内容|基本情况|内容|要点|说明|产品|文档|资料|一下|一份|这份|这个|关于|的/g,'').replace(/[\s，,。？?：:、]+/g,'');
  if (!overviewBody && matches.length<=3) return { allowed: new Set(matches.map(m => m.id)), queries: [] as string[], overview: true };
  return { allowed: new Set(matches.map(m => m.id)), queries: [...new Set([question.trim(), body])].slice(0, 2) };
}
