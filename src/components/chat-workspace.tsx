'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, BookOpen, Bot, Check, ChevronDown, Code2, Copy, Feather, Menu, MessageCircle, Moon, PanelLeftClose, Plus, Search, Sparkles, Square, Sun, Trash2, X, Zap } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import Link from 'next/link';
import { BrandMark, useBranding } from '@/components/brand-provider';
import { Sources } from '@/components/sources';
import { ToolCards } from '@/components/tool-cards';
import { WorkflowPanel } from '@/components/workflow-panel';
import { type ChatMode, type Conversation, type Message } from '@/lib/chat';
import { restoreHistory, serializeHistory } from '@/lib/chat-history';
import { applyWorkflowEvent, finishWorkflow, type WorkflowRun } from '@/lib/agent/workflow';
import { readChatReply } from '@/lib/chat-stream';
import type { Source } from '@/lib/rag/types';
import type { AgentPhase, ToolRecord } from '@/lib/agent/types';

type PendingReply = { conversationId: string; messageId: string; parentId: string; text: string; committed: boolean; mode: ChatMode; sources: Source[]; tools: ToolRecord[]; workflow?: WorkflowRun };
const phaseLabels: Record<AgentPhase, string> = { thinking: '正在思考任务', searching: '正在检索知识库', calculating: '正在计算', analyzing: '正在分析文档', answering: '正在生成回答' };

const STORAGE = 'moyu-conversations-v1';
const suggestions = [
  { icon: Feather, title: '准备一次好沟通', text: '整理表达，传递专业与温度', prompt: '请给我一份温和清晰的客户沟通提纲，不包含未经证实的产品承诺。', color: 'peach' },
  { icon: Code2, title: '把信息整理清楚', text: '从零散资料到清晰的结构', prompt: '请提供一份客户沟通前的资料整理清单，不编造产品信息。', color: 'blue' },
  { icon: BookOpen, title: '读懂一份资料', text: '梳理要点，标记需要核实的内容', prompt: '请介绍阅读保险条款时需要核对哪些信息，避免给出具体产品承诺。', color: 'purple' },
  { icon: Zap, title: '安排有序的一天', text: '把重要的事，放在合适的时间', prompt: '请帮我制定一份保险顾问的日常工作检查清单。', color: 'green' },
];

function CopyButton({ content, label = false }: { content: string; label?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <button className="copy-button" aria-label="复制内容" onClick={async () => { try { await navigator.clipboard.writeText(content); setCopied(true); setFailed(false); setTimeout(() => setCopied(false), 1800); } catch { setFailed(true); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}{(label || copied || failed) && <span>{failed ? '复制失败' : copied ? '已复制' : '复制'}</span>}</button>;
}

export default function ChatWorkspace() {
  const {brand}=useBranding();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<ChatMode>('chat');
  const [dark, setDark] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>('thinking');
  const [agentDetail, setAgentDetail] = useState('');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<{ conversationId: string; message: Message } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<PendingReply | null>(null);
  const historyWritable = useRef(true);
  const entryModeRequest = useRef<{ mode?: ChatMode } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const active = conversations.find(c => c.id === activeId);
  const displayedMessages = [...(active?.messages || []), ...(draft?.conversationId === activeId ? [draft.message] : [])];

  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/chat', { cache: 'no-store', signal: abort.signal }).then(r => r.json()).then(data => {
      if (!abort.signal.aborted && typeof data.configured === 'boolean') setConfigured(data.configured);
    }).catch(() => {});
    return () => abort.abort();
  }, []);

  useEffect(() => {
    try {
      const valid = restoreHistory(localStorage.getItem(STORAGE) || '[]');
      // Hydrate browser-only preferences after the server-rendered shell mounts.
      /* eslint-disable react-hooks/set-state-in-effect */
      setConversations(valid);
      const previous = localStorage.getItem('moyu-active');
      if (!entryModeRequest.current) {
        const entryMode = new URLSearchParams(window.location.search).get('mode');
        entryModeRequest.current = { mode: entryMode === 'chat' || entryMode === 'knowledge' || entryMode === 'agent' ? entryMode : undefined };
      }
      const requestedMode = entryModeRequest.current.mode;
      const selected = requestedMode ? null : valid.find(c => c.id === previous);
      setActiveId(selected?.id || null);
      setMode(requestedMode || selected?.mode || 'chat');
      if (requestedMode) {
        const params = new URLSearchParams(window.location.search);
        params.delete('mode');
        window.history.replaceState(null, '', '/chat' + (params.size ? `?${params}` : '') + window.location.hash);
      }
      setDark((localStorage.getItem('moyu-theme') || (document.documentElement.dataset.theme||'dark')) === 'dark');
    } catch { historyWritable.current = false; setStorageError('本地记录无法安全读取，原存储未覆盖；当前可继续聊天，但暂不保存。'); }
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => controller.current?.abort();
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      if (historyWritable.current) localStorage.setItem(STORAGE, serializeHistory(conversations));
      localStorage.setItem('moyu-theme', dark ? 'dark' : 'light');
      if (activeId) localStorage.setItem('moyu-active', activeId); else localStorage.removeItem('moyu-active');
    } catch { /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setStorageError('历史体积已达上限或浏览器存储不可用；旧记录未覆盖，本次更改暂留在当前页面。');
    }
  }, [conversations, activeId, ready, dark]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [active?.messages, busy, draft]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = Math.min(textarea.current.scrollHeight, 180) + 'px'; } }, [input]);

  function saveReply(job: PendingReply, status?: Message['status']) {
    if (job.committed) return;
    job.committed = true;
    if (!job.text.trim() && !job.tools.length && !job.workflow) return;
    if (job.workflow && (status === 'error' || status === 'interrupted')) job.workflow = finishWorkflow(job.workflow, status === 'error' ? 'error' : 'cancelled', status === 'error' ? '连接或执行异常中断，未确认完成的步骤已结束展示。' : '用户停止任务，未确认服务端最终完成。');
    const tools = job.tools.map(tool => tool.status === 'running' ? { ...tool, status: 'interrupted' as const, elapsedMs: Math.max(0, Date.now() - tool.startedAt), summary: status === 'error' ? '任务异常中断，工具未确认完成。' : '用户停止任务，工具未确认完成。' } : tool);
    const message: Message = { id: job.messageId, role: 'assistant', content: job.text, provider: 'deepseek', mode: job.mode, sources: job.sources, tools, workflow: job.workflow, ...(status ? { status } : {}) };
    setConversations(current => current.map(c => {
      if (c.id !== job.conversationId || !c.messages.some(m => m.id === job.parentId)) return c;
      return { ...c, updatedAt: Date.now(), messages: [...c.messages.filter(m => m.id !== job.messageId), message] };
    }));
  }
  function stop() {
    controller.current?.abort();
    if (pending.current?.mode === 'agent' && !pending.current.workflow) setError('已取消请求 · 尚未收到服务端运行事件，未创建工具步骤。');
    if (pending.current) saveReply(pending.current, 'interrupted');
    controller.current = null; pending.current = null;
    setDraft(null); setBusy(false);
  }
  function select(id: string | null) { stop(); setActiveId(id); if (id) setMode(conversations.find(c => c.id === id)?.mode || 'chat'); setInput(''); setError(''); setSidebar(false); }
  function changeMode(value: ChatMode) { if (value === mode) return; select(null); setMode(value); }
  function remove(id: string) {
    if (!window.confirm('确定删除这段对话吗？删除后无法恢复。')) return;
    if (id === activeId) select(null);
    setConversations(current => current.filter(c => c.id !== id));
  }
  async function requestReply(id: string, messages: Message[]) {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    const job: PendingReply = { conversationId: id, messageId: crypto.randomUUID(), parentId: messages.at(-1)!.id, text: '', committed: false, mode, sources: [], tools: [] };
    pending.current = job;
    // Retrying a partial response replaces that response instead of duplicating it.
    setConversations(current => current.map(c => c.id === id ? { ...c, messages } : c));
    setBusy(true); setError(''); setDraft(null); setAgentPhase('thinking'); setAgentDetail('');
    const publish = () => {
      if (abort.signal.aborted || controller.current !== abort) return;
      setDraft({ conversationId: id, message: { id: job.messageId, role: 'assistant', content: job.text, provider: 'deepseek', mode: job.mode, sources: job.sources, tools: job.tools.map(tool => ({ ...tool })), workflow: job.workflow } });
    };
    try {
      const response = await fetch(mode === 'agent' ? '/api/agent' : '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, messages: messages.filter(m => m.content.trim()).slice(mode === 'agent' ? -24 : -99).map(({ role, content }) => ({ role, content })) }), signal: abort.signal });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        if (response.headers.get('x-moyu-key-required') === '1') setConfigured(false);
        throw new Error(data?.error || '回复失败，请稍后重试。');
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('回复格式异常，请重试。');
      if (response.headers.get('x-moyu-provider') !== 'local-policy') setConfigured(true);
      const notice = await readChatReply(response.body, text => {
        if (abort.signal.aborted || controller.current !== abort) return;
        job.text += text;
        publish();
      }, sources => { if (abort.signal.aborted) return; job.sources = sources; publish(); }, event => {
        if (abort.signal.aborted || controller.current !== abort) return;
        if ('runId' in event) { job.workflow = applyWorkflowEvent(job.workflow, event); publish(); }
        else if (event.type === 'status') { setAgentPhase(event.phase); setAgentDetail(event.detail || ''); }
        else if (event.type === 'tool_start') {
          if (job.tools.length >= 15 || job.tools.some(tool => tool.id === event.record.id)) throw new Error('工具执行记录异常，已停止展示。');
          job.tools.push({ ...event.record }); publish();
        } else if (event.type === 'tool_finish' || event.type === 'tool_error') {
          const tool = job.tools.find(tool => tool.id === event.id);
          if (!tool || tool.status !== 'running') throw new Error('工具执行顺序异常，请重试。');
          Object.assign(tool, { status: event.type === 'tool_finish' ? 'completed' : 'failed', elapsedMs: event.elapsedMs, summary: event.summary, outputSummary: event.outputSummary }); publish();
        }
      });
      if (!abort.signal.aborted) saveReply(job, notice ? 'limited' : undefined);
    } catch (e) {
      if (!abort.signal.aborted && controller.current === abort) {
        saveReply(job, 'error');
        setError(e instanceof TypeError ? '网络连接失败，请检查网络后重试。' : e instanceof Error ? e.message : '回复失败，请重试。');
      }
    } finally {
      if (controller.current === abort) { controller.current = null; pending.current = null; setDraft(null); setBusy(false); }
    }
  }
  function send(text = input) {
    if (!text.trim() || busy || controller.current || !ready) return;
    const content = text.trim().slice(0, 10000);
    const id = activeId || crypto.randomUUID();
    const messages: Message[] = [...(active?.messages || []), { id: crypto.randomUUID(), role: 'user', content }];
    if (messages.length > 198) { setError('这段对话已达到长度上限，请新建对话。'); return; }
    setConversations(current => [{ id, title: active?.title || content.slice(0, 28), updatedAt: Date.now(), messages, mode }, ...current.filter(c => c.id !== id)].slice(0, 100));
    setActiveId(id); setInput(''); void requestReply(id, messages);
  }

  const filtered = conversations.filter(c => c.title.toLowerCase().includes(query.toLowerCase()));
  const lastMessage = active?.messages.at(-1);
  const canRetry = lastMessage?.role === 'user' || (lastMessage?.role === 'assistant' && (lastMessage.status === 'error' || lastMessage.status === 'interrupted'));
  function retry() {
    if (!active || !canRetry || busy) return;
    void requestReply(active.id, lastMessage?.role === 'assistant' ? active.messages.slice(0, -1) : active.messages);
  }

  return <div className="app-shell">
    {sidebar && <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'is-open' : ''}`}>
      <div className="brand-row"><Link className="brand" href="/" aria-label={brand.siteName+'首页'}><BrandMark/><span>{brand.siteName}<small>{brand.subtitle}</small></span></Link><button className="icon-button close-sidebar" title="关闭侧栏" aria-label="关闭侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={18} /></button></div>
      <button className="new-chat" onClick={() => select(null)}><Plus size={18} /><span>开启新对话</span><span className="new-chat-hint">↗</span></button>
      <Link href="/" className="knowledge-entry"><BookOpen size={17}/><span>返回业务工作台</span></Link>
      <Link href="/settings" className="knowledge-entry"><Feather size={17}/><span>外观与品牌设置</span></Link>
      <label className="search"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索历史对话" aria-label="搜索历史对话" />{query && <button aria-label="清空搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
      <div className="history-heading">对话记录 <span>{conversations.length.toString().padStart(2, '0')}</span></div>
      <nav className="history" aria-label="聊天历史">{filtered.length ? filtered.map(c => <div key={c.id} className={`history-item ${activeId === c.id ? 'selected' : ''}`}><button className="history-select" onClick={() => select(c.id)}><MessageCircle size={16} /><span>{c.title}</span></button><button className="delete-chat" title="删除对话" aria-label={`删除对话：${c.title}`} onClick={() => remove(c.id)}><Trash2 size={14} /></button></div>) : <div className="history-empty"><MessageCircle size={25} strokeWidth={1.3} /><p>{query ? '没有找到相关对话' : '还没有对话记录'}</p><span>{query ? '试试其他关键词' : '从一个小小的好奇开始吧'}</span></div>}</nav>
      <div className="sidebar-bottom"><div className="local-note"><span className="status-dot" /><span>对话仅保存在此浏览器</span></div><button className="theme-button" onClick={() => setDark(!dark)}>{dark ? <Sun size={17} /> : <Moon size={17} />}<span>{dark ? '切换浅色模式' : '切换深色模式'}</span><span className="theme-indicator">{dark ? '深色' : '浅色'}</span></button><div className="profile"><div className="avatar">我</div><div><strong>我的个人空间</strong><span>专业服务，从容工作</span></div><span className="free-label">本地版</span></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="打开聊天历史" onClick={() => setSidebar(true)}><Menu size={21} /></button><span className="model-name">{brand.siteName} <ChevronDown size={15} /></span><span className="model-badge">DeepSeek</span><Link href="/" className="chat-workbench-link">工作台</Link></div><div className="topbar-right"><span className="status-dot" /><span>DeepSeek AI{configured === false ? " · 待配置" : ""}</span><button className="icon-button" aria-label={dark ? '切换浅色模式' : '切换深色模式'} onClick={() => setDark(!dark)}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button></div></header>
      {configured === false && <div className="storage-alert" role="status">尚未配置 DeepSeek：请在项目根目录 .env.local 中填写 DEEPSEEK_API_KEY，然后重启开发服务器。</div>}{storageError && <div className="storage-alert" role="status">{storageError}<button aria-label="关闭提醒" onClick={() => setStorageError('')}><X size={14} /></button></div>}
      <div className={`content-scroll ${active ? 'has-chat' : ''}`}>
        {!active ? <section className="welcome"><div className="welcome-emblem"><BrandMark/></div><div className="eyebrow">{brand.subtitle}</div><h1>{brand.welcome}</h1><p className="welcome-description">把资料读清楚，把沟通准备好。<br className="mobile-break" /> 每一份判断，都有依据可循。</p><div className="suggestion-grid">{mode === 'agent' ? <div className="knowledge-welcome">我会按需调用检索、计算和文档分析，并展示真实步骤。模型会收到可用文档目录；分析工具会将所选正文分段发送给 DeepSeek，可能产生多次调用。<button className="agent-example" onClick={() => send('请使用计算器计算 50*299*0.85，并给出两位小数的金额。')}>试试：50 件商品，每件 299 元，打八五折 ↗</button><Link href="/knowledge">查看可分析的知识库文档 ↗</Link></div> : mode === 'knowledge' ? <div className="knowledge-welcome">先上传文档，再提出具体问题。回答会附上真实检索片段，证据不足时明确告知。<Link href="/knowledge">打开{brand.knowledgeName} ↗</Link></div> : suggestions.map(({ icon: Icon, title, text, prompt, color }) => <button key={title} className="suggestion-card" disabled={!ready} onClick={() => send(prompt)}><span className={`suggestion-icon ${color}`}><Icon size={21} strokeWidth={1.7} /></span><strong>{title}</strong><span className="suggestion-text">{text}</span><ArrowUpRight className="suggestion-arrow" size={17} /></button>)}</div><div className="welcome-footnote"><span />以专业为底色，以温度相伴<span /></div></section> : <section className="messages" aria-label="对话内容">{displayedMessages.map(m => <article key={m.id} className={`message ${m.role}`}><div className="message-avatar">{m.role === 'assistant' ? <Sparkles size={19} /> : '我'}</div><div className="message-content"><div className="message-author">{m.role === 'assistant' ? (m.mode === 'agent' ? brand.agentName : m.mode === 'knowledge' ? brand.knowledgeName : brand.chatName) : '你'}{m.role === 'assistant' && <span>{m.provider === 'deepseek' ? 'AI' : '历史回复'}</span>}</div>{m.workflow ? <WorkflowPanel run={m.workflow} sources={m.sources} scope={m.id} /> : <ToolCards tools={m.tools} />}<div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre({ children }) { return <div className="code-block"><div className="code-header"><span>代码</span><CopyButton content={getCodeText(children)} label /></div><pre>{children}</pre></div>; }, a({ children, href }) { return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>; } }}>{m.content}</ReactMarkdown></div><Sources sources={m.sources} agent={m.mode === 'agent'} scope={m.id} />{m.status && <div className="reply-status">{m.status === 'interrupted' ? '已停止 · 保留已生成内容' : m.status === 'error' ? '回复中断 · 内容可能不完整' : '已达到回复长度上限，可继续提问'}</div>}{m.role === 'assistant' && <CopyButton content={m.content} />}</div></article>)}{busy && !draft && <div className="message assistant"><div className="message-avatar"><Sparkles size={19} /></div><div className="thinking" role="status"><span /><span /><span /><small>{mode === 'agent' ? phaseLabels[agentPhase] : '正在思考'}</small></div></div>}<div ref={bottom} /></section>}
      </div>
      <div className="composer-area"><div className="chat-mode-tabs" role="group" aria-label="聊天模式"><button aria-pressed={mode === 'chat'} onClick={() => changeMode('chat')}><Sparkles size={13} />{brand.chatName}</button><button aria-pressed={mode === 'knowledge'} onClick={() => changeMode('knowledge')}><BookOpen size={13} />{brand.knowledgeName}</button><button aria-pressed={mode === 'agent'} onClick={() => changeMode('agent')}><Bot size={13} />{brand.agentName}</button>{mode !== 'chat' && <Link href="/knowledge">管理文档 ↗</Link>}</div>{busy && mode === 'agent' && <div className="agent-phase" role="status"><span className="status-dot" />{phaseLabels[agentPhase]}{agentDetail && <small>{agentDetail}</small>}</div>}{error && <div className="error-message" role="alert">{error}{canRetry && <button onClick={retry} disabled={busy}>重新生成</button>}</div>}{!busy && canRetry && !error && <button className="continue-button" onClick={retry}>重新生成回复</button>}<form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><textarea ref={textarea} aria-label="输入你的问题" placeholder="问点什么，让想法发生…" value={input} maxLength={10000} rows={1} disabled={!ready} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} /><div className="composer-toolbar"><span className="composer-mode"><Sparkles size={14} />{mode==='agent'?brand.agentName:mode==='knowledge'?brand.knowledgeName:brand.chatName}<span className="mode-dot">·</span><span>有据可循</span></span><div className="send-controls"><span className="keyboard-hint">Enter 发送 / Shift + Enter 换行</span>{busy ? <button type="button" className="send-button" aria-label="停止生成" onClick={stop}><Square size={15} fill="currentColor" /></button> : <button className="send-button" type="submit" disabled={!input.trim() || !ready} aria-label="发送消息"><ArrowUp size={21} /></button>}</div></div></form><div className="disclaimer">由 DeepSeek 提供回复，AI 内容可能不准确，请核实重要信息。<span>由你的好奇心驱动 ✧</span></div></div>
    </main>
  </div>;
}

function getCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(getCodeText).join('');
  if (children && typeof children === 'object' && 'props' in children) return getCodeText((children as { props: { children?: React.ReactNode } }).props.children);
  return '';
}
