'use strict';
// Real study UI and paper engine, controlled reader/model snapshots, no user files or cloud keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'pdf-study-browser');
fs.mkdirSync(output, { recursive: true });
let browser, page, phase = 'startup';
const errors = [];
const stage = label => { phase = label; console.log(`[PDF study browser] ${label}`); };
const panel = () => page.locator('.guanyi-study-panel');
const noteInput = () => panel().getByRole('textbox', { name: '研读笔记', exact: true });
const question = () => panel().getByRole('textbox', { name: '研读问题', exact: true });
const card = (kind, id) => panel().locator(`[data-note-kind="${kind}"][data-note-id="${id}"]`);
const button = name => panel().getByRole('button', { name, exact: true });
const tab = name => panel().getByRole('tab', { name, exact: true }).click();
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function assertDialogClose(title, origin, method = 'icon') {
  const dialog = page.locator('.guanyi-study-dialog');
  const close = dialog.getByRole('button', { name: '关闭' + title, exact: true });
  assert.equal(await close.getAttribute('title'), '关闭' + title);
  assert.equal((await close.textContent()).trim(), '', 'dialog close uses a pure icon');
  assert.equal(await close.locator('svg[aria-hidden="true"]').count(), 1);
  assert.equal(await close.evaluate(node => {
    const rect = node.getBoundingClientRect(), dialog = node.closest('dialog').getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return rect.right <= dialog.right && dialog.right - rect.right <= 32 && rect.top >= dialog.top && rect.top - dialog.top <= 32 && (hit === node || node.contains(hit));
  }), true, 'dialog close is a visible, clickable upper-right control');
  if (method === 'escape') await close.press('Escape');
  else if (method === 'cancel') await dialog.getByRole('button', { name: '取消', exact: true }).click();
  else await close.click();
  await dialog.waitFor({ state: 'hidden' }); await settle();
  assert.equal(await origin.evaluate(node => document.activeElement === node), true, `${title}: ${method} returns focus to its trigger`);
}
async function remount(record) {
  await page.evaluate(async record => { await study.dispose(); mountStudy(record); study.show('notes'); }, record);
  await settle();
}
async function assertSendIcon(name) {
  const icon = panel().locator('.guanyi-study-send');
  assert.equal(await icon.getAttribute('aria-label'), name);
  assert.equal(await icon.getAttribute('title'), name);
  assert.equal((await icon.textContent()).trim(), '', `${name} uses a pure icon`);
  assert.equal(await icon.locator('svg[aria-hidden="true"]').count(), 1);
  const geometry = await icon.evaluate(icon => {
    const box = icon.closest('.guanyi-study-composer-input'), input = box?.querySelector('textarea');
    if (!box || !input) return null;
    const outer = box.getBoundingClientRect(), rect = icon.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { inside: rect.left >= outer.left && rect.right <= outer.right + 1 && rect.top >= outer.top && rect.bottom <= outer.bottom + 1,
      bottomRight: outer.right - rect.right <= 20 && outer.bottom - rect.bottom <= 20,
      viewport: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      hit: hit === icon || icon.contains(hit), padding: parseFloat(getComputedStyle(input).paddingBottom), height: rect.height };
  });
  assert.ok(geometry, 'textarea and icon share one composer input');
  for (const key of ['inside', 'bottomRight', 'viewport', 'hit']) assert.equal(geometry[key], true, `${name}: ${key}`);
  assert.ok(geometry.padding >= geometry.height, 'last text line reserves space for its inset send/stop icon');
}
(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"></head><body><div id="toolbar"></div><section id="container"><iframe class="guanyi-pdf-frame" title="测试PDF画布" srcdoc="<p>原版 PDF 画布保持独立</p>"></iframe></section></body></html>');
  for (const file of ['css/app.css', 'css/pdf-study.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
  await page.addStyleTag({ content: 'html,body{width:100%;height:100%;margin:0;min-width:0;overflow:hidden}body{display:flex;flex-direction:column;background:var(--ui-color-background-base);color:var(--ui-color-text-primary)}#toolbar{display:flex;flex:0 0 49px;align-items:center;padding:0 12px;background:var(--ui-color-background-top);border-bottom:1px solid var(--ui-color-line-regular)}#container{position:relative;flex:1;min-height:0}.guanyi-pdf-frame{width:100%;height:100%;border:0;background:var(--ui-color-background-base)}' });
  await page.evaluate(skill => { window.GuanyiPaperReaderSkill = skill; }, fs.readFileSync(path.join(root, 'vendor/paper-reader-skill/SKILL.md'), 'utf8'));
  for (const file of ['js/paper-reader.js', 'js/pdf-study.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
  await page.evaluate(() => {
    const clone = value => JSON.parse(JSON.stringify(value));
    window.fixture = { page: 1, requests: [], saved: null, writes: [], failWrites: false, mode: 'normal', notices: [], located: [], restored: [], selection: null, markdown: [],
      native: [{ id: 'native-1', nativeId: 'native-1', page: 2, subtype: 'Text', text: '原生 PDF 评论 <img src=x onerror=alert(1)>', quote: '第2页原文 <script>window.__nativeInjected=1</script>', rects: [[10, 20, 100, 30]], sourceHash: 'hash-a' }],
      annotationReads: 0, subscriptions: 0, unsubscribes: 0, deferAnnotations: false, pendingAnnotations: [], aborted: 0 };
    window.evidence = p => ({ id: `block-${p}`, page: p, pageLabel: String(p), text: `第${p}页原文：结论需要结合材料与条件来理解。`, rects: [[10, 20, 100, 30]], sourceHash: 'hash-a', itemStart: 0, itemEnd: 2 });
    window.reader = {
      info: { sourceHash: 'hash-a', numPages: 4 }, page: async p => ({ page: p, label: String(p), blocks: [evidence(p)], scanned: false }), outline: async () => [],
      position: () => ({ page: fixture.page, zoom: 'page-width', scroll: 100 }), captureSelection: () => fixture.selection,
      locate: async source => { fixture.located.push(clone(source)); fixture.page = source.page; return { precise: true }; },
      restore: async position => { fixture.restored.push(clone(position)); fixture.page = position.page; },
      annotations: async () => { fixture.annotationReads += 1; const snapshot = clone(fixture.native); if (fixture.deferAnnotations) return new Promise(resolve => fixture.pendingAnnotations.push(() => resolve(snapshot))); return snapshot; },
      onSelection: callback => { window.selectionHandler = callback; return () => { window.selectionHandler = null; }; },
      onAnnotationsChanged: callback => { window.annotationHandler = callback; fixture.subscriptions += 1; return () => { fixture.unsubscribes += 1; if (window.annotationHandler === callback) window.annotationHandler = null; }; },
      setStudyOpen: open => { fixture.studyOpen = open; }
    };
    window.mountStudy = record => {
      window.study = GuanyiPdfStudy.mount({ doc: { id: 'pdf-test', name: '测试资料', readerStudy: record }, reader, container: document.querySelector('#container'), toolbar: document.querySelector('#toolbar'),
        modelReady: () => true, configureModel() {}, notify: message => fixture.notices.push(message),
        persist: async record => {
          if (fixture.failWrites) throw new Error('磁盘空间不足');
          const latest = record.messages.at(-1), saved = fixture.saved?.messages.at(-1);
          if (fixture.failDraftAfterAnswer && latest?.status === 'ready' && saved?.id === latest.id && saved?.status === 'ready') {
            fixture.failDraftAfterAnswer = false; fixture.answerDraftSaveFailed = true; throw new Error('回答已保存，草稿存储暂不可用');
          }
          fixture.saved = clone(record); fixture.writes.push(clone(record));
        },
        createMarkdown: async record => fixture.markdown.push(clone(record)),
        request: async (messages, { signal }) => {
          const content = messages.at(-1).content;
          const payload = JSON.parse(Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).find(text => text.trim().startsWith('{')) : content); fixture.requests.push(payload);
          if (fixture.mode === 'error') throw new Error('测试模型暂不可用');
          if (fixture.legacyRefresh) {
            const id = payload.evidence?.[0]?.id || payload.sourceIdRanges?.[0]?.first;
            const response = JSON.stringify({ reading: { title: '本次全文研读', documentType: '测试论文',
              summary: { body: '本次已结合全部页面文字与图像完成研读。', evidenceIds: [id] }, sections: [], terms: [], quotes: [], related: [] }, questions: [], cards: [] });
            // An uncooperative transport deliberately ignores AbortSignal. Its
            // late result must never replace the record saved before stopping.
            if (fixture.mode === 'defer') return new Promise(resolve => { fixture.pendingReading.push(() => resolve(response)); });
            return response;
          }
          if (fixture.mode === 'wait') return new Promise((resolve, reject) => { signal.addEventListener('abort', () => { fixture.aborted += 1; reject(new DOMException('已停止', 'AbortError')); }, { once: true }); });
          if (fixture.mode === 'invalid') return JSON.stringify({ answer: '伪造来源', evidenceIds: ['E999'], insufficient: false });
          if ((!payload.stage && payload.task) || /prepare|read-batch|synthesize-reading/.test(payload.stage || '')) return JSON.stringify({
            reading: { title: '理解结论', documentType: '测试论文', summary: { body: '需要核对材料和条件。', evidenceIds: ['E1'] },
              sections: [{ kind: 'methods', title: '方法', body: '依据原文核对材料。', basis: 'source', evidenceIds: ['E1'] }, { kind: 'results', title: '结果与边界', body: '结论需要结合材料与条件。', basis: 'author', evidenceIds: ['E1'] }],
              terms: [{ term: '适用条件', explanation: '结论得到支持的条件。', evidenceIds: ['E1'] }],
              quotes: [{ quote: evidence(1).text, translation: '第1页说明了结论的适用条件。', evidenceIds: ['E1'] }], related: [] },
            guide: [{ title: '理解结论', body: '需要核对材料和条件。', evidenceIds: ['E1'] }], questions: [{ question: '适用条件是什么？', evidenceIds: ['E1'] }], cards: [{ question: '为何要核对条件？', answer: '结论需要结合材料与条件。', type: '边界', evidenceIds: ['E1'] }] });
          return JSON.stringify({ answer: '这段原文要求结合条件理解结论。', evidenceIds: ['E1'], insufficient: false, card: { question: '理解结论时应核对什么？', answer: '核对材料与适用条件。', type: '边界', evidenceIds: ['E1'] } });
        } });
    };
    mountStudy(null);
  });

  stage('retaining guide, explicit learning-card confirmation and self-test');
  assert.equal(await panel().isVisible(), false);
  await page.locator('.guanyi-study-toggle').click(); await button('研读全文').click();
  await page.waitForFunction(() => fixture.saved?.preparations[0]?.status === 'ready');
  assert.equal(await page.evaluate(() => fixture.saved.cards.length), 0);
  assert.equal(await page.locator('iframe.guanyi-pdf-frame').count(), 1);
  await tab('文档对话');
  const scopeSelect = panel().getByRole('combobox', { name: '文档对话范围', exact: true });
  for (const method of ['icon', 'escape', 'cancel']) {
    await scopeSelect.selectOption('document'); await scopeSelect.focus(); await scopeSelect.selectOption('range');
    await assertDialogClose('锁定提问页段', scopeSelect, method);
    assert.equal(await page.evaluate(() => fixture.saved.scope.mode), 'document', 'closing range dialog never applies a range');
  }
  await tab('学习卡 0'); await button('预览与编辑').click();
  await assertDialogClose('预览学习卡', button('预览与编辑'));
  await button('预览与编辑').click(); await assertDialogClose('预览学习卡', button('预览与编辑'), 'escape');
  await button('预览与编辑').click(); await assertDialogClose('预览学习卡', button('预览与编辑'), 'cancel');
  assert.equal(await page.evaluate(() => fixture.saved.cards.length), 0);
  await button('预览与编辑').click();
  await page.locator('dialog').getByRole('textbox', { name: '学习卡问题', exact: true }).fill('我自己的自测问题');
  await page.evaluate(() => { fixture.failWrites = true; });
  await page.locator('dialog').getByRole('button', { name: '确认保留', exact: true }).click();
  await page.locator('dialog .guanyi-study-error').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.evaluate(() => fixture.saved.cards.length), 0);
  assert.equal(await page.locator('dialog').getByRole('textbox', { name: '学习卡问题', exact: true }).inputValue(), '我自己的自测问题', 'failed card save keeps dialog input');
  assert.equal(await page.locator('dialog').getByRole('button', { name: '关闭预览学习卡', exact: true }).isVisible(), true, 'failed card save keeps an accessible close action');
  await page.evaluate(() => { fixture.failWrites = false; });
  await page.locator('dialog').getByRole('button', { name: '确认保留', exact: true }).click();
  await page.waitForFunction(() => fixture.saved.cards.length === 1);
  await button('编辑').click(); await assertDialogClose('编辑学习卡', button('编辑'));
  await button('开始自测').click(); assert.equal(await panel().getByText('结论需要结合材料与条件。', { exact: true }).count(), 0);
  await button('显示答案').click(); await button('基本理解').click();
  await page.waitForFunction(() => fixture.saved.cards[0].reviews.length === 1);
  console.log('PASS prepare, range/card dialog close icons, Escape/cancel focus, candidate edit/save failure, confirmed card and self-test');

  stage('checking default native cards, escaping and automatic annotation refresh');
  await tab('批注'); assert.equal(await noteInput().count(), 0, 'notes starts with cards, without an open editor');
  await card('native', 'native-1').waitFor();
  assert.match(await card('native', 'native-1').textContent(), /原生 PDF 评论 <img src=x onerror=alert\(1\)>/);
  assert.equal(await card('native', 'native-1').locator('img,script').count(), 0);
  assert.equal(await page.evaluate(() => !!window.__nativeInjected), false);
  for (const name of ['编辑笔记', '删除笔记']) assert.equal(await card('native', 'native-1').getByRole('button', { name, exact: true }).count(), 0, 'native cards have no fake CRUD');
  await card('native', 'native-1').locator('.app-comment-card__quote').click();
  assert.equal(await page.evaluate(() => fixture.located.at(-1).page), 2);
  assert.equal(await page.evaluate(() => fixture.located.at(-1).sourceHash), 'hash-a');
  assert.equal(await page.evaluate(() => fixture.subscriptions), 1);
  await page.evaluate(() => { fixture.native.push({ id: 'native-2', page: 3, subtype: 'Highlight', text: '自动新增的原生高亮', quote: evidence(3).text, sourceHash: 'hash-a' }); annotationHandler(); });
  await card('native', 'native-2').waitFor();
  await page.evaluate(() => { fixture.native[1].text = '原生评论修改后自动刷新'; annotationHandler(); });
  await card('native', 'native-2').filter({ hasText: '原生评论修改后自动刷新' }).waitFor();
  await page.evaluate(() => { fixture.native = fixture.native.filter(note => note.id !== 'native-2'); annotationHandler(); });
  await page.waitForFunction(() => !document.querySelector('[data-note-kind="native"][data-note-id="native-2"]'));
  console.log('PASS native cards escape content, locate local evidence and follow add/edit/delete snapshots');

  stage('creating, editing and cancelling saved study notes');
  await page.evaluate(() => { fixture.page = 2; }); await button('新建笔记').click();
  const initialNote = '我的真实思考 <img src=x onerror=alert(2)>\n需要保留原文条件。';
  await noteInput().fill(initialNote); await page.evaluate(() => { fixture.page = 4; fixture.failWrites = true; });
  await button('保存研读笔记').click(); await page.locator('.guanyi-study-storage').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.evaluate(() => fixture.saved.notes.length), 0);
  assert.equal(await noteInput().inputValue(), initialNote, 'failed save retains text and editor');
  await page.evaluate(() => { fixture.failWrites = false; }); await button('保存研读笔记').click();
  await page.waitForFunction(() => fixture.saved.notes.length === 1 && !fixture.saved.noteEditor);
  const firstNote = await page.evaluate(() => fixture.saved.notes[0]);
  assert.equal(firstNote.sources[0].page, 2, 'new note freezes the page before subsequent turns');
  await card('study', firstNote.id).waitFor(); assert.equal(await noteInput().count(), 0);
  assert.ok((await card('study', firstNote.id).textContent()).includes(initialNote));
  assert.equal(await card('study', firstNote.id).locator('img,script').count(), 0);
  for (const name of ['编辑笔记', '删除笔记']) {
    const control = card('study', firstNote.id).getByRole('button', { name, exact: true });
    assert.equal(await control.getAttribute('title'), name); assert.equal((await control.textContent()).trim(), ''); assert.equal(await control.locator('svg').count(), 1);
  }
  await card('study', firstNote.id).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const revisedNote = '修改后的同一条笔记：保留材料、条件与来源。';
  assert.equal(await noteInput().inputValue(), initialNote); await noteInput().fill(revisedNote); await button('保存研读笔记').click();
  await page.waitForFunction(({ id, text }) => fixture.saved.notes.length === 1 && fixture.saved.notes[0].id === id && fixture.saved.notes[0].text === text && !fixture.saved.noteEditor, { id: firstNote.id, text: revisedNote });
  const edited = await page.evaluate(() => fixture.saved.notes[0]);
  assert.equal(edited.createdAt, firstNote.createdAt); assert.deepEqual(edited.sources, firstNote.sources, 'editing keeps source and identity');
  await card('study', firstNote.id).getByRole('button', { name: '编辑笔记', exact: true }).click();
  await noteInput().fill('取消的修改不能覆盖已保存笔记'); await button('取消编辑').click();
  await page.waitForFunction(() => !fixture.saved.noteEditor && fixture.saved.noteEditingId === null);
  assert.equal(await noteInput().count(), 0); assert.equal(await page.evaluate(() => fixture.saved.notes[0].text), revisedNote);
  console.log('PASS transactional new note, frozen page, escaped text, same-id editing and cancellation');

  stage('restoring active editors, legacy drafts and selection notes');
  await card('study', firstNote.id).getByRole('button', { name: '编辑笔记', exact: true }).click();
  const resumedDraft = '编辑中的草稿在关闭和重新挂载后仍保留'; await noteInput().fill(resumedDraft);
  await noteInput().evaluate(input => { input.focus(); input.setSelectionRange(2, 5); });
  const nativeReadsBeforeEdit = await page.evaluate(() => fixture.annotationReads);
  await page.evaluate(() => annotationHandler());
  await page.waitForFunction(count => fixture.annotationReads > count, nativeReadsBeforeEdit); await settle();
  assert.deepEqual(await noteInput().evaluate(input => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input })),
    { value: resumedDraft, start: 2, end: 5, focused: true }, 'automatic native refresh preserves the active note draft, caret and focus');
  await page.waitForFunction(({ id, text }) => fixture.saved.noteEditingId === id && fixture.saved.noteEditor && fixture.saved.noteDraft === text, { id: firstNote.id, text: resumedDraft });
  await page.locator('.guanyi-study-close').click(); await page.locator('.guanyi-study-toggle').click();
  assert.equal(await noteInput().inputValue(), resumedDraft);
  await remount(await page.evaluate(() => fixture.saved)); assert.equal(await noteInput().inputValue(), resumedDraft);
  await button('保存研读笔记').click();
  await page.waitForFunction(({ id, text }) => fixture.saved.notes.length === 1 && fixture.saved.notes[0].id === id && fixture.saved.notes[0].text === text && !fixture.saved.noteEditor, { id: firstNote.id, text: resumedDraft });
  const legacy = await page.evaluate(() => { const record = JSON.parse(JSON.stringify(fixture.saved)); delete record.noteEditor; delete record.noteEditingId; record.noteDraft = '旧版本尚未保存的研读笔记'; record.noteContext = { mode: 'page', start: 3, end: 3, sourceHash: 'hash-a' }; return record; });
  await remount(legacy); assert.equal(await noteInput().inputValue(), legacy.noteDraft, 'legacy noteDraft opens its editor');
  await button('取消编辑').click(); await page.waitForFunction(() => !fixture.saved.noteEditor);
  await page.evaluate(() => { fixture.selection = { text: evidence(1).text, sources: [evidence(1)] }; selectionHandler(fixture.selection); });
  await page.locator('.guanyi-study-selection').getByRole('button', { name: '批注', exact: true }).click();
  assert.equal(await noteInput().isVisible(), true, 'selection annotation actively opens an editor');
  await noteInput().fill('从选区开始的第二条笔记'); await page.evaluate(() => { fixture.page = 4; }); await button('保存研读笔记').click();
  await page.waitForFunction(() => fixture.saved.notes.length === 2 && !fixture.saved.noteEditor);
  const selectedNote = await page.evaluate(() => fixture.saved.notes.at(-1));
  assert.equal(selectedNote.sources[0].text, await page.evaluate(() => evidence(1).text)); assert.equal(selectedNote.sources[0].page, 1); assert.notEqual(selectedNote.id, firstNote.id);
  console.log('PASS editor id/draft persistence, legacy draft restoration and explicit selection-note editor');

  stage('confirming isolated note deletion and failure recovery');
  // A newer note on the same page puts the chosen note second in the visible
  // list. Repeated icon labels must never restore focus to the first card.
  await page.evaluate(() => selectionHandler(fixture.selection));
  await page.locator('.guanyi-study-selection').getByRole('button', { name: '批注', exact: true }).click();
  await noteInput().fill('排列在目标卡片前的独立笔记'); await button('保存研读笔记').click();
  await page.waitForFunction(() => fixture.saved.notes.length === 3 && !fixture.saved.noteEditor);
  const leadingNote = await page.evaluate(() => fixture.saved.notes.at(-1));
  assert.equal(await panel().locator('[data-note-kind]').nth(0).getAttribute('data-note-id'), leadingNote.id);
  assert.equal(await panel().locator('[data-note-kind]').nth(1).getAttribute('data-note-id'), selectedNote.id, 'the deletion target is the second visible card');
  await card('study', selectedNote.id).getByRole('button', { name: '删除笔记', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement.closest('[data-note-id]')?.dataset.noteId, label: document.activeElement.textContent.trim() })),
    { id: selectedNote.id, label: '取消删除' }, 'opening second-card confirmation focuses its own safe cancel action');
  await card('study', selectedNote.id).getByRole('button', { name: '取消删除', exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.saved.notes.length), 3, 'cancel delete retains every note');
  const assertSecondDeleteFocused = async () => assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement.closest('[data-note-id]')?.dataset.noteId, label: document.activeElement.getAttribute('aria-label') })),
    { id: selectedNote.id, label: '删除笔记' }, 'cancel returns focus to the second card delete icon');
  await assertSecondDeleteFocused();
  const readsBeforeFocusRefresh = await page.evaluate(() => fixture.annotationReads);
  await page.evaluate(() => annotationHandler());
  await page.waitForFunction(count => fixture.annotationReads > count, readsBeforeFocusRefresh); await settle();
  await assertSecondDeleteFocused();
  await card('study', selectedNote.id).getByRole('button', { name: '删除笔记', exact: true }).click();
  await page.evaluate(() => { fixture.failWrites = true; });
  await card('study', selectedNote.id).getByRole('button', { name: '确认删除笔记', exact: true }).click();
  await page.locator('.guanyi-study-storage').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.evaluate(() => fixture.saved.notes.length), 3); assert.equal(await card('study', selectedNote.id).count(), 1);
  const storageSave = page.locator('.guanyi-study-storage').getByRole('button', { name: '仅保存当前草稿', exact: true });
  assert.equal(await storageSave.isVisible(), true, 'failed destructive transaction describes its safe draft-only retry');
  assert.equal(await page.locator('.guanyi-study-storage').getByRole('button', { name: '重试保存', exact: true }).count(), 0);
  const notesBeforeDraftSave = await page.evaluate(() => fixture.saved.notes);
  const recoveryDraft = '删除失败后仅保存这条新问题草稿，仍需明确确认删除';
  await tab('文档对话'); await question().fill(recoveryDraft); await tab('批注');
  await page.evaluate(() => { fixture.failWrites = false; });
  const writesBeforeDraftSave = await page.evaluate(() => fixture.writes.length);
  await storageSave.click();
  await page.waitForFunction(({ count, text }) => fixture.writes.length > count && fixture.saved.draft === text, { count: writesBeforeDraftSave, text: recoveryDraft });
  assert.deepEqual(await page.evaluate(() => fixture.saved.notes), notesBeforeDraftSave, 'draft-only save cannot replay the failed note deletion');
  assert.equal(await card('study', selectedNote.id).count(), 1, 'the original note is still visible after saving the draft');
  assert.equal(await card('study', selectedNote.id).getByRole('button', { name: '确认删除笔记', exact: true }).isVisible(), true, 'destructive confirmation is still pending after draft-only save');
  await card('study', selectedNote.id).getByRole('button', { name: '确认删除笔记', exact: true }).click();
  await page.waitForFunction(id => fixture.saved.notes.length === 2 && !fixture.saved.notes.some(note => note.id === id), selectedNote.id);
  assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement.closest('[data-note-id]')?.dataset.noteId, label: document.activeElement.getAttribute('aria-label') })),
    { id: firstNote.id, label: '编辑笔记' }, 'successful confirmation moves focus to a remaining study-note edit icon');
  await card('study', leadingNote.id).getByRole('button', { name: '删除笔记', exact: true }).click();
  await card('study', leadingNote.id).getByRole('button', { name: '确认删除笔记', exact: true }).click();
  await page.waitForFunction(() => fixture.saved.notes.length === 1);
  assert.equal(await card('study', firstNote.id).count(), 1); assert.equal(await card('native', 'native-1').count(), 1);
  assert.equal(await page.evaluate(() => fixture.native.length), 1, 'study-note deletion never edits native annotation data');
  console.log('PASS second-card delete focus, safe draft-only recovery, explicit deletion and adjacent-card focus');

  stage('preserving frozen chat evidence, IME, source errors and retry');
  await page.evaluate(() => { fixture.selection = { text: evidence(1).text, sources: [evidence(1)] }; selectionHandler(fixture.selection); });
  await page.locator('.guanyi-study-selection').getByRole('button', { name: '解释这段', exact: true }).click(); await page.evaluate(() => { fixture.page = 3; fixture.mode = 'normal'; });
  await assertSendIcon('发送'); await button('发送').click(); await page.waitForFunction(() => fixture.saved.messages.at(-1)?.status === 'ready');
  assert.equal(await page.evaluate(() => fixture.saved.messages[0].context.sources[0].page), 1);
  assert.match(await page.evaluate(() => fixture.requests.at(-1).evidence[0].text), /第1页原文/);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(fixture.requests.at(-1).evidence)), /sourceHash|rects|desktopPath/);
  await panel().locator('.guanyi-study-chat').getByRole('button', { name: '第 1 页', exact: true }).click(); assert.equal(await page.evaluate(() => fixture.located.at(-1).page), 1);
  await page.locator('.guanyi-study-return').click(); assert.equal(await page.evaluate(() => fixture.restored.at(-1).page), 3);
  await page.evaluate(() => selectionHandler(fixture.selection)); await page.locator('.guanyi-study-selection').getByRole('button', { name: '生成学习卡', exact: true }).click();
  await page.locator('dialog').getByRole('textbox', { name: '学习卡问题', exact: true }).waitFor();
  assert.equal(await page.locator('dialog').getByRole('textbox', { name: '学习卡问题', exact: true }).inputValue(), '理解结论时应核对什么？');
  assert.equal(await page.evaluate(() => fixture.saved.cards.length), 1); assert.equal(await page.evaluate(() => fixture.saved.supplemental.length), 1);
  await page.locator('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => { fixture.mode = 'invalid'; }); await question().fill('请返回未知来源');
  const count = await page.evaluate(() => fixture.requests.length);
  await question().evaluate(node => { node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })); node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  assert.equal(await page.evaluate(() => fixture.requests.length), count, 'IME confirmation must not send');
  await button('发送').click(); await page.waitForFunction(() => fixture.saved.messages.at(-1).status === 'error');
  const failedId = await page.evaluate(() => fixture.saved.messages.at(-1).id);
  assert.match(await panel().textContent(), /未知来源/); assert.equal(await page.evaluate(() => fixture.saved.messages.at(-1).sources.length), 0);
  await page.evaluate(() => { fixture.mode = 'normal'; }); await button('重试这次问题').click();
  await page.waitForFunction(id => fixture.saved.messages.at(-1).id === id && fixture.saved.messages.at(-1).status === 'ready', failedId);
  console.log('PASS frozen selection, private evidence, source/return, supplemental cards, IME and same-message retry');

  stage('retaining a saved answer when its later draft-only persistence fails');
  await question().fill('已保存的回答不能因为随后草稿写入失败而改成错误');
  await page.evaluate(() => { fixture.failDraftAfterAnswer = true; fixture.answerDraftSaveFailed = false; });
  await button('发送').click();
  await page.waitForFunction(() => fixture.answerDraftSaveFailed);
  assert.equal(await page.evaluate(() => fixture.saved.messages.at(-1).status), 'ready');
  assert.equal(await page.evaluate(() => fixture.saved.messages.at(-1).answer), '这段原文要求结合条件理解结论。');
  assert.equal(await panel().locator('.guanyi-study-chat').last().getByText('这段原文要求结合条件理解结论。', { exact: true }).count(), 1);
  assert.equal(await panel().locator('.guanyi-study-chat').last().getByText('本次回答失败。', { exact: true }).count(), 0);
  console.log('PASS saved answer remains ready after its following draft save fails');

  stage('checking actual light/dark card and composer layouts at 1440/390');
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; study.show('notes'); }, theme); await settle();
    assert.equal(await noteInput().count(), 0); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await panel().evaluate(node => Math.round(node.getBoundingClientRect().width)), 360);
    assert.equal(await page.locator('.guanyi-study-mask').isVisible(), width < 1180);
    assert.equal(await panel().locator('.guanyi-study-heading').evaluate(node => node.getBoundingClientRect().height), 54);
    await card('study', firstNote.id).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `notes-${theme}-${width}.png`) });
    await card('study', firstNote.id).getByRole('button', { name: '编辑笔记', exact: true }).click();
    assert.equal(await noteInput().inputValue(), resumedDraft);
    assert.equal(await noteInput().evaluate(input => { const rect = input.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }), true, 'note editor stays inside the viewport');
    await page.screenshot({ path: path.join(output, `notes-editor-${theme}-${width}.png`) });
    await button('取消编辑').click(); await page.waitForFunction(() => !fixture.saved.noteEditor);
    await tab('文档对话'); await question().fill('核对原文范围后再发送\n末行不能被右下角图标遮挡'); await settle(); await assertSendIcon('发送');
    await page.screenshot({ path: path.join(output, `chat-${theme}-${width}.png`) });
    await page.evaluate(() => { fixture.mode = 'wait'; }); const start = await page.evaluate(() => fixture.requests.length);
    await button('发送').click(); await page.waitForFunction(count => fixture.requests.length > count && fixture.saved.messages.at(-1).status === 'pending', start);
    await assertSendIcon('停止'); await page.screenshot({ path: path.join(output, `chat-stopping-${theme}-${width}.png`) });
    await button('停止').click(); await page.waitForFunction(() => fixture.saved.messages.at(-1).status === 'interrupted'); await assertSendIcon('发送');
    assert.equal(await question().inputValue(), '核对原文范围后再发送\n末行不能被右下角图标遮挡'); await page.evaluate(() => { fixture.mode = 'normal'; });
  }
  assert.equal(await page.evaluate(() => fixture.aborted), 4);
  console.log('PASS theme/width geometry, shared 54px header, inset send/stop icon, cancellation and retained draft');

  stage('separating saved sampling results from the current full-document task');
  await page.setViewportSize({ width: 1440, height: 960 });
  const beforeLegacyDisplay = await page.evaluate(() => fixture.saved);
  const legacyReading = await page.evaluate(() => {
    const record = JSON.parse(JSON.stringify(fixture.saved));
    record.preparations = [{ id: 'legacy-sampled-reading', key: 'legacy-sample', sourceHash: 'hash-a', start: 1, end: 20, status: 'ready',
      coverage: '文字块 80/2411', guide: [{ title: '旧版采样导读', body: '此前仅抽取了部分文字，这不是本次全文结果。', sources: [evidence(1)] }], questions: [], candidates: [] }];
    fixture.legacyRefresh = true; fixture.pendingReading = []; fixture.mode = 'normal';
    reader.info.numPages = 24;
    reader.renderVisual = async () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=', mimeType: 'image/png', width: 1, height: 1 });
    return record;
  });
  const previous = () => panel().locator('details.guanyi-study-previous');
  const guideHeader = () => panel().locator('.guanyi-study-guide-start');
  const assertPreviousClosed = async () => {
    assert.equal(await previous().count(), 1);
    assert.equal(await previous().evaluate(node => node.open), false, 'prior results are initially collapsed');
    assert.equal(await previous().locator(':scope > summary').textContent(), '查看此前的研读结果');
    assert.equal(await previous().locator('.guanyi-study-coverage').isVisible(), false, 'prior coverage is not presented as current progress');
    assert.equal(await panel().locator('.guanyi-study-body > .guanyi-study-coverage').count(), 0);
  };
  const assertCurrentScope = async () => {
    const text = await guideHeader().locator('[data-study-current-scope]').innerText();
    assert.match(text, /全文\s*24\s*页/);
    assert.match(text, /页面图像|页图像/);
    assert.doesNotMatch(text, /80\/2411|20\s*页/);
  };
  await remount(legacyReading); await tab('导读');
  await assertPreviousClosed(); await assertCurrentScope();
  assert.equal(await panel().getByRole('heading', { name: '旧版采样导读', exact: true }).isVisible(), false);
  const previousSummary = previous().locator(':scope > summary');
  await previousSummary.focus(); await previousSummary.press('Enter');
  assert.match(await previous().innerText(), /此前.*保存|此前.*内容/);
  assert.equal(await panel().getByRole('heading', { name: '旧版采样导读', exact: true }).isVisible(), true, 'saved legacy guide remains explicitly accessible');
  assert.match(await previous().innerText(), /80\/2411/);
  await previous().getByRole('button', { name: '第 1 页', exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.located.at(-1).page), 1, 'legacy source links keep their original page');
  await page.locator('.guanyi-study-return').click();
  await previousSummary.press('Enter'); await assertPreviousClosed();
  await page.evaluate(() => study.flush());
  const savedLegacySources = await page.evaluate(() => fixture.saved.preparations.find(item => item.id === 'legacy-sampled-reading').guide[0].sources);

  // Vary one identity/completeness field at a time so each historic shape is
  // rejected for the right reason, rather than incidentally for an old key.
  const completeReading = JSON.parse(JSON.stringify(legacyReading));
  Object.assign(completeReading.preparations[0], { id: 'current-complete-reading', end: 24,
    key: beforeLegacyDisplay.preparations.find(item => item.status === 'ready').key,
    reading: beforeLegacyDisplay.preparations.find(item => item.status === 'ready').reading,
    coverage: { sentBlocks: 24, totalBlocks: 24, sentImages: 24, totalImages: 24 } });
  const stringCoverageWithReading = JSON.parse(JSON.stringify(legacyReading));
  stringCoverageWithReading.preparations[0] = { ...completeReading.preparations[0], coverage: '文字块 80/2411' };
  await remount(stringCoverageWithReading); await tab('导读'); await assertPreviousClosed();
  assert.equal(await previous().locator('.guanyi-study-overview').isVisible(), false);
  const objectCoverageWithoutReading = JSON.parse(JSON.stringify(completeReading));
  delete objectCoverageWithoutReading.preparations[0].reading;
  await remount(objectCoverageWithoutReading); await tab('导读'); await assertPreviousClosed();
  for (const change of [{ key: 'legacy-sample' }, { sourceHash: 'old-source-hash' }, { start: 1, end: 20 }]) {
    const priorRecord = JSON.parse(JSON.stringify(completeReading));
    Object.assign(priorRecord.preparations[0], change);
    await remount(priorRecord); await tab('导读'); await assertPreviousClosed(); await assertCurrentScope();
  }
  const recoveredReading = JSON.parse(JSON.stringify(completeReading));
  recoveredReading.preparations.unshift({ id: 'old-failed-reading', key: 'old-engine-key', sourceHash: 'hash-a', start: 1, end: 20, status: 'error', error: '已经恢复的旧版失败' });
  await remount(recoveredReading); await tab('导读');
  assert.equal(await previous().count(), 0);
  assert.equal(await panel().locator('.guanyi-study-current-result').isVisible(), true);
  assert.doesNotMatch(await panel().innerText(), /本次研读失败|已经恢复的旧版失败|上次研读已中断/);
  const latestFailedReading = JSON.parse(JSON.stringify(recoveredReading));
  latestFailedReading.preparations.push({ ...latestFailedReading.preparations[0], id: 'latest-failed-reading', error: '最近一次失败仍需提示' });
  await remount(latestFailedReading); await tab('导读');
  assert.match(await panel().innerText(), /本次研读失败.*最近一次失败仍需提示/s);
  await remount(legacyReading); await tab('导读');

  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle();
    await assertPreviousClosed(); await assertCurrentScope();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await previousSummary.evaluate(node => {
      const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.left >= 0 && rect.right <= innerWidth && (hit === node || node.contains(hit));
    }), true, 'previous-result disclosure remains reachable in each theme and viewport');
    await page.screenshot({ path: path.join(output, `legacy-guide-${theme}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => { fixture.mode = 'defer'; }); await button('研读全文').click();
  await page.waitForFunction(() => fixture.pendingReading.length === 1 && fixture.saved.preparations.at(-1).status === 'preparing');
  await assertPreviousClosed(); await assertCurrentScope();
  assert.match(await guideHeader().innerText(), /新的全文结果生成中.*此前结果保留在下方/);
  assert.equal(await panel().getByRole('heading', { name: '旧版采样导读', exact: true }).isVisible(), false);
  await page.screenshot({ path: path.join(output, 'legacy-guide-generating.png') });
  await previousSummary.click();
  assert.match(await previous().innerText(), /不是本次.*进度|不代表本次.*进度/);
  const requestsBeforeProgress = await page.evaluate(() => fixture.requests.length);
  await page.evaluate(() => fixture.pendingReading.splice(0).forEach(resolve => resolve()));
  await page.waitForFunction(count => fixture.requests.length > count && fixture.pendingReading.length === 1, requestsBeforeProgress);
  assert.equal(await previous().evaluate(node => node.open), true, 'progress rerender preserves an explicitly opened previous result');
  await previousSummary.click();
  const requestsBeforeNextProgress = await page.evaluate(() => fixture.requests.length);
  await page.evaluate(() => fixture.pendingReading.splice(0).forEach(resolve => resolve()));
  await page.waitForFunction(count => fixture.requests.length > count && fixture.pendingReading.length === 1, requestsBeforeNextProgress);
  await assertPreviousClosed();
  await button('停止').click(); await page.waitForFunction(() => fixture.saved.preparations.at(-1).status === 'interrupted');
  await assertPreviousClosed(); assert.match(await panel().innerText(), /上次研读已中断/);
  const writesAfterCancel = await page.evaluate(() => fixture.writes.length);
  await page.evaluate(() => { fixture.mode = 'normal'; fixture.pendingReading.splice(0).forEach(resolve => resolve()); }); await settle();
  assert.equal(await page.evaluate(() => fixture.writes.length), writesAfterCancel, 'late response after stop cannot write a replacement reading');
  assert.equal(await page.evaluate(() => fixture.saved.preparations.filter(item => item.status === 'ready').length), 1);
  assert.deepEqual(await page.evaluate(() => fixture.saved.preparations.find(item => item.id === 'legacy-sampled-reading').guide[0].sources), savedLegacySources);

  await page.evaluate(() => { fixture.mode = 'error'; }); await button('重试全文研读').click();
  await page.waitForFunction(() => fixture.saved.preparations.at(-1).status === 'error');
  await assertPreviousClosed(); assert.match(await panel().innerText(), /本次研读失败.*测试模型暂不可用/s);
  assert.equal(await page.evaluate(() => fixture.saved.preparations.filter(item => item.status === 'ready').length), 1);
  await page.evaluate(() => { fixture.mode = 'normal'; }); await button('重试全文研读').click();
  await page.waitForFunction(() => fixture.saved.preparations.at(-1).status === 'ready' && fixture.saved.preparations.at(-1).reading?.title === '本次全文研读');
  assert.equal(await previous().count(), 0, 'successful full reading becomes the primary result');
  assert.equal(await panel().getByRole('heading', { name: '本次全文研读', exact: true }).isVisible(), true);
  assert.match(await panel().locator('.guanyi-study-coverage').innerText(), /全文 24 页.*文字块 24\/24.*页面图像 24\/24/);
  assert.doesNotMatch(await panel().innerText(), /80\/2411|旧版采样导读|本次研读失败|上次研读已中断/);
  assert.deepEqual(await page.evaluate(() => fixture.saved.messages), beforeLegacyDisplay.messages, 'legacy migration and replacement preserve saved conversations');
  assert.deepEqual(await page.evaluate(() => fixture.saved.preparations.find(item => item.id === 'legacy-sampled-reading').guide[0].sources), savedLegacySources, 'successful refresh retains historical source snapshots');
  const fullReading = await page.evaluate(() => fixture.saved.preparations.at(-1));

  // A modern, complete result is also clearly separated while its replacement
  // is running; stopping brings that already saved result back into view.
  await page.evaluate(() => { fixture.mode = 'defer'; }); await button('重新研读').click();
  await page.waitForFunction(() => fixture.pendingReading.length === 1 && fixture.saved.preparations.at(-1).status === 'preparing');
  await assertPreviousClosed(); await assertCurrentScope();
  assert.equal(await previous().locator('.guanyi-study-overview').isVisible(), false);
  assert.match(await guideHeader().innerText(), /新的全文结果生成中.*此前结果保留在下方/);
  await button('停止').click(); await page.waitForFunction(() => fixture.saved.preparations.at(-1).status === 'interrupted');
  assert.equal(await previous().count(), 0);
  assert.equal(await panel().getByRole('heading', { name: '本次全文研读', exact: true }).isVisible(), true);
  await page.evaluate(() => { fixture.mode = 'normal'; fixture.pendingReading.splice(0).forEach(resolve => resolve()); }); await settle();
  assert.deepEqual(await page.evaluate(id => fixture.saved.preparations.find(item => item.id === id), fullReading.id), fullReading);

  await page.evaluate(() => { fixture.legacyRefresh = false; fixture.mode = 'wait'; });
  await tab('文档对话'); await question().fill('当前问答不应被标为重新研读');
  const beforeQuestion = await page.evaluate(() => fixture.requests.length);
  await button('发送').click();
  await page.waitForFunction(count => fixture.requests.length > count && fixture.saved.messages.at(-1).status === 'pending', beforeQuestion);
  await tab('导读');
  assert.equal(await previous().count(), 0, 'a pending question does not collapse the saved full reading');
  assert.equal(await panel().getByRole('heading', { name: '本次全文研读', exact: true }).isVisible(), true);
  assert.equal(await guideHeader().getByRole('button', { name: '重新研读', exact: true }).isDisabled(), true);
  assert.doesNotMatch(await guideHeader().innerText(), /正在研读|新的全文结果生成中|本次研读范围/);
  await button('停止').click(); await page.waitForFunction(() => fixture.saved.messages.at(-1).status === 'interrupted');
  await page.evaluate(() => { fixture.mode = 'normal'; });
  await page.evaluate(() => { reader.info.numPages = 4; delete reader.renderVisual; fixture.legacyRefresh = false; });
  await remount(beforeLegacyDisplay);
  console.log('PASS legacy-format migration, prior/current scope separation, disclosure access, late-result cancellation, failure retention and full-result replacement');

  stage('preserving export and rejecting late native snapshots after dispose');
  await page.setViewportSize({ width: 1440, height: 960 }); await tab('批注');
  for (const method of ['icon', 'escape', 'cancel']) {
    await button('整理为 Markdown').click(); await assertDialogClose('整理为 Markdown', button('整理为 Markdown'), method);
    assert.equal(await page.evaluate(() => fixture.markdown.length), 0, 'closing export never creates a document');
  }
  await button('整理为 Markdown').click();
  await page.evaluate(() => { fixture.failWrites = true; });
  await page.locator('dialog').getByRole('button', { name: '创建 Markdown 笔记', exact: true }).click();
  await page.locator('dialog .guanyi-study-error').filter({ hasText: '创建笔记失败' }).waitFor();
  assert.equal(await page.locator('dialog').isVisible(), true, 'failed export keeps dialog and selection');
  assert.equal(await page.locator('dialog').getByRole('button', { name: '关闭整理为 Markdown', exact: true }).isVisible(), true);
  await page.evaluate(() => { fixture.failWrites = false; });
  await page.locator('dialog').getByRole('button', { name: '创建 Markdown 笔记', exact: true }).click(); await page.waitForFunction(() => fixture.markdown.length === 1);
  assert.match(await page.evaluate(() => fixture.markdown[0].content), /编辑中的草稿在关闭和重新挂载后仍保留/);
  assert.match(await page.evaluate(() => fixture.markdown[0].content), /来源版本 hash-a/);
  await tab('文档对话'); await page.evaluate(() => { fixture.mode = 'wait'; }); await question().fill('中断后仍要保留的问题');
  const pendingStart = await page.evaluate(() => fixture.requests.length); await button('发送').click();
  await page.waitForFunction(count => fixture.requests.length > count && fixture.saved.messages.at(-1).status === 'pending', pendingStart);
  await page.evaluate(() => { fixture.deferAnnotations = true; annotationHandler(); }); await page.waitForFunction(() => fixture.pendingAnnotations.length > 0);
  await page.evaluate(() => { fixture.oldAnnotationHandler = annotationHandler; }); await page.evaluate(() => study.dispose());
  assert.equal(await page.evaluate(() => fixture.saved.messages.at(-1).status), 'interrupted'); assert.equal(await page.evaluate(() => fixture.saved.draft), '中断后仍要保留的问题');
  assert.equal(await page.evaluate(() => fixture.subscriptions === fixture.unsubscribes), true, 'dispose removes every annotation subscription');
  assert.equal(await page.evaluate(() => annotationHandler), null);
  const disposedWrites = await page.evaluate(() => fixture.writes.length), disposedReads = await page.evaluate(() => fixture.annotationReads);
  await page.evaluate(() => { fixture.pendingAnnotations.splice(0).forEach(resolve => resolve()); fixture.oldAnnotationHandler(); }); await settle();
  assert.equal(await page.evaluate(() => fixture.writes.length), disposedWrites); assert.equal(await page.evaluate(() => fixture.annotationReads), disposedReads, 'stale subscription callback cannot read again');
  assert.equal(await page.locator('iframe.guanyi-pdf-frame').count(), 1);
  assert.equal(await page.locator('.guanyi-pdf-study-shell,.guanyi-study-panel,.guanyi-study-toggle,.guanyi-study-dialog').count(), 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify({ originalCanvasRetained: true, explicitCardConfirmation: true, defaultNoteCards: true, transactionalNoteWrites: true, sameIdNoteEditing: true,
    deleteIsolation: true, secondCardDeleteFocus: true, draftOnlySaveDoesNotDelete: true, explicitDeleteAfterDraftSave: true, editorPersistence: true, legacyDraftRestoration: true, selectionOpensEditor: true, nativeAutoRefresh: true, nativeContentEscaped: true, nativeNoFakeCrud: true, nativeSourceLocation: true,
    frozenChatEvidence: true, invalidSourcesBlocked: true, sameMessageRetry: true, savedAnswerSurvivesDraftFailure: true, imeSafe: true, sendStopInsideInput: true, themeWidths: ['light/1440', 'light/390', 'dark/1440', 'dark/390'], dialogCloseIcons: true, dialogCloseFocus: true, dialogEscapeCancel: true, dialogSaveFailureRetainsInput: true,
    legacyGuideCollapsed: true, legacyGuideSourcePreserved: true, legacyGuideRecordShapes: true, currentFullDocumentScope: true, priorResultNotCurrentProgress: true, priorDisclosureSurvivesProgress: true,
    resolvedFailureNotShown: true, latestFailureShown: true, questionDoesNotMimicReading: true, lateReadingIgnoredAfterCancel: true, failedReadingKeepsPrevious: true, successfulReadingReplacesDisplay: true, savedConversationsPreserved: true, export: true, disposalRace: true, errors }, null, 2)}\n`);
  console.log('PASS export, interrupted draft, subscription cleanup and late annotation-read isolation; no page errors');
})().catch(async error => {
  console.error(`PDF study browser failed during ${phase}:`, error); fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack || error}\n`);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await page.evaluate(() => ({ fixture, html: document.querySelector('.guanyi-study-panel')?.outerHTML })).then(value => fs.writeFileSync(path.join(output, 'failure-state.json'), `${JSON.stringify(value, null, 2)}\n`)).catch(() => {});
  }
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
