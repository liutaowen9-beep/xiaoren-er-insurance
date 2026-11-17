'use client';

import { useRef, useState } from 'react';
import type { DocumentState, KnowledgeDocument } from '@/lib/rag/types';

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '文档操作失败。');
  return body;
}
const states = { active: '有效', inactive: '已停用', archived: '已归档' };
export function KnowledgeManagement({ doc, disabled, onRefresh }: { doc: KnowledgeDocument; disabled: boolean; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [versions, setVersions] = useState<KnowledgeDocument[]>([]), [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const url = `/api/knowledge/documents/${doc.id}`;
  async function operation(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(message); await onRefresh(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); }
    finally { setBusy(false); }
  }
  function change(state: DocumentState) {
    const message = state === 'active' ? '恢复后此文档将参与新任务检索，是否继续？' : state === 'archived' ? '归档后退出新任务检索，保留所有文件和历史版本，是否继续？' : doc.state === 'archived' ? '取消归档后保持停用，需再点击恢复才能参与检索，是否继续？' : '停用后立即退出新任务检索，保留全部数据，是否继续？';
    if (!window.confirm(message)) return;
    void operation(() => api(url + '/manage', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, revision: doc.revision }) }), `文档${states[state]}。已发送给模型的旧证据无法撤回。`);
  }
  function replace(file?: File) {
    if (!file) return;
    if (!window.confirm(`使用“${file.name}”创建新版本？新索引验证成功后才切换，旧版本及引用保留。`)) { if (input.current) input.current.value = ''; return; }
    const form = new FormData(); form.set('file', file); form.set('revision', String(doc.revision));
    void operation(async () => {
      const response = await api(url + '/replace', { method: 'POST', body: form });
      if (input.current) input.current.value = '';
      return response;
    }, '已处理替换请求；相同内容不重复建版本，新候选版本索引完成后自动发布。');
  }
  function history() {
    if (expanded) { setExpanded(false); return; }
    void operation(async () => { const body = await api(url + '/manage'); setVersions(body.versions); setExpanded(true); }, '');
  }
  const blocked = busy || disabled;
  const manageable = doc.isCurrent || (doc.version === 1 && doc.status === 'failed');
  return <section className="management-actions" aria-label="文档生命周期与版本管理">
    <div className="version-meta"><strong>{doc.state ? states[doc.state] : '有效'} · 版本 {doc.version ?? 1}</strong><span>更新于 {new Date(doc.updatedAt ?? doc.createdAt).toLocaleString('zh-CN')}</span></div>
    <div className="management-buttons">
      <input ref={input} type="file" accept=".pdf,.docx,.txt,.md" hidden onChange={e => replace(e.target.files?.[0])} />
      <button disabled={blocked || !manageable} onClick={() => input.current?.click()}>替换</button>
      {doc.state === 'active' && <button disabled={blocked || !manageable} onClick={() => change('inactive')}>停用</button>}
      {doc.state === 'inactive' && <button disabled={blocked || !manageable} onClick={() => change('active')}>恢复</button>}
      {doc.state !== 'archived' ? <button disabled={blocked || !manageable} onClick={() => change('archived')}>归档</button> : <button disabled={blocked || !manageable} onClick={() => change('inactive')}>取消归档</button>}
      <button disabled={busy} onClick={history}>{expanded ? '收起版本' : '版本记录'}</button>
    </div>
    {doc.replacement && <div role="status">候选版本 {doc.replacement.version}：{doc.replacement.status === 'failed' ? '失败，旧版本保持不变' : '处理中，旧版本继续有效'}{doc.replacement.error && <p className="document-error">{doc.replacement.error}</p>}{doc.replacement.status === 'failed' && <button disabled={blocked} onClick={() => { if (window.confirm('重新建立该候选版本索引，并在成功后替换当前版本？')) void operation(() => api(`/api/knowledge/documents/${doc.replacement!.id}`, { method: 'POST' }), '候选版本正在重试。'); }}>重试候选版本</button>}</div>}
    {expanded && <div className="version-list">{versions.map(version => <div key={version.id}><strong>版本 {version.version} {version.isCurrent ? '· 当前版本' : '· 历史／候选版本'}</strong><span>{version.name} · {version.chunkCount} 个切片 · {version.status === 'ready' ? '索引完成' : version.status === 'failed' ? '索引失败' : '处理中'}</span><time>{new Date(version.createdAt).toLocaleString('zh-CN')}</time>{version.error && <p className="document-error">{version.error}</p>}</div>)}</div>}
    {busy && <p role="status">正在处理…</p>}{notice && <p role="status">{notice}</p>}{error && <p className="document-error" role="alert">{error}</p>}
  </section>;
}
