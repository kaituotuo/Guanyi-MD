/* Evidence-bound PDF study workspace. Original PDF bytes remain owned by the reader. */
(function () {
  'use strict';

  const VERSION = 2;
  const STUDY_PANEL_MIN_WIDTH = 360;
  const STUDY_PANEL_WIDTH_KEY = 'guanyi-pdf-study-panel-width-v1';
  let preferredStudyPanelWidth;
  const BASIS_LABELS = { source:'原文事实', author:'作者观点', explanation:'辅助解释' };
  const normalizeBasis = value => ['source','author','explanation'].includes(value) ? value : 'explanation';
  const clone = value => JSON.parse(JSON.stringify(value));
  const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
  const fullText = value => String(value ?? '').replace(/\u0000/g, '').trim();
  const errorText = value => window.GuanyiModelErrors?.message(value) || clean(value?.message || value, 500);
  const number = (value, fallback = 1) => Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : fallback;
  const uid = () => globalThis.crypto?.randomUUID?.() || `study-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fingerprint = value => { let hash = 2166136261; for (const c of String(value)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619); return (hash >>> 0).toString(36); };
  const normalizedText = value => fullText(value).normalize('NFKC').replace(/\s+/g, '');
  const validRange = (start,end,total) => Number.isInteger(start) && Number.isInteger(end) && start >= 1 && start <= end && end <= total;
  const MODEL_PROTOCOL_LABELS = { chat:'Chat Completions', responses:'Responses', anthropic:'Anthropic Messages', unknown:'未识别' };
  const INSUFFICIENT_ANSWER = window.GuanyiPaperReader?.INSUFFICIENT_ANSWER || '当前范围内没有足够原文支持这个问题。可以扩大页段或换一种问法后重试。';
  const QUICK_FIELDS = { question:'研究问题', method:'对象与方法', finding:'主要发现', boundary:'适用边界' };
  const QUICK_PLACEHOLDER = /^(?:无|暂无|缺项|不适用|N\/A|(?:(?:原文)?摘要(?:中|里)?\s*)?(?:未|没有)(?:明确)?(?:交代|说明|提及|提供|报告)(?:相关(?:信息|内容))?)[。.!！\s]*$/iu;
  const QUICK_MISSING_METADATA = /^摘要(?:中|里)?(?:未|没有)(?:明确)?(?:交代|说明|提及|提供|报告)(?:研究对象|样本[数量]|受试者人数|受试者年龄|年龄|(?:足型)?纳入标准|测试设备|统计方法)[。.!！\s]*$/u;
  const QUICK_MISSING_LIST = /(^|[。！？；;，,\n])[^。！？；;，,\n]*、[^。！？；;，,\n]*均(?:为缺项|未(?:交代|说明|提及|提供|报告))(?=[。！？；;，,\n]|$)/gu;

  function studyFailureSnapshot(value) {
    const stage = value?.stage;
    const hasBatch = validRange(stage?.batch, stage?.batch, stage?.totalBatches) && Number.isInteger(stage?.totalBatches);
    const batch = hasBatch ? { batch:stage.batch, totalBatches:stage.totalBatches } : null;
    let safeStage;
    if (stage?.phase === 'reading' && batch) safeStage = { phase:'reading', ...batch };
    if (stage?.phase === 'synthesizing' && Number.isSafeInteger(stage.level) && stage.level > 0) {
      safeStage = { phase:'synthesizing', level:stage.level, ...batch };
      if (batch && typeof stage.final === 'boolean') safeStage.final = stage.final;
    }
    const model = window.GuanyiModelErrors?.diagnostic?.(value?.model);
    if (!safeStage && !model) return null;
    return { ...(safeStage ? { stage:safeStage } : {}), ...(model ? { model } : {}) };
  }

  function guideFailureTitle(stage) {
    if (stage?.phase === 'reading') return `第 ${stage.batch} / ${stage.totalBatches} 批研读失败`;
    if (stage?.phase === 'synthesizing') {
      if (stage.final) return '全文最终综合失败';
      if (stage.batch) return `全文综合第 ${stage.level} 层、第 ${stage.batch} / ${stage.totalBatches} 批失败`;
      return `全文综合第 ${stage.level} 层失败`;
    }
    return '本次研读失败';
  }

  function sourceSnapshot(value) {
    if (!value || !Number.isInteger(Number(value.page)) || Number(value.page)<1 || !clean(value.sourceHash, 160)) return null;
    const visual = value.kind === 'page-image';
    const rects = !visual && Array.isArray(value.rects) ? value.rects.filter(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)).map(rect => [...rect]) : [];
    return { id:fullText(value.id) || `page-${number(value.page)}`, page:number(value.page), pageLabel:clean(value.pageLabel ?? value.label ?? value.page, 80), text:visual ? '' : fullText(value.text ?? value.quote), rects,
      itemStart:Number.isFinite(value.itemStart) ? value.itemStart : null, itemEnd:Number.isFinite(value.itemEnd) ? value.itemEnd : null,
      sourceHash:clean(value.sourceHash, 160), blockIds:Array.isArray(value.blockIds) ? value.blockIds.map(fullText) : [], precise:!visual && value.precise !== false && rects.length > 0,
      ...(visual ? { kind:'page-image', width:Number.isFinite(value.width) ? value.width : null, height:Number.isFinite(value.height) ? value.height : null } : {}),
      extractionStatus:clean(value.extractionStatus,80), extractionWarning:fullText(value.extractionWarning || value.warning) };
  }
  function sourcesSnapshot(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map(sourceSnapshot).filter(source => source && !seen.has(`${source.sourceHash}:${source.id}`) && seen.add(`${source.sourceHash}:${source.id}`));
  }
  function normalizeReading(value) {
    if (!value || typeof value !== 'object') return null;
    const item = value => ({ ...value, sources:sourcesSnapshot(value?.sources) });
    const { wrapUp, ...reading } = value;
    const conclusionBody = fullText(wrapUp?.body);
    const limits = fullText(wrapUp?.limits);
    return { ...reading, title:fullText(value.title), documentType:fullText(value.documentType), sources:sourcesSnapshot(value.sources),
      summary:{ ...item(value.summary || {}), body:fullText(value.summary?.body) },
      sections:(Array.isArray(value.sections) ? value.sections : []).filter(Boolean).map(section => {
        const { readingCue, originalHeading, ...fields } = item(section);
        const cue = fullText(readingCue);
        const heading = fullText(originalHeading);
        return { ...fields, title:fullText(section.title), body:fullText(section.body), basis:normalizeBasis(section.basis),
          ...(cue ? { readingCue:cue } : {}), ...(heading ? { originalHeading:heading } : {}) };
      }),
      ...(conclusionBody ? { wrapUp:{ body:conclusionBody, basis:normalizeBasis(wrapUp.basis), sources:sourcesSnapshot(wrapUp.sources), ...(limits ? { limits } : {}) } } : {}),
      terms:(Array.isArray(value.terms) ? value.terms : []).filter(Boolean).map(value => ({ ...item(value), term:fullText(value.term), explanation:fullText(value.explanation) })),
      quotes:(Array.isArray(value.quotes) ? value.quotes : []).filter(Boolean).map(value => ({ ...item(value), quote:fullText(value.quote), translation:fullText(value.translation) })),
      related:(Array.isArray(value.related) ? value.related : []).filter(Boolean).map(value => ({ ...item(value), title:fullText(value.title), body:fullText(value.body) })) };
  }
  function readingConclusion(reading) {
    if (reading.wrapUp?.body) return [reading.wrapUp];
    return (reading.sections || []).filter(item => item.body && /^(conclusions?|limitations?)$/i.test(item.kind || ''));
  }
  function completeReading(reading) {
    const hasBodyAndSources = item => !!(item?.body && item.sources?.length);
    return hasBodyAndSources(reading?.summary) && !!reading.sections?.length
      && reading.sections.every(section => section.title && hasBodyAndSources(section))
      && hasBodyAndSources(reading.wrapUp);
  }
  function normalizeAnswer(item) {
    if (!item.insufficient) return { ...item, sources:sourcesSnapshot(item.sources) };
    const result = { ...item, answer:INSUFFICIENT_ANSWER, sources:[] };
    delete result.card;
    return result;
  }
  function quickFieldText(value, limit) {
    if (typeof value !== 'string') return '';
    // Earlier quick readings could append a list of missing items to an otherwise useful detail.
    const detail = clean(value.replace(QUICK_MISSING_LIST, '').replace(/^[。！？；;，,\s]+/u, ''), limit);
    return QUICK_PLACEHOLDER.test(detail) || QUICK_MISSING_METADATA.test(detail) ? '' : detail;
  }
  function normalizeQuickReading(value) {
    if (!value || typeof value !== 'object') return null;
    const sourceHash = clean(value.sourceHash, 160);
    const sources = sourcesSnapshot(value.sources).filter(source => source.sourceHash === sourceHash && source.page <= 2 && source.text);
    const takeaway = quickFieldText(value.takeaway, 600);
    const fields = Object.fromEntries(Object.keys(QUICK_FIELDS)
      .map(key => [key, quickFieldText(value[key], 1000)]).filter(([, detail]) => detail));
    if (!takeaway || !fields.finding || !sources.length) return null;
    const pages = [...new Set([...(Array.isArray(value.pages) ? value.pages : []), ...sources.map(source => source.page)])]
      .filter(page => Number.isInteger(page) && page >= 1 && page <= 2).sort((a,b) => a-b);
    return { sourceHash, sources, pages, takeaway, ...fields, purpose:clean(value.purpose, 200) };
  }
  function previewSources(values) {
    const groups=[];
    for(const source of sourcesSnapshot(values)) {
      const last=groups.at(-1);const previousRect=last?.rects.at(-1);const nextRect=source.rects[0];
      const height=previousRect?Math.max(1,previousRect[3]-previousRect[1]):0;
      const previousLine=previousRect?last.rects.filter(rect=>Math.abs(rect[1]-previousRect[1])<=height*.5):[];
      const nextLine=nextRect?source.rects.filter(rect=>Math.abs(rect[1]-nextRect[1])<=height*.5):[];
      const lineStep=previousRect&&nextRect?previousRect[1]-nextRect[1]:0;
      // A page-wide column warning does not make two verified, adjacent lines
      // in the same column unrelated. Keep their exact text and line breaks.
      const adjacent=last && last.kind!=='page-image' && source.kind!=='page-image' && last.page===source.page && last.sourceHash===source.sourceHash
        && Number.isInteger(last.itemEnd) && Number.isInteger(source.itemStart) && source.itemStart>=last.itemEnd && source.itemStart-last.itemEnd<=1
        && previousLine.length && nextLine.length && Math.abs(Math.min(...previousLine.map(rect=>rect[0]))-Math.min(...nextLine.map(rect=>rect[0])))<=height*2
        && lineStep>=height*.5 && lineStep<=height*3;
      if(adjacent){last.text+=`\n${source.text}`;last.itemEnd=source.itemEnd;last.rects.push(...source.rects);last.blockIds.push(...(source.blockIds.length?source.blockIds:[source.id]));}
      else groups.push({...source,rects:source.rects.map(rect=>[...rect]),blockIds:source.blockIds.length?[...source.blockIds]:[source.id]});
    }
    return groups;
  }
  function normalizeRecord(value, info = {}) {
    const input = value && typeof value === 'object' ? clone(value) : {};
    const result = { version:VERSION, currentHash:clean(info.sourceHash || input.currentHash, 160), tab:['guide','ask','cards','notes'].includes(input.tab) ? input.tab : 'guide',
      draft:clean(input.draft, 4000), noteDraft:clean(input.noteDraft, 8000), noteEditor:input.noteEditor === true || !!clean(input.noteDraft,8000), noteEditingId:clean(input.noteEditingId,240) || null, scope:input.scope || null, noteContext:input.noteContext || null,
      quickPurpose:clean(input.quickPurpose, 200), quickReading:normalizeQuickReading(input.quickReading),
      preparations:Array.isArray(input.preparations) ? input.preparations.filter(item=>item && typeof item==='object') : [], messages:Array.isArray(input.messages) ? input.messages.slice(-100) : [],
      cards:Array.isArray(input.cards) ? input.cards.slice(-500) : [], notes:Array.isArray(input.notes) ? input.notes.slice(-1000) : [], supplemental:Array.isArray(input.supplemental) ? input.supplemental.slice(-100) : [] };
    for (const item of [...result.preparations, ...result.messages]) if (['pending','preparing','generating'].includes(item.status)) { item.status = 'interrupted'; item.error = '上次任务已中断，可以重试。'; }
    for (const collection of ['cards','notes','supplemental']) result[collection] = result[collection].filter(item => item && typeof item === 'object').map(item => ({ ...item, sources:sourcesSnapshot(item.sources), ...(collection === 'cards' ? { reviews:Array.isArray(item.reviews) ? item.reviews.slice(-500) : [] } : {}) }));
    result.messages = result.messages.filter(item => item && typeof item === 'object').map(normalizeAnswer);
    for (const prep of result.preparations) {
      const failure = prep.status === 'error' && studyFailureSnapshot(prep.failure);
      if (failure) prep.failure = failure;
      else delete prep.failure;
      prep.reading = normalizeReading(prep.reading);
      prep.sources = sourcesSnapshot(prep.sources);
      prep.guide = (Array.isArray(prep.guide) ? prep.guide : []).map(item => ({ ...item, sources:sourcesSnapshot(item.sources) }));
      prep.questions = (Array.isArray(prep.questions) ? prep.questions : []).map(item => ({ ...item, sources:sourcesSnapshot(item.sources) }));
      prep.candidates = (Array.isArray(prep.candidates) ? prep.candidates : []).map(item => ({ ...item, sources:sourcesSnapshot(item.sources) }));
    }
    return result;
  }
  function createStore(initial, persist, readUi = () => ({})) {
    let state = clone(initial);
    let queue = Promise.resolve();
    return {
      get state() { return state; },
      transact(change) {
        const job = queue.catch(() => {}).then(async () => {
          const next = { ...clone(state), ...clone(readUi()) };
          if (change) change(next);
          await persist(clone(next));
          state = next;
          return state;
        });
        queue = job;
        return job;
      },
      pending() { return queue; }
    };
  }
  function parseObject(text) {
    let source = clean(text, 200000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const first = source.indexOf('{'); const last = source.lastIndexOf('}');
    if (first < 0 || last < first) throw new Error('模型没有返回可校验的结构化结果，请重试。');
    let value;
    try { value = JSON.parse(source.slice(first, last + 1)); } catch (_) { throw new Error('模型返回的结构化结果不完整，已有输入和结果仍保留，请重试。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型结果格式不可用，请重试。');
    return value;
  }
  // Kept for legacy result parsing; all native text remains available without a budget or sample.
  function evidencePack(blocks) {
    const valid = sourcesSnapshot(blocks).filter(source => source.text);
    const map = new Map(valid.map((source,index) => [`E${index+1}`, source]));
    return { map, evidence:[...map].map(([id, source]) => ({ id, text:source.text })), total:valid.length, selected:valid.length, sampled:false };
  }
  function resolveEvidence(ids, pack, required = true) {
    if (!Array.isArray(ids)) { if (required) throw new Error('模型结果缺少原文依据，未采纳这次结果。'); return []; }
    const keys = [...new Set(ids.map(id => clean(id, 40)))];
    if (keys.some(id => !pack.map.has(id))) throw new Error('模型返回了未知来源编号，结果已拦截，请重试。');
    if (required && !keys.length) throw new Error('模型结果缺少原文依据，未采纳这次结果。');
    return keys.map(id => clone(pack.map.get(id)));
  }
  function parsePreparation(text, pack, key, sourceHash) {
    const data = parseObject(text);
    const guide = (Array.isArray(data.guide) ? data.guide : []).slice(0, 8).map(item => ({ title:clean(item.title, 120), body:clean(item.body, 5000), sources:resolveEvidence(item.evidenceIds, pack) })).filter(item => item.title && item.body);
    const questions = (Array.isArray(data.questions) ? data.questions : []).slice(0, 6).map(item => ({ question:clean(item.question, 500), sources:resolveEvidence(item.evidenceIds, pack) })).filter(item => item.question);
    const candidates = (Array.isArray(data.cards) ? data.cards : []).slice(0, 6).map((item,index) => ({ id:`${key}-candidate-${index}`, key:`${sourceHash}:${key}:${fingerprint(`${clean(item.question)}:${(item.evidenceIds || []).join(',')}`)}`, question:clean(item.question, 1000), answer:clean(item.answer, 6000), type:clean(item.type, 60) || '核心知识', sources:resolveEvidence(item.evidenceIds, pack), sourceHash, ai:true })).filter(item => item.question && item.answer);
    if (!guide.length) throw new Error('当前原文不足以生成带来源的导读，请改小页段或换一段文字。');
    return { guide, questions, candidates };
  }
  function parseAnswer(text, pack) {
    const data = parseObject(text);
    if (data.insufficient === true) {
      resolveEvidence(data.evidenceIds || [], pack, false);
      return normalizeAnswer({ insufficient:true });
    }
    const answer = clean(data.answer, 12000);
    if (!answer) throw new Error('模型没有返回回答，请重试。');
    return { answer, sources:resolveEvidence(data.evidenceIds, pack), insufficient:false };
  }
  function addCard(record, candidate, edits) {
    const key = candidate.key || `${candidate.sourceHash}:${fingerprint(`${candidate.question}:${candidate.sources.map(source => source.id).join(',')}`)}`;
    const existing = record.cards.find(card => card.candidateKey === key);
    if (existing) return existing;
    const card = { id:`card-${fingerprint(key)}`, candidateKey:key, sourceHash:candidate.sourceHash, question:clean(edits.question, 1000), answer:clean(edits.answer, 8000), type:clean(candidate.type, 60), sources:sourcesSnapshot(candidate.sources), ai:candidate.ai !== false, createdAt:Date.now(), reviews:[] };
    if (!card.question || !card.answer || !card.sources.length) throw new Error('请补全问题、答案与原文来源。');
    record.cards.push(card);
    return card;
  }
  function exportMarkdown(record, title) {
    const literal=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\[/g,'\\[').replace(/\]/g,'\\]').replace(/!/g,'\\!');
    const lines = [`# ${literal(clean(title, 200))} · 研读笔记`, '', '> AI 辅助内容需要结合原文核验。文件页码可能与印刷页码不同。', ''];
    const evidence = sources => (sources || []).flatMap(source => [source.kind==='page-image' ? '> 页面图像，图表依据（请回到 PDF 原页核对）' : `> ${literal(source.text).replace(/\n/g, '\n> ') || '（页面记录，无原文摘录）'}`, '', `来源：文件第 ${source.page} 页${source.pageLabel && source.pageLabel !== String(source.page) ? `（页标签 ${literal(source.pageLabel)}）` : ''}；来源版本 ${source.sourceHash}`, '']);
    const quick = normalizeQuickReading(record.quickReading);
    if (quick) {
      lines.push('## 摘要快读（AI · 基于原文摘要）', '', literal(quick.takeaway), '');
      if (quick.purpose) lines.push(`阅读目的：${literal(quick.purpose)}`, '');
      for (const [key,label] of Object.entries(QUICK_FIELDS)) {
        if (quick[key]) lines.push(`**${label}** ${literal(quick[key])}`, '');
      }
      lines.push(...evidence(quick.sources));
    }
    const preparations = (record.preparations || []).filter(item => item.status === 'ready');
    if (preparations.length) {
      lines.push('## 全文研读（AI）', '');
      for (const prep of preparations) {
        const reading = prep.reading;
        lines.push(`### ${literal(reading?.title || title)}`, '', `来源版本：${literal(prep.sourceHash)}`, '');
        if(prep.coverage && typeof prep.coverage==='object'){
          lines.push(`已研读 ${prep.coverage.sentBlocks || 0}/${prep.coverage.totalBlocks || 0} 个文字块${prep.coverage.totalImages ? `；页面图像 ${prep.coverage.sentImages || 0}/${prep.coverage.totalImages}` : '；文字研读，未处理页面图像'}`, '');
          if(prep.coverage.scannedPages?.length)lines.push(`无可用文字层：文件第 ${prep.coverage.scannedPages.join('、')} 页`, '');
          for(const warning of prep.coverage.warnings || [])lines.push(`提取提示（文件第 ${warning.page} 页）：${literal(warning.message)}`, '');
        }
        if (reading) {
          if (!completeReading(reading)) lines.push('> 此前保存的导读结构不完整，请结合原文核对。', '');
          lines.push(literal(reading.documentType), '', '#### 全文概览', '', literal(reading.summary?.body), '', ...evidence(reading.summary?.sources));
          if (reading.sections?.length) lines.push(reading.sectionOrder === 'source' ? '#### 按原文脉络精读' : '#### 分节解读', '');
          for (const section of reading.sections || []) {
            lines.push(`##### ${literal(section.title)}`, '', `内容性质：${BASIS_LABELS[normalizeBasis(section.basis)]}`, '');
            if (section.originalHeading && section.originalHeading !== section.title) lines.push(`原文小节：${literal(section.originalHeading)}`, '');
            lines.push(literal(section.body), '');
            if (section.readingCue) lines.push(`**精读提示** ${literal(section.readingCue)}`, '');
            lines.push(...evidence(section.sources));
          }
          const conclusion = readingConclusion(reading);
          if (conclusion.length) {
            lines.push('#### 读完总结', '');
            for (const item of conclusion) {
              if (item.title) lines.push(`##### ${literal(item.title)}`, '');
              lines.push(`内容性质：${BASIS_LABELS[normalizeBasis(item.basis)]}`, '', literal(item.body), '');
              if (item.limits) lines.push(`**适用边界** ${literal(item.limits)}`, '');
              lines.push(...evidence(item.sources));
            }
          }
          if (reading.terms?.length) lines.push('#### 术语与概念', '', ...reading.terms.flatMap(item => [`**${literal(item.term)}**`, '', literal(item.explanation), '', ...evidence(item.sources)]));
          if (reading.quotes?.length) lines.push('#### 原文摘引与译文', '', ...reading.quotes.flatMap(item => [`> ${literal(item.quote).replace(/\n/g,'\n> ')}`, '', ...(item.translation ? [`译文：${literal(item.translation)}`, ''] : []), ...evidence(item.sources)]));
          if (reading.related?.length) lines.push('#### 延伸理解', '', ...reading.related.flatMap(item => [`**${literal(item.title)}**`, '', literal(item.body), '', ...evidence(item.sources)]));
          if (reading.sources?.length) lines.push('#### 研读来源', '', ...evidence(reading.sources));
        } else for (const item of prep.guide || []) lines.push(`#### ${literal(item.title)}`, '', literal(item.body), '', ...evidence(item.sources));
      }
    }
    if (record.notes.length) lines.push('## 我的批注', '', ...record.notes.flatMap(note => [
      ...(note.kind === 'research-excerpt' ? ['### 研究摘录', ''] : []),
      ...(note.text ? [literal(note.text), ''] : []), ...evidence(note.sources)
    ]));
    if (record.cards.length) lines.push('## 学习卡', '', ...record.cards.flatMap(card => [`### ${literal(card.question)}`, '', literal(card.answer), '', `类型：${literal(card.type || '学习卡')} · ${card.ai ? 'AI 辅助，经我确认保留' : '我的记录'}`, ...(card.reviews?.length ? [`自测记录：${card.reviews.map(item => `${new Date(item.at).toISOString()} ${literal(item.rating)}`).join('；')}`] : []), '', ...evidence(card.sources)]));
    const messages = record.messages.filter(item => item.status === 'ready');
    if (messages.length) lines.push('## 文档对话（AI）', '', ...messages.flatMap(item => [`### ${literal(item.question)}`, '',
      literal(item.insufficient ? INSUFFICIENT_ANSWER : item.answer), '', ...evidence(item.insufficient ? [] : item.sources)]));
    return lines.join('\n');
  }

  function studyPanelPreference() {
    if (preferredStudyPanelWidth !== undefined) return preferredStudyPanelWidth;
    preferredStudyPanelWidth = STUDY_PANEL_MIN_WIDTH;
    try {
      const saved = Number(window.localStorage.getItem(STUDY_PANEL_WIDTH_KEY));
      if (Number.isSafeInteger(saved) && saved >= STUDY_PANEL_MIN_WIDTH) preferredStudyPanelWidth = saved;
    } catch (_) { /* Resizing also works without persistent storage. */ }
    return preferredStudyPanelWidth;
  }

  function rememberStudyPanelWidth(width) {
    if (width === studyPanelPreference()) return;
    preferredStudyPanelWidth = width;
    try { window.localStorage.setItem(STUDY_PANEL_WIDTH_KEY, String(width)); }
    catch (_) { /* Retain the preference in memory if the write fails. */ }
  }

  function mountPanelResizer(shell, panel, closeButton, signal) {
    const resizer = document.createElement('div');
    resizer.className = 'guanyi-study-resizer';
    resizer.title = '拖动调整面板宽度，双击恢复';
    resizer.hidden = true;
    resizer.tabIndex = -1;
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', '调整智能研读面板宽度');
    resizer.setAttribute('aria-controls', panel.id);
    resizer.setAttribute('aria-valuemin', String(STUDY_PANEL_MIN_WIDTH));
    panel.prepend(resizer);

    let width;
    let maximum = STUDY_PANEL_MIN_WIDTH;
    let drag = null;

    function applyWidth(requested) {
      const next = Math.round(Math.max(STUDY_PANEL_MIN_WIDTH, Math.min(maximum, requested)));
      if (width === next) return;
      width = next;
      shell.style.setProperty('--guanyi-study-panel-width', `${width}px`);
      resizer.setAttribute('aria-valuenow', String(width));
      resizer.setAttribute('aria-valuetext', `${width} 像素`);
    }

    function finishDrag(commit = true) {
      if (!drag) return;
      const { pointerId, startWidth, moved } = drag;
      drag = null;
      shell.classList.remove('study-resizing');
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      if (commit && moved && width !== startWidth) rememberStudyPanelWidth(width);
    }

    function sync() {
      if (panel.hidden) return;
      const availableWidth = Math.min(window.innerWidth, shell.clientWidth || window.innerWidth);
      maximum = window.innerWidth > 760 ? Math.max(STUDY_PANEL_MIN_WIDTH, Math.floor(availableWidth / 2)) : STUDY_PANEL_MIN_WIDTH;
      const enabled = maximum > STUDY_PANEL_MIN_WIDTH;
      const returnFocus = !enabled && document.activeElement === resizer;
      if (!enabled) finishDrag(false);
      resizer.hidden = !enabled;
      resizer.tabIndex = enabled ? 0 : -1;
      resizer.setAttribute('aria-valuemax', String(maximum));
      applyWidth(drag ? width : studyPanelPreference());
      if (returnFocus) closeButton.focus({ preventScroll:true });
    }

    const events = { signal };
    resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false || drag || resizer.hidden) return;
      event.preventDefault();
      drag = { pointerId:event.pointerId, startX:event.clientX, startWidth:width, moved:false };
      shell.classList.add('study-resizing');
      try { resizer.setPointerCapture(event.pointerId); } catch (_) { /* Window listeners still track the pointer. */ }
    }, events);
    function resizeFromPointer(event) {
      if (drag?.pointerId !== event.pointerId) return;
      if (event.clientX !== drag.startX) drag.moved = true;
      applyWidth(drag.startWidth + drag.startX - event.clientX);
    }
    window.addEventListener('pointermove', resizeFromPointer, events);
    window.addEventListener('pointerup', event => {
      if (drag?.pointerId !== event.pointerId) return;
      resizeFromPointer(event);
      finishDrag();
    }, events);
    function finishPointerDrag(event) {
      if (drag?.pointerId === event.pointerId) finishDrag();
    }
    window.addEventListener('pointercancel', finishPointerDrag, events);
    resizer.addEventListener('lostpointercapture', finishPointerDrag, events);
    window.addEventListener('blur', () => finishDrag(), events);
    resizer.addEventListener('keydown', event => {
      const step = event.shiftKey ? 64 : 16;
      if (event.key === 'ArrowLeft') applyWidth(width + step);
      else if (event.key === 'ArrowRight') applyWidth(width - step);
      else if (event.key === 'Home') applyWidth(STUDY_PANEL_MIN_WIDTH);
      else if (event.key === 'End') applyWidth(maximum);
      else return;
      event.preventDefault();
      event.stopPropagation();
      rememberStudyPanelWidth(width);
    }, events);
    resizer.addEventListener('dblclick', () => {
      applyWidth(STUDY_PANEL_MIN_WIDTH);
      rememberStudyPanelWidth(width);
    }, events);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    observer?.observe(shell);
    window.addEventListener('resize', sync, events);
    signal.addEventListener('abort', () => {
      finishDrag();
      observer?.disconnect();
      shell.style.removeProperty('--guanyi-study-panel-width');
    }, { once:true });
    return { sync, finishDrag };
  }

  function mount(options) {
    const { doc, reader, container, toolbar } = options;
    if (!reader || !container || !toolbar) throw new Error('PDF 智能研读缺少阅读上下文');
    const info = reader.info || {};
    const sourceHash = clean(info.sourceHash, 160);
    const totalPages = number(info.numPages);
    let disposed = false;
    let activeTask = null;
    let taskController = null;
    let taskRequestSession = null;
    let taskKind = null;
    let previousResultOpen = false;
    let openGuideChapter = '';
    let draftTimer;
    let returnPosition = null;
    let evidenceOrigin = null;
    let followupOrigin = null;
    let followupPromptCount = -1;
    let evidenceBusy = false;
    const sourceDisclosures = new Map();
    const studyScroll = new Map();
    let selection = null;
    let dialogCandidate = null;
    let dialogEpoch = 0;
    let dialogOrigin = null;
    let dialogOriginLabel = '';
    let dialogOriginKey = '';
    const visualPreviews = new Map();
    const visualSupported = typeof reader.renderVisual === 'function';
    const listeners = new AbortController();
    const ui = { open:false, tab:'guide', draft:'', noteDraft:'', noteEditor:false, noteEditingId:null, noteSaving:false, scope:null, noteContext:null, storageError:'', error:'', unsavedReadingFailure:null, progress:'', busy:false, nativeAnnotations:[], annotationError:'', testCard:null, testRevealed:false };
    const restored = normalizeRecord(doc.readerStudy, info);
    Object.assign(ui, { tab:restored.tab, draft:restored.draft, noteDraft:restored.noteDraft, noteEditor:restored.noteEditor, noteEditingId:restored.noteEditingId, scope:restored.scope, noteContext:restored.noteContext });
    ui.quickPurpose = restored.quickPurpose;
    ui.quickError = '';
    let quickPurposeOpen = !!restored.quickPurpose;
    const currentPage = () => Math.min(totalPages, number(reader.position?.()?.page));
    const pageContext = () => {
      const page = currentPage();
      return { mode:'page', start:page, end:page, sourceHash };
    };
    const documentContext = () => ({ mode:'document', start:1, end:totalPages, sourceHash });
    const legacyDefaultPage = Number(doc.readerStudy?.version || 1) < VERSION && ui.scope?.mode === 'page' && !ui.draft;
    if (!['document','page','selection','range'].includes(ui.scope?.mode) || legacyDefaultPage || (ui.scope.sourceHash !== sourceHash && !ui.draft)) ui.scope = documentContext();
    const store = createStore(restored, options.persist, () => ({ currentHash:sourceHash, tab:ui.tab, draft:ui.draft, noteDraft:ui.noteDraft, noteEditor:ui.noteEditor, noteEditingId:ui.noteEditingId, scope:ui.scope, noteContext:ui.noteContext, quickPurpose:ui.quickPurpose }));
    const state = () => store.state;
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const action = (label, handler, className = '') => { const node = el('button', `guanyi-study-action ${className}`, label); node.type = 'button'; node.addEventListener('click', event=>{try{Promise.resolve(handler(event)).catch(error=>{ui.error=error.message;notify(error.message);render();});}catch(error){ui.error=error.message;notify(error.message);render();}}, { signal:listeners.signal }); return node; };
    const iconAction = (label, path, handler, className = '') => { const node=action('',handler,className); node.title=label; node.setAttribute('aria-label',label); node.innerHTML=`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${path}</svg>`; return node; };
    const notify = message => options.notify?.(message);
    async function save(change) { try { await store.transact(change); ui.storageError = ''; } catch (error) { ui.storageDraftOnly=!!change;ui.storageError = `保存失败：${error.message}。内容仍留在当前窗口，${change?'请重试刚才的操作':'请重试'}。`; renderStorage(); throw error; } }
    function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(() => { save().catch(() => {}); }, 500); }

    // Reparenting a live iframe with append() reloads its browsing context and
    // strands the original PDF.js worker. Use connected atomic moves; older
    // browsers keep the reader in place and put the panel beside it directly.
    const wrappedReading = typeof container.moveBefore === 'function' && container.isConnected;
    const shell = wrappedReading ? el('div', 'guanyi-pdf-study-shell') : container;
    const reading = wrappedReading ? el('div', 'guanyi-study-reading') : container;
    if (wrappedReading) {
      const originalChildren = [...container.childNodes];
      shell.append(reading);
      container.append(shell);
      for (const child of originalChildren) reading.moveBefore(child, null);
    } else container.classList.add('guanyi-pdf-study-shell', 'guanyi-study-inline');
    container.classList.add('has-pdf-study');
    const mask = action('关闭智能研读', () => hide(), 'guanyi-study-mask');
    mask.tabIndex = -1; mask.hidden = true;
    const panel = el('aside', 'guanyi-study-panel');
    panel.setAttribute('aria-label', '智能研读'); panel.hidden = true;
    const heading = el('div', 'guanyi-study-heading');
    const closeButton = action('', () => hide(), 'app-icon-button guanyi-study-close');
    closeButton.title = '关闭智能研读'; closeButton.setAttribute('aria-label', '关闭智能研读');
    closeButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 4 8 8M12 4 4 12"/></svg>';
    closeButton.classList.remove('guanyi-study-action');
    heading.append(el('strong', '', '智能研读'), closeButton);
    const tabs = el('div', 'guanyi-study-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '智能研读功能');
    const tabButtons = {};
    const labels = { guide:'导读', ask:'文档对话', cards:'学习卡', notes:'批注' };
    for (const [id,label] of Object.entries(labels)) {
      const button = action(label, () => selectTab(id)); button.dataset.studyTab = id; button.setAttribute('role','tab'); button.id = `pdf-study-${doc.id}-${id}`; tabButtons[id] = button; tabs.append(button);
      button.addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const keys = Object.keys(labels); const index = keys.indexOf(id); const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowRight' ? 1 : 3)) % 4]; selectTab(next); tabButtons[next].focus(); }, { signal:listeners.signal });
    }
    const storage = el('div', 'guanyi-study-storage'); storage.hidden = true; storage.setAttribute('role', 'alert');
    const body = el('div', 'guanyi-study-body'); body.setAttribute('role','tabpanel');
    body.addEventListener('compositionstart',()=>{ui.composing=true;},{signal:listeners.signal});
    body.addEventListener('compositionend',()=>{ui.composing=false;if(ui.deferredRender){ui.deferredRender=false;setTimeout(render,0);}},{signal:listeners.signal});
    const footer = el('div', 'guanyi-study-footer'); footer.append(action('整理为 Markdown', () => openExport()));
    panel.append(heading,tabs,storage,body,footer); shell.append(mask,panel);
    const toggle = action('', () => ui.open ? hide() : show(), 'fmt-btn guanyi-study-toggle');
    toggle.classList.remove('guanyi-study-action');
    toggle.title = '智能研读'; toggle.setAttribute('aria-label', '智能研读');
    toggle.innerHTML = '<svg class="guanyi-study-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 5.5C6.4 4.4 4.3 4.1 2 4.6v7.7c2.3-.5 4.4-.2 6 1 1.6-1.2 3.7-1.5 6-1V6M8 5.5v7.8M4 7.1l2 .4M4 9.4l2 .4"/><path class="guanyi-study-icon-accent" d="m12 1.5.6 1.8 1.9.7-1.9.7-.6 1.8-.6-1.8L9.5 4l1.9-.7Z"/></svg>';
    toggle.setAttribute('aria-expanded','false'); toggle.setAttribute('aria-controls', `pdf-study-panel-${doc.id}`); panel.id = `pdf-study-panel-${doc.id}`;
    const panelResizer = mountPanelResizer(shell, panel, closeButton, listeners.signal);
    toolbar.append(toggle);
    const selectionBar = el('div','guanyi-study-selection'); selectionBar.hidden = true; selectionBar.setAttribute('aria-label','选区研读操作');
    selectionBar.append(action('解释这段', () => useSelection('explain')), action('生成学习卡', () => useSelection('card')), action('批注', () => useSelection('note')), action('取消', () => { selection = null; selectionBar.hidden = true; })); if(visualSupported)selectionBar.append(el('p','guanyi-study-selection-disclosure','解释和制卡会发送选中文字及所在整页图像。')); reading.append(selectionBar);
    const dialog = el('dialog','guanyi-study-dialog'); container.append(dialog);

    function prepareDialog(title, description) {
      if (!dialog.open) {
        dialogOrigin = document.activeElement;
        dialogOriginLabel = dialogOrigin?.getAttribute('aria-label') || dialogOrigin?.textContent?.trim() || '';
        dialogOriginKey = dialogOrigin?.dataset.studyFocusKey || dialogOrigin?.dataset.studyEvidence || '';
      }
      clearVisualPreviews(dialog);
      dialog.replaceChildren();
      const header = el('header', 'guanyi-study-dialog-heading');
      const heading = sectionTitle(title);
      heading.id = `pdf-study-dialog-title-${doc.id}`;
      dialog.setAttribute('aria-labelledby', heading.id);
      const close = iconAction('关闭' + title, '<path d="m4 4 8 8M12 4 4 12"/>', () => dialog.close(), 'guanyi-study-dialog-close');
      close.classList.remove('guanyi-study-action');
      header.append(heading, close);
      dialog.append(header, paragraph(description, 'guanyi-study-muted'));
    }

    function scopeLabel(scope = ui.scope) {
      const version = scope?.sourceHash && scope.sourceHash !== sourceHash ? '旧版来源 · ' : '';
      const origin = scope?.citation ? '出处 · ' : '';
      if (scope?.mode === 'document') return `${version}全文 · ${totalPages} 页`;
      if (scope?.mode === 'selection') {
        const pages = [...new Set((scope.sources || []).map(source => source.page))].join('、');
        return `${version}${origin}${scope.citation ? '已锁定摘录' : '已锁定选区'} · ${pages} 页`;
      }
      const start = number(scope?.start);
      const end = number(scope?.end, start);
      const page = start === end ? `文件第 ${start} 页` : `文件第 ${start}–${end} 页`;
      return `${version}${origin}${page} · 已锁定`;
    }
    function renderStorage() { storage.replaceChildren(); storage.hidden = !ui.storageError; if (ui.storageError) storage.append(el('p','',ui.storageError),action(ui.storageDraftOnly?'仅保存当前草稿':'重试保存', () => save().then(render).catch(() => {}))); }
    function setOpen(open) {
      if (!open) panelResizer.finishDrag();
      ui.open = open; panel.hidden = !open; shell.classList.toggle('study-open',open); toggle.setAttribute('aria-expanded',String(open)); mask.hidden = !open || innerWidth >= 1180;
      if (open) panelResizer.sync();
      reader.setStudyOpen?.(open);
      syncEvidenceNavigation();
    }
    function show(tab) {
      if (disposed) return;
      const wasOpen = ui.open;
      if (tab) ui.tab = tab;
      if (!returnPosition) evidenceOrigin = null;
      setOpen(true);
      render({preserveScroll:!wasOpen});
      if (ui.tab==='notes') refreshAnnotations();
    }
    function hide(restoreFocus = true) {
      rememberStudyScroll();
      taskController?.abort();
      clearVisualPreviews();
      setOpen(false);
      if (restoreFocus) {
        toggle.focus({ preventScroll:true });
        if (toolbar.scrollWidth > toolbar.clientWidth) {
          toggle.scrollIntoView({ block:'nearest', inline:'nearest' });
        }
      }
    }
    function selectTab(tab) { ui.tab = tab; ui.testCard = null; render(); scheduleDraft(); if (tab === 'notes') refreshAnnotations(); }
    function rememberStudyScroll() {
      const tab = body.dataset.tab;
      if (!ui.open || !tab) return;
      const messages = body.querySelector('.guanyi-study-messages');
      studyScroll.set(tab, { top:body.scrollTop, messages:messages ? {
        top:messages.scrollTop, bottom:messages.scrollHeight-messages.clientHeight-messages.scrollTop<30
      } : null });
    }
    function render({preserveScroll=false} = {}) {
      if (disposed) return;
      if (ui.composing) { ui.deferredRender=true; return; }
      const focused=body.contains(document.activeElement)?document.activeElement:null;
      const focusLabel=focused?.getAttribute('aria-label');
      const focusKey=focused?.dataset.studyFocusKey || focused?.dataset.studyEvidence;
      const focusGuideAction=!!focused?.closest('.guanyi-study-guide-actions');
      const focusNoteId=focused?.closest('[data-note-id]')?.dataset.noteId;
      const caret=focused?.tagName==='TEXTAREA'?{start:focused.selectionStart,end:focused.selectionEnd}:null;
      const oldTab=body.dataset.tab;
      if (!preserveScroll) rememberStudyScroll();
      // Native toggle events are queued; capture the live disclosure before a
      // batch-progress render replaces it, including rapid open/close actions.
      const previousResult=body.querySelector('.guanyi-study-previous');
      if(previousResult)previousResultOpen=previousResult.open;
      body.querySelectorAll('.guanyi-study-source-preview[data-source-group]').forEach(details => {
        sourceDisclosures.set(details.dataset.sourceGroup, details.open);
      });
      for (const [id,button] of Object.entries(tabButtons)) { button.setAttribute('aria-selected', String(ui.tab === id)); button.tabIndex = ui.tab === id ? 0 : -1; }
      tabButtons.cards.textContent = `学习卡 ${state().cards.length}`;
      body.setAttribute('aria-labelledby',tabButtons[ui.tab].id); clearVisualPreviews(body); body.replaceChildren(); body.className = `guanyi-study-body guanyi-study-body--${ui.tab}`;body.dataset.tab=ui.tab;
      renderStorage();
      ({guide:renderGuide, ask:renderAsk, cards:renderCards, notes:renderNotes})[ui.tab]();
      const scroll = studyScroll.get(ui.tab);
      if (scroll) {
        body.scrollTop = scroll.top;
        const messages = body.querySelector('.guanyi-study-messages');
        if (messages && scroll.messages) messages.scrollTop = scroll.messages.bottom ? messages.scrollHeight : scroll.messages.top;
      } else {
        const messages = body.querySelector('.guanyi-study-messages');
        if (messages) messages.scrollTop = messages.scrollHeight;
      }
      if (oldTab === ui.tab && (focusKey || focusLabel)) {
        const keyed = focusKey && [...body.querySelectorAll('[data-study-focus-key],[data-study-evidence]')]
          .find(node => (node.dataset.studyFocusKey || node.dataset.studyEvidence) === focusKey);
        const next = keyed || (focusLabel && [...body.querySelectorAll('[aria-label]')].find(node =>
          node.getAttribute('aria-label')===focusLabel && (!focusNoteId || node.closest('[data-note-id]')?.dataset.noteId===focusNoteId)));
        if (next) {
          next.focus({preventScroll:true});
          if (caret && next.setSelectionRange) next.setSelectionRange(caret.start,caret.end);
        }
      }
      if (focusGuideAction && oldTab === ui.tab && !body.contains(document.activeElement)) {
        body.querySelector('.guanyi-study-guide-actions button:not(:disabled)')?.focus({ preventScroll:true });
      }
    }
    function paragraph(text, className = '') { return el('p',className,text); }
    function sectionTitle(text) { return el('h3','guanyi-study-section-title',text); }
    function oldVersion(hash) { return hash && hash !== sourceHash; }
    function clearVisualPreviews(root) {
      for(const [details,entry] of visualPreviews){if(root&&!root.contains(details))continue;entry.controller.abort();entry.content.querySelectorAll('img').forEach(image=>image.removeAttribute('src'));entry.content.replaceChildren();details.open=false;visualPreviews.delete(details);}
    }
    function appendVisualPreview(parent,source) {
      const details=el('details','guanyi-study-visual-preview');details.dataset.sourceId=source.id;details.append(el('summary','','查看原图'));
      const content=el('div','guanyi-study-visual-content');details.append(content);parent.append(details);
      details.addEventListener('toggle',async()=>{
        if(!details.open){const entry=visualPreviews.get(details);entry?.controller.abort();content.querySelectorAll('img').forEach(image=>image.removeAttribute('src'));content.replaceChildren();visualPreviews.delete(details);return;}
        if(visualPreviews.has(details))return;
        if(oldVersion(source.sourceHash)){content.append(paragraph('原图属于旧文件版本，请打开对应 PDF 查看；这里保留了原页码。','guanyi-study-muted'));return;}
        if(!visualSupported){content.append(paragraph('当前阅读器无法预览页面图像，请在 PDF 原页核对。','guanyi-study-muted'));return;}
        const controller=new AbortController();const entry={controller,content};visualPreviews.set(details,entry);content.replaceChildren(paragraph('正在读取原页图像…','guanyi-study-muted'));
        try{const image=await reader.renderVisual(source,{signal:controller.signal});if(disposed||controller.signal.aborted||!details.isConnected||!details.open)return;const img=el('img');img.alt=`PDF 原页图像，文件第 ${source.page} 页`;img.width=image.width;img.height=image.height;img.src=image.dataUrl;content.replaceChildren(img,paragraph('本地原页预览；可定位到 PDF 放大核对图表。','guanyi-study-muted'));}
        catch(error){if(error.name!=='AbortError'&&!controller.signal.aborted)content.replaceChildren(paragraph(errorText(error),'guanyi-study-error'));}
      },{signal:listeners.signal});
    }
    function appendSources(parent, sources, expanded = false, { compact = false, key = '', research = false } = {}) {
      if (!sources?.length) return;
      const group = key || fingerprint(sources.map(source => `${source.sourceHash}:${source.id}`).join(','));
      const list = el('div','guanyi-study-sources');
      const preview = el('details','guanyi-study-source-preview');
      preview.dataset.sourceGroup = group;
      preview.open = expanded || sourceDisclosures.get(group) === true;
      preview.append(el('summary','',`查看原文依据（${sources.length}）`));
      const pages = new Set();
      for (const source of previewSources(sources)) {
        const visual = source.kind === 'page-image';
        const older = oldVersion(source.sourceHash);
        const pageKey = `${source.sourceHash}:${source.page}:${visual?'image':'text'}`;
        if (!compact && !pages.has(pageKey)) {
          pages.add(pageKey);
          const pageLabel = source.pageLabel !== String(source.page) ? ` · ${source.pageLabel}` : '';
          list.append(evidenceAction(`${older?'旧版 · ':''}第 ${source.page} 页${visual?'图像':''}${pageLabel}`,
            source, 'guanyi-study-source', `${group}:page:${pageKey}`));
        }
        const excerpt = el('div',`guanyi-study-source-excerpt${visual?' guanyi-study-source-excerpt--visual':''}`);
        const excerptHeading = el('div','guanyi-study-excerpt-heading');
        excerptHeading.append(
          paragraph(`文件第 ${source.page} 页${visual?' · 页面图像，图表依据':''}${older?' · 旧版来源':''}`, 'guanyi-study-muted'),
          evidenceAction(visual?'定位图表所在页':'定位此摘录',source,'guanyi-study-source-locate',`${group}:excerpt:${source.id}`)
        );
        excerpt.append(excerptHeading);
        if (visual) appendVisualPreview(excerpt,source);
        else excerpt.append(el('blockquote','',source.text || '这条来源只有页面记录，没有可用原文摘录。'));
        if (research) {
          const actions = el('div', 'guanyi-study-research-actions');
          if (!older) {
            const ask = action('基于此处追问', event => followupFromSource(source,sources,event.currentTarget));
            ask.dataset.studyEvidence = `${group}:ask:${source.id}`;
            actions.append(ask);
          }
          const note = action('存为研究摘录', () => openResearchExcerpt(source));
          note.dataset.studyFocusKey = `${group}:note:${source.id}`;
          actions.append(note);
          excerpt.append(actions);
        }
        preview.append(excerpt);
      }
      preview.addEventListener('toggle',()=>{
        if (body.contains(preview)) sourceDisclosures.set(group,preview.open);
        if (!preview.open) clearVisualPreviews(preview);
      },{signal:listeners.signal});
      if (!compact) parent.append(list);
      parent.append(preview);
    }
    function followupFromSource(source, citations, trigger) {
      if (oldVersion(source.sourceHash)) return;
      if (ui.tab === 'guide') followupOrigin = { tab:'guide', trigger, key:trigger.dataset.studyEvidence,
        chapter:!!trigger.closest('[data-study-chapter]') };
      const page = source.page;
      const base = { start:page, end:page, sourceHash, citation:true };
      followupPromptCount = state().messages.length;
      if (source.kind === 'page-image' || !source.text) {
        ui.scope = { ...base, mode:'page' };
      } else {
        const ids = new Set([source.id, ...(source.blockIds || [])]);
        const original = sourcesSnapshot(citations).filter(item => item.page === page && item.sourceHash === sourceHash && ids.has(item.id));
        const blocks = original.map(item => item.text).join('\n') === source.text ? original : [source];
        ui.scope = { ...base, mode:'selection', sources:blocks };
      }
      selectTab('ask');
      const messages = body.querySelector('.guanyi-study-messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
      body.querySelector('.guanyi-study-composer textarea')?.focus({preventScroll:true});
    }
    function evidenceAction(label, source, className, key) {
      const button = action(label,event=>locate(source,event.currentTarget),className);
      button.dataset.studyEvidence = key;
      if (oldVersion(source.sourceHash)) button.title = '来源文件已变化，不能定位到当前 PDF';
      return button;
    }
    async function locate(source, trigger) {
      if (oldVersion(source.sourceHash)) {
        notify('这条来源属于旧文件版本。保留的原文可查看或导出，不能在当前 PDF 上精确定位。');
        return;
      }
      if (evidenceBusy || disposed) return;
      const position = returnPosition || clone(reader.position());
      const origin = { tab:ui.tab, trigger, key:trigger?.dataset.studyEvidence, page:source.page };
      let focusResume = false;
      evidenceBusy = true;
      syncEvidenceNavigation();
      try {
        const result = await reader.locate(source);
        if (disposed) return;
        returnPosition = returnPosition || result?.previousPosition || position;
        evidenceOrigin = origin;
        if (innerWidth < 1180 && ui.open && ui.tab === origin.tab) {
          hide(false);
          focusResume = !dialog.open;
        }
        if (!result?.precise) notify(source.kind==='page-image'?'已定位图表所在页，请在 PDF 中放大核对。':'已定位到来源页；这条记录暂不能精确标出文字区域。');
      } finally {
        evidenceBusy = false;
        syncEvidenceNavigation();
        if (focusResume) resumeButton.focus({preventScroll:true});
      }
    }
    function focusEvidenceOrigin(origin) {
      if (disposed || !ui.open || ui.tab !== origin?.tab) return;
      const target = origin.trigger && body.contains(origin.trigger) ? origin.trigger
        : origin.key && [...body.querySelectorAll('[data-study-evidence]')].find(button=>button.dataset.studyEvidence===origin.key);
      if (target) {
        for (let parent=target.parentElement; parent&&parent!==body; parent=parent.parentElement) {
          if (parent.tagName==='DETAILS') parent.open=true;
        }
      }
      (target?.getClientRects().length ? target : tabButtons[ui.tab]).focus({preventScroll:true});
    }
    function syncEvidenceNavigation() {
      evidenceNavigation.hidden = !evidenceOrigin || (innerWidth < 1180 && ui.open);
      evidencePosition.textContent = returnPosition && evidenceOrigin ? `原文 · 第 ${evidenceOrigin.page} 页` : '';
      returnButton.hidden = !returnPosition;
      returnButton.disabled = evidenceBusy;
      resumeButton.hidden = ui.open;
      resumeButton.disabled = evidenceBusy;
      resumeButton.textContent = ({ ask:'继续对话',cards:'返回学习卡',notes:'返回批注' })[evidenceOrigin?.tab] || '继续导读';
    }
    const evidenceNavigation = el('div','guanyi-study-evidence-nav');
    evidenceNavigation.hidden = true;
    evidenceNavigation.setAttribute('role','group');
    evidenceNavigation.setAttribute('aria-label','原文定位');
    const evidencePosition = el('span','guanyi-study-evidence-position');
    const returnButton = action('返回阅读位置',async()=>{
      if (!returnPosition || evidenceBusy) return;
      evidenceBusy = true;
      syncEvidenceNavigation();
      try {
        await reader.restore(returnPosition);
        if (disposed) return;
        returnPosition = null;
        const origin = evidenceOrigin;
        if (ui.open) {
          evidenceOrigin = null;
          focusEvidenceOrigin(origin);
        }
      } finally {
        evidenceBusy = false;
        syncEvidenceNavigation();
        if (!disposed && !ui.open && !returnPosition) resumeButton.focus({preventScroll:true});
      }
    },'guanyi-study-return');
    const resumeButton = action('继续导读',()=>{
      const origin = evidenceOrigin;
      if (!origin) return;
      show(origin.tab);
      focusEvidenceOrigin(origin);
    },'guanyi-study-resume');
    returnButton.hidden = true;
    evidenceNavigation.append(evidencePosition,returnButton,resumeButton);
    shell.append(evidenceNavigation);

    function statusNotice(parent) { if (ui.error) parent.append(paragraph(errorText(ui.error),'guanyi-study-notice error')); if (ui.progress) parent.append(paragraph(ui.progress,'guanyi-study-notice')); }
    function modelNotice(parent) { if (!options.modelReady?.()) parent.append(paragraph('请先配置模型：顶部 … > 模型配置','guanyi-study-muted')); }
    function coverageLabel(prep) {
      if (typeof prep.coverage === 'string') return `此前的文字研读 · ${prep.coverage}`;
      const coverage = prep.coverage || {};
      const missing = coverage.scannedPages || [];
      const range = prep.start === 1 && prep.end === totalPages ? `全文 ${totalPages} 页` : `文件第 ${prep.start || 1}–${prep.end || totalPages} 页`;
      return `${range} · 文字块 ${coverage.sentBlocks || 0}/${coverage.totalBlocks || 0}${coverage.totalImages ? ` · 页面图像 ${coverage.sentImages || 0}/${coverage.totalImages}` : ' · 文字研读，未处理页面图像'}${missing.length ? `；文件第 ${missing.join('、')} 页无文字层${coverage.totalImages ? '，已按图像研读' : ''}` : ''}`;
    }
    const preparationKey = () => `${sourceHash}:paper-${window.GuanyiPaperReader?.VERSION}:document`;
    const currentPreparation = prep => prep?.status === 'ready' && prep.key === preparationKey() && prep.sourceHash === sourceHash && completeReading(prep.reading) && prep.coverage && typeof prep.coverage === 'object' && prep.start === 1 && prep.end === totalPages;
    function readingBasis(value) {
      const basis = normalizeBasis(value);
      return el('span', `guanyi-study-basis guanyi-study-basis--${basis}`, BASIS_LABELS[basis]);
    }
    function readingCallout(label, text) {
      const hint = paragraph('', 'guanyi-study-reading-cue');
      hint.append(el('strong', '', label), document.createTextNode(text));
      return hint;
    }
    function readingEntry(item) {
      const article = el('article','guanyi-study-reading-card guanyi-study-reading-entry');
      const meta = el('div','guanyi-study-entry-heading');
      meta.append(el('h4','',item.title), readingBasis(item.basis));
      article.append(meta);
      if (item.originalHeading && item.originalHeading !== item.title) {
        article.append(paragraph(`原文小节 · ${item.originalHeading}`, 'guanyi-study-muted'));
      }
      article.append(paragraph(item.body));
      if (item.readingCue) article.append(readingCallout('精读提示', item.readingCue));
      appendSources(article,item.sources,false,{research:true});
      return article;
    }

    function guideLead(text, limit = 144) {
      const first = fullText(text).split(/\r?\n|(?<=[。！？!?])|(?<=\.)\s/u, 1)[0];
      return first.length <= limit ? first : `${first.slice(0, limit).trimEnd()}…`;
    }

    function guidePageLabel(sources) {
      const pages = [...new Set((sources || []).map(source => source.page))].sort((a, b) => a - b);
      if (!pages.length) return '';
      const start = pages[0], end = pages.at(-1);
      if (pages.length === 1) return `文件第 ${start} 页`;
      if (end - start + 1 === pages.length) return `文件第 ${start}–${end} 页`;
      return `文件第 ${start} 页等 ${pages.length} 页`;
    }

    function guideChapterBody(section) {
      const observations = fullText(section.body).split(/\r?\n+/).map(fullText).filter(Boolean);
      // Arrange only explicit short observations. Their wording, order and
      // values come from the saved result; the UI never reconstructs a dataset.
      if (/^(results?|figure)$/i.test(section.kind || '') && observations.length >= 2 && observations.length <= 4 &&
          observations.every(observation => observation.length <= 160 && /\d/.test(observation.normalize('NFKC')))) {
        const comparison = el('div', 'guanyi-study-guide-comparison');
        comparison.append(...observations.map(observation => paragraph(observation, 'guanyi-study-guide-observation')));
        return comparison;
      }
      return paragraph(section.body);
    }

    function renderGuideChapter(section, key, onToggle) {
      const article = el('article', 'guanyi-study-reading-card guanyi-study-reading-entry guanyi-study-chapter');
      article.dataset.studyChapter = key;
      const title = section.title || section.originalHeading || '章节解读';
      const toggle = action('', onToggle, 'guanyi-study-chapter-toggle');
      toggle.setAttribute('aria-label', title);
      toggle.dataset.studyFocusKey = `guide-chapter:${key}`;
      const detailId = `pdf-study-guide-step-${doc.id}-${fingerprint(key)}`;
      const icon = el('span', 'ui-icon gicon guanyi-study-chapter-chevron');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 16 16" focusable="false"><use href="#gicon-chevron-right"></use></svg>';
      toggle.append(el('span', 'guanyi-study-chapter-title', title));
      const pages = guidePageLabel(section.sources);
      if (pages) {
        const pageLabel = el('span', 'guanyi-study-chapter-pages', pages);
        pageLabel.id = `${detailId}-pages`;
        toggle.setAttribute('aria-describedby', pageLabel.id);
        toggle.append(pageLabel);
      }
      toggle.append(icon);
      const heading = el('h4', 'guanyi-study-chapter-heading');
      heading.append(toggle);
      const preview = paragraph(guideLead(section.body), 'guanyi-study-chapter-preview');
      const detail = el('div', 'guanyi-study-chapter-detail');
      detail.id = detailId;
      toggle.setAttribute('aria-controls', detail.id);
      const meta = el('div', 'guanyi-study-chapter-meta');
      if (section.originalHeading && section.originalHeading !== title) {
        meta.append(el('span', 'guanyi-study-muted', `原文小节 · ${section.originalHeading}`));
      }
      meta.append(readingBasis(section.basis));
      detail.append(meta);
      if (section.readingCue) detail.append(readingCallout('精读提示', section.readingCue));
      detail.append(guideChapterBody(section));
      appendSources(detail, section.sources, false, { key:`guide:chapter:${key}`, research:true });
      article.append(heading, preview, detail);
      const setExpanded = expanded => {
        toggle.setAttribute('aria-expanded', String(expanded));
        preview.hidden = expanded;
        detail.hidden = !expanded;
      };
      setExpanded(openGuideChapter === key);
      return { article, toggle, key, setExpanded };
    }

    function cardRecommendation(candidate, key, previewLabel) {
      const saved = candidate.key && state().cards.find(card => card.candidateKey === candidate.key);
      const label = saved ? '编辑学习卡' : previewLabel;
      const button = action(label, () => previewCandidate(saved || candidate, saved?.id));
      button.setAttribute('aria-label', label);
      button.dataset.studyFocusKey = key;
      const recommendation = el('div','guanyi-study-card-recommendation');
      recommendation.append(paragraph(saved ? '已保存学习卡' : '建议学习卡','guanyi-study-eyebrow'), paragraph((saved || candidate).question), button);
      return recommendation;
    }
    function guideCandidateAction(prep, key) {
      const candidates = (prep.candidates || []).filter(item => item.question && item.answer && item.sources?.length);
      const candidate = candidates.find(item => /结论|总结/.test(item.type || '')) || candidates[0];
      return candidate ? cardRecommendation(candidate, `guide-card:${key}`, '存为学习卡') : null;
    }

    function renderReading(prep, host = body) {
      const reading = prep.reading;
      const resultKey = prep.id || prep.key || fingerprint(`${reading.title}:${reading.summary?.body}`);
      const summary = el('article','guanyi-study-reading-card guanyi-study-overview');
      summary.append(paragraph(`全文概览 · ${reading.documentType ? reading.documentType + ' · ' : ''}AI 辅助`,'guanyi-study-eyebrow'));
      summary.append(el('h3','',reading.title || doc.name));
      const overview = el('div', 'guanyi-study-guide-overview-text');
      const summaryText = fullText(reading.summary?.body);
      const lead = guideLead(summaryText, 100);
      if (lead && summaryText.startsWith(lead)) {
        overview.append(paragraph(lead, 'guanyi-study-guide-lead'));
        const rest = summaryText.slice(lead.length).trim();
        if (rest) overview.append(paragraph(rest));
      } else overview.append(paragraph(summaryText, 'guanyi-study-guide-lead'));
      summary.append(overview);
      appendSources(summary,reading.summary?.sources,false,{ key:`guide:overview:${resultKey}`, research:true });
      host.append(summary);
      if (reading.sections?.length) {
        const route = el('section','guanyi-study-reading-route');
        const ordered = reading.sectionOrder === 'source';
        route.append(sectionTitle(ordered ? '按原文脉络精读' : '分节解读'));
        const steps = el(ordered ? 'ol' : 'ul','guanyi-study-reading-steps');
        const chapters = reading.sections.map((section, index) => {
          const key = `${resultKey}:${index}`;
          return renderGuideChapter(section, key, () => {
            expandChapter(openGuideChapter === key ? '' : key);
          });
        });
        function expandChapter(key) {
          openGuideChapter = key;
          for (const chapter of chapters) chapter.setExpanded(chapter.key === key);
        }
        for (const chapter of chapters) {
          const entry = el('li');
          entry.append(chapter.article);
          steps.append(entry);
        }
        const first = chapters[0];
        const start = action('开始精读', () => {
          expandChapter(first.key);
          first.toggle.focus({ preventScroll:true });
          body.scrollTop += first.toggle.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
        }, 'is-primary guanyi-study-guide-read');
        start.setAttribute('aria-label', '开始精读');
        start.dataset.studyFocusKey = `guide-start:${resultKey}`;
        summary.append(start);
        route.append(steps);
        host.append(route);
      }
      const conclusion = readingConclusion(reading);
      const cardAction = guideCandidateAction(prep, resultKey);
      if (conclusion.length) {
        const wrap = el('article','guanyi-study-reading-card guanyi-study-wrap-up');
        wrap.append(sectionTitle('读完总结'));
        for (const [index, item] of conclusion.entries()) {
          const detail = el('div','guanyi-study-wrap-up-entry');
          const meta = el('div','guanyi-study-entry-heading');
          const title = item.title || { source:'研究支持', author:'作者结论', explanation:'要点回顾' }[normalizeBasis(item.basis)];
          meta.append(el('h4', '', title));
          meta.append(readingBasis(item.basis));
          detail.append(meta, paragraph(item.body));
          if (item.limits) detail.append(readingCallout('适用边界', item.limits));
          appendSources(detail,item.sources,false,{ key:`guide:conclusion:${resultKey}:${index}`, research:true });
          wrap.append(detail);
        }
        if (cardAction) wrap.append(cardAction);
        host.append(wrap);
      } else if (cardAction) host.append(cardAction);
      if(reading.terms?.length){const group=el('details','guanyi-study-detail-group');group.append(el('summary','',`术语与概念 · ${reading.terms.length}`));for(const item of reading.terms){const article=el('article','guanyi-study-entry');article.append(el('h4','',item.term),paragraph(item.explanation));appendSources(article,item.sources);group.append(article);}host.append(group);}
      if(reading.quotes?.length){const group=el('details','guanyi-study-detail-group');group.append(el('summary','',`原文摘引与译文 · ${reading.quotes.length}`));for(const item of reading.quotes){const article=el('article','guanyi-study-entry');article.append(el('blockquote','guanyi-study-exact-quote',item.quote));if(item.translation)article.append(paragraph('译文','guanyi-study-eyebrow'),paragraph(item.translation));appendSources(article,item.sources);group.append(article);}host.append(group);}
      if(reading.related?.length){const group=el('details','guanyi-study-detail-group');group.append(el('summary','',`延伸理解 · ${reading.related.length}`));for(const item of reading.related)group.append(readingEntry({...item,basis:'explanation'}));host.append(group);}
    }
    function renderGuideFailure(attempt, hasPrevious) {
      const notice = el('div','guanyi-study-notice');
      if (attempt.status === 'interrupted') {
        notice.append(paragraph('上次研读已中断。'));
      } else {
        const model = attempt.failure?.model;
        notice.append(el('h4','guanyi-study-error',guideFailureTitle(attempt.failure?.stage)));
        const reason = window.GuanyiModelErrors?.diagnosticMessage?.(model) || (attempt.error && errorText(attempt.error));
        if (reason) notice.append(paragraph(reason));
        if (model) {
          const details = el('details','guanyi-study-detail-group');
          details.append(el('summary','','查看诊断信息'));
          const response = `响应结构：${MODEL_PROTOCOL_LABELS[model.responseShape]}`;
          details.append(paragraph(`请求协议：${MODEL_PROTOCOL_LABELS[model.wireApi]} · ${response}${model.httpStatus ? ` · HTTP ${model.httpStatus}` : ''}`,'guanyi-study-muted'));
          details.append(paragraph(model.stopReason ? `服务结束原因：${model.stopReason}` : '服务未提供可识别的结束原因。','guanyi-study-muted'));
          notice.append(details);
        }
      }
      if (hasPrevious) notice.append(paragraph('已有导读仍可阅读。','guanyi-study-muted'));
      notice.append(action('重试全文研读',()=>beginTask(() => prepareRange(1,totalPages),'reading')));
      body.append(notice);
    }
    function renderQuickCard(quick) {
      const article = el('article','guanyi-study-reading-card guanyi-study-overview guanyi-study-quick');
      const head = el('div','guanyi-study-quick-heading');
      head.append(sectionTitle('摘要快读'), paragraph(`基于原文摘要 · ${guidePageLabel(quick.pages.map(page=>({page})))}`, 'guanyi-study-muted'));
      article.append(head, paragraph(quick.takeaway,'guanyi-study-quick-takeaway'));
      if (quick.purpose) article.append(paragraph(`阅读目的 · ${quick.purpose}`, 'guanyi-study-muted'));
      const fields = el('dl','guanyi-study-quick-fields');
      for (const [key,label] of Object.entries(QUICK_FIELDS)) {
        if (!quick[key]) continue;
        const field = el('div');
        field.append(el('dt','',label), el('dd','',quick[key]));
        fields.append(field);
      }
      article.append(fields);
      appendSources(article,quick.sources,false,{ key:'guide:abstract', research:true });
      body.append(article);
    }
    function renderGuide() {
      const preparations = state().preparations.filter(prep => prep.status === 'ready').slice().reverse();
      const latest = preparations.find(currentPreparation) || preparations.find(prep => prep.sourceHash === sourceHash) || preparations[0];
      const preparing = ui.busy && taskKind === 'reading';
      const quickBusy = ui.busy && taskKind === 'quick';
      const quick = state().quickReading?.sourceHash === sourceHash ? state().quickReading : null;
      const lastAttempt=state().preparations.filter(prep=>prep.sourceHash===sourceHash).at(-1);
      const failedAttempt = ui.unsavedReadingFailure || (lastAttempt && ['interrupted','error'].includes(lastAttempt.status) ? lastAttempt : null);
      const header = el('section','guanyi-study-guide-start guanyi-study-reading-card');
      const actionRow = el('div','guanyi-study-guide-heading');
      const actions = el('div','guanyi-study-guide-actions');
      actionRow.append(sectionTitle(preparing ? '正在研读…' : quickBusy ? '正在整理摘要…' : '智能导读'), actions);
      if (!preparing && !quickBusy) {
        const quickLabel = quick ? '重新快读' : '摘要快读';
        const preview = action(quickLabel, () => beginTask(prepareQuickReading, 'quick'), quick || currentPreparation(latest) ? '' : 'is-primary');
        preview.disabled = ui.busy;
        preview.dataset.studyFocusKey = 'guide:quick-read';
        actions.append(preview);
        const label = currentPreparation(latest) ? '重新研读' : '研读全文';
        const prepare = action(label, () => beginTask(() => prepareRange(1,totalPages),'reading'), quick && !currentPreparation(latest) ? 'is-primary' : '');
        prepare.setAttribute('aria-label', label);
        prepare.dataset.studyFocusKey = 'guide:full-read';
        prepare.disabled = ui.busy;
        actions.append(prepare);
      }
      if (ui.busy) {
        const stop = action('停止', () => taskController?.abort());
        stop.setAttribute('aria-label', '停止');
        actions.append(stop);
      }
      header.append(actionRow);
      const fullScope = `${preparing?'本次研读范围':'全文研读范围'}：全文 ${totalPages} 页${visualSupported?` · 全部文字与 ${totalPages} 页图像`:' · 全部可提取文字，不含页面图像'}`;
      const scope = paragraph(quickBusy ? '本次快读范围：原文摘要 · 仅文字' : fullScope,'guanyi-study-muted');
      scope.dataset.studyCurrentScope='';
      header.append(scope);
      if (!latest && !quick && !quickBusy) header.append(paragraph('先从原文摘要了解研究，再决定是否研读全文。','guanyi-study-guide-path'));
      if (!preparing && !quickBusy) {
        const purpose = el('details','guanyi-study-quick-purpose');
        purpose.open = quickPurposeOpen;
        const input = el('input');
        input.maxLength = 200;
        input.value = ui.quickPurpose;
        input.placeholder = '例如，想看这项研究怎么设计试验';
        input.setAttribute('aria-label','阅读目的');
        input.addEventListener('input', () => { ui.quickPurpose = input.value; scheduleDraft(); });
        purpose.append(el('summary','','补充摘要快读的目的'), input);
        purpose.addEventListener('toggle', () => { if (purpose.isConnected) quickPurposeOpen = purpose.open; }, {signal:listeners.signal});
        header.append(purpose);
      }
      if (preparing && latest) header.append(paragraph('新的全文结果生成中，此前结果保留在下方。','guanyi-study-muted'));
      modelNotice(header);
      if (ui.progress) {
        const progress = paragraph(ui.progress,'guanyi-study-notice');
        progress.setAttribute('role','status');
        header.append(progress);
      }
      const repeatedError=failedAttempt&&(ui.error===failedAttempt.error||(failedAttempt.status==='interrupted'&&ui.error.startsWith('已停止')));
      if(ui.error&&!repeatedError)header.append(paragraph(errorText(ui.error),'guanyi-study-notice error'));
      if (ui.quickError && !quickBusy) header.append(paragraph(ui.quickError,'guanyi-study-error'));
      body.append(header);
      if (quick) renderQuickCard(quick);
      if(failedAttempt&&!ui.busy) renderGuideFailure(failedAttempt, !!latest);
      if (!latest) return;
      const previous = preparing || !currentPreparation(latest);
      const result = el(previous?'details':'section',previous?'guanyi-study-previous':'guanyi-study-current-result');result.dataset.studyResultState=previous?'previous':'current';
      if (previous) {
        result.open = previousResultOpen;
        const summary = el('summary', '', '查看此前的研读结果');
        summary.setAttribute('aria-label', '查看此前的研读结果');
        const description = preparing ? '以下是此前保存的内容，不代表本次研读进度。'
          : latest.reading && !completeReading(latest.reading) ? '此前保存的导读结构不完整。可重新研读，生成包含概览、章节和总结的完整导读。'
          : '这是此前保存的结果。点击「研读全文」可生成当前全文解读。';
        result.append(summary, paragraph(description, 'guanyi-study-muted'));
        result.addEventListener('toggle', () => { if (result.isConnected) previousResultOpen = result.open; }, { signal:listeners.signal });
      }
      body.append(result);
      if(oldVersion(latest.sourceHash))result.append(paragraph('旧版研读 · 来源文件已有变化，原文快照仍保留。','guanyi-study-notice'));
      result.append(paragraph(coverageLabel(latest),'guanyi-study-coverage'));
      if(latest.coverage?.warnings?.length){const warnings=el('details','guanyi-study-extraction-warning');warnings.append(el('summary','',`${latest.coverage.warnings.length} 页的文字阅读顺序需核对`));for(const warning of latest.coverage.warnings)warnings.append(paragraph(`文件第 ${warning.page} 页：${warning.message}`));result.append(warnings);}
      if(latest.reading)renderReading(latest,result);else{result.append(sectionTitle('此前保存的导读（AI）'));for(const item of latest.guide || []){const article=el('article','guanyi-study-entry');article.append(el('h4','',item.title),paragraph(item.body));appendSources(article,item.sources);result.append(article);}}
      if (latest.questions?.length) {
        result.append(sectionTitle('继续追问'));
        for (const item of latest.questions) result.append(action(item.question, () => {
          if (!ui.draft.trim()) {
            ui.scope = oldVersion(latest.sourceHash)
              ? { mode:'selection', sources:clone(item.sources), sourceHash:latest.sourceHash }
              : documentContext();
            ui.draft = item.question;
          } else notify('输入框已有问题草稿，已保留。');
          selectTab('ask');
          body.querySelector('textarea')?.focus({ preventScroll:true });
        }));
      }
      if(latest.candidates?.length)result.append(action(`查看 ${latest.candidates.length} 张学习卡候选`,()=>selectTab('cards')));
    }
    async function ensureModel() { if (!await Promise.resolve(options.modelReady?.())) { options.configureModel?.(); throw new Error('请先完成模型配置，原文尚未发送。'); } }
    function abortCheck(signal) { if (signal?.aborted) throw new DOMException('已停止','AbortError'); }
    function pageVisual(page,pageLabel) { return {id:`pdf:${sourceHash}:p${page}:image`,page,pageLabel:pageLabel || String(page),sourceHash,kind:'page-image',text:'',rects:[],precise:false}; }
    function renderVisual(visual,settings) { return reader.renderVisual(visual,{signal:settings?.signal}); }
    async function extractRange(start,end,signal) {
      if(!validRange(start,end,totalPages))throw new Error(`请选择 1–${totalPages} 页内的有效整数范围。`);
      const blocks=[];const visuals=[];const scanned=[];const warnings=[];let complete=0;
      for(let page=start;page<=end;page+=1){abortCheck(signal);const data=await reader.page(page,{signal});abortCheck(signal);const warning=fullText(data.warning);if(warning)warnings.push({page,message:warning});blocks.push(...sourcesSnapshot(data.blocks).map(block=>warning?{...block,extractionStatus:'needs_review',extractionWarning:warning}:block));if(visualSupported)visuals.push(pageVisual(page,data.pageLabel || data.label));if(data.scanned||!data.blocks?.some(block=>fullText(block.text)))scanned.push(page);complete+=1;ui.progress=`正在读取文件第 ${page} 页 · ${complete}/${end-start+1}`;if(ui.tab==='guide')render();}
      return {blocks,visuals,scanned,warnings,start,end};
    }
    async function modelRequest(messages,settings={}) {
      const signal=settings.signal || taskController?.signal;
      abortCheck(signal);
      // Capture once for the entire multi-batch task, including later synthesis requests.
      if(!taskRequestSession)taskRequestSession=Promise.resolve(options.createRequestSession?options.createRequestSession({signal}):options.request);
      const request=await taskRequestSession;abortCheck(signal);
      if(typeof request!=='function')throw new Error('模型请求暂不可用，请检查顶部 … > 模型配置。');
      const controller=taskController;
      const requestBudget=Math.max(1000,Math.min(300000,Number(settings.timeoutMs)||90000));
      const timer=setTimeout(()=>controller?.abort(),requestBudget*2+5000);let abort;
      try{return await new Promise((resolve,reject)=>{abort=()=>reject(new DOMException('已停止','AbortError'));signal?.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>request(messages,{...settings,signal})).then(resolve,reject);});}
      finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
    }
    function onProgress(value) {
      ui.progress=typeof value==='string'?value:value?.message || '正在研读原文…';render();
    }
    function paperReader() {
      if(!window.GuanyiPaperReader?.prepare || !window.GuanyiPaperReader?.answer)throw new Error('全文研读组件尚未加载，请重新打开应用。已有结果仍保留。');
      return window.GuanyiPaperReader;
    }
    function beginTask(work, kind = null) {
      if(ui.busy || disposed)return activeTask;
      ui.busy=true;ui.error='';taskController=new AbortController();taskRequestSession=null;taskKind=kind;
      if(kind==='reading'){ui.unsavedReadingFailure=null;previousResultOpen=false;const previous=body.querySelector('.guanyi-study-previous');if(previous)previous.open=false;}
      if (kind === 'quick') ui.quickError = '';
      const controller=taskController;
      activeTask=(async()=>{
        try { await work(controller.signal); }
        catch (error) {
          const message = error.name === 'AbortError' ? '已停止。本次输入和已有结果已保留，可以重试。' : errorText(error);
          if (kind === 'quick') ui.quickError = message;
          else ui.error = message;
        } finally { ui.busy=false;ui.progress='';taskController=null;taskRequestSession=null;taskKind=null;render(); }
      })();
      render();return activeTask;
    }
    async function prepareQuickReading(signal) {
      const engine = paperReader();
      const purpose = clean(ui.quickPurpose, 200);
      onProgress('正在查找可核对的原文摘要…');
      const blocks = [];
      let abstract = [];
      for (let page = 1; page <= Math.min(2, totalPages) && !abstract.length; page += 1) {
        const input = await reader.page(page, {signal});
        abortCheck(signal);
        blocks.push(...sourcesSnapshot(input.blocks).filter(block => block.sourceHash === sourceHash && block.page === page));
        // Keep the verified array returned by the extractor as the request scope.
        abstract = engine.extractAbstract(blocks);
      }
      if (!abstract.length) throw new Error('前两页没有识别到可核对的原文摘要。可以继续研读全文。');
      await ensureModel();
      abortCheck(signal);
      onProgress('正在整理原文摘要…');
      const result = await engine.quick({ blocks:abstract, request:modelRequest, signal, title:doc.name, purpose });
      abortCheck(signal);
      const quick = normalizeQuickReading({ ...result, sourceHash, purpose, pages:abstract.map(block=>block.page) });
      if (!quick) throw new Error('摘要快读结果不完整，请重试。');
      await save(next => { abortCheck(signal); next.quickReading = quick; });
    }
    async function prepareRange(start,end) {
      const signal=taskController.signal;
      const engine=paperReader();
      if(!validRange(start,end,totalPages))throw new Error(`请选择 1–${totalPages} 页内的有效整数范围。`);
      const key=preparationKey();
      await ensureModel();abortCheck(signal);
      const attemptId=uid();const pending={id:attemptId,key,sourceHash,start,end,status:'preparing',createdAt:Date.now()};
      // Keep an existing ready result until its replacement has completed and persisted.
      await save(next=>{next.preparations.push(pending);});
      try{
        const extracted=await extractRange(start,end,signal);
        if(!extracted.blocks.some(item=>item.text)&&!extracted.visuals.length)throw new Error('当前文字研读没有可用文字层，请使用支持页面图像的阅读器重新打开 PDF。');
        const result=await engine.prepare({blocks:extracted.blocks,visuals:extracted.visuals,renderVisual:visualSupported?renderVisual:undefined,request:modelRequest,signal,onProgress,title:doc.name});abortCheck(signal);
        const reading=normalizeReading(result.reading);
        if (!completeReading(reading)) throw new Error('全文导读缺少有原文依据的概览、章节精读或读完总结。请重试。');
        const candidates=(result.candidates || []).map((item,index)=>({...item,id:`${attemptId}-candidate-${index}`,key:`${sourceHash}:${key}:${fingerprint(`${item.question}:${(item.sources || []).map(source=>source.id).join(',')}`)}`,sources:sourcesSnapshot(item.sources),sourceHash,ai:true}));
        const ready={...pending,reading,questions:(result.questions || []).map(item=>({...item,sources:sourcesSnapshot(item.sources)})),candidates,status:'ready',coverage:{...result.coverage,pages:end-start+1,scannedPages:extracted.scanned,warnings:extracted.warnings},completedAt:Date.now()};
        await save(next=>{abortCheck(signal);next.preparations=next.preparations.filter(prep=>prep.key!==key);next.preparations.push(ready);});
      } catch (error) {
        const interrupted = signal.aborted || error.name === 'AbortError';
        const failure = !interrupted && studyFailureSnapshot({ stage:error.studyStage, model:error.modelDiagnostic });
        const attempt = { status:interrupted ? 'interrupted' : 'error', error:errorText(error), ...(failure ? { failure } : {}) };
        try {
          await save(next => {
            const target = next.preparations.find(prep => prep.id === attemptId);
            if (target) Object.assign(target, attempt);
          });
        } catch (_) {
          // Keep the diagnosis visible in this window even if storage fails.
          ui.unsavedReadingFailure = attempt;
        }
        throw error;
      }
    }
    function askPrompts() {
      if (ui.scope.citation) {
        return ui.scope.mode === 'selection'
          ? ['这段原文在论证中起什么作用？', '这里有哪些条件或限制值得核对？']
          : ['这页原文提供了哪些证据？', '这页结果的单位、比较对象和条件是什么？'];
      }
      const preparation = state().preparations.slice().reverse().find(currentPreparation);
      const suggested = (preparation?.questions || []).map(item => clean(item.question, 4000)).filter(Boolean);
      return [...new Set([...suggested, '这份文档主要回答什么问题？', '哪些原文证据支撑主要结论？', '理解这份文档时需要注意哪些限制？'])].slice(0, 3);
    }
    let askDraftVersion = 0;
    function updateAskDraft(value) {
      ui.draft = value;
      askDraftVersion += 1;
    }
    function beginAsk(options) {
      return beginTask(() => sendQuestion(options), 'ask');
    }
    function renderAsk() {
      const messages = el('div', 'guanyi-study-messages');
      messages.tabIndex = 0;
      messages.setAttribute('aria-label', '文档对话记录');
      const thread = el('div', 'guanyi-study-ask-thread');
      const history = state().messages;
      for (const item of history) thread.append(renderAskTurn(item));
      if (!history.length || (ui.scope.citation && followupPromptCount === history.length)) {
        const empty = el('section', 'guanyi-study-chat-empty');
        const prompts = el('div', 'guanyi-study-ask-prompts');
        empty.append(sectionTitle('试试这样问'));
        for (const question of askPrompts()) {
          const shortcut = action(question, () => {
            body.querySelector('.guanyi-study-composer textarea')?.focus({preventScroll:true});
            return beginAsk({question});
          });
          shortcut.disabled = ui.busy;
          prompts.append(shortcut);
        }
        empty.append(prompts);
        thread.append(empty);
      }
      messages.append(thread);

      const composer = el('div', 'guanyi-study-composer');
      const controls = el('div', 'guanyi-study-ask-controls');
      const canExpandCitation = ui.scope.citation && !oldVersion(ui.scope.sourceHash) && totalPages > 1;
      if (followupOrigin || canExpandCitation) {
        const returnSource = el('div', 'guanyi-study-ask-origin');
        if (followupOrigin) {
          const label = followupOrigin.chapter ? '回到章节' : '回到导读';
          const back = action(label, () => {
            selectTab('guide');
            focusEvidenceOrigin(followupOrigin);
          });
          back.dataset.studyFocusKey = 'ask-guide-origin';
          returnSource.append(back);
        }
        if (canExpandCitation) {
          const expand = action('扩大到相邻页', openScopeDialog);
          expand.dataset.studyFocusKey = 'ask-citation-expand';
          returnSource.append(expand);
        }
        controls.append(returnSource);
      }
      const scope = el('div', 'guanyi-study-scope');
      const select = el('select');
      select.setAttribute('aria-label', '文档对话范围');
      const pageLabel = ui.scope.citation && ui.scope.mode === 'page' ? '出处页' : '当前页';
      const selectionLabel = ui.scope.citation && ui.scope.mode === 'selection' ? '出处摘录' : '当前选区';
      for (const [value, label] of [['document','全文'], ['page',pageLabel], ['selection',selectionLabel], ['range','指定页段']]) {
        const option = el('option', '', label);
        option.value = value;
        select.append(option);
      }
      select.value = ui.scope.mode;
      select.addEventListener('change', async () => {
        const mode = select.value;
        select.value = ui.scope.mode;
        if (mode === 'range') return openScopeDialog();
        await changeAskScope(mode, select);
      });

      const label = ui.scope.mode === 'document' && !oldVersion(ui.scope.sourceHash)
        ? `文件第 ${totalPages > 1 ? `1–${totalPages}` : '1'} 页` : scopeLabel();
      const rangeLabel = el('span', 'guanyi-study-scope-label', label);
      rangeLabel.id = `guanyi-study-ask-scope-${doc.id}`;
      rangeLabel.title = label;
      select.setAttribute('aria-describedby', rangeLabel.id);
      scope.append(select, rangeLabel);
      if (ui.scope.mode !== 'document' || oldVersion(ui.scope.sourceHash)) {
        const refreshLabel = { document:'更新全文范围', page:'更新到当前阅读页', selection:'更新到当前选区', range:'调整页段' }[ui.scope.mode];
        scope.append(iconAction(refreshLabel, '<path d="M12.6 6a4.8 4.8 0 1 0 .2 3M10 2.5h3v3"/>', event =>
          ui.scope.mode === 'range' ? openScopeDialog() : changeAskScope(ui.scope.mode, event.currentTarget), 'guanyi-study-scope-refresh'));
      }
      controls.append(scope);
      if (ui.scope.mode === 'selection') {
        const preview = (ui.scope.sources || []).map(source => source.text).filter(Boolean).join('\n');
        if (preview) controls.append(el('blockquote', 'guanyi-study-ask-selection', preview));
      }

      const input = el('textarea');
      input.value = ui.draft;
      input.maxLength = 4000;
      input.rows = 2;
      input.placeholder = '围绕原文提问…';
      input.setAttribute('aria-label', '研读问题');
      const askPending = ui.busy && taskKind === 'ask';
      const send = iconAction(askPending ? '停止' : '发送',
        askPending ? '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>' : '<path d="M8 12.5v-9m-3.5 3.5L8 3.5l3.5 3.5"/>',
        () => {
          input.focus({preventScroll:true});
          return askPending ? taskController?.abort() : beginAsk();
        }, 'is-primary guanyi-study-send');
      send.dataset.studyFocusKey = 'ask-send';
      const syncSend = () => { send.disabled = !askPending && (ui.busy || !ui.draft.trim()); };
      input.addEventListener('input', () => {
        updateAskDraft(input.value);
        syncSend();
        scheduleDraft();
      });
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229 || ui.composing) return;
        event.preventDefault();
        event.stopPropagation();
        if (!ui.busy && ui.draft.trim()) beginAsk();
      });
      syncSend();
      const inputBox = el('div', 'guanyi-study-composer-input');
      inputBox.append(input, send);
      controls.append(inputBox);
      const shortcut = 'Enter 发送 · Shift + Enter 换行';
      const selectionText = ui.scope.citation ? '出处摘录' : '选中文字';
      const disclosure = visualSupported
        ? ui.scope.mode === 'selection' ? `发送${selectionText}及所在整页图像` : '发送所选范围内的文字和页面图像'
        : '发送所选范围内的可提取文字';
      const hint = paragraph(`${disclosure} · ${shortcut}`, 'guanyi-study-composer-hint');
      hint.id = `guanyi-study-ask-hint-${doc.id}`;
      input.setAttribute('aria-describedby', hint.id);
      controls.append(hint);
      if (askPending && ui.progress) {
        const progress = paragraph(ui.progress, 'guanyi-study-ask-progress');
        progress.setAttribute('role', 'status');
        controls.append(progress);
      }
      if (ui.error && !history.some(item => item.status !== 'ready' && item.error &&
          (item.error === ui.error || (item.status === 'interrupted' && ui.error.startsWith('已停止'))))) {
        controls.append(paragraph(errorText(ui.error), 'guanyi-study-notice error'));
      }
      modelNotice(controls);
      composer.append(controls);
      body.append(messages, composer);
    }
    function renderAskTurn(item) {
      const article = el('article', 'guanyi-study-chat');
      article.dataset.askId = item.id;
      article.append(
        paragraph(item.question, 'guanyi-study-ask-question'),
        paragraph(item.scopeLabel || '已锁定来源', 'guanyi-study-muted guanyi-study-ask-scope')
      );
      const answer = el('div', 'guanyi-study-ask-answer');
      if (item.status === 'ready' && !item.insufficient) {
        answer.append(paragraph(item.answer));
        appendSources(answer,item.sources,false,{compact:true,key:'ask:'+item.id,research:true});
        const candidate = item.candidateKey && state().supplemental.find(card => card.key === item.candidateKey);
        if (candidate) answer.append(cardRecommendation(candidate, `ask:card:${item.id}`, '预览建议学习卡'));
        else if (item.sources?.length) answer.append(action('生成学习卡草稿', () => previewCandidate({
          id:item.id, key:`answer:${item.id}`, question:item.question, answer:item.answer,
          sources:item.sources, sourceHash:item.sourceHash, type:'文档对话', ai:true
        }), 'guanyi-study-ask-card'));
      } else if (item.status === 'pending') {
        const pending = paragraph('正在查找原文并生成回答…', 'guanyi-study-ask-progress');
        pending.setAttribute('role', 'status');
        answer.append(pending);
      } else {
        const exhausted = item.status === 'ready' && item.insufficient;
        const notice = el('div', 'guanyi-study-ask-notice');
        if (exhausted) notice.append(paragraph(INSUFFICIENT_ANSWER));
        else {
          notice.append(paragraph(item.status === 'interrupted' ? '任务已中断，可以重试。' : '本次回答失败。'));
          if (item.error) notice.append(paragraph(errorText(item.error), 'guanyi-study-muted'));
        }
        const currentSource = item.context?.sourceHash === sourceHash;
        if (!currentSource && item.context?.sourceHash) {
          notice.append(paragraph('来源文件已有变化，请在当前 PDF 重新选择提问范围。', 'guanyi-study-muted'));
        } else if (currentSource && (!exhausted || item.context.mode !== 'document')) {
          const retry = action(exhausted ? '用全文重试' : '重试这次问题',
            () => beginAsk({retry:item, context:exhausted ? documentContext() : item.context}));
          retry.disabled = ui.busy;
          notice.append(retry);
        }
        answer.append(notice);
      }
      article.append(answer);
      return article;
    }
    async function changeAskScope(mode, origin) {
      if (mode === 'selection') {
        const captured = await reader.captureSelection();
        if (disposed || !origin.isConnected || !ui.open) return;
        const sources = sourcesSnapshot(captured?.sources).filter(source => source.sourceHash === sourceHash && source.text);
        if (!sources.length) {
          notify('请先在 PDF 中选择文字。');
          return;
        }
        ui.scope = {mode:'selection',sourceHash,sources};
      } else ui.scope = mode === 'document' ? documentContext() : pageContext();
      render();
      scheduleDraft();
    }
    async function contextEvidence(context,signal) {
      if(context.sourceHash!==sourceHash) throw new Error('这段问题的来源属于旧文件版本。请选择当前文件的范围；旧记录仍可查看或导出。');
      if(context.mode==='selection') {
        const sources=sourcesSnapshot(context.sources);
        const pages=new Map();
        for(const source of sources){
          abortCheck(signal);
          if(source.sourceHash!==sourceHash || !source.text)throw new Error('选区来源已经失效，请重新选择原文。');
          if(!pages.has(source.page))pages.set(source.page,await reader.page(source.page,{signal}));
          const page=pages.get(source.page);const exact=page.blocks?.find(block=>block.id===source.id);const local=exact?.text || (page.blocks||[]).map(block=>block.text).join('');
          if(!normalizedText(local).includes(normalizedText(source.text)))throw new Error('选区原文已无法与当前 PDF 核对，请重新选择；旧记录仍保留。');
        }
        return {blocks:sources,visuals:visualSupported?[...pages.keys()].map(page=>pageVisual(page,pages.get(page).pageLabel || pages.get(page).label)):[]};
      }
      const result=await extractRange(context.mode==='document'?1:Number(context.start),context.mode==='document'?totalPages:Number(context.end ?? context.start),signal);return result;
    }
    function includesAskContext(context, previous) {
      if (context.mode === 'document') return true;
      if (!previous || previous.sourceHash !== context.sourceHash) return false;
      const previousSelection = Array.isArray(previous.sources) ? previous.sources : [];
      if (context.mode === 'selection') {
        if (previous.mode !== 'selection' || !previousSelection.length || !Array.isArray(context.sources)) return false;
        return previousSelection.every(source => source && context.sources.some(selected =>
          selected?.id === source.id && selected.page === source.page && selected.text === source.text));
      }
      const start = Number(context.start), end = Number(context.end ?? context.start);
      if (previous.mode === 'selection') {
        return previousSelection.length > 0 && previousSelection.every(source => source && source.page >= start && source.page <= end);
      }
      if (previous.mode !== 'page' && previous.mode !== 'range') return false;
      const previousStart = Number(previous.start), previousEnd = Number(previous.end ?? previous.start);
      return previousStart >= start && previousStart <= previousEnd && previousEnd <= end;
    }
    async function sendQuestion({retry, context:range, question:prompt, makeCard=retry?.makeCard === true} = {}) {
      const signal = taskController.signal;
      const draft = ui.draft;
      const draftVersion = askDraftVersion;
      const question = clean(retry?.question ?? prompt ?? draft, 4000);
      const context = clone(range || retry?.context || ui.scope);
      if (!question) throw new Error('请先输入问题。');
      const preceding = state().messages.slice(0, retry ? state().messages.findIndex(entry => entry.id === retry.id) : undefined);
      const history = preceding.filter(entry =>
        entry.status === 'ready' && !entry.insufficient && entry.sourceHash === sourceHash && includesAskContext(context, entry.context))
        .slice(-4).map(entry => ({question:entry.question, answer:entry.answer}));
      await ensureModel();
      abortCheck(signal);
      const id=retry?.id||uid();const item={id,sourceHash,question,context,makeCard,scopeLabel:scopeLabel(context),status:'pending',sources:[],createdAt:retry?.createdAt || Date.now()};
      await save(next=>{const index=next.messages.findIndex(entry=>entry.id===id);if(index>=0)next.messages[index]=item;else next.messages.push(item);});render();
      if (!retry && ui.tab === 'ask') {
        const messages = body.querySelector('.guanyi-study-messages');
        if (messages) messages.scrollTop = messages.scrollHeight;
      }
      let answerSaved=false;
      try{
        const extracted=await contextEvidence(context,signal);const {blocks,visuals}=extracted;if(!blocks.some(item=>item.text)&&!visuals.length)throw new Error('当前文字研读范围没有可用文字依据，请使用支持页面图像的阅读器重新打开 PDF。');
        const answer=normalizeAnswer(await paperReader().answer({blocks,visuals,renderVisual:visualSupported?renderVisual:undefined,request:modelRequest,signal,onProgress,question,history,makeCard,title:doc.name}));abortCheck(signal);
        const { card, ...result } = answer;
        const candidate = answerCardCandidate(card,id);
        await save(next => {
          abortCheck(signal);
          Object.assign(next.messages.find(entry=>entry.id===id), result, { status:'ready', completedAt:Date.now(), candidateKey:candidate?.key || '' });
          if (candidate && !next.supplemental.some(item=>item.key===candidate.key)) next.supplemental.push(candidate);
        });
        answerSaved=true;
        if (!retry && prompt === undefined && askDraftVersion === draftVersion && ui.draft === draft) updateAskDraft('');
        await save();
        if (makeCard && candidate && !signal.aborted && ui.open && ui.tab === 'ask') previewCandidate(candidate);
        else if (makeCard && !candidate && !answer.insufficient) ui.error='文档回答已保留，但模型未返回完整学习卡。可以从回答创建草稿，或重试生成。';
      }catch(error){if(!answerSaved)await save(next=>{const target=next.messages.find(entry=>entry.id===id);if(target){target.status=signal.aborted?'interrupted':'error';target.error=error.message;}});throw error;}
    }
    function answerCardCandidate(value,id) {
      const question = fullText(value?.question);
      const answer = fullText(value?.answer);
      const sources = sourcesSnapshot(value?.sources).filter(source => source.sourceHash === sourceHash);
      if (!question || !answer || !sources.length) return null;
      const key = `manual:${sourceHash}:${fingerprint(`${question}:${sources.map(source=>source.id).join(',')}`)}`;
      return { id:`manual-${id}`,key,question,answer,type:fullText(value.type)||'文档对话',sourceHash,sources,ai:true };
    }
    function openScopeDialog() {
      dialogEpoch+=1;
      prepareDialog('锁定提问页段', '选择下一轮提问的起止页。已发送的问答保留原范围。');
      const citationPage = ui.scope.citation && ui.scope.sourceHash === sourceHash && ui.scope.start;
      const startPage = citationPage ? Math.max(1, citationPage - 1) : ui.scope.start || currentPage();
      const endPage = citationPage ? (citationPage === 1 ? Math.min(totalPages, 2) : citationPage)
        : ui.scope.end || Math.min(totalPages, currentPage() + 19);
      const start=el('input');start.type='number';start.min='1';start.max=String(totalPages);start.value=String(startPage);start.setAttribute('aria-label','提问起始页');
      const end=el('input');end.type='number';end.min='1';end.max=String(totalPages);end.value=String(endPage);end.setAttribute('aria-label','提问结束页');
      const error=paragraph('','guanyi-study-error');const row=el('div','guanyi-study-range');row.append(start,el('span','','至'),end);dialog.append(row,error,action('取消',()=>dialog.close()),action('使用这个页段',()=>{const a=Number(start.value),b=Number(end.value);if(!validRange(a,b,totalPages)){error.textContent=`请选择 1–${totalPages} 页内的有效整数范围。`;return;}ui.scope={mode:'range',start:a,end:b,sourceHash};dialog.close();render();scheduleDraft();},'is-primary'));dialog.showModal();
    }
    function renderCards() {
      if(ui.testCard){renderTest();return;}
      body.append(sectionTitle('AI 学习卡候选'),paragraph('候选只有经你预览、编辑并确认保留后，才进入“我的学习卡”、自测和导出。','guanyi-study-muted'));
      const candidates=[...state().preparations.flatMap(prep=>prep.candidates||[]),...state().supplemental].filter(candidate=>!state().cards.some(card=>card.candidateKey===candidate.key));
      if(!candidates.length)body.append(paragraph('先研读全文，或从选区、文档对话补充学习卡。','guanyi-study-empty'));
      for(const candidate of candidates){const article=el('article','guanyi-study-entry');article.append(paragraph(`${oldVersion(candidate.sourceHash)?'旧版 · ':''}${candidate.type}`,'guanyi-study-muted'),el('h4','',candidate.question),action('预览与编辑',()=>previewCandidate(candidate)));appendSources(article,candidate.sources);body.append(article);}
      body.append(sectionTitle(`我的学习卡 · ${state().cards.length}`));
      for(const card of state().cards){const article=el('article','guanyi-study-entry');article.append(el('h4','',card.question),paragraph(card.answer),paragraph(`${card.ai?'AI 辅助 · 已确认保留':'我的记录'}${card.reviews?.length?` · 最近自评：${card.reviews.at(-1).rating}`:''}`,'guanyi-study-muted'));appendSources(article,card.sources);article.append(action('开始自测',()=>{ui.testCard=card.id;ui.testRevealed=false;render();}),action('编辑',()=>previewCandidate(card,card.id)));body.append(article);}
      if(ui.error)statusNotice(body);
    }
    function previewCandidate(candidate,editId) {
      const epoch=++dialogEpoch;dialogCandidate=clone(candidate);const frozenCandidate=clone(candidate);prepareDialog(editId?'编辑学习卡':'预览学习卡','核对原文，修改成自己的表达。确认后才保存。');
      const q=el('textarea');q.value=candidate.question;q.maxLength=1000;q.setAttribute('aria-label','学习卡问题');const a=el('textarea');a.value=candidate.answer;a.maxLength=8000;a.setAttribute('aria-label','学习卡答案');dialog.append(el('label','','问题'),q,el('label','','答案'),a);appendSources(dialog,candidate.sources,true);
      const error=paragraph('','guanyi-study-error');const confirm=action('确认保留',async()=>{if(!q.value.trim()||!a.value.trim()){error.textContent='请填写问题和答案。';return;}confirm.disabled=true;const edits={question:q.value,answer:a.value};try{await save(next=>{if(editId){const target=next.cards.find(card=>card.id===editId);if(target){target.question=clean(edits.question,1000);target.answer=clean(edits.answer,8000);target.updatedAt=Date.now();}}else addCard(next,frozenCandidate,edits);});if(dialog.open&&dialogEpoch===epoch)dialog.close();notify('学习卡已保存。');render();}catch(e){error.textContent=ui.storageError;confirm.disabled=false;}},'is-primary');
      dialog.append(error,action('取消',()=>dialog.close()),confirm);dialog.showModal();
    }
    function renderTest() {
      const card=state().cards.find(item=>item.id===ui.testCard);if(!card){ui.testCard=null;renderCards();return;}body.append(sectionTitle('先回忆，再核对'),el('h4','',card.question));
      if(!ui.testRevealed)body.append(action('显示答案',()=>{ui.testRevealed=true;render();},'is-primary'));
      else{body.append(paragraph(card.answer));appendSources(body,card.sources,true);body.append(paragraph('这是你的自评，不代表系统判断已掌握。','guanyi-study-muted'));for(const rating of ['仍需复习','基本理解','能解释清楚'])body.append(action(rating,async()=>{try{await save(next=>next.cards.find(item=>item.id===card.id).reviews.push({at:Date.now(),rating}));ui.testCard=null;render();}catch(_){}}));}
      body.append(action('返回学习卡',()=>{ui.testCard=null;render();}));
    }
    let annotationEpoch=0;
    async function refreshAnnotations() {
      const epoch=++annotationEpoch;
      try {
        const annotations = await reader.annotations();
        if (disposed || epoch !== annotationEpoch) return;
        const next = Array.isArray(annotations) ? annotations : [];
        const changed = ui.annotationError || JSON.stringify(next) !== JSON.stringify(ui.nativeAnnotations);
        ui.nativeAnnotations = next;
        ui.annotationError = '';
        if (changed && ui.tab === 'notes' && ui.open) render();
      }
      catch(error) { if(disposed||epoch!==annotationEpoch)return;ui.annotationError='暂时无法读取 PDF 批注，请重试。';if(ui.tab==='notes'&&ui.open)render(); }
    }
    function beginNote(note) {
      if(ui.noteEditor)return;
      ui.noteEditingId=note?.id||null;ui.noteDraft=note?.text||'';
      ui.noteContext=note?{mode:'selection',sourceHash:note.sourceHash||note.sources?.[0]?.sourceHash||sourceHash,
        sources:sourcesSnapshot(note.sources),kind:note.kind}:pageContext();
      ui.noteEditor=true;render();body.querySelector('[aria-label="研读笔记"]')?.focus();scheduleDraft();
    }
    function openResearchExcerpt(evidence) {
      const source = sourceSnapshot(evidence);
      if (!source) return;
      if (ui.noteEditor) {
        const existing = ui.noteContext?.sources?.[0];
        const sameDraft = !ui.noteEditingId && ui.noteContext?.kind === 'research-excerpt'
          && existing?.id === source.id && existing.sourceHash === source.sourceHash && existing.text === source.text;
        if (!sameDraft) {
          selectTab('notes');
          body.querySelector('[aria-label="研读笔记"]')?.focus();
          notify('当前有一条未保存的笔记，已保留。');
          return;
        }
      } else {
        ui.noteContext = { mode:'selection', sourceHash:source.sourceHash, sources:[source], kind:'research-excerpt' };
        ui.noteEditor = true;
        scheduleDraft();
      }
      const context = ui.noteContext;
      const epoch = ++dialogEpoch;
      prepareDialog('存为研究摘录', '保留出处，可以写下自己的判断。');
      const pageLabel = source.pageLabel && source.pageLabel !== String(source.page) ? ` · 页标签 ${source.pageLabel}` : '';
      dialog.append(paragraph(`文件第 ${source.page} 页${pageLabel}${oldVersion(source.sourceHash) ? ' · 旧版来源' : ''}`, 'guanyi-study-muted'));
      if (source.text) dialog.append(el('blockquote', 'app-composer__quote', source.text));
      if (source.kind === 'page-image') {
        dialog.append(paragraph('图表所在页 · 页面级出处', 'guanyi-study-muted'));
        appendVisualPreview(dialog, source);
      }
      const label = el('label', '', '我的判断（可选）');
      const input = el('textarea');
      input.id = `pdf-study-excerpt-note-${doc.id}`;
      input.setAttribute('aria-label', '研读笔记');
      input.maxLength = 8000;
      input.value = ui.noteDraft;
      label.htmlFor = input.id;
      input.addEventListener('input', () => { ui.noteDraft = input.value; scheduleDraft(); }, { signal:listeners.signal });
      const feedback = paragraph('', 'guanyi-study-error');
      feedback.setAttribute('role', 'alert');
      const confirm = action('保存摘录', async () => {
        if (ui.noteSaving) return;
        confirm.disabled = true;
        input.readOnly = true;
        const saved = await saveDraftNote();
        if (!saved) {
          input.readOnly = false;
          confirm.disabled = false;
          feedback.textContent = ui.storageError;
          return;
        }
        if (dialog.open && dialogEpoch === epoch) {
          dialog.close();
          selectTab('notes');
        }
        notify('研究摘录已保存。');
      }, 'is-primary');
      dialog.append(label, input, feedback, action('取消', () => dialog.close()), confirm);
      dialog.addEventListener('close', () => {
        if (ui.noteContext !== context || ui.noteDraft.trim() || ui.noteSaving) return;
        ui.noteDraft = '';
        ui.noteEditor = false;
        ui.noteContext = null;
        scheduleDraft();
      }, { once:true, signal:listeners.signal });
      dialog.showModal();
      input.focus();
    }
    async function finishNote(change) {
      if(ui.noteSaving)return;const editingId=ui.noteEditingId;let completed=false;ui.noteSaving=true;render();
      try {
        await save(next=>{change?.(next);next.noteDraft='';next.noteEditingId=null;next.noteEditor=false;next.noteContext=null;});
        ui.noteDraft='';ui.noteEditingId=null;ui.noteEditor=false;ui.noteContext=null;completed=true;
      } catch(_) {} finally {ui.noteSaving=false;render();if(completed){const card=[...body.querySelectorAll('[data-note-kind="study"]')].find(node=>node.dataset.noteId===editingId);(card?.querySelector('[aria-label="编辑笔记"]')||body.querySelector('.guanyi-study-notes-toolbar button'))?.focus({preventScroll:true});}}
      return completed;
    }
    function saveDraftNote() {
      const context = ui.noteContext || pageContext();
      const text = clean(ui.noteDraft, 8000);
      const research = context.kind === 'research-excerpt';
      if (!text && !research) return false;
      const id = ui.noteEditingId;
      const sources = context.sources?.length ? sourcesSnapshot(context.sources) : [sourceSnapshot({
        id:`page-${context.start}`, page:context.start, pageLabel:String(context.start), text:'', rects:[], sourceHash:context.sourceHash
      })];
      return finishNote(next => {
        if (id) {
          const note = next.notes.find(item => item.id === id);
          if (!note) throw new Error('这条笔记已不存在，草稿仍保留。');
          note.text = text;
          note.updatedAt = Date.now();
        } else {
          next.notes.push({ id:uid(), text, sources, sourceHash:context.sourceHash,
            ...(research ? {kind:'research-excerpt'} : {}), createdAt:Date.now() });
        }
      });
    }
    function noteSource(note,native=false) {
      return native?sourceSnapshot({...note,id:note.id||`annotation-${note.page}`,text:note.quote||'',sourceHash:note.sourceHash||sourceHash}):note.sources?.[0];
    }
    function focusNote(id,label) {
      const card=[...body.querySelectorAll('[data-note-kind="study"]')].find(node=>node.dataset.noteId===id);
      (card?.querySelector(`[aria-label="${label}"]`)||body.querySelector('.guanyi-study-notes-toolbar button'))?.focus({preventScroll:true});
    }
    function renderNoteCard(note,native=false) {
      const article=el('article','app-comment-card guanyi-study-note-card');article.dataset.noteKind=native?'native':'study';article.dataset.noteId=note.id;
      const source=noteSource(note,native);const quote=clean(native?note.quote:source?.text,16000);
      const head=el('div','app-comment-card__head');
      const page=source?`${oldVersion(source.sourceHash)?'旧版 · ':''}第 ${source.page} 页`:'';
      const research = !native && note.kind === 'research-excerpt';
      const linkLabel = source?.kind === 'page-image' ? `${page} · 图表所在页` : page;
      const quoteButton=action(quote||linkLabel||'未关联原文',event=>source&&locate(source,event.currentTarget),'app-comment-card__quote');quoteButton.title=[linkLabel,quote].filter(Boolean).join(' · ');quoteButton.setAttribute('aria-label',`定位批注：${linkLabel}${quote?' · '+quote:''}`);quoteButton.disabled=!source;
      quoteButton.dataset.studyEvidence=`note:${note.id}`;
      head.append(quoteButton);
      if(!native) {
        const actions=el('div','app-comment-card__actions');
        const edit=iconAction('编辑笔记','<path d="m9.7 3.2 3.1 3.1M3 13l.7-3.7 7-7a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-7 7L3 13Z"/>',()=>beginNote(note));edit.disabled=ui.noteEditor;
        const remove=iconAction('删除笔记','<path d="M2.5 4.5h11M6 4.5V2.7h4v1.8M4 4.5l.6 9h6.8l.6-9M6.5 7v4M9.5 7v4"/>',()=>{ui.noteDeleteId=note.id;render();body.querySelector('.guanyi-study-note-delete button')?.focus({preventScroll:true});},'is-delete');remove.disabled=ui.noteEditingId===note.id;
        actions.append(edit,remove);head.append(actions);
      }
      article.append(head);
      const comment=clean(native?(note.subtype==='FreeText'?note.text:(note.comment??(note.text!==note.quote?note.text:''))):note.text,12000);if(comment)article.append(paragraph(comment));
      const nativeTypes={Highlight:'高亮',Underline:'下划线',StrikeOut:'删除线',Squiggly:'波浪线',Text:'评论',FreeText:'文本',Ink:'绘注',Stamp:'印章'};
      const type=native?`PDF ${nativeTypes[note.subtype]||'批注'}`:research?'研究摘录':'研读笔记';
      const pageLabel = research && source?.pageLabel && source.pageLabel !== String(source.page) ? `页标签 ${source.pageLabel}` : '';
      const at=note.updatedAt||note.createdAt;const date=at?new Date(at):null;const time=date&&Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
      article.append(el('small','',[page,pageLabel,type,time].filter(Boolean).join(' · ')));
      if(ui.noteDeleteId===note.id&&!native) {
        const row=el('div','guanyi-study-note-delete');row.append(el('span','','删除这条笔记？'),action('取消删除',()=>{ui.noteDeleteId=null;render();focusNote(note.id,'删除笔记');}),action('确认删除笔记',async()=>{const neighbor=state().notes.find(item=>item.id!==note.id)?.id;await save(next=>{next.notes=next.notes.filter(item=>item.id!==note.id);});ui.noteDeleteId=null;render();focusNote(neighbor,'编辑笔记');}));article.append(row);
      }
      return article;
    }
    function renderNotes() {
      const count=state().notes.length+ui.nativeAnnotations.length;const bar=el('div','guanyi-study-notes-toolbar');
      const create=action('新建笔记',()=>beginNote());create.disabled=ui.noteEditor;bar.append(el('span','',`${count} 条批注`),create);body.append(bar);
      if(ui.annotationError) {const notice=el('div','guanyi-study-notice error');notice.append(el('span','',ui.annotationError),action('重试读取批注',refreshAnnotations));body.append(notice);}
      if(ui.noteEditor) {
        const composer=el('div','app-comment-composer guanyi-study-note-editor');const context=ui.noteContext||pageContext();
        const research = context.kind === 'research-excerpt';
        const title = research ? '研究摘录' : ui.noteEditingId ? '编辑笔记' : '新建笔记';
        const source = context.sources?.[0];
        const page = research && source ? `文件第 ${source.page} 页${source.kind === 'page-image' ? ' · 图表所在页' : ''}`
          : scopeLabel(context).replace('文件','').replace(' · 已锁定','');
        const head=el('div','app-composer__head');head.append(el('strong','',title),el('span','',page));composer.append(head);
        if(context.sources?.[0]?.text){const quote=el('div','app-composer__quote',context.sources[0].text);quote.title=context.sources[0].text;composer.append(quote);}
        const input=el('textarea');input.value=ui.noteDraft;input.readOnly=ui.noteSaving;input.maxLength=8000;input.placeholder='写下你的理解或疑问…';input.setAttribute('aria-label','研读笔记');
        const syncSave = () => { saveButton.disabled = ui.noteSaving || (!research && !ui.noteDraft.trim()); };
        input.addEventListener('input',()=>{ui.noteDraft=input.value;if(!ui.noteContext)ui.noteContext=pageContext();scheduleDraft();syncSave();});
        const saveButton = action(research ? '保存摘录' : '保存研读笔记', saveDraftNote, 'is-primary');
        syncSave();
        const actions=el('div','app-composer__actions');const cancel=action('取消编辑',()=>finishNote());cancel.disabled=ui.noteSaving;actions.append(cancel,saveButton);composer.append(input,actions);body.append(composer);
      }
      if(!count&&!ui.noteEditor)body.append(paragraph('暂无批注，可选择原文添加，或新建笔记。','app-comment-empty'));
      const cards=[...state().notes.map(note=>({note,native:false})),...ui.nativeAnnotations.map(note=>({note,native:true}))];
      cards.sort((a,b)=>(noteSource(a.note,a.native)?.page??Infinity)-(noteSource(b.note,b.native)?.page??Infinity)||(b.note.updatedAt||b.note.createdAt||0)-(a.note.updatedAt||a.note.createdAt||0));
      for(const item of cards)body.append(renderNoteCard(item.note,item.native));
    }
    async function useSelection(kind) {
      const captured=selection||await reader.captureSelection();if(!captured?.sources?.length){notify('请先选择可提取的 PDF 原文。');return;}
      const context={mode:'selection',sourceHash,sources:sourcesSnapshot(captured.sources)};selectionBar.hidden=true;
      if(kind==='note'){if(!ui.noteEditor){ui.noteContext=context;ui.noteEditor=true;ui.noteEditingId=null;}show('notes');body.querySelector('textarea')?.focus();scheduleDraft();return;}
      ui.scope = context;
      if (kind !== 'card' && !ui.draft.trim()) updateAskDraft('请解释这段原文，说明核心概念、关系与适用条件。');
      show('ask');
      body.querySelector('textarea')?.focus();
      scheduleDraft();
      if (kind === 'card') beginAsk({context, question:'请用这段原文提炼一个值得自测的核心问题，并给出有依据的答案。', makeCard:true});
    }
    function openExport() {
      const epoch = ++dialogEpoch;
      prepareDialog('整理为 Markdown','选择要整理的内容。原文摘录、文件页码、来源版本和 AI 标识会一同保留。');
      const labels = { preparations:'全文研读与原文依据', notes:'我的研读笔记', cards:'已确认学习卡', messages:'已完成的文档对话' };
      const ready = items => items.filter(item => item.status === 'ready');
      const counts = { preparations:ready(state().preparations).length, notes:state().notes.length, cards:state().cards.length, messages:ready(state().messages).length };
      const checks = {};
      function addOption(key,label,count) {
        const row = el('label','guanyi-study-check');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = key !== 'messages';
        checks[key] = input;
        row.append(input, el('span','',`${label}（${count}）`));
        dialog.append(row);
      }
      if (state().quickReading) addOption('quickReading','摘要快读与原文依据',1);
      for (const [key,label] of Object.entries(labels)) addOption(key,label,counts[key]);
      const error = paragraph('','guanyi-study-error');
      const confirm = action('创建 Markdown 笔记', async () => {
        const selected = { quickReading:checks.quickReading?.checked ? state().quickReading : null };
        for (const key of Object.keys(labels)) selected[key] = checks[key].checked ? state()[key] : [];
        if (!selected.quickReading && !selected.notes.length && !selected.cards.length && !ready(selected.preparations).length && !ready(selected.messages).length) {
          error.textContent = '请先选择至少一项已保存的内容。';
          return;
        }
        confirm.disabled = true;
        try {
          await flush();
          await options.createMarkdown({ name:`${clean(doc.name,120)} · 研读笔记`, content:exportMarkdown(selected,doc.name) });
          if (dialog.open && dialogEpoch === epoch) dialog.close();
        } catch (e) { error.textContent = `创建笔记失败：${e.message}。已有研读内容仍保留。`; confirm.disabled = false; }
      }, 'is-primary');
      dialog.append(error,action('取消',()=>dialog.close()),confirm);
      dialog.showModal();
    }
    const unsubscribe=reader.onSelection?.(value=>{selection=value?.sources?.length?{text:clean(value.text,16000),sources:sourcesSnapshot(value.sources)}:null;selectionBar.hidden=!selection;});
    const unsubscribeAnnotations=reader.onAnnotationsChanged?.(()=>{if(!disposed)refreshAnnotations();});
    toolbar.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (ui.open && innerWidth < 1180 && target?.getAttribute('aria-label') === '目录与页面缩略图') hide(false);
    }, { capture:true, signal:listeners.signal });
    window.addEventListener('resize',()=>{mask.hidden=!ui.open||innerWidth>=1180;syncEvidenceNavigation();},{signal:listeners.signal});
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&!dialog.open){event.preventDefault();event.stopPropagation();hide();}if(event.target.matches('input,textarea,select')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','PageUp','PageDown'].includes(event.key))event.stopPropagation();},{signal:listeners.signal});
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && ui.open && !dialog.open && !document.querySelector('.app-modal-backdrop:not([hidden])')) { event.preventDefault(); hide(); } }, { signal:listeners.signal });
    dialog.addEventListener('close',()=>{
      clearVisualPreviews(dialog);dialogCandidate=null;
      const origin = dialogOrigin, label = dialogOriginLabel, key = dialogOriginKey;
      dialogOrigin = null; dialogOriginLabel = ''; dialogOriginKey = '';
      requestAnimationFrame(()=>{
        if(disposed||dialog.open)return;
        if (!ui.open) {
          if (!evidenceNavigation.hidden && !resumeButton.hidden) resumeButton.focus({preventScroll:true});
          return;
        }
        if(origin?.isConnected&&origin.getClientRects().length){origin.focus({preventScroll:true});return;}
        const controls = [...panel.querySelectorAll('button,select')].filter(node => !node.disabled && node.getClientRects().length);
        const replacement = (key && controls.find(node => (node.dataset.studyFocusKey || node.dataset.studyEvidence) === key))
          || (label && controls.find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label));
        (replacement||tabButtons[ui.tab]||toggle).focus({preventScroll:true});
      });
    },{signal:listeners.signal});
    async function flush() {clearTimeout(draftTimer);if(taskController)taskController.abort();if(activeTask)await activeTask;await save(next=>{for(const item of [...next.preparations,...next.messages])if(['pending','preparing','generating'].includes(item.status)){item.status='interrupted';item.error='任务已中断，输入和已有结果已保留，可以重试。';}});}
    async function dispose() {if(disposed)return;panelResizer.finishDrag();clearVisualPreviews();await flush();disposed=true;annotationEpoch+=1;listeners.abort();unsubscribe?.();unsubscribeAnnotations?.();reader.setStudyOpen?.(false);toggle.remove();evidenceNavigation.remove();dialog.remove();selectionBar.remove();mask.remove();panel.remove();if(wrappedReading){for(const child of [...reading.childNodes])container.moveBefore(child,shell);shell.remove();}else container.classList.remove('guanyi-pdf-study-shell','guanyi-study-inline');container.classList.remove('has-pdf-study');}
    render();
    return {flush,dispose,show,hide};
  }

  window.GuanyiPdfStudy = Object.freeze({ mount, _test:Object.freeze({ sourceSnapshot,sourcesSnapshot,previewSources,normalizeReading,normalizeRecord,createStore,evidencePack,resolveEvidence,parsePreparation,parseAnswer,addCard,exportMarkdown }) });
})();
