'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const storageKey = 'guanyi.home-study.prototype.v1';
  const safeParse = (value, fallback) => { try { return JSON.parse(value) || fallback; } catch (_) { return fallback; } };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
  const svg = (name) => `<svg aria-hidden="true"><use href="#${name}"></use></svg>`;
  const files = [
    { id:'doc-research', name:'训练干预与功能表现', ext:'pdf', type:'PDF', folder:'研究资料', location:'论文示例 · 8 页', opened: Date.now() - 2 * 60 * 1000, page:3, section:'研究方法与参与者', source:'paper' },
    { id:'doc-notes', name:'运动生理学阅读笔记', ext:'md', type:'MD', folder:'我的文档', location:'Markdown · 12 KB', opened: Date.now() - 38 * 60 * 1000, page:1, section:'氧运输与运动', source:'md', content:'# 运动生理学阅读笔记\n\n## 待回答的问题\n\n- 耗氧量与供氧能力有什么区别？\n- 哪些测量条件会影响解释？\n\n> 来源：运动生理学，持续补充你的理解。' },
    { id:'doc-textbook', name:'运动生理学', ext:'pdf', type:'PDF', folder:'研究资料', location:'教材示例 · 186 页', opened: Date.now() - 3 * 60 * 60 * 1000, page:42, section:'氧运输与运动', source:'textbook' },
    { id:'doc-outline', name:'AI 阅读工作流草稿', ext:'md', type:'MD', folder:'我的文档', location:'Markdown · 6 KB', opened: Date.now() - 24 * 60 * 60 * 1000, page:1, section:'工作流设计', source:'md', content:'# AI 阅读工作流草稿\n\n## 阅读目标\n\n先核对原文，再整理成自己的理解。\n\n## 下一步\n\n- 补充来源\n- 标记证据不足' },
    { id:'doc-plain', name:'会议摘录 2026-11-12', ext:'txt', type:'TXT', folder:'我的文档', location:'纯文本 · 4 KB', opened: Date.now() - 2 * 24 * 60 * 60 * 1000, page:1, section:'全文', source:'txt', content:'会议摘录 2026-11-12\n\n记录下一次阅读与写作计划。' },
    { id:'doc-ebook', name:'阅读与学习方法', ext:'epub', type:'EPUB', folder:'阅读书目', location:'电子书 · 12 章', opened: Date.now() - 5 * 24 * 60 * 60 * 1000, page:4, section:'第二章', source:'epub', content:'# 阅读与学习方法\n\n> EPUB 阅读视图示例内容，用于演示章节导航；并非真实导入的电子书。\n\n## 第一章 设定可检查的阅读目标\n\n开始阅读前，先写下希望回答的问题。目标应能通过复述、比较或回到原文核对，而不只是“读完这一章”。\n\n## 第二章 和原文对话\n\n遇到重要段落时，记录它回答了什么、依赖哪些条件，以及还有哪些问题没有解决。书签可以帮助你回到需要重读的位置。\n\n## 第三章 留下自己的理解\n\n合上文档后，用自己的语言整理要点，再打开原文检查遗漏。把解释、判断和原文出处分开记录，让笔记在以后仍可核对。' }
  ];
  const saved = safeParse(localStorage.getItem(storageKey), {});
  const customDocs = Array.isArray(saved.customDocs) ? saved.customDocs.filter(file => file && file.id && file.name) : [];
  const state = {
    theme: saved.theme === 'dark' ? 'dark' : 'light',
    active: saved.active || 'home',
    filter: 'all',
    query: '',
    sourceIds: Array.isArray(saved.sourceIds) ? saved.sourceIds : [],
    docs: [...files.map(file => ({ ...file, opened: Number(saved.opened?.[file.id]) || file.opened, content: saved.content?.[file.id] || file.content })), ...customDocs],
    tabs: Array.isArray(saved.tabs) ? ['home', ...saved.tabs.filter(id => id !== 'home')] : ['home'],
    chat: saved.chat || null,
    md: saved.md || null,
    pendingPrompt: null,
    pendingPdf: null,
    pdfReady: false,
    reading: saved.reading || {}
  };
  const persist = () => {
    const opened = Object.fromEntries(state.docs.map(file => [file.id, file.opened]));
    const content = Object.fromEntries(state.docs.filter(file => file.content).map(file => [file.id, file.content]));
    const fixtureIds = new Set(files.map(file => file.id));
    const customDocs = state.docs.filter(file => !fixtureIds.has(file.id));
    localStorage.setItem(storageKey, JSON.stringify({ theme:state.theme, active:state.active, tabs:state.tabs, sourceIds:state.sourceIds, opened, content, customDocs, chat:state.chat, md:state.md, reading:state.reading }));
  };
  const doc = (id) => state.docs.find(file => file.id === id);
  const currentSources = () => state.sourceIds.map(doc).filter(Boolean);
  function formatTime(timestamp) {
    const distance = Date.now() - timestamp;
    if (distance < 60 * 1000) return '刚刚';
    if (distance < 60 * 60 * 1000) return `${Math.max(1, Math.floor(distance / 60000))} 分钟前`;
    if (distance < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(distance / 3600000))} 小时前`;
    return new Intl.DateTimeFormat('zh-CN', { month:'numeric', day:'numeric' }).format(new Date(timestamp));
  }
  function iconFor(ext) { return `<span class="file-badge ${ext}">${ext === 'md' ? 'M' : ext.toUpperCase()}</span>`; }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 2600); }
  function setTheme() { document.documentElement.dataset.theme = state.theme; $('theme-toggle').setAttribute('aria-pressed', String(state.theme === 'dark')); $('theme-toggle').setAttribute('aria-label', state.theme === 'dark' ? '切换浅色主题' : '切换深色主题'); if (state.pdfReady) renderSourceFrame({ theme:state.theme }); }
  function renderTabs() {
    const tabs = [{ id:'home', name:'主页', home:true }, ...state.tabs.filter(id => id !== 'home').map(id => doc(id)).filter(Boolean)];
    $('tabs').innerHTML = tabs.map(tab => { const safeName = escapeHtml(tab.name); return `<button class="work-tab ${tab.home ? 'home-tab' : ''}" role="tab" aria-selected="${state.active === tab.id}" tabindex="${state.active === tab.id ? 0 : -1}" data-tab="${escapeHtml(tab.id)}">${tab.home ? svg('home') : iconFor(tab.ext)}<span class="tab-name">${safeName}</span>${tab.home ? '' : `<span class="tab-close" data-close-tab="${escapeHtml(tab.id)}" aria-label="关闭 ${safeName}">${svg('close')}</span>`}</button>`; }).join('');
  }
  function renderTree() {
    const groups = ['我的文档','研究资料','阅读书目'];
    $('folder-tree').innerHTML = groups.map(folder => { const items = state.docs.filter(file => file.folder === folder); return `<div class="folder-group"><button class="folder-toggle" aria-expanded="true"><svg><use href="#chevron"></use></svg>${svg('folder')}<span>${escapeHtml(folder)}</span><span class="folder-count">${items.length}</span></button><div>${items.map(file => `<button class="tree-doc ${state.active === file.id ? 'active' : ''}" data-open-doc="${escapeHtml(file.id)}">${iconFor(file.ext)}<span>${escapeHtml(file.name)}</span></button>`).join('')}</div></div>`; }).join('');
  }
  function recentDocs() {
    const query = state.query.trim().toLowerCase();
    return [...state.docs].filter(file => state.filter === 'all' || file.ext === state.filter).filter(file => !query || `${file.name} ${file.folder} ${file.location}`.toLowerCase().includes(query)).sort((a,b) => b.opened - a.opened);
  }
  function renderRecent() {
    const list = recentDocs();
    $('recent-count').textContent = `${list.length} 项`;
    if (!list.length) { $('recent-list').innerHTML = `<div class="list-empty">${svg('search')}<h3>没有匹配的最近文档</h3><p>换一个关键词，或从左侧文档夹打开资料。</p></div>`; return; }
    $('recent-list').innerHTML = list.map(file => `<div class="recent-row"><button class="document-open" data-open-doc="${escapeHtml(file.id)}">${iconFor(file.ext)}<span class="document-label"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.type)} · ${escapeHtml(file.location)}</small></span></button><span class="document-location">${escapeHtml(file.folder)}</span><span class="document-time">${formatTime(file.opened)}</span><button class="row-action" data-open-doc="${escapeHtml(file.id)}" aria-label="打开 ${escapeHtml(file.name)}">${svg('chevron')}</button></div>`).join('');
  }
  function renderHome() { renderRecent(); $('home-scope').textContent = currentSources().length ? `来源：${currentSources().map(file => file.name).join('、')}` : '当前：自由对话 · 未关联文档'; $('context-label').textContent = currentSources().length ? `已选 ${currentSources().length} 份文档` : '选择文档作为来源'; $('home-send').disabled = !$('home-prompt').value.trim(); }
  function switchView(id) {
    if (id !== 'home' && id !== 'chat' && id !== 'md' && !doc(id)) id = 'home';
    state.active = id; if (id !== 'home' && id !== 'chat' && id !== 'md' && !state.tabs.includes(id)) state.tabs.push(id); if (id !== 'home' && id !== 'chat' && id !== 'md') { const file = doc(id); if (file) { file.opened = Math.max(Date.now(), ...state.docs.map(item => item.opened + 1)); } }
    const home = id === 'home'; const chat = id === 'chat'; const md = id === 'md'; const file = doc(id); const pdf = file?.ext === 'pdf';
    const text = !home && !chat && !md && !pdf;
    document.body.dataset.workspace = home ? 'home' : chat ? 'chat' : md ? 'editing' : 'reading';
    $('sidebar').classList.remove('is-open'); $('sidebar-scrim').hidden = true; $('sidebar-toggle').setAttribute('aria-expanded', 'false');
    $('text-outline-toggle').hidden = !text;
    $('edit-reading-doc').hidden = !text || file?.ext !== 'md';
    $('ask-reading-doc').hidden = !text;
    $('global-search').hidden = !home;
    $('home-view').hidden = !home; $('chat-view').hidden = !chat; $('md-view').hidden = !md; $('pdf-view').hidden = !pdf; $('text-view').hidden = home || chat || md || pdf;
    $('view-caption').hidden = home;
    $('view-caption').textContent = home ? '' : chat ? 'AI 对话' : md ? 'Markdown 工作区' : doc(id)?.name || '文档';
    if (text) renderText(file);
    if (chat) renderChat(); if (md) renderMarkdown(); renderTabs(); renderTree(); renderRecent(); persist();
    if (pdf) renderSourceFrame();
    if (!pdf) $('status-message').textContent = home ? '主页 · 本地工作台' : chat ? 'AI 对话 · 预设演示' : md ? 'Markdown · 编辑工作区' : `${file.type} · 阅读视图`;
  }
  function fileFor(id) { return doc(id); }
  function openDoc(id, studyOpen, panel) { const file = doc(id); if (!file) return; if (file.ext === 'pdf') { const position = state.reading[id] || {}; state.pendingPdf = { document:file.source, page:position.page || file.page, panel:panel || position.panel || 'guide', studyOpen:studyOpen ?? position.studyOpen ?? false }; } switchView(id); }
  function readingMarkup(value) {
    const template = document.createElement('template');
    template.innerHTML = window.marked ? marked.parse(escapeHtml(value)) : escapeHtml(value).replaceAll('\n','<br>');
    template.content.querySelectorAll('a').forEach(link => { if (!/^(https?:|mailto:|#)/i.test(link.getAttribute('href') || '')) link.removeAttribute('href'); else { link.target = '_blank'; link.rel = 'noreferrer noopener'; } });
    return template;
  }
  function renderText(file) {
    $('text-view').classList.remove('outline-open', 'outline-hidden');
    const content = file.content || '这是文档阅读示例。可从主页选择其他资料，或围绕这份文档提问。';
    const template = file.ext === 'txt' ? document.createElement('template') : readingMarkup(content);
    if (file.ext === 'txt') template.innerHTML = `<div style="white-space:pre-wrap">${escapeHtml(content)}</div>`;
    const headings = [...template.content.querySelectorAll('h1,h2,h3')];
    headings.forEach((heading,index) => { heading.id = `document-heading-${index}`; });
    const outline = headings.length ? headings.map((heading,index) => `<button data-heading="document-heading-${index}" class="${heading.tagName === 'H1' ? '' : 'subheading'}">${escapeHtml(heading.textContent)}</button>`).join('') : '<p class="outline-empty">这份文档暂未设置章节标题。</p>';
    $('text-view').innerHTML = `<div class="text-document-layout"><aside class="text-outline" aria-label="当前文档目录"><h2>文档目录</h2><nav>${outline}</nav><small>仅显示当前文档的章节</small></aside><div class="text-reading-canvas"><article class="text-paper"><p class="eyebrow">${escapeHtml(file.type)} · 阅读视图</p>${headings[0]?.tagName === 'H1' ? '' : `<h1>${escapeHtml(file.name)}</h1>`}${template.innerHTML}</article></div></div>`;
    $('text-outline-toggle').setAttribute('aria-expanded', String(innerWidth > 760));
  }
  function selectSources() { $('source-options').innerHTML = state.docs.map(file => `<label class="source-option">${iconFor(file.ext)}<input type="checkbox" value="${escapeHtml(file.id)}" ${state.sourceIds.includes(file.id) ? 'checked' : ''}><span>${escapeHtml(file.name)}</span><span>${escapeHtml(file.folder)}</span></label>`).join(''); $('source-dialog').showModal(); }
  function closeDialogs() { $$('dialog').forEach(dialog => { if (dialog.open) dialog.close(); }); }
  function answerFor(prompt) { const sources = currentSources(); if (sources.length) return { title:'基于选定文档的预设回答', body:`我先把问题限定在「${sources.map(file => file.name).join('、')}」中。建议先核对文档里的定义、关键证据和适用边界，再把可靠的结论整理成自己的笔记。`, source:sources[0] }; return { title:'自由对话 · 预设演示', body:`这是一次不绑定文档的自由对话。你可以继续提问，也可以先选择一份 PDF、Markdown 或 EPUB，再让回答绑定到具体来源。`, source:null }; }
  function startChat(prompt) { state.chat = { prompt, answer:answerFor(prompt), sources:currentSources().map(file => file.id) }; switchView('chat'); }
  function renderChat() { const chat = state.chat; $('chat-scope').innerHTML = chat?.sources?.length ? `来源范围：${chat.sources.map(id => doc(id)).filter(Boolean).map(file => `<button class="source-chip" data-open-doc="${escapeHtml(file.id)}">${iconFor(file.ext)} ${escapeHtml(file.name)}</button>`).join('')}` : '自由对话 · 未关联文档'; $('chat-footer-scope').textContent = chat?.sources?.length ? `回答范围：${chat.sources.map(id => doc(id)?.name).filter(Boolean).join('、')}` : '自由对话'; $('chat-messages').innerHTML = chat ? `<article class="chat-message user"><div class="message-label">你的问题</div>${escapeHtml(chat.prompt)}</article><article class="chat-message"><div class="message-label">${svg('spark')}${escapeHtml(chat.answer.title)}</div><p>${escapeHtml(chat.answer.body)}</p>${chat.answer.source ? `<div class="message-source"><small>来源 · ${escapeHtml(chat.answer.source.name)} · 第 ${chat.answer.source.page || 1} 页</small>原文证据会在进入智能研读后保留，当前回答只展示演示内容。</div>` : ''}<div class="message-actions"><button data-action="ask-about-current">继续追问</button><button data-action="save-chat">整理为 Markdown</button>${chat.answer.source ? `<button data-action="open-study">进入智能研读</button>` : ''}</div></article>` : ''; }
  function renderMarkdown() { const note = state.md || { name:'未命名文档', content:'# 新的阅读笔记\n\n## 我想记住什么\n\n写下你的理解，并保留来源。' }; $('md-name').value = note.name; $('md-source').value = note.content; renderPreview(); }
  function renderPreview() { const value = $('md-source').value; $('md-preview').innerHTML = window.marked ? marked.parse(value) : value.replaceAll('\n','<br>'); }
  function newMarkdown() { state.md = { name:'未命名文档', content:'# 新的阅读笔记\n\n' }; switchView('md'); requestAnimationFrame(() => { $('md-source').focus(); $('md-source').setSelectionRange($('md-source').value.length, $('md-source').value.length); }); }
  function saveMarkdown() { const id = state.md?.id || `md-${Date.now()}`; state.md = { id, name:$('md-name').value.trim() || '未命名文档', content:$('md-source').value }; const file = { id, name:state.md.name, ext:'md', type:'MD', folder:'我的文档', location:'Markdown · 刚刚保存', opened:Date.now(), page:1, section:'', source:'md', content:state.md.content }; state.docs = [file, ...state.docs.filter(item => item.id !== id)]; if (!state.tabs.includes(id)) state.tabs.push(id); $('md-save-state').textContent = '已保存到本地文档'; persist(); renderTree(); renderRecent(); toast('已保存到本地文档，最近打开已更新。'); }
  function saveChatAsMarkdown() { const chat = state.chat; state.md = { name:`${chat?.prompt?.slice(0,18) || 'AI'} · 阅读笔记`, content:`# ${chat?.prompt || 'AI 阅读笔记'}\n\n${chat?.answer?.body || ''}\n\n## 来源\n\n${(chat?.sources || []).map(id => `- ${doc(id)?.name || id}`).join('\n') || '- 自由对话，尚未关联文档'}` }; switchView('md'); requestAnimationFrame(() => { $('md-source').focus(); }); }
  function renderSourceFrame(overrides) {
    if (!state.pdfReady) return;
    const frame = $('pdf-frame');
    const file = doc(state.active);
    if (!overrides && file?.ext !== 'pdf') return;
    const position = state.reading[file?.id] || {};
    const message = overrides || state.pendingPdf || { document:file.source, page:position.page || file.page, panel:position.panel || 'guide', studyOpen:position.studyOpen ?? false };
    frame.contentWindow.postMessage({ type:'guanyi-pdf-open', theme:state.theme, ...message }, location.origin === 'null' ? '*' : location.origin);
    if (!overrides) state.pendingPdf = null;
  }
  function bind() {
    document.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
      const closeId = event.target.closest('[data-close-tab]')?.dataset.closeTab;
      if (closeId && closeId !== 'home') { state.tabs = state.tabs.filter(id => id !== closeId); if (state.active === closeId) switchView('home'); renderTabs(); persist(); return; }
      if (target.dataset.openDoc) { openDoc(target.dataset.openDoc); return; }
      if (target.dataset.tab) { openDoc(target.dataset.tab); if (target.dataset.tab === 'home') switchView('home'); return; }
      if (target.dataset.filter) { state.filter = target.dataset.filter; $$('.recent-filters [role="tab"]').forEach(tab => tab.setAttribute('aria-selected', String(tab === target))); renderRecent(); return; }
      if (target.dataset.heading) { $(target.dataset.heading)?.scrollIntoView({ block:'start' }); if (innerWidth <= 760) { $('text-view').classList.remove('outline-open'); $('text-outline-toggle').setAttribute('aria-expanded', 'false'); } return; }
      if (target.dataset.prompt) { if (target.dataset.needSource && !currentSources().length) { selectSources(); state.pendingPrompt = target.dataset.prompt; return; } startChat(target.dataset.prompt); return; }
      if (target.dataset.action === 'new-md') { newMarkdown(); return; }
      if (target.dataset.action === 'open-smart-study') { const file = currentSources().find(item => item.ext === 'pdf') || doc('doc-research'); if (file) openDoc(file.id, true, 'guide'); return; }
      if (target.dataset.action === 'open') { toast('打开文档入口：选择本地 Markdown、TXT、PDF 或 EPUB。'); return; }
      if (target.dataset.action === 'add-folder') { toast('添加文档目录入口已保留，正式版将复用目录扫描。'); return; }
      if (target.dataset.action === 'search') { switchView('home'); $('global-search-input').focus(); return; }
      if (target.dataset.action === 'ask-about-current') { if (doc(state.active)) state.sourceIds = [state.active]; startChat(`请帮我梳理「${doc(state.active)?.name || '这份文档'}」的关键内容。`); return; }
      if (target.dataset.action === 'save-chat') { saveChatAsMarkdown(); return; }
      if (target.dataset.action === 'open-study') { const file = currentSources()[0] || doc(state.active) || doc('doc-research'); if (file) { closeDialogs(); openDoc(file.id, true); } return; }
      if (target.id === 'context-button') { selectSources(); return; }
      if (target.dataset.mode) { $$('.view-segment [data-mode]').forEach(item => item.setAttribute('aria-selected', String(item === target))); $('editor-columns').dataset.mode = target.dataset.mode; return; }
      if (target.dataset.format) { const area = $('md-source'); const insertion = ({heading:'# ',bold:'**文字**',list:'- ',quote:'> '}[target.dataset.format]); area.setRangeText(insertion, area.selectionStart, area.selectionEnd, 'end'); area.dispatchEvent(new Event('input')); }
    });
    $('theme-toggle').addEventListener('click', () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; setTheme(); persist(); });
    $('home-prompt').addEventListener('input', () => { $('home-send').disabled = !$('home-prompt').value.trim(); });
    $('home-send').addEventListener('click', () => { const prompt = $('home-prompt').value.trim(); if (prompt) startChat(prompt); });
    $('recent-query').addEventListener('input', event => { state.query = event.target.value; renderRecent(); });
    $('global-search-input').addEventListener('input', event => { state.query = event.target.value; $('recent-query').value = event.target.value; renderRecent(); });
    $('global-search-input').addEventListener('keydown', event => { if (event.key === 'Escape') { event.currentTarget.value = ''; state.query = ''; renderRecent(); event.currentTarget.blur(); } if (event.key === 'Enter') { const first = recentDocs()[0]; if (first) openDoc(first.id); } });
    $('global-search').addEventListener('click', event => { if (event.target.id === 'global-search') $('global-search-input').focus(); });
    $('pdf-frame').addEventListener('load', () => renderSourceFrame());
    $('text-outline-toggle').addEventListener('click', () => { const compact = innerWidth <= 760; const open = compact ? $('text-view').classList.toggle('outline-open') : !$('text-view').classList.toggle('outline-hidden'); $('text-outline-toggle').setAttribute('aria-expanded', String(open)); });
    $('edit-reading-doc').addEventListener('click', () => { const file = doc(state.active); if (!file || file.ext !== 'md') return; state.md = { id:file.id, name:file.name, content:file.content || '' }; switchView('md'); });
    $('ask-reading-doc').addEventListener('click', () => { const file = doc(state.active); if (!file) return; state.sourceIds = [file.id]; startChat(`请帮我梳理「${file.name}」的关键内容。`); });
    $('sidebar-toggle').addEventListener('click', () => { const isOpen = $('sidebar').classList.toggle('is-open'); $('sidebar-toggle').setAttribute('aria-expanded', String(isOpen)); $('sidebar-scrim').hidden = !isOpen; });
    $('sidebar-scrim').addEventListener('click', () => { $('sidebar').classList.remove('is-open'); $('sidebar-scrim').hidden = true; });
    $('confirm-context').addEventListener('click', () => { state.sourceIds = $$('#source-options input:checked').map(input => input.value); closeDialogs(); renderHome(); if (state.pendingPrompt) { const prompt = state.pendingPrompt; state.pendingPrompt = null; startChat(prompt); } });
    $('clear-context').addEventListener('click', () => { state.sourceIds = []; closeDialogs(); renderHome(); });
    $$('[data-close-dialog]').forEach(button => button.addEventListener('click', closeDialogs));
    $('chat-form').addEventListener('submit', event => { event.preventDefault(); const input = $('chat-input'); if (!input.value.trim()) return; state.chat.prompt = input.value.trim(); state.chat.answer = answerFor(state.chat.prompt); input.value = ''; renderChat(); persist(); });
    $('save-chat').addEventListener('click', saveChatAsMarkdown); $('md-save').addEventListener('click', saveMarkdown); $('md-source').addEventListener('input', renderPreview); $('md-name').addEventListener('input', () => { $('md-save-state').textContent = '未保存'; });
    $('review-button').addEventListener('click', () => { $('action-title').textContent = '主页与智能研读方案'; $('action-content').innerHTML = '<p>主页承接“选择文档 → AI 快捷对话 → 进入智能研读”的连续路径。自由对话不会假装有来源；选定文档后，回答明确标记来源范围。最近列表按最近打开时间降序排列，编辑保存不会改变排序，重新打开才会更新。</p><div class="action-list"><button class="button secondary" data-action="new-md">创建一份 Markdown 笔记</button><button class="button secondary" data-action="open-study">查看当前智能研读</button></div>'; $('action-dialog').showModal(); });
    $('preview-state').addEventListener('change', event => { const value = event.target.value; if (value === 'empty') { state.docs = []; renderTree(); renderRecent(); toast('这是首次使用状态：先新建 Markdown 或打开一份文档。'); } else if (value === 'missing') toast('有 1 份文档无法读取，可从最近列表移除或重新打开。'); else if (value === 'model-error') toast('AI 请求失败，问题仍保留在当前对话框，可重试。'); else if (value === 'model-unconfigured') toast('还未配置模型，核心的阅读、编辑和保存仍可继续。'); else { state.docs = files.map(file => ({ ...file })); renderTree(); renderRecent(); } });
    window.addEventListener('message', event => {
      if (event.source !== $('pdf-frame').contentWindow) return;
      if (event.data?.type === 'guanyi-pdf-ready') { state.pdfReady = true; renderSourceFrame(); return; }
      const file = doc(state.active);
      if (state.pdfReady && event.data?.type === 'guanyi-pdf-state' && file?.ext === 'pdf' && file.source === event.data.document) {
        state.reading[file.id] = { page:event.data.page, panel:event.data.panel, studyOpen:event.data.studyOpen };
        $('status-message').textContent = `${event.data.studyOpen ? '智能研读' : 'PDF 阅读'} · 第 ${event.data.page} 页 · ${file.name}`;
        persist();
      }
    });
    window.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); switchView('home'); $('global-search-input').focus(); } if (event.key === 'Escape') closeDialogs(); });
  }
  state.tabs = ['home', ...new Set(state.tabs.filter(id => id !== 'home' && doc(id)))];
  state.sourceIds = state.sourceIds.filter(id => doc(id));
  if (state.active !== 'home' && state.active !== 'chat' && state.active !== 'md' && !doc(state.active)) state.active = 'home';
  const requestedView = new URLSearchParams(location.search).get('view');
  if (doc(requestedView)) state.active = requestedView;
  setTheme(); renderTabs(); renderTree(); renderHome(); bind(); switchView(state.active || 'home');
  window.__GUANYI_HOME_STUDY__ = { getState:() => ({ active:state.active, docs:state.docs.map(file => ({ id:file.id,name:file.name,opened:file.opened })), sourceIds:state.sourceIds, theme:state.theme }) };
})();
