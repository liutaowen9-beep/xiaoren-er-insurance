'use client';

import Link from 'next/link';
import {Card} from '@/components/ui/card';
import { ShowcaseShell } from '@/components/showcase-shell';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, FileText, Moon, RefreshCw, Sun, Trash2, Upload } from 'lucide-react';
import { BrandMark, useBranding } from '@/components/brand-provider';
import { KnowledgeManagement } from '@/components/knowledge-management';
import type { DocumentStatus, KnowledgeDocument } from '@/lib/rag/types';

const labels: Record<DocumentStatus, string> = { queued: '等待处理', parsing: '解析文档', chunking: '智能切片', embedding: '本地向量化', indexing: '保存索引', ready: '已完成', failed: '索引失败' };
const running = (status: DocumentStatus) => status !== 'ready' && status !== 'failed';
async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '操作失败，请重试。');
  return body;
}

export default function KnowledgePage() {
  const {brand}=useBranding();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [dragging, setDragging] = useState(false);
  const [dark, setDark] = useState(false);
  const [deploymentMode, setDeploymentMode] = useState('sandbox');
  const readOnly = ['read-only-verification', 'production-read-only'].includes(deploymentMode);
  const [maxSize, setMaxSize] = useState(10 * 1024 * 1024);
  const [loading, setLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    try {
      const body = await api('/api/knowledge/documents');
      setDocuments(body.documents); setDeploymentMode(body.config.deploymentMode ?? 'sandbox'); setMaxSize(body.config.maxUploadBytes);
    } catch (e) { setError(e instanceof Error ? e.message : '无法读取知识库。'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // This starts an asynchronous HTTP synchronization; no render-derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    let value = document.documentElement.dataset.theme !== 'light';
    try { const saved = localStorage.getItem('moyu-theme'); if (saved) value = saved === 'dark'; } catch { /* Browser storage is optional. */ }
    document.documentElement.dataset.theme = value ? 'dark' : 'light';
    // Synchronize the browser-only preference after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(value);
  }, []);

  function toggleTheme() { const value = !dark; setDark(value); document.documentElement.dataset.theme = value ? 'dark' : 'light'; try { localStorage.setItem('moyu-theme', value ? 'dark' : 'light'); } catch {} }
  async function upload(file?: File) {
    if (!file || busy || readOnly) return;
    if (file.size > maxSize) { setError(`文件不能超过 ${maxSize / 1024 / 1024}MB。`); return; }
    setBusy('upload'); setError(''); setNotice('正在上传文档…');
    try {
      const form = new FormData(); form.set('file', file);
      const result = await api('/api/knowledge/documents', { method: 'POST', body: form });
      setNotice(result.duplicate ? '该文件已存在，未重复创建索引。失败的文档可点击重新索引。' : '上传成功，正在后台解析并建立本地向量索引。');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '上传失败。'); setNotice(''); }
    finally { setBusy(''); if (input.current) input.current.value = ''; }
  }
  async function action(doc: KnowledgeDocument, remove: boolean) {
    if (!remove && !window.confirm('确认重新索引？将创建候选版本，成功后切换，保留历史版本。')) return;
    if (remove && !window.confirm(`确定删除“${doc.name}”及其所有历史版本、切片、向量和原文件吗？`)) return;
    setBusy(doc.id); setError(''); setNotice('');
    try { await api(`/api/knowledge/documents/${doc.id}`, { method: remove ? 'DELETE' : 'POST', headers: remove ? { 'If-Match': String(doc.revision) } : undefined }); setNotice(remove ? '文档及对应索引已删除。' : '正在重新索引，请稍候。'); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); }
    finally { setBusy(''); }
  }
  const processing = documents.some(d => running(d.status) || (d.replacement && running(d.replacement.status)));
  const [filter, setFilter] = useState('all');
  const visible = documents.filter(d => filter === 'all' || d.state === filter);
  return <ShowcaseShell active="knowledge"><main className="knowledge-shell"><header className="knowledge-header"><Link href="/" className="knowledge-brand"><BrandMark/><strong>{brand.siteName}</strong><span>{deploymentMode === 'sandbox' ? brand.knowledgeName+' · 隔离开发' : readOnly ? brand.knowledgeName+' · 正式库只读' : brand.knowledgeName}</span></Link><button className="icon-button" aria-label="切换主题" onClick={toggleTheme}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button></header><div className="knowledge-main"><Link href="/chat" className="back-link"><ArrowLeft size={15} />返回聊天</Link><div className="knowledge-title"><div><div className="eyebrow">让你的资料，成为答案的依据</div><h1><BookOpen size={27} />{brand.knowledgeName}</h1><p>文档在本机解析和向量化，问答时仅将相关片段发送给 DeepSeek。</p></div><Link className="knowledge-ask" href="/?mode=knowledge">开始知识库问答 ↗</Link></div><section className="knowledge-metrics" aria-label="知识库实时概况">{[
 ['文档总数',documents.length,'当前知识库记录'],['当前可检索',documents.filter(d=>d.status==='ready'&&(!d.state||d.state==='active')&&d.isCurrent!==false).length,'有效且索引完成'],['切片总数',documents.reduce((sum,d)=>sum+d.chunkCount,0),'列表文档的实际切片'],['索引处理中',documents.filter(d=>running(d.status)).length,'正在处理的文档']
].map(([label,value,note])=><Card className="knowledge-metric" key={label}><span>{label}</span><strong>{loading?'—':value}</strong><small>{note}</small></Card>)}</section><div className="private-notice">{deploymentMode === 'sandbox' ? '隔离测试知识库 · 不连接生产数据' : deploymentMode === 'independent-local' ? '独立本地知识库 · 原正式库保持独立' : readOnly ? 'V7 知识库只读连接 · 聊天和检索需通过正式激活校验 · 上传及修改暂不开放' : '正式知识库已批准启用'} · 仅限本机个人使用 · 无 OCR · 扫描版 PDF 请先转换为文字版 · 来源需人工核验</div>{error && <div role="alert" className="error-message">{error}<button onClick={() => setError('')}>关闭</button></div>}{notice && <div className="knowledge-notice" role="status">{notice}</div>}<section className={`upload-zone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length > 1) setError('每次请上传一个文件。'); else void upload(e.dataTransfer.files[0]); }}><span className="upload-icon"><Upload size={27} /></span><h2>{busy === 'upload' ? '正在上传…' : processing ? '文档正在本地建立索引' : '把文档拖到这里'}</h2><p>支持 PDF、DOCX、TXT、MD，单个文件不超过 {maxSize / 1024 / 1024}MB</p><input ref={input} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={e => void upload(e.target.files?.[0])} /><button className="knowledge-ask" disabled={!!busy || processing || readOnly} onClick={() => input.current?.click()}>选择文件</button><small>首次加载模型可能需要稍候。文件内容以哈希去重，原文件不会进入 public 目录。</small></section><div className="document-heading"><label>文档范围 <select aria-label="文档范围" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部</option><option value="active">有效</option><option value="inactive">已停用</option><option value="archived">已归档</option></select></label><h2>全部文档 <span>{documents.length}</span></h2><button className="copy-button" onClick={() => void refresh()}><RefreshCw size={14} />刷新状态</button></div>{loading ? <p className="knowledge-empty">正在读取知识库…</p> : !documents.length ? <div className="knowledge-empty"><FileText size={30} /><p>还没有文档，上传一份资料开始探索吧。</p></div> : <div className="document-list">{visible.map(doc => <article className="document-card" key={doc.id}><span className="document-icon"><FileText size={23} /></span><div className="document-info"><h3>{doc.name}</h3><div className="document-meta"><span>{(doc.size / 1024).toFixed(1)} KB</span><span>{doc.chunkCount} 个切片</span><time>{new Date(doc.createdAt).toLocaleString('zh-CN')}</time></div>{doc.error && <p className="document-error">{doc.error}</p>}</div><span className={`document-status ${doc.status}`} role="status">{labels[doc.status]}</span><div className="document-actions"><button title="重新索引/失败重试" aria-label={`重新索引 ${doc.name}`} disabled={!!busy || processing || readOnly} onClick={() => void action(doc, false)}><RefreshCw size={16} /><span>重新索引</span></button><button title="删除文档" aria-label={`删除文档 ${doc.name}`} disabled={!!busy || running(doc.status) || readOnly} onClick={() => void action(doc, true)}><Trash2 size={16} /><span>删除</span></button></div><KnowledgeManagement doc={doc} disabled={!!busy || processing || readOnly} onRefresh={refresh} /></article>)}</div>}<footer className="knowledge-footer">本地多语言向量检索 · SQLite 持久化 · Top K 默认 5<br />请勿直接公开部署；身份验证、数据隔离和分布式限流尚未启用。</footer></div></main></ShowcaseShell>;
}
