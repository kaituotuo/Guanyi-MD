'use strict';
// This prototype uses original, fictional fixtures and never calls an AI service.
(() => {
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const storageKey = 'guanyi.pdf-study.prototype.v1';
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (_) { /* A private window may disallow storage. */ }
  const documents = {
    textbook: {
      title: '运动生理学 · 学习示例', short: '运动生理学', total: 186, start: 42,
      section: '第二章 · 氧运输与运动', goal: '说清楚“耗氧量”与“供氧能力”的区别。',
      outline: [[42, '02', '氧运输与运动'], [55, '2.1', '耗氧量的决定因素'], [56, '2.2', '概念之间的联系'], [64, '03', '复习与自测']],
      pages: {
        42: { kicker: 'CHAPTER 02', title: '氧运输与运动', subtitle: '把一个复杂过程拆开，再把它们联系起来。', heading: '2.1 从外界空气到组织利用', paragraphs: [
          ['oxygen-chain', '本学习示例将氧运输概括为三个相互联系的环节：肺部气体交换、循环运输与组织利用。阅读时应分别理解每个环节，再分析它们之间的关系。'],
          ['oxygen-use', '“耗氧量”描述一定时间内机体利用氧的量；它与单一环节的供氧能力并不等同。解释这一指标时，需要同时关注运输过程与组织利用。'],
          ['oxygen-boundary', '概念之间存在联系，并不意味着任一指标可以独立说明全部过程。学习机制时，应明确指标的定义、测量条件与解释范围。']
        ], figure: true, callout: '试着用自己的语言回答：某个测量指标，能否代表整条运输链？' },
        55: { kicker: 'CHAPTER 02 / 2.1', title: '耗氧量的决定因素', subtitle: '用关系式整理思路，用测量条件限定解释。', heading: '2.1.1 一个用于演示的关系框架', paragraphs: [
          ['determinants', '在本演示的概念框架中，心输出量和动静脉氧含量差共同参与解释耗氧量。前者描述循环输送，后者联系组织从血液中获取氧的过程。'],
          ['measurement', '对一个测量值作出解释之前，需要核对受试者特征、测试协议、计量单位与测量时间。不同条件下的数值不能直接比较。'],
          ['formula-boundary', '关系式帮助组织概念，但不能独立证明训练效果，也不能据此为某一个人制定运动方案。']
        ], callout: '把“指标定义、影响因素、测量条件、解释边界”分别写下来。' },
        56: { kicker: 'CHAPTER 02 / 2.2', title: '概念之间的联系', subtitle: '一张概念卡只回答一个清晰的问题。', heading: '2.2.1 避免把关联写成等同', paragraphs: [
          ['concept-link', '整理学习笔记时，可以依次写出概念定义、前置概念、相邻概念与适用边界。用“参与解释”“受到影响”等具体关系，替代含糊的“相关”。'],
          ['recall', '合上教材后，用自己的语言复述，再返回原文核对。复述遗漏的部分可以成为下一轮学习的问题。']
        ], callout: '练习：不用“能力更强”这类笼统词，解释两个指标的不同。' },
        64: { kicker: 'CHAPTER 03', title: '复习与自测', subtitle: '从“看懂了”走向“说得清楚”。', heading: '3.1 回忆、检查与修正', paragraphs: [
          ['review', '本页是原型中的自测示例。先解释一个概念，再说明它与另一个概念的区别，最后补充适用条件与暂时不能回答的问题。'],
          ['review-plan', '把尚不清楚的概念保留在待复习列表中。学习卡应保留原文页码，便于在回忆后返回来源检查。']
        ], callout: '打开右侧“学习卡”，遮住答案，检查自己是否真正理解。' }
      }
    },
    paper: {
      title: '训练干预与功能表现 · 研究示例', short: '训练干预与功能表现', total: 8, start: 3,
      section: '研究论文 · 方法与结果', goal: '找出研究人群、结局指标与外推边界。',
      outline: [[1, '01', '摘要与研究问题'], [3, '02', '研究方法与参与者'], [5, '03', '结果与不确定性'], [7, '04', '讨论、局限与外推']],
      pages: {
        1: { kicker: 'FICTIONAL RESEARCH / ABSTRACT', title: '训练干预与功能表现', subtitle: '用于展示研读流程的虚构研究。所有样本、数据与结论均为模拟。', heading: '摘要', paragraphs: [
          ['abstract', '目的：演示如何从一篇研究中提取人群、干预、对照与结局。方法：研究示例设定为两组平行随机试验。结果与局限请分别查看第 5 页与第 7 页。'],
          ['question', '演示问题：在特定受试者中，一个短期训练项目与对照条件相比，功能测试结果出现了怎样的变化？']
        ], callout: '这是交互设计资料，不能作为运动训练或健康决策的依据。' },
        3: { kicker: 'METHODS / DEMO STUDY', title: '研究方法与参与者', subtitle: 'Synthetic study · 仅为交互演示编写，无对应真实论文', heading: '2.1 研究设计', paragraphs: [
          ['population', '本虚构研究纳入 48 名 20–35 岁、无规律训练经历的成年人，随机分配至训练组与对照组。研究未纳入有特定疾病或正在康复的人群。'],
          ['intervention', '训练组完成 8 周、每周 3 次的示例训练，对照组保持原有活动。具体强度、实际完成率与进阶细节在本演示资料中未报告。'],
          ['outcomes', '主要结局为示例功能测试分数。研究在基线与第 8 周测量结果；该测试分数不等同于所有健康结局。']
        ], columns: true, callout: '核对：研究对象与你关心的人群是否一致？干预是否报告充分？' },
        5: { kicker: 'RESULTS / SYNTHETIC NUMBERS', title: '结果与不确定性', subtitle: '以下数值全部虚构，仅用于展示证据与数值核对。', heading: '3.1 主要结局', paragraphs: [
          ['result', '本模拟结果中，组间平均差为 2.1 分，95% 置信区间为 0.4 至 3.8 分。资料没有报告该量表的最小临床重要差异。'],
          ['harms', '本演示资料未报告不良事件和损伤的收集方法。不能把“未报告”解释为“没有发生”。'],
          ['interpretation', '应把数值结果、测量的不确定性与实际意义分别讨论。这个示例不能为任何真实干预提供效果证明。']
        ], table: true, callout: '三个需要核对的内容：效应大小、区间宽度、实际意义。' },
        7: { kicker: 'DISCUSSION / LIMITATIONS', title: '局限与外推边界', subtitle: '作者写了什么，证据又能支持到哪里？', heading: '4.1 解释范围', paragraphs: [
          ['limitations', '本模拟研究样本量较小，随访仅 8 周，研究对象为年轻且无规律训练经历的成年人。结果不能直接外推至老年人、疾病人群或竞技运动员。'],
          ['conflict', '本演示未提供完整方案注册信息、依从性数据与资金来源。因此这些字段只能标记为“本演示资料未报告”。'],
          ['causality', '判断结论时，应同时检查研究设计、实施过程、结果与局限。仅凭摘要中的一句结论不足以完成评价。']
        ], callout: '把“作者结论”“已报告数据”和“你的判断”分别记录。' }
      }
    }
  };
  const freshSession = (id) => ({ page: Number(stored.positions?.[id]) || documents[id].start, scroll: 0, panel: 'guide', scope: 'page', draft: '', draftContext: null, noteDraft: '', noteContext: null, selection: '', selectionPage: null, selectionBlock: '', answers: [], notes: stored.notes?.[id] || [], history: [] });
  const state = { document: stored.document === 'paper' ? 'paper' : 'textbook', theme: stored.theme === 'dark' ? 'dark' : 'light', scenario: 'ready', sessions: { textbook: freshSession('textbook'), paper: freshSession('paper') }, cards: Array.isArray(stored.cards) ? stored.cards : [], cardDraft: null, revealed: new Set(), pending: null, zoom: 'fit', returnFocus: null };
  const current = () => state.sessions[state.document];
  const doc = () => documents[state.document];
  let toastTimer;
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200); }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ document: state.document, theme: state.theme, cards: state.cards, positions: Object.fromEntries(Object.entries(state.sessions).map(([key, session]) => [key, session.page])), notes: Object.fromEntries(Object.entries(state.sessions).map(([key, session]) => [key, session.notes])), goals: stored.goals || {} })); return true; }
    catch (_) { toast('浏览器暂时无法保存，当前会话仍可继续；建议导出笔记。'); return false; }
  }
  const ref = (page, block = '') => `<button class="page-ref" data-page="${page}" data-block="${escape(block)}">${icon('quote')}第 ${page} 页</button>`;
  const source = (page, block) => { const item = doc().pages[page]; return item?.paragraphs.find(([id]) => id === block)?.[1] || item?.paragraphs[0]?.[1] || ''; };
  function documentCandidates() {
    // Fixed fixtures model the result of automatic preparation; no AI call runs.
    const fixtures = {
      textbook: [
        { key: 'oxygen-concept', kind: '概念知识', question: '耗氧量与单一供氧环节有什么区别？', answer: '耗氧量描述一定时间内利用氧的量，涉及运输与组织利用。单一环节的供氧能力只描述整个过程的一部分，两者不能等同。', references: [[42, 'oxygen-use']] },
        { key: 'concept-framework', kind: '核心思路', question: '怎样从多个环节建立对复杂过程的整体理解？', answer: '先分别理解各环节，再把它们之间的关系连接起来；记录概念定义、前置概念、相邻概念与适用边界，明确具体关系。', references: [[42, 'oxygen-chain'], [56, 'concept-link']] },
        { key: 'measurement-conditions', kind: '方法与条件', question: '比较测量指标之前，需要核对哪些条件？', answer: '核对受试者特征、测试协议、计量单位与测量时间。不同条件下的数值不能直接比较。', references: [[55, 'measurement']] }
      ],
      paper: [
        { key: 'research-question', kind: '核心研究思路', question: '这项虚构研究通过什么比较，回答什么问题？', answer: '比较示例训练与保持原有活动的对照条件，观察功能测试结果如何变化。干预设为8周、每周3次；这些设置均为演示数据。', references: [[1, 'question'], [3, 'intervention']] },
        { key: 'study-design', kind: '方法与设计', question: '这份研究的人群和试验安排是什么？', answer: '虚构研究纳入48名20–35岁、无规律训练经历的成年人，随机分配至训练组与对照组。强度、完成率与进阶细节未报告。', references: [[3, 'population'], [3, 'intervention']] },
        { key: 'result-boundaries', kind: '结论与边界', question: '模拟结果报告了什么，还不能推出什么？', answer: '模拟组间平均差为2.1分，95%置信区间0.4–3.8分；实际意义的判断标准未报告。研究对象与随访范围有限，不能直接外推到老年人、疾病人群或竞技运动员。', references: [[5, 'result'], [7, 'limitations']] }
      ]
    };
    return fixtures[state.document].map(item => {
      const sources = item.references.map(([page, block]) => ({ page, block, quote: source(page, block) }));
      return { candidateId: `${state.document}:${item.key}`, kind: item.kind, question: item.question, answer: item.answer, page: sources[0].page, block: sources[0].block, quote: sources[0].quote, sources };
    }).filter(candidate => !state.cards.some(card => card.document === state.document && card.candidateId === candidate.candidateId));
  }
  function pageData(page) {
    return doc().pages[page] || { kicker: 'PROTOTYPE / SAMPLE PAGE', title: `第 ${page} 页`, subtitle: '此页未编排演示正文。目录中的示例页可体验完整证据流程。', heading: '继续阅读', paragraphs: [['placeholder', '请从左侧目录跳转至已编排的示例页。本原型展示阅读交互，不包含整本教材或实际论文。']], callout: '教材示例页：42、55、56、64；论文示例页：1、3、5、7。' };
  }
  function renderPaper(highlight = '') {
    const page = current().page, data = pageData(page);
    $('page-input').value = page;
    $('page-input').max = doc().total;
    $('total-pages').textContent = `/ ${doc().total}`;
    $('previous-page').disabled = page <= 1;
    $('next-page').disabled = page >= doc().total;
    $('reading-breadcrumb').textContent = `${state.document === 'textbook' ? '第二章 · 氧运输与运动' : '研究示例 · ' + data.title}`;
    $('document-footer').textContent = '智能研读 · 原文排版视图';
    $('return-button').hidden = !current().history.length;
    $('pdf-page').innerHTML = `<div class="page-running"><span>${state.document === 'textbook' ? '运动生理学 / 学习示例' : '训练干预与功能表现 / 虚构研究'}</span><span>GUANYI · DEMO</span></div><div class="chapter-kicker">${data.kicker}</div><h2>${data.title}</h2><p class="lead">${data.subtitle}</p><h3>${data.heading}</h3><div class="${data.columns ? 'two-column' : ''}">${data.paragraphs.map(([id, text]) => `<p tabindex="0" role="button" aria-label="选择段落：${escape(text.slice(0, 24))}" class="selectable${id === highlight ? ' evidence-highlight' : ''}" data-block-id="${id}">${text}</p>`).join('')}</div>${data.figure ? '<div class="mechanism"><div class="mechanism-box">肺部交换<em>进入血液</em></div><span>→</span><div class="mechanism-box">循环运输<em>输送氧</em></div><span>→</span><div class="mechanism-box">组织利用<em>使用氧</em></div></div><div class="figure-caption">图 2–1　概念关系示意（原创演示插图）</div>' : ''}${data.table ? '<table class="paper-table"><caption>模拟结果 · 非真实研究数据</caption><thead><tr><th>指标</th><th>组间平均差</th><th>95% CI</th></tr></thead><tbody><tr><td>功能测试分数</td><td>2.1 分</td><td>0.4 至 3.8</td></tr></tbody></table>' : ''}<div class="paper-callout"><strong>阅读提示</strong>${data.callout}</div><div class="paper-label">原创演示资料 · 不作为医学或训练依据</div><div class="page-number"><span>${doc().short}</span><span>${page}</span></div>`;
    $('pdf-page').style.width = state.zoom === 'fit' ? '' : `${690 * Number(state.zoom)}px`;
    $('pdf-page').style.maxWidth = state.zoom === 'fit' ? '' : 'none';
    $('outline').innerHTML = doc().outline.map(([p, n, name]) => `<button class="${page === p ? 'active' : ''}" data-page="${p}"><span>${n}</span>${name}</button>`).join('');
    if (highlight) requestAnimationFrame(() => $('pdf-page').querySelector(`[data-block-id="${CSS.escape(highlight)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
  function navigate(page, block = '', evidence = false, trigger = null) {
    const number = Math.max(1, Math.min(doc().total, Math.round(Number(page)) || 1));
    if (evidence) { current().history.push({ page: current().page, scroll: $('paper-scroll').scrollTop }); state.returnFocus = trigger; }
    current().page = number;
    if (!evidence && !current().draft.trim()) clearSelection();
    renderPaper(block);
    if (!block) $('paper-scroll').scrollTop = 0;
    updateScopeHint();
    if (!evidence && current().panel === 'notes' && !current().noteDraft.trim()) { current().noteContext = null; renderPanel(); }
    persist();
  }
  function returnToReading() {
    const location = current().history.pop();
    if (!location) return;
    current().page = location.page; renderPaper();
    updateScopeHint();
    requestAnimationFrame(() => { $('paper-scroll').scrollTop = location.scroll; state.returnFocus?.isConnected && state.returnFocus.focus({ preventScroll: true }); });
    persist();
  }
  function openPanel(panel, focus = false) {
    current().panel = panel;
    $('study-panel').classList.remove('is-hidden');
    $('study-toggle').setAttribute('aria-expanded', 'true');
    renderPanel();
    if (focus) $('panel-content').focus({ preventScroll: true });
  }
  function scenarioNotice() {
    const notices = {
      indexing: ['正在建立研读索引', '已完成示例前 2 页。阅读与批注照常可用；全文问答待索引完成后开放。', '完成索引演示'],
      scan: ['这一份 PDF 还没有文字层', '页面可以阅读。文字提问需要先识别内容；OCR 属于后续版本，本原型展示引导状态。', '切回文字版示例'],
      stale: ['原文件已有新版本', '旧回答与学习卡保留来源版本。核对新版本后，重新建立索引，避免引用错位。', '查看版本更新演示']
    };
    const item = notices[state.scenario];
    return item ? `<div class="notice"><strong>${item[0]}</strong><p>${item[1]}</p><button class="secondary-button" data-action="recover">${item[2]}</button></div>` : '';
  }
  function renderGuide() {
    if (state.document === 'textbook') return `${scenarioNotice()}<p class="section-kicker">CHAPTER 02 · 学习导读</p><h3 class="guide-title">先看见全貌，<br>再理解每一个概念。</h3><p class="body-copy">本章围绕氧的运输与利用展开。先区分三个环节，再带着问题阅读。</p><div class="context-label">${icon('check')}导读对应示例第 42–56 页</div><div class="section-heading">带着这 3 个问题读<small>学习目标</small></div><div class="question-list"><button class="question-row" data-question="氧运输包括哪几个环节？"><span class="number">01</span><span>氧运输包括哪几个环节？</span>${icon('arrow')}</button><button class="question-row" data-question="耗氧量与供氧能力有什么区别？"><span class="number">02</span><span>耗氧量等同于供氧能力吗？</span>${icon('arrow')}</button><button class="question-row" data-question="解释指标时需要注意什么条件？"><span class="number">03</span><span>解释指标时，需要核对哪些条件？</span>${icon('arrow')}</button></div><div class="section-heading">先修概念<small>点按开始解释</small></div><div class="prerequisite"><button class="chip" data-question="通俗解释心输出量">心输出量</button><button class="chip" data-question="通俗解释动静脉氧含量差">动静脉氧含量差</button><button class="chip" data-question="通俗解释耗氧量">耗氧量</button></div><div class="section-heading">建议的阅读路径<small>按自己的节奏</small></div><div class="chapter-card"><div><strong>① 理解运输链</strong>${ref(42, 'oxygen-chain')}</div><p>把肺、血液与组织连在一起理解。</p><button class="small-link" data-action="select-example">选中一段，试试解释 →</button></div><div class="chapter-card"><div><strong>② 梳理指标与边界</strong>${ref(55, 'measurement')}</div><p>每个指标都需要定义与测量条件。</p></div><p class="guide-footer-note">导读与回答均为预设演示。使用正式产品时，每条来源都需要解析与校验。</p>`;
    const rows = [
      ['研究问题', '示例训练与对照条件相比，功能测试结果如何变化？', 1, 'question'],
      ['研究设计', '两组平行随机试验 · 虚构示例', 3, 'population'],
      ['P · 人群', '48 名 20–35 岁、无规律训练经历的成年人。', 3, 'population'],
      ['I / C', '8 周、每周 3 次示例训练 / 原有活动。强度与完成率未报告。', 3, 'intervention'],
      ['O · 结局', '示例功能测试分数；基线与第 8 周测量。', 3, 'outcomes'],
      ['主要结果', '模拟组间平均差 2.1 分；95% CI 0.4–3.8。实际意义待核实。', 5, 'result'],
      ['外推边界', '不能直接外推至老年人、疾病人群或竞技运动员。', 7, 'limitations']
    ];
    return `${scenarioNotice()}<p class="section-kicker">RESEARCH BRIEF · 论文导读</p><h3 class="guide-title">先理解研究，<br>再判断结论。</h3><p class="body-copy">把“研究做了什么”和“结果说明什么”分开核对。</p><div class="notice neutral"><strong>虚构研究，仅供交互演示</strong>所有样本、干预与数值均为模拟，无真实论文对应。</div><div class="section-heading">研究卡<small>每个字段都有来源</small></div>${rows.map(([name, text, page, block]) => `<div class="research-row"><span>${name}</span><div><p>${text}</p>${ref(page, block)}</div></div>`).join('')}<div class="section-heading">值得进一步追问</div><button class="prompt-button" data-question="这篇论文的结果可以直接用于老年人吗？">这项结果适用于哪些人？ →</button><button class="prompt-button" data-question="统计结果与实际意义有什么区别？">数值差异具有实际意义吗？ →</button><p class="guide-footer-note">“未报告”保留为缺失项。研究卡的正式版本需要人工核对，不自动认定证据质量。</p>`;
  }
  function baseContext() { return { scope: current().scope, page: current().page, selection: current().selection, selectionPage: current().selectionPage, selectionBlock: current().selectionBlock }; }
  function scopeName(scope = current().scope, page = current().page, selectionPage = current().selectionPage) { return ({ selection: `已选文字 · 第 ${selectionPage || page} 页`, page: `当前页 · 第 ${page} 页`, chapter: state.document === 'textbook' ? '本章 · 第 42–56 页' : '方法与结果 · 第 3–5 页', document: `本文 · 共 ${doc().total} 页` })[scope]; }
  function updateScopeHint() {
    const context = current().draftContext || baseContext();
    if ($('scope-hint')) $('scope-hint').textContent = `${scopeName(context.scope, context.page, context.selectionPage)} · 仅依据本文${current().draftContext ? ' · 已锁定本次范围' : ''}`;
    if ($('scope-select')) $('scope-select').value = context.scope;
  }
  function answerMarkup(answer) {
    const status = answer.status;
    let body;
    if (status === 'loading') body = `<div class="loading-row"><span class="loading-dot"></span>正在查找原文并组织解释…</div><p class="guide-footer-note">模拟响应，可取消；不发送任何文档。</p>`;
    else if (status === 'error') body = `<div class="notice"><strong>请求暂未完成</strong><p>模型请求失败（演示）。问题已保留，当前阅读与笔记可继续使用。</p><button class="secondary-button" data-retry="${answer.id}">重试本次问题</button></div>`;
    else if (status === 'cancelled') body = '<div class="notice neutral"><strong>已取消本次提问</strong>问题与阅读位置均已保留。</div>';
    else if (status === 'insufficient') body = '<div class="notice neutral"><strong>当前范围没有足够依据</strong><p>不能根据已有原文回答这个问题。你可以扩大到“本文”，或补充相关资料。</p><button class="secondary-button" data-action="expand-scope">改为本文范围</button></div>';
    else if (status === 'unplanned') body = '<div class="notice neutral"><strong>此问题尚未编排演示回答</strong><p>原型没有接入模型。可以使用下方示例问题体验证据流程。</p><button class="secondary-button" data-question="通俗解释耗氧量">体验概念解释</button></div>';
    else body = `<p>${answer.explanation}</p>${answer.extra ? `<h4>阅读时还要留意</h4><p>${answer.extra}</p>` : ''}${answer.evidence.map((e) => `<div class="evidence"><div class="evidence-label"><span>原文依据 · 演示资料</span>${ref(e.page, e.block)}</div><blockquote>“${escape(e.quote)}”</blockquote><small>${doc().short} · ${escape(answer.scopeLabel)} · 示例版本 1</small></div>`).join('')}<div class="answer-actions"><button data-save-answer="${answer.id}">${icon('cards')}生成学习卡</button><button data-note-answer="${answer.id}">${icon('note')}记入笔记</button></div>`;
    return `<div class="chat-user">${escape(answer.question)}<div class="muted-small">${escape(answer.scopeLabel)}</div></div><div class="chat-answer" data-answer-id="${answer.id}"><div class="answer-label">${icon('spark')}${status === 'ready' ? '解释 · 预设演示' : '研读助手'}</div>${body}</div>`;
  }
  function renderAsk() {
    const session = current();
    const disabled = ['scan', 'indexing', 'stale'].includes(state.scenario);
    return `<div class="ask-shell"><div class="ask-top"><div class="scope-row"><span>依据范围</span><select id="scope-select" aria-label="问答依据范围"><option value="selection" ${session.scope === 'selection' ? 'selected' : ''} ${!session.selection ? 'disabled' : ''}>已选文字</option><option value="page" ${session.scope === 'page' ? 'selected' : ''}>当前页</option><option value="chapter" ${session.scope === 'chapter' ? 'selected' : ''}>当前章节</option><option value="document" ${session.scope === 'document' ? 'selected' : ''}>本文</option></select></div><p class="scope-hint" id="scope-hint">${escape(scopeName())} · 仅依据本文</p>${session.scope === 'selection' && session.selection ? `<blockquote class="selected-context">${escape(session.selection)}</blockquote>` : ''}</div><div class="chat-thread" id="chat-thread">${scenarioNotice()}${session.answers.length ? session.answers.map(answerMarkup).join('') : `<div class="chat-empty"><p class="section-kicker">READ WITH QUESTIONS</p><h3>${state.document === 'textbook' ? '把没理解的地方，<br>变成一个好问题。' : '从研究问题出发，<br>向原文寻找依据。'}</h3><p>回答与解释始终附带原文，便于你自己核对。</p>${(state.document === 'textbook' ? ['通俗解释耗氧量', '耗氧量与供氧能力有什么区别？', '解释指标时需要注意什么条件？'] : ['这篇论文的结果可以直接用于老年人吗？', '统计结果与实际意义有什么区别？', '研究人群和训练方案是什么？']).map(q => `<button class="prompt-button" data-question="${q}">${q}</button>`).join('')}</div>`}</div><div class="composer-area"><div class="composer"><textarea id="question-input" rows="2" aria-label="向文档提问" placeholder="${disabled ? '可先准备问题，待内容可用后再发送' : '哪里还不明白？带着问题继续读…'}" maxlength="1000">${escape(session.draft)}</textarea><div class="composer-bottom"><span>仅依据本文 <span aria-hidden="true">·</span> 演示模型</span>${state.pending ? '<button class="send-button cancel-button" id="cancel-request">取消</button>' : `<button class="send-button" id="send-question" aria-label="发送问题" ${disabled ? 'disabled' : ''}>${icon('arrow')}</button>`}</div></div><div class="composer-footnote">演示资料与预设回答；正式版本调用模型前可查看发送范围。</div></div></div>`;
  }
  function renderCards() {
    const cards = state.cards.filter(card => card.document === state.document);
    const candidates = documentCandidates();
    const ready = !['scan', 'indexing', 'stale'].includes(state.scenario);
    const candidateMarkup = ready ? `<div class="section-heading">根据本文整理的候选卡<small>${candidates.length} 张待核对</small></div><p class="body-copy">自动提炼概念、思路与方法，先核对再保留。以下为预设演示候选，未加入卡库。</p>${candidates.map(candidate => `<article class="candidate-card" data-candidate-id="${candidate.candidateId}"><div class="card-top"><span class="card-tag">${candidate.kind}</span><span>候选 · 未入库</span></div><h3>${escape(candidate.question)}</h3><div class="card-top"><div>${candidate.sources.map(s => ref(s.page, s.block)).join(' ')}</div><button class="small-link" data-candidate="${candidate.candidateId}">预览并保留 →</button></div></article>`).join('') || '<div class="notice neutral">本文候选已全部保留。仍可从选区或对话中补充学习卡。</div>'}` : `${scenarioNotice()}<p class="body-copy">文档准备完成后，再整理候选卡。已保留的卡片仍可复习与导出。</p>`;
    return `<p class="section-kicker">ACTIVE RECALL · 主动回忆</p><h3 class="guide-title">抓住关键内容，<br>再形成自己的理解。</h3>${candidateMarkup}<div class="section-heading">我的学习卡<small>已确认保存</small></div><div class="card-summary"><span>${cards.length.toString().padStart(2, '0')}</span><div><strong>${cards.length ? `${cards.filter(card => !card.mastered).length} 张待复习` : '还没有保留的学习卡'}</strong><p>确认保留后才进入自测与导出</p></div></div>${cards.length ? `<button class="primary-button full-width" data-action="review">${icon('cards')}开始自测</button><div class="section-heading">本篇已保留<small>点击答案可展开</small></div>${cards.map(card => `<article class="study-card" data-card-id="${card.id}"><div class="card-top"><span class="card-tag">${card.kind || '概念卡'}</span><div>${(card.sources || [{ page: card.page, block: card.block }]).map(s => ref(s.page, s.block)).join(' ')}</div></div><h3>${escape(card.question)}</h3>${state.revealed.has(card.id) ? `<div class="card-answer">${escape(card.answer)}</div>` : ''}<div class="card-controls"><button data-reveal="${card.id}">${state.revealed.has(card.id) ? '遮住答案' : '查看答案'}</button><button data-edit-card="${card.id}">编辑</button>${card.mastered ? '<span class="mastered">✓ 已掌握</span>' : '<span class="muted-small">待复习</span>'}</div></article>`).join('')}<button class="secondary-button full-width" data-action="export">${icon('download')}导出 Markdown 笔记</button>` : '<p class="guide-footer-note">可以保留上方候选，也可以从选区或文档对话中生成补充卡片。</p>'}<p class="guide-footer-note">每张卡都保留原文出处。掌握度由你的自测决定。</p>`;
  }
  function renderNotes() {
    const context = current().noteContext ||= { page: current().selectionPage || current().page, quote: current().selection, block: current().selectionBlock || '' };
    return `<p class="section-kicker">MARGINALIA · 阅读批注</p><h3 class="guide-title">留下思考，<br>也留下出处。</h3><p class="body-copy">选中原文后写下你的理解、疑问或待核实事项。</p>${context.quote ? `<div class="evidence"><div class="evidence-label"><span>本次批注来源 · 已锁定</span>${ref(context.page, context.block)}</div><blockquote>${escape(context.quote)}</blockquote></div>` : `<div class="notice neutral">本次笔记记录于第 ${context.page} 页。开始输入后会锁定来源，翻页不会改变它。</div>`}<div class="note-editor"><textarea id="note-input" aria-label="你的批注" placeholder="用自己的话记录理解，或留下待核实的问题…">${escape(current().noteDraft)}</textarea></div><button class="primary-button full-width" style="margin-top:10px" data-action="save-note">保存批注</button><div class="section-heading">本篇记录<small>${current().notes.length} 条</small></div>${current().notes.map(note => `<article class="note-entry"><div class="card-top"><span>我的批注 · 示例版本 1</span><div>${(note.sources || [{ page: note.page, block: note.block }]).map(s => ref(s.page, s.block)).join(' ')}</div></div>${note.quote ? `<blockquote>${escape(note.quote)}</blockquote>` : ''}<p>${escape(note.text)}</p><span class="note-time">${escape(note.date)}</span></article>`).join('')}${current().notes.length ? `<button class="secondary-button full-width" data-action="export">${icon('download')}导出阅读笔记</button>` : ''}`;
  }
  function renderPanel() {
    document.querySelectorAll('[data-panel]').forEach(button => { const active = button.dataset.panel === current().panel; button.id = `panel-tab-${button.dataset.panel}`; button.setAttribute('aria-controls', 'panel-content'); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
    $('panel-content').setAttribute('aria-labelledby', `panel-tab-${current().panel}`);
    $('card-count').textContent = state.cards.filter(card => card.document === state.document).length;
    $('panel-content').setAttribute('aria-label', { guide: '导读', ask: '文档对话', cards: '学习卡', notes: '批注' }[current().panel]);
    $('panel-content').innerHTML = ({ guide: renderGuide, ask: renderAsk, cards: renderCards, notes: renderNotes })[current().panel]();
    updateScopeHint();
  }
  function selectText(text, page = current().page, block = '') {
    current().selection = text.trim().slice(0, 3000); current().selectionPage = page; current().selectionBlock = block; current().scope = 'selection';
    if (!current().noteDraft.trim()) current().noteContext = null;
    current().draftContext = null;
    $('selection-menu').hidden = false;
    document.querySelectorAll('.selected-passage').forEach(element => element.classList.remove('selected-passage'));
    if (block) document.querySelector(`[data-block-id="${CSS.escape(block)}"]`)?.classList.add('selected-passage');
    if (current().panel === 'ask') renderPanel();
  }
  function clearSelection() {
    current().selection = ''; current().selectionPage = null; current().selectionBlock = '';
    if (current().scope === 'selection') current().scope = 'page';
    $('selection-menu').hidden = true;
    document.querySelectorAll('.selected-passage').forEach(element => element.classList.remove('selected-passage'));
    window.getSelection()?.removeAllRanges();
  }
  function selectExample() {
    navigate(state.document === 'textbook' ? 42 : 3);
    const [block, text] = pageData(current().page).paragraphs[1] || pageData(current().page).paragraphs[0];
    selectText(text, current().page, block);
    toast('已选中示例段落。可点击“解释这段”继续。');
  }
  function prepareQuestion(question) {
    current().draft = question; current().draftContext = baseContext(); openPanel('ask');
    $('question-input')?.focus({ preventScroll: true });
  }
  function composeAnswer(answer) {
    if (answer.scope === 'selection' && /解释这段/.test(answer.question)) {
      const page = answer.selectionPage || answer.page;
      const paragraph = doc().pages[page]?.paragraphs.find(([, text]) => text.includes(answer.selection));
      if (!paragraph) return { status: 'insufficient' };
      const explanations = {
        'oxygen-chain': '这段把氧的运输分成交换、运输和利用三个环节。先分别理解“在哪里交换、怎样输送、由谁利用”，再把它们连成一个过程。',
        'oxygen-use': '“耗氧量”回答的是一段时间内利用了多少氧。单一环节的供氧能力只描述链条的一部分，因此两者不能直接画等号。',
        'determinants': '这段用两个因素整理耗氧量：一个对应循环输送，一个对应组织获取。你可以先写出各自描述的过程，再回到原文检查两者的关系。',
        'population': '先核对研究对象：示例纳入的是年轻、没有规律训练经历的成年人。未纳入的人群不在这条证据的直接覆盖范围中。',
        'intervention': '这段报告了训练周期、频次和对照条件，同时明确列出强度与完成率等缺失信息。整理研究卡时，已报告项可以提取，缺失项继续标为未报告。',
        'result': '平均差描述模拟结果的大小，置信区间描述估计的不确定性。原文没有给出最小临床重要差异，所以实际意义仍需核实。',
        'limitations': '这段限定了研究对象、随访时长和外推范围。理解结论时，应把这些条件与结果放在一起看。',
        'harms': '“未报告”说明资料缺少这方面的信息，并不能证明不良事件没有发生。可以把它保存为一个待核实问题。'
      };
      return { status: 'ready', explanation: explanations[paragraph[0]] || '先找出这段的对象、核心关系和适用条件，再试着用一句话复述。下面保留选中的逐字原文，可以逐句核对自己的理解。', extra: '这是本地编排的选区讲解演示，只依据已选文字。', evidence: [{ page, block: paragraph[0], quote: answer.selection }] };
    }
    let pages;
    if (answer.scope === 'selection') pages = [answer.selectionPage || answer.page];
    else if (answer.scope === 'page') pages = [answer.page];
    else if (answer.scope === 'chapter') pages = state.document === 'textbook' ? [42, 55, 56] : [3, 5];
    else pages = state.document === 'textbook' ? [42, 55, 56, 64] : [1, 3, 5, 7];
    const q = answer.question;
    let evidence, explanation, extra = '';
    if (state.document === 'paper') {
      if (/老年|外推|适用|局限/.test(q)) { evidence = [[3, 'population'], [7, 'limitations']]; explanation = '这份虚构研究的受试者是年轻且没有规律训练经历的成年人，资料没有提供老年人群的研究结果。因此，本文不能支持“可直接用于老年人”的判断。'; extra = '需要区分“研究没有纳入某人群”与“干预对该人群无效”。前者表示缺少依据，不能推导出后者。'; }
      else if (/统计|意义|结果|效应|置信/.test(q)) { evidence = [[5, 'result']]; explanation = '在这个模拟数据中，平均差与置信区间描述结果及其不确定性。是否具有实际意义，还需要了解量表与相应判断标准。资料没有报告最小临床重要差异，所以此处应保留“待核实”。'; }
      else if (/研究|人群|训练|方案|强度/.test(q)) { evidence = [[3, 'population'], [3, 'intervention']]; explanation = '本示例采用两组平行随机设计。人群、周期与频次可以从资料中找到；训练强度、实际完成率与进阶细节未报告。这些缺失内容应留空，不能由模型补齐。'; }
      else return { status: 'unplanned' };
    } else {
      if (/条件|测量|注意/.test(q)) { evidence = [[55, 'measurement']]; explanation = '解释一个数值之前，要先核对四个条件：测的是谁、如何测试、采用什么单位、何时测量。条件不一致时，不能直接把数值放在一起比较。'; }
      else if (/心输出|动静脉|决定/.test(q)) { evidence = [[55, 'determinants']]; explanation = '这段示例把两个因素放在一起理解：心输出量对应“送出多少血液”，动静脉氧含量差对应“组织从血液中获取了多少氧”。这是帮助理解关系的解释，具体定义仍应回到教材核对。'; }
      else if (/氧|环节|解释|区别|这段/.test(q)) { evidence = [[42, /环节|运输/.test(q) ? 'oxygen-chain' : 'oxygen-use']]; explanation = '可以把这一过程理解为一条运输链：肺负责交换，循环负责输送，组织负责利用。“耗氧量”描述一段时间内利用了多少氧，因此需要结合运输与利用理解，不能只用一个环节来代替。'; extra = '试着合上解释，用自己的话回答：“测到利用量，为什么还不能单独判断哪一个环节的能力？”'; }
      else return { status: 'unplanned' };
    }
    evidence = evidence.filter(([page]) => pages.includes(page)).map(([page, block]) => ({ page, block, quote: source(page, block) }));
    if (answer.scope === 'selection') evidence = evidence.filter(e => answer.selection.includes(e.quote) || e.quote.includes(answer.selection));
    if (!evidence.length) return { status: 'insufficient' };
    // Keep the interpretation restricted to the known source range in this demo.
    if (answer.scope === 'selection' || answer.scope === 'page') { explanation = `这段原文强调：${evidence[0].quote} 可以先用自己的话复述，再核对每个术语和适用条件。`; extra = '本次只依据这个范围。需要其他章节的解释时，可主动扩大范围。'; }
    return { status: 'ready', evidence, explanation, extra };
  }
  function sendQuestion(retry = null) {
    if (state.pending) return;
    if (['scan', 'indexing', 'stale'].includes(state.scenario)) { toast('当前内容尚不可用于提问；你可以先准备问题。'); return; }
    const session = current(), question = (retry?.question || session.draft).trim();
    if (!question) { toast('先写下一个问题。'); $('question-input')?.focus(); return; }
    const context = session.draftContext || baseContext();
    const answer = retry || { id: `a${Date.now()}`, question, ...context, scopeLabel: scopeName(context.scope, context.page, context.selectionPage), status: 'loading' };
    answer.status = 'loading';
    if (!retry) session.answers.push(answer);
    if (!retry) { session.draft = ''; session.draftContext = null; }
    const documentId = state.document;
    const failure = state.scenario;
    state.pending = { documentId, answer, timer: null };
    renderPanel();
    $('question-input')?.focus({ preventScroll: true });
    $('chat-thread')?.scrollTo({ top: 100000, behavior: 'smooth' });
    state.pending.timer = setTimeout(() => {
      if (!state.pending || state.pending.answer !== answer) return;
      Object.assign(answer, failure === 'error' ? { status: 'error' } : failure === 'insufficient' ? { status: 'insufficient' } : composeAnswer(answer));
      state.pending = null;
      if (state.document === documentId && current().panel === 'ask') {
        const input = $('question-input');
        const restoreInput = ['question-input', 'send-question', 'cancel-request'].includes(document.activeElement?.id);
        const selection = [input?.selectionStart, input?.selectionEnd];
        renderPanel(); $('chat-thread')?.scrollTo({ top: 100000, behavior: 'smooth' });
        if (restoreInput) { $('question-input')?.focus({ preventScroll: true }); if (selection[0] != null) $('question-input').setSelectionRange(...selection); }
      }
    }, 850);
  }
  function cancelRequest() { if (!state.pending) return; clearTimeout(state.pending.timer); state.pending.answer.status = 'cancelled'; state.pending = null; renderPanel(); }
  function previewCard(candidate) {
    state.cardDraft = { ...candidate, document: state.document };
    const sources = candidate.sources || [{ page: candidate.page, block: candidate.block, quote: candidate.quote }];
    showModal(`<p class="section-kicker">LEARNING CARD · 草稿</p><h2>先核对，再加入学习卡。</h2><p>${candidate.candidateId ? '已根据本文整理为候选卡。' : '已根据你选定的内容起草。'}确认后才会保存到卡库，当前为预设演示。</p><label for="card-draft-question">问题</label><textarea id="card-draft-question" maxlength="300" aria-label="学习卡草稿问题">${escape(candidate.question)}</textarea><label for="card-draft-answer">答案 / 我的理解</label><textarea id="card-draft-answer" maxlength="3000" aria-label="学习卡草稿答案">${escape(candidate.answer)}</textarea><p>来源：${escape(doc().title)} · ${sources.map(s => `第 ${s.page} 页`).join('、')}。原文与页码一并保留。</p><div class="review-actions"><button type="button" class="secondary-button" data-action="close-modal">取消</button><button type="button" class="primary-button" data-action="save-card-draft">确认保存</button></div>`);
  }
  function saveCard({ question, answer, page, block = '', quote = '', kind = '概念卡', sources = null, candidateId = '' }) {
    const exists = state.cards.some(card => card.document === state.document && ((candidateId && card.candidateId === candidateId) || (card.question === question && card.quote === quote)));
    if (exists) { toast('这张学习卡已在列表中，无需重复保存。'); return; }
    state.cards.push({ id: `c${Date.now()}`, document: state.document, question, answer, page, block, quote, sources: sources || [{ page, block, quote }], candidateId, kind, mastered: false, version: '示例版本 1' });
    const saved = persist(); renderPanel(); if (saved) toast('已保存到学习卡，原文与页码一并保留。');
  }
  function exportNotes() {
    const cards = state.cards.filter(card => card.document === state.document), notes = current().notes;
    const sourceLines = item => (item.sources || [{ page: item.page, quote: item.quote }]).flatMap(s => [`来源：${doc().title}，第 ${s.page} 页；示例版本 1。`, '', s.quote ? `> ${s.quote}` : '', '']);
    const text = [`# ${doc().short} · 研读笔记`, '', '> 观译 PDF 智能研读交互原型 v0.3。资料、数值、研究和回答全部为演示，不作医学或训练依据。', '> 来源：虚构演示资料 · 示例版本 1。', '', '## 学习卡', '', ...cards.flatMap(card => [`### ${card.question}`, '', card.answer, '', ...sourceLines(card), `复习状态：${card.mastered ? '已掌握' : '待复习'}`, '']), '## 我的批注', '', ...notes.flatMap(note => [`### 第 ${note.page} 页`, '', note.text, '', ...sourceLines(note), `记录：${note.date} · 示例版本 1`, ''])].join('\n');
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' }), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `${doc().short}-研读笔记-演示.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已导出 Markdown，包含来源、原文和复习状态。');
    return text;
  }
  function showModal(html) { $('modal-content').innerHTML = html; $('modal').showModal(); }
  function reviewCards(index = 0, revealed = false) {
    const cards = state.cards.filter(card => card.document === state.document);
    if (index >= cards.length) { showModal(`<p class="section-kicker">SESSION COMPLETE</p><h2>这一轮，学得怎么样？</h2><p>已复习 ${cards.length} 张卡。未掌握的内容仍在待复习列表中，随时回到原文核对。</p><button class="primary-button full-width" data-action="close-modal">完成复习</button>`); return; }
    const card = cards[index];
    $('modal-content').innerHTML = `<p class="section-kicker">ACTIVE RECALL</p><h2>先回忆，再看答案。</h2><span class="review-progress">${index + 1} / ${cards.length} 张 · 第 ${card.page} 页</span><div class="review-card"><span class="card-tag">${card.kind}</span><h3>${escape(card.question)}</h3>${revealed ? `<div class="review-answer">${escape(card.answer)}</div>` : '<p>试着用自己的话说出来。</p>'}</div>${revealed ? `<div class="review-actions"><button class="secondary-button" data-grade="again" data-index="${index}">还需复习</button><button class="primary-button" data-grade="known" data-index="${index}">已经理解 ${icon('check')}</button></div>` : `<button class="primary-button full-width" data-review-reveal="${index}">查看答案</button>`}`;
    if (!$('modal').open) $('modal').showModal();
  }
  function changeDocument(id) {
    if (!documents[id] || id === state.document) return;
    if (state.pending) cancelRequest();
    current().scroll = $('paper-scroll').scrollTop;
    state.document = id;
    state.scenario = 'ready'; $('scenario-select').value = 'ready';
    $('selection-menu').hidden = true;
    document.querySelectorAll('[data-document]').forEach(button => button.classList.toggle('active', button.dataset.document === id));
    $('learning-goal').textContent = stored.goals?.[id] || doc().goal;
    $('outline-label').textContent = id === 'textbook' ? '章节目录' : '论文结构';
    renderPaper(); renderPanel(); renderReadState(); $('paper-scroll').scrollTop = current().scroll; persist();
  }
  function renderReadState() { $('read-state').innerHTML = `<span></span>${({ scan: '无文字层', indexing: '正在构建索引', stale: '来源版本待核对' })[state.scenario] || '文字层可用'}`; }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.document) changeDocument(button.dataset.document);
    if (button.dataset.panel) openPanel(button.dataset.panel);
    if (button.dataset.page) navigate(button.dataset.page, button.dataset.block || '', !button.closest('#outline'), button);
    if (button.dataset.question) prepareQuestion(button.dataset.question);
    if (button.dataset.candidate) { const candidate = documentCandidates().find(item => item.candidateId === button.dataset.candidate); if (candidate) previewCard(candidate); }
    if (button.dataset.reveal) { state.revealed.has(button.dataset.reveal) ? state.revealed.delete(button.dataset.reveal) : state.revealed.add(button.dataset.reveal); renderPanel(); }
    if (button.dataset.retry) { const answer = current().answers.find(a => a.id === button.dataset.retry); state.scenario = 'ready'; $('scenario-select').value = 'ready'; sendQuestion(answer); }
    if (button.dataset.saveAnswer) { const answer = current().answers.find(a => a.id === button.dataset.saveAnswer); const evidence = answer.evidence[0]; previewCard({ question: answer.question, answer: answer.explanation, page: evidence.page, block: evidence.block, quote: evidence.quote, sources: answer.evidence }); }
    if (button.dataset.noteAnswer) { const answer = current().answers.find(a => a.id === button.dataset.noteAnswer); const evidence = answer.evidence[0]; current().notes.push({ text: `[AI 解释 · 预设演示] ${answer.explanation}`, quote: evidence.quote, page: evidence.page, block: evidence.block, sources: answer.evidence, date: new Date().toLocaleDateString('zh-CN') }); if (persist()) toast('已记入本篇批注，解释与原文分开保存。'); }
    if (button.dataset.editCard) { const card = state.cards.find(c => c.id === button.dataset.editCard); showModal(`<p class="section-kicker">MY UNDERSTANDING</p><h2>写成自己的理解</h2><label for="card-question">问题</label><textarea id="card-question" maxlength="300">${escape(card.question)}</textarea><label for="card-answer">答案 / 我的理解</label><textarea id="card-answer" maxlength="3000">${escape(card.answer)}</textarea><p>原文和来源页码会保留。</p><button type="button" class="primary-button full-width" data-action="update-card" data-card="${card.id}">保存修改</button>`); }
    if (button.dataset.reviewReveal) reviewCards(Number(button.dataset.reviewReveal), true);
    if (button.dataset.grade) { const cards = state.cards.filter(card => card.document === state.document); const index = Number(button.dataset.index); cards[index].mastered = button.dataset.grade === 'known'; persist(); renderPanel(); reviewCards(index + 1); }
    if (button.dataset.selectionAction) {
      const action = button.dataset.selectionAction;
      if (action === 'clear') { clearSelection(); if (current().panel === 'ask') renderPanel(); }
      if (action === 'explain') { current().draft = '请解释这段原文'; openPanel('ask'); $('selection-menu').hidden = true; sendQuestion(); }
      if (action === 'save') { previewCard({ question: '如何用自己的话解释这段内容？', answer: current().selection, page: current().selectionPage, block: current().selectionBlock, quote: current().selection, kind: '原文卡', afterPanel: 'cards' }); $('selection-menu').hidden = true; }
      if (action === 'annotate') { openPanel('notes'); $('selection-menu').hidden = true; $('note-input')?.focus(); }
    }
    switch (button.dataset.action) {
      case 'select-example': selectExample(); break;
      case 'expand-scope': { const answer = current().answers.find(a => a.id === button.closest('[data-answer-id]')?.dataset.answerId); current().scope = 'document'; if (!current().draft.trim()) current().draft = answer?.question || ''; current().draftContext = baseContext(); renderPanel(); $('question-input')?.focus(); toast('已扩大到本文范围，请确认问题后重新发送。'); break; }
      case 'recover': state.scenario = 'ready'; $('scenario-select').value = 'ready'; renderReadState(); renderPanel(); toast('已切回可研读的示例版本。'); break;
      case 'review': reviewCards(); break;
      case 'export': exportNotes(); break;
      case 'close-modal': state.cardDraft = null; $('modal').close(); break;
      case 'save-card-draft': {
        const draft = state.cardDraft, question = $('card-draft-question')?.value.trim(), answer = $('card-draft-answer')?.value.trim();
        if (!draft || draft.document !== state.document) { toast('来源文档已变化，请重新生成草稿。'); break; }
        if (!question || !answer) { toast('请保留问题和答案，再确认保存。'); break; }
        saveCard({ ...draft, question, answer });
        state.cardDraft = null; $('modal').close(); if (draft.afterPanel) openPanel(draft.afterPanel); break;
      }
      case 'save-note': {
        const text = $('note-input').value.trim(); if (!text) { $('note-input').focus(); toast('写下想保留的理解或问题。'); break; }
        const context = current().noteContext || { quote: current().selection, page: current().selectionPage || current().page, block: current().selectionBlock || '' };
        current().notes.push({ text, ...context, date: new Date().toLocaleDateString('zh-CN') }); const saved = persist(); current().noteDraft = ''; current().noteContext = null; clearSelection(); renderPanel(); if (saved) toast('批注已保存在当前浏览器。'); break;
      }
      case 'update-card': { const card = state.cards.find(c => c.id === button.dataset.card); const question = $('card-question').value.trim(), answer = $('card-answer').value.trim(); if (!question || !answer) { toast('请保留问题和答案。'); break; } Object.assign(card, { question, answer, kind: '我的理解' }); if (persist()) toast('已保存你的理解，原文来源保持关联。'); $('modal').close(); renderPanel(); break; }
      case 'save-goal': { const value = $('goal-input').value.trim(); if (value) { stored.goals ||= {}; stored.goals[state.document] = value; $('learning-goal').textContent = value; persist(); $('modal').close(); } break; }
      case 'confirm-reset': { localStorage.removeItem(storageKey); location.reload(); break; }
    }
    if (button.id === 'send-question') sendQuestion();
    if (button.id === 'cancel-request') cancelRequest();
  });
  $('pdf-page').addEventListener('click', (event) => { const target = event.target.closest('[data-block-id]'); if (!target || window.getSelection()?.toString()) return; if (state.scenario === 'scan') { toast('扫描件需先识别文字；此状态仅演示阅读。'); return; } selectText(target.textContent, current().page, target.dataset.blockId); });
  $('pdf-page').addEventListener('mouseup', () => { const selection = window.getSelection(); if (selection?.toString().trim() && $('pdf-page').contains(selection.anchorNode) && state.scenario !== 'scan') selectText(selection.toString()); });
  $('pdf-page').addEventListener('keydown', (event) => { const target = event.target.closest('[data-block-id]'); if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); if (state.scenario !== 'scan') selectText(target.textContent, current().page, target.dataset.blockId); } });
  document.addEventListener('input', event => { if (event.target.id === 'question-input') { if (!current().draftContext && event.target.value.trim()) current().draftContext = baseContext(); current().draft = event.target.value; if (!current().draft.trim()) current().draftContext = null; updateScopeHint(); } if (event.target.id === 'note-input') current().noteDraft = event.target.value; });
  document.addEventListener('change', event => { if (event.target.id === 'scope-select') { current().scope = event.target.value; current().draftContext = current().draft.trim() ? baseContext() : null; renderPanel(); $('scope-select').focus(); } });
  document.addEventListener('keydown', (event) => {
    if (event.target.id === 'question-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendQuestion(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && current().selection && !event.isComposing && !event.target.closest('input,textarea,select')) { event.preventDefault(); current().draft = '请解释这段原文'; openPanel('ask'); $('selection-menu').hidden = true; sendQuestion(); return; }
    if (event.key === 'Escape' && !$('modal').open) { clearSelection(); }
    const editing = event.target.closest('input,textarea,select,button,[contenteditable]') || $('modal').open;
    if (!editing && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); navigate(current().page + (event.key === 'ArrowRight' ? 1 : -1)); }
    if (event.target.matches('[data-panel]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const tabs = [...document.querySelectorAll('[data-panel]')]; const index = tabs.indexOf(event.target); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; openPanel(tabs[next].dataset.panel); tabs[next].focus();
    }
  });
  $('page-input').addEventListener('change', () => navigate($('page-input').value));
  $('previous-page').addEventListener('click', () => navigate(current().page - 1));
  $('next-page').addEventListener('click', () => navigate(current().page + 1));
  $('return-button').addEventListener('click', returnToReading);
  $('zoom-select').addEventListener('change', () => { state.zoom = $('zoom-select').value; renderPaper(); });
  function toggleStudy(force) { const hidden = force === undefined ? !$('study-panel').classList.contains('is-hidden') : !force; $('study-panel').classList.toggle('is-hidden', hidden); $('study-toggle').setAttribute('aria-expanded', String(!hidden)); if (hidden) $('study-toggle').focus({ preventScroll: true }); }
  $('study-toggle').addEventListener('click', () => toggleStudy());
  $('study-close').addEventListener('click', () => toggleStudy(false));
  $('library-toggle').addEventListener('click', () => { if (innerWidth <= 1000) $('library').classList.toggle('is-open'); else $('library').classList.toggle('is-hidden'); });
  $('theme-button').addEventListener('click', () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = state.theme; persist(); });
  $('scenario-select').addEventListener('change', () => { if (state.pending) cancelRequest(); state.scenario = $('scenario-select').value; clearSelection(); renderReadState(); openPanel(['error', 'insufficient'].includes(state.scenario) ? 'ask' : current().panel); });
  $('help-button').addEventListener('click', () => showModal('<p class="section-kicker">GUANYI / PROTOTYPE v0.3</p><h2>把阅读，变成理解。</h2><p>当前两份文档采用运动健康演示资料；问答与候选卡为本地预设，不接入模型。</p><ol><li>点击或拖选一段原文，“解释这段”会进入同一文档对话。</li><li>点击回答的页码核对来源，再“返回阅读位置”。</li><li>打开“学习卡”，查看根据本文整理的概念、核心思路与方法候选。</li><li>预览候选、编辑并确认，才会加入“我的学习卡”与复习。也可从原文或对话补充卡片。</li><li>底部“预览状态”可查看失败、扫描件、索引与版本变化。</li></ol><button class="primary-button full-width" data-action="close-modal">开始体验 '+icon('arrow')+'</button>'));
  $('goal-button').addEventListener('click', () => showModal(`<p class="section-kicker">LEARNING GOAL</p><h2>这次，想学会什么？</h2><p>用一句话写下一个可以检查的目标。</p><textarea id="goal-input" aria-label="本次学习目标" maxlength="150">${escape(stored.goals?.[state.document] || doc().goal)}</textarea><button type="button" class="primary-button full-width" data-action="save-goal">保存学习目标</button>`));
  $('reset-button').addEventListener('click', () => showModal('<p class="section-kicker">RESET DEMO</p><h2>重新体验原型</h2><p>会清除本原型保存的演示学习卡、批注、主题和位置。观译正式应用的数据不受影响。</p><button type="button" class="primary-button full-width" data-action="confirm-reset">清除演示并重新开始</button>'));
  // Prevent dialog action buttons from submitting the surrounding close form.
  $('modal').addEventListener('click', event => { if (event.target.closest('[data-action],[data-review-reveal],[data-grade]')) event.preventDefault(); });
  // Clear at the synchronous user action; a queued close event can belong to
  // the previous dialog when a new draft has already been opened.
  $('modal').addEventListener('cancel', () => { state.cardDraft = null; });
  $('modal').addEventListener('submit', () => { state.cardDraft = null; });
  document.documentElement.dataset.theme = state.theme;
  document.querySelectorAll('[data-document]').forEach(button => button.classList.toggle('active', button.dataset.document === state.document));
  $('learning-goal').textContent = stored.goals?.[state.document] || doc().goal;
  renderPaper(); renderPanel(); renderReadState();
  // Read-only inspection for the hidden prototype acceptance runner.
  window.__PDF_STUDY_PROTOTYPE__ = { getState: () => JSON.parse(JSON.stringify({ document: state.document, page: current().page, panel: current().panel, scenario: state.scenario, cards: state.cards, notes: current().notes, answers: current().answers, scope: current().scope, pending: Boolean(state.pending) })), exportMarkdown: exportNotes };
})();
