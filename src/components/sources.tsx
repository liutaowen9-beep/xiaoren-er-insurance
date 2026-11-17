'use client';

import { useRef, useState, useEffect } from 'react';
import type { Source } from '@/lib/rag/types';
import { isSource } from '@/lib/chat';

export function Sources({ sources, agent = false, scope = 'evidence' }: { sources?: Source[]; agent?: boolean; scope?: string }) {
  if (!sources?.length) return null;
  return <div className="source-list"><div className="source-heading">{agent ? '工具实际读取的证据片段 · 文档分析来源可能为分段预览，请核对原文' : '本次检索证据 · 请核对原文，相关不等于答案正确'}</div>{sources.map(source => <SourceCard key={source.chunkId} source={source} scope={scope} />)}</div>;
}
function SourceCard({ source, scope }: { source: Source; scope: string }) {
  const [text, setText] = useState(source.text), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [versionInfo, setVersionInfo] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function load() {
    if (abort.current) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ documentId: source.documentId, chunkId: source.chunkId });
      const response = await fetch(`/api/knowledge/sources?${params}`, { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '来源读取失败。');
      if (!isSource(data.source) || data.source.documentId !== source.documentId || data.source.chunkId !== source.chunkId) throw new Error('来源数据不匹配。');
      setText(data.source.text);
      if (data.source.version) setVersionInfo(`版本 ${data.source.version} · ${data.source.isCurrent ? '当前版本' : '历史版本'} · ${data.source.state === 'inactive' ? '已停用' : data.source.state === 'archived' ? '已归档' : '有效'}；历史证据不代表当前有效资料。`);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '来源读取失败。'); }
    finally { if (!controller.signal.aborted) setBusy(false); abort.current = null; }
  }
  return <details className="source-card" id={`source-${scope}-${source.chunkId}`}><summary><span className="source-number">{source.number}</span><strong>{source.fileName}</strong>{source.page && <span>第 {source.page} 页</span>}<span className="source-score">{source.kind === 'document' ? '原文预览' : `相似度 ${source.score.toFixed(3)}`}</span></summary>{text ? <p>{text}</p> : <div className="source-reload"><p>原文不保存在浏览器历史中，点击从本机知识库读取。</p><button onClick={load} disabled={busy}>{busy ? '读取中…' : '查看实际来源原文'}</button>{error && <p role="alert">{error}</p>}</div>}{versionInfo && <div className="source-meta">{versionInfo}</div>}{source.title && <div className="source-meta">标题：{source.title}</div>}<div className="source-meta">文档 {source.documentId}<br />切片 {source.chunkId}</div></details>;
}
