/* Run with: node tools/run-electron-smoke.mjs docs/pdf-study/acceptance.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const prototypeRoot = __dirname;
const projectRoot = path.resolve(prototypeRoot, '../..');
const outputRoot = path.join(projectRoot, '.tmp-test', 'pdf-study-prototype');
fs.mkdirSync(outputRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputRoot, 'run-'));
app.setPath('userData', path.join(runRoot, 'profile'));
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
const watchdog = setTimeout(() => { console.error('PDF study prototype acceptance timed out'); app.exit(1); }, 180000);

let window;
let operation = 'boot';
const checks = [];
const screenshots = [];
const errors = [];
const networkRequests = [];
const evaluate = (code) => window.webContents.executeJavaScript(code);
const state = () => evaluate('window.__PDF_STUDY_PROTOTYPE__.getState()');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await delay(35);
  }
  throw new Error(`Timed out: ${label}`);
}
async function click(selector) {
  const position = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    if (element.disabled) throw new Error('Disabled click target: ' + ${JSON.stringify(selector)});
    // A paragraph split over CSS columns has a union box whose center may be
    // the empty column gap. Click a visible rendered fragment, as a person does.
    for (const rect of element.getClientRects()) {
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x,y);
      if (hit === element || element.contains(hit)) return {x,y};
    }
    throw new Error('Unavailable click target: ' + ${JSON.stringify(selector)} + '; selection=' + getSelection()?.toString() + '; state=' + JSON.stringify(window.__PDF_STUDY_PROTOTYPE__.getState()));
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...position });
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
  await delay(45);
}
async function fill(selector, text) {
  await click(selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await window.webContents.insertText(text);
}
async function choose(selector, value) {
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await delay(40);
}
async function page(number) {
  await choose('#page-input', String(number));
  await until(async () => (await state()).page === number, `page ${number}`);
}
async function ask(question, scope = null) {
  if ((await state()).panel !== 'ask') await click('[data-panel="ask"]');
  if (scope) await choose('#scope-select', scope);
  await fill('#question-input', question);
  await click('#send-question');
  await until(async () => !(await state()).pending, 'answer completes');
  return (await state()).answers.at(-1);
}
function passed(name, detail = {}) { checks.push({ name, status: 'passed', ...detail }); }
async function capture(name, width, height, theme, panel = 'guide', document = 'textbook') {
  if ((await state()).document !== document) await click(`.document-tab[data-document="${document}"]`);
  if (await evaluate('document.documentElement.dataset.theme') !== theme) await click('#theme-button');
  if (await evaluate('document.getElementById("study-panel").classList.contains("is-hidden")')) await click('#study-toggle');
  if ((await state()).panel !== panel) await click(`[data-panel="${panel}"]`);
  await choose('#scenario-select', 'ready');
  window.setContentSize(width, height);
  await delay(140);
  if (panel === 'cards') await evaluate('document.getElementById("panel-content").scrollTop=0');
  await until(() => evaluate('document.getElementById("toast").hidden'), 'transient toast cleared before screenshot');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(80);
  const metrics = await evaluate(`(() => {
    const rect = selector => {const element=document.querySelector(selector),r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,visible:!!element.getClientRects().length&&getComputedStyle(element).display!=='none'};};
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme,prototype:rect('.prototype-bar'),titlebar:rect('.titlebar'),toolbar:rect('.reader-toolbar'),panel:rect('#study-panel'),content:rect('#panel-content'),footer:rect('.app-status'),library:rect('#library'),tabs:rect('.document-tabs'),scrim:rect('#workspace-scrim'),page:rect('#pdf-page'),composer:document.querySelector('#question-input')?rect('#question-input'):null};
  })()`);
  assert.equal(window.isVisible(), false, `${name}: window must stay hidden`);
  assert.equal(window.isFocused(), false, `${name}: window must not take focus`);
  assert.equal(metrics.width, width);
  assert.equal(metrics.height, height);
  assert.ok(metrics.scrollWidth <= width + 1, `${name}: document has horizontal overflow (${metrics.scrollWidth})`);
  assert.ok(metrics.panel.right <= width + 1 && metrics.panel.left >= -1, `${name}: panel outside viewport`);
  assert.ok(metrics.panel.top >= metrics.prototype.bottom, `${name}: panel covers prototype label`);
  assert.ok(metrics.panel.bottom <= metrics.footer.top + 1, `${name}: panel covers status controls`);
  assert.ok(metrics.content.height >= 200, `${name}: panel lacks working area`);
  assert.ok(Math.abs(metrics.footer.height - 26) <= 1, `${name}: status bar must follow the 26px baseline`);
  assert.ok(Math.abs(metrics.toolbar.height - (width <= 760 ? 47 : 49)) <= 1, `${name}: PDF toolbar height drifted from the design-system baseline`);
  if (width >= 1180) {
    assert.ok(Math.abs(metrics.library.width - 268) <= 1, `${name}: sidebar must be 268px`);
    assert.ok(Math.abs(metrics.panel.width - 360) <= 1, `${name}: study panel must be 360px`);
    assert.ok(metrics.toolbar.right <= metrics.panel.left + 1, `${name}: wide study panel overlaps toolbar`);
    assert.equal(metrics.scrim.visible, false, `${name}: wide layout must not show the drawer scrim`);
  } else {
    assert.ok(metrics.panel.top >= metrics.toolbar.bottom - 1, `${name}: overlay panel covers page navigation toolbar`);
    assert.ok(metrics.panel.width <= 361, `${name}: overlay panel exceeds the 360px baseline`);
    assert.equal(metrics.scrim.visible, true, `${name}: overlay panel needs a visible scrim`);
  }
  if (width > 760) assert.ok(Math.abs(metrics.library.width - 268) <= 1, `${name}: visible sidebar must remain 268px`);
  if (width <= 760) assert.ok(metrics.tabs.width >= 80, `${name}: document tabs lost their scroll viewport`);
  if (metrics.composer) assert.ok(metrics.composer.bottom <= metrics.panel.bottom && metrics.composer.left >= metrics.panel.left, `${name}: composer outside panel`);
  const imagePath = path.join(prototypeRoot, `preview-v1-${name}.png`);
  fs.writeFileSync(imagePath, (await window.webContents.capturePage()).toPNG());
  screenshots.push({ name, imagePath, metrics });
}

(async () => {
  await app.whenReady();
  if (process.platform === 'darwin') app.dock.hide();
  window = new BrowserWindow({
    width: 1440, height: 1000, useContentSize: true,
    show: false, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  window.webContents.on('console-message', (event) => { if (event.level === 'error' || /Uncaught (?:TypeError|ReferenceError|Error)/.test(event.message)) errors.push(event.message); });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { networkRequests.push(details.url); callback({ cancel: true }); });
  const downloads = [];
  window.webContents.session.on('will-download', (_event, item) => {
    const savePath = path.join(runRoot, item.getFilename());
    item.setSavePath(savePath);
    const entry = { path: savePath, status: 'pending' };
    downloads.push(entry);
    item.once('done', (_doneEvent, status) => { entry.status = status; });
  });
  await window.loadFile(path.join(prototypeRoot, 'current.html'));
  await until(() => evaluate('Boolean(window.__PDF_STUDY_PROTOTYPE__)'), 'prototype boot');
  assert.equal((await state()).document, 'textbook');
  assert.equal((await state()).page, 42);
  assert.equal(window.isVisible(), false);
  assert.equal(await evaluate('document.documentElement.dataset.designSystem'), 'guanyi-v1.0');
  assert.equal(await evaluate('document.documentElement.dataset.prototypeVersion'), 'v0.3-ds-v1');
  assert.equal(await evaluate('document.querySelector("meta[name=prototype-scenario]").content'), 'PDF 文档智能研读');
  assert.match(await evaluate('document.querySelector("meta[name=prototype-baseline]").content'), /V1\.0/);
  assert.match(await evaluate('document.querySelector("meta[name=prototype-difference]").content'), /模拟 PDF/);
  assert.match(await evaluate('document.querySelector("meta[name=prototype-narrow-screen]").content'), /1180px.*760px/);
  passed('Current design-system prototype booted with review metadata in a hidden window');
  const designContract = await evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    const tabs = [...document.querySelectorAll('.document-tab')];
    const iconButtons = [...document.querySelectorAll('.icon-button')];
    document.getElementById('theme-button').focus();
    const focus = getComputedStyle(document.getElementById('theme-button'));
    return {
      sidebar: root.getPropertyValue('--guanyi-sidebar-width').trim(),
      toolbar: root.getPropertyValue('--guanyi-formatbar-height').trim(),
      status: root.getPropertyValue('--guanyi-statusbar-height').trim(),
      selectedTabs: tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length,
      tabbableTabs: tabs.filter(tab => tab.tabIndex === 0).length,
      unnamedIconButtons: iconButtons.filter(button => !button.getAttribute('aria-label') && !button.textContent.trim()).length,
      focusOutline: focus.outlineWidth,
      themePressed: document.getElementById('theme-button').getAttribute('aria-pressed'),
      studyExpanded: document.getElementById('study-toggle').getAttribute('aria-expanded'),
      libraryExpanded: document.getElementById('library-toggle').getAttribute('aria-expanded')
    };
  })()`);
  assert.deepEqual([designContract.sidebar, designContract.toolbar, designContract.status], ['268px', '49px', '26px']);
  assert.equal(designContract.selectedTabs, 1);
  assert.equal(designContract.tabbableTabs, 1);
  assert.equal(designContract.unnamedIconButtons, 0);
  assert.equal(designContract.focusOutline, '2px');
  assert.equal(designContract.themePressed, 'false');
  assert.equal(designContract.studyExpanded, 'true');
  assert.equal(designContract.libraryExpanded, 'true');
  passed('Semantic tokens, document tabs, icon names, focus ring and disclosure states follow Design System V1.0');
  assert.equal(await evaluate('document.querySelectorAll("[data-mode],.study-modes").length'), 0);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-panel]")].map(button=>button.childNodes[0].textContent.trim())'), ['导读', '文档对话', '学习卡', '批注']);
  assert.equal(await evaluate('document.querySelectorAll(".study-context").length'), 0);
  assert.equal(await evaluate('document.querySelector("#study-panel").textContent.includes("通用研读 · 导读随本文结构适配")'), false);
  assert.equal(await evaluate('document.querySelectorAll(".document-tab").length'), 2);
  assert.equal((await state()).cards.length, 0);
  passed('Universal study keeps one four-tab workspace and separate sample document tabs without learning-mode gates');

  await click('[data-panel="cards"]');
  const initialCandidates = await evaluate('[...document.querySelectorAll(".candidate-card")].map(card=>({id:card.dataset.candidateId,type:card.querySelector(".card-tag").textContent,question:card.querySelector("h3").textContent,pages:[...card.querySelectorAll(".page-ref")].map(button=>Number(button.dataset.page))}))');
  assert.equal(initialCandidates.length, 3);
  assert.ok(initialCandidates.every(candidate => candidate.id && candidate.type && candidate.question && candidate.pages.length));
  assert.equal(new Set(initialCandidates.map(candidate => candidate.type)).size, 3);
  assert.equal((await state()).cards.length, 0, 'Automatically prepared candidates are not saved cards');
  assert.equal(await evaluate('Boolean(document.querySelector("[data-action=review],[data-action=export]"))'), false, 'Candidates must not enter self-testing or export before confirmation');
  await click('[data-panel="guide"]');
  passed('Document preparation exposes typed source-linked candidate cards without adding them to review or export');

  await capture('textbook-light', 1440, 1000, 'light');
  await click('[data-block-id="oxygen-use"]');
  assert.equal(await evaluate('document.getElementById("selection-menu").hidden'), false);
  await click('[data-selection-action="explain"]');
  await until(async () => !(await state()).pending, 'selected passage explanation');
  let answer = (await state()).answers.at(-1);
  assert.equal(answer.status, 'ready');
  assert.equal(answer.scope, 'selection');
  assert.equal(answer.evidence[0].page, 42);
  assert.match(answer.evidence[0].quote, /耗氧量/);
  assert.equal((await state()).cards.length, 0, 'Explaining a passage must not automatically create a card');
  const answerId = answer.id;
  await capture('textbook-answer', 1440, 1000, 'light', 'ask');
  passed('Textbook passage selection produces scoped explanation with original evidence');

  await page(55);
  const scrollBefore = await evaluate('(() => { const el=document.getElementById("paper-scroll");el.scrollTop=80;return el.scrollTop;})()');
  await click(`[data-answer-id="${answerId}"] .page-ref`);
  assert.equal((await state()).page, 42);
  assert.ok(await evaluate('Boolean(document.querySelector("[data-block-id=oxygen-use].evidence-highlight"))'));
  await click('#return-button');
  assert.equal((await state()).page, 55);
  await delay(50);
  assert.ok(Math.abs((await evaluate('document.getElementById("paper-scroll").scrollTop')) - scrollBefore) <= 1);
  assert.equal(await evaluate('document.activeElement.matches(".page-ref")'), true);
  passed('Evidence jumps to the original page and returns to the prior page, scroll and citation focus');

  await click(`[data-save-answer="${answerId}"]`);
  assert.equal(await evaluate('document.getElementById("modal").open'), true);
  assert.equal((await state()).cards.length, 0);
  assert.equal(await evaluate('document.getElementById("card-count").textContent'), '0');
  assert.ok(await evaluate('document.getElementById("card-draft-question").value.length>0'));
  assert.ok(await evaluate('document.getElementById("card-draft-answer").value.length>0'));
  await click('[data-action="close-modal"]');
  assert.equal((await state()).cards.length, 0);
  await click(`[data-save-answer="${answerId}"]`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(() => evaluate('!document.getElementById("modal").open'), 'card draft dismissed by Escape');
  assert.equal((await state()).cards.length, 0);
  passed('Generated card drafts remain outside the library and can be cancelled by button or Escape');

  await click(`[data-save-answer="${answerId}"]`);
  const draftAnswer = '草稿核对：耗氧量描述一定时间内利用氧的量，不能用单一供氧环节代替。';
  await fill('#card-draft-answer', draftAnswer);
  assert.equal((await state()).cards.length, 0);
  await click('[data-action="save-card-draft"]');
  assert.equal((await state()).cards.length, 1, await evaluate('JSON.stringify({modal:document.getElementById("modal").open,toast:document.getElementById("toast").textContent,question:document.getElementById("card-draft-question")?.value,answer:document.getElementById("card-draft-answer")?.value})'));
  assert.equal((await state()).cards[0].answer, draftAnswer);
  assert.equal((await state()).cards[0].page, 42);
  assert.match((await state()).cards[0].quote, /耗氧量/);
  passed('Editable draft enters the library only after explicit confirmation and retains its source');
  await click(`[data-save-answer="${answerId}"]`);
  await click('[data-action="save-card-draft"]');
  assert.equal((await state()).cards.length, 1);
  await click('[data-panel="cards"]');
  const cardId = (await state()).cards[0].id;
  await click(`[data-edit-card="${cardId}"]`);
  await fill('#card-question', '我能说清楚耗氧量与供氧能力的区别吗？');
  await fill('#card-answer', '耗氧量描述一段时间内利用了多少氧，需要结合运输与利用理解。');
  await click('[data-action="update-card"]');
  assert.equal((await state()).cards[0].page, 42);
  assert.match((await state()).cards[0].quote, /耗氧量/);
  assert.equal((await state()).cards[0].kind, '我的理解');
  await click('[data-action="review"]');
  assert.equal(await evaluate('document.getElementById("modal").open'), true);
  assert.equal(await evaluate('Boolean(document.querySelector(".review-answer"))'), false);
  await click('[data-review-reveal="0"]');
  assert.ok(await evaluate('document.querySelector(".review-answer").textContent.includes("耗氧量")'));
  await click('[data-grade="known"]');
  assert.equal((await state()).cards[0].mastered, true);
  await click('[data-action="close-modal"]');
  await click('[data-action="export"]');
  await until(() => downloads.some(download => download.status === 'completed'), 'Markdown download');
  const markdown = fs.readFileSync(downloads.at(-1).path, 'utf8');
  assert.match(markdown, /第 42 页/);
  assert.match(markdown, /预设|演示/);
  assert.match(markdown, /已掌握/);
  assert.match(markdown, /耗氧量/);
  await capture('learning-cards', 1440, 1000, 'light', 'cards', 'textbook');
  passed('Learning cards deduplicate, preserve sources while editing, record self-test mastery and export Markdown');

  await window.reload();
  await until(() => evaluate('Boolean(window.__PDF_STUDY_PROTOTYPE__)'), 'prototype reload');
  assert.equal((await state()).cards.length, 1);
  assert.equal((await state()).cards[0].mastered, true);
  assert.equal((await state()).page, 55);
  passed('Reload restores learning cards, mastery and document page');

  await click('[data-block-id="measurement"]');
  await click('[data-selection-action="save"]');
  assert.equal(await evaluate('document.getElementById("modal").open'), true);
  assert.match(await evaluate('document.getElementById("card-draft-answer").value'), /测量值/);
  assert.equal((await state()).cards.length, 1, 'Selection card must also wait for confirmation');
  await click('[data-action="close-modal"]');
  assert.equal((await state()).cards.length, 1);
  passed('Direct selection-to-card follows the same draft-and-confirm contract');

  await click('.document-tab[data-document="paper"]');
  assert.equal((await state()).page, 3);
  assert.match(await evaluate('document.getElementById("panel-content").textContent'), /48 名|48/);
  assert.match(await evaluate('document.getElementById("panel-content").textContent'), /虚构研究/);
  assert.equal((await state()).answers.length, 0);
  await capture('paper-light', 1440, 1000, 'light', 'guide', 'paper');
  await click('#panel-content .page-ref[data-page="5"]');
  assert.equal((await state()).page, 5);
  assert.ok(await evaluate('Boolean(document.querySelector("[data-block-id=result].evidence-highlight"))'));
  await click('#return-button');
  assert.equal((await state()).page, 3);
  answer = await ask('这篇论文的结果可以直接用于老年人吗？', 'document');
  assert.equal(answer.status, 'ready');
  assert.deepEqual(answer.evidence.map(item => item.page), [3, 7]);
  assert.match(answer.explanation, /不能支持|没有提供/);
  await click(`[data-note-answer="${answer.id}"]`);
  assert.equal((await state()).notes.length, 1);
  assert.deepEqual((await state()).notes[0].sources.map(item => item.page), [3, 7]);
  await click(`[data-save-answer="${answer.id}"]`);
  assert.equal((await state()).cards.filter(card => card.document === 'paper').length, 0);
  assert.match(await evaluate('document.getElementById("modal-content").textContent'), /第 3 页.*第 7 页/);
  await click('[data-action="save-card-draft"]');
  assert.deepEqual((await state()).cards.find(card => card.document === 'paper').sources.map(item => item.page), [3, 7]);
  await click('[data-panel="cards"]');
  const previousDownloadCount = downloads.length;
  await click('[data-action="export"]');
  await until(() => downloads.length > previousDownloadCount && downloads.at(-1).status === 'completed', 'multi-source paper export');
  const paperMarkdown = fs.readFileSync(downloads.at(-1).path, 'utf8');
  assert.match(paperMarkdown, /第 3 页/);
  assert.match(paperMarkdown, /第 7 页/);
  assert.match(paperMarkdown, /不能直接外推/);
  await click('[data-panel="notes"]');
  await fill('#note-input', '待核实：训练强度与完成率为何未报告？');
  await click('[data-panel="guide"]');
  await page(5);
  await click('[data-panel="notes"]');
  assert.equal(await evaluate('document.getElementById("note-input").value'), '待核实：训练强度与完成率为何未报告？');
  await click('[data-action="save-note"]');
  assert.equal((await state()).notes.at(-1).page, 3);
  await click('[data-panel="ask"]');
  await capture('paper-dark', 1440, 1000, 'dark', 'ask', 'paper');
  passed('Paper study shows fictional PICO fields, evidence links and source-based applicability answer');
  passed('Multi-evidence cards and exported notes preserve every cited source page');

  await page(1);
  answer = await ask('统计结果与实际意义有什么区别？', 'page');
  assert.equal(answer.status, 'insufficient');
  await click('[data-action="expand-scope"]');
  assert.equal((await state()).scope, 'document');
  answer = await ask('统计结果与实际意义有什么区别？');
  assert.equal(answer.status, 'ready');
  assert.equal(answer.evidence[0].page, 5);
  passed('Narrow scope yields insufficient evidence; expanding scope finds the quoted results page');

  await choose('#scenario-select', 'error');
  answer = await ask('研究人群和训练方案是什么？', 'document');
  assert.equal(answer.status, 'error');
  assert.equal(answer.question, '研究人群和训练方案是什么？');
  await click(`[data-retry="${answer.id}"]`);
  await until(async () => !(await state()).pending, 'retry answer');
  assert.equal((await state()).answers.at(-1).status, 'ready');
  assert.equal((await state()).answers.at(-1).id, answer.id);
  await fill('#question-input', '研究人群和训练方案是什么？');
  await click('#send-question');
  assert.equal((await state()).pending, true);
  await click('#cancel-request');
  assert.equal((await state()).pending, false);
  assert.equal((await state()).answers.at(-1).status, 'cancelled');
  passed('Request failures retain the question, retry in place, and can be cancelled');

  for (const scenario of ['scan', 'indexing', 'stale']) {
    await choose('#scenario-select', scenario);
    await fill('#question-input', '保留这个尚未发送的问题');
    assert.equal(await evaluate('document.getElementById("send-question").disabled'), true);
    const pageBefore = (await state()).page;
    await click('#next-page');
    assert.equal((await state()).page, pageBefore + 1);
    assert.equal(await evaluate('document.getElementById("question-input").value'), '保留这个尚未发送的问题');
    await click('[data-action="recover"]');
    assert.equal((await state()).scenario, 'ready');
    assert.equal(await evaluate('document.getElementById("question-input").value'), '保留这个尚未发送的问题');
    assert.equal(await evaluate('document.getElementById("send-question").disabled'), false);
  }
  passed('OCR, indexing and stale-source states preserve reading and prepared questions with recovery');

  await click('.document-tab[data-document="textbook"]');
  assert.equal((await state()).answers.length, 0); // Reload intentionally kept durable study assets only.
  assert.equal((await state()).cards.filter(card => card.document === 'textbook').length, 1);
  assert.equal((await state()).notes.length, 0);
  await click('[data-panel="ask"]');
  await page(55);
  await choose('#scope-select', 'page');
  await fill('#question-input', '解释指标时需要注意什么条件？');
  await page(56);
  assert.match(await evaluate('document.getElementById("scope-hint").textContent'), /第 55 页.*已锁定/);
  assert.equal(await evaluate('document.getElementById("question-input").value'), '解释指标时需要注意什么条件？');
  await click('#send-question');
  await click('#page-input');
  await until(async () => !(await state()).pending, 'locked-context answer');
  assert.equal((await state()).answers.at(-1).page, 55);
  assert.equal((await state()).answers.at(-1).evidence[0].page, 55);
  assert.equal(await evaluate('document.activeElement.id'), 'page-input');
  passed('Prepared questions freeze page scope across navigation and completion preserves PDF-side focus');
  await fill('#question-input', '通俗解释耗氧量');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
  await delay(50);
  assert.equal((await state()).pending, false);
  await choose('#scope-select', 'document');
  await fill('#question-input', '通俗解释耗氧量');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await until(async () => !(await state()).pending && (await state()).answers.length > 0, 'Enter sends question');
  assert.equal((await state()).answers.at(-1).status, 'ready');
  passed('Document switching isolates notes and answers; keyboard supports Enter and Shift+Enter');

  await capture('tablet', 1024, 768, 'light', 'ask', 'textbook');
  await capture('narrow', 760, 800, 'dark', 'ask', 'paper');
  await capture('mobile', 360, 844, 'light', 'ask', 'textbook');
  await click('#study-close');
  assert.equal(await evaluate('document.getElementById("study-panel").classList.contains("is-hidden")'), true);
  assert.equal(await evaluate('document.activeElement.id'), 'study-toggle');
  await click('#study-toggle');
  assert.equal(await evaluate('document.getElementById("study-toggle").getAttribute("aria-expanded")'), 'true');
  passed('1180/760/360 responsive layouts remain stable; the overlay study panel can be closed and reopened');

  window.setContentSize(1440, 1000);
  await click('.document-tab[data-document="paper"]');
  await window.reload();
  await until(() => evaluate('Boolean(window.__PDF_STUDY_PROTOTYPE__)'), 'paper durable notes restore');
  assert.equal((await state()).notes.length, 2);
  assert.deepEqual((await state()).notes[0].sources.map(item => item.page), [3, 7]);
  assert.equal((await state()).notes[1].page, 3);
  passed('Personal note drafts keep their original page across navigation and durable multi-source notes restore');

  const selectedPassages = [];
  for (const [documentId, pages] of Object.entries({ textbook: [42, 55, 56, 64], paper: [1, 3, 5, 7] })) {
    if ((await state()).document !== documentId) await click(`.document-tab[data-document="${documentId}"]`);
    for (const number of pages) {
      await page(number);
      const paragraphs = await evaluate('[...document.querySelectorAll("#pdf-page [data-block-id]")].map(el => ({id:el.dataset.blockId,text:el.textContent}))');
      for (const paragraph of paragraphs) {
        operation = `select ${documentId}/${number}/${paragraph.id}`;
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(30);
        await click(`[data-block-id="${paragraph.id}"]`);
        await click('[data-selection-action="explain"]');
        await until(async () => !(await state()).pending, `selected explanation ${documentId}/${number}/${paragraph.id}`);
        const explained = (await state()).answers.at(-1);
        assert.equal(explained.status, 'ready', `${documentId}/${number}/${paragraph.id}`);
        assert.equal(explained.scope, 'selection');
        assert.equal(explained.evidence[0].quote, paragraph.text);
        assert.equal(explained.evidence[0].block, paragraph.id);
        assert.equal(explained.evidence[0].page, number);
        selectedPassages.push(`${documentId}/${number}/${paragraph.id}`);
      }
    }
  }
  passed('Every authored selectable passage explains the exact original paragraph', { count: selectedPassages.length, passages: selectedPassages });

  await choose('#scenario-select', 'insufficient');
  const olderInsufficient = await ask('统计结果与实际意义有什么区别？', 'page');
  const newerInsufficient = await ask('研究人群和训练方案是什么？', 'page');
  assert.equal(olderInsufficient.status, 'insufficient');
  assert.equal(newerInsufficient.status, 'insufficient');
  await click(`[data-answer-id="${olderInsufficient.id}"] [data-action="expand-scope"]`);
  assert.equal(await evaluate('document.getElementById("question-input").value'), olderInsufficient.question);
  assert.equal((await state()).scope, 'document');
  passed('Expanding an older insufficient answer restores that exact historical question');

  await choose('#scenario-select', 'error');
  const olderError = await ask('统计结果与实际意义有什么区别？', 'document');
  assert.equal(olderError.status, 'error');
  const nextQuestion = '我准备的下一问：研究人群和训练方案是什么？';
  await fill('#question-input', nextQuestion);
  await click(`[data-retry="${olderError.id}"]`);
  assert.equal(await evaluate('document.getElementById("question-input").value'), nextQuestion);
  await until(async () => !(await state()).pending, 'old retry with next-question draft');
  assert.equal((await state()).answers.find(item => item.id === olderError.id).status, 'ready');
  assert.equal(await evaluate('document.getElementById("question-input").value'), nextQuestion);
  passed('Retrying an old failed answer preserves the prepared next-question draft');

  await click('.document-tab[data-document="textbook"]');
  await page(42);
  await click('[data-block-id="oxygen-chain"]');
  await click('[data-panel="ask"]');
  await choose('#scope-select', 'document');
  const keyboardQuestion = '耗氧量与供氧能力有什么区别？';
  const answerCount = (await state()).answers.length;
  await fill('#question-input', keyboardQuestion);
  const modifier = process.platform === 'darwin' ? 'meta' : 'control';
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: [modifier] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: [modifier] });
  await until(async () => !(await state()).pending && (await state()).answers.length > answerCount, 'modified Enter with selection');
  assert.equal((await state()).answers.length, answerCount + 1);
  assert.equal((await state()).answers.at(-1).question, keyboardQuestion);
  assert.equal(await evaluate('document.getElementById("question-input").value'), '');
  passed('Modified Enter in the question field sends only the user question while a passage remains selected');

  operation = 'automatic candidate preview and confirmation';
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await click('[data-panel="cards"]');
  const candidate = initialCandidates[1];
  const totalSavedBefore = (await state()).cards.length;
  const textbookSavedBefore = (await state()).cards.filter(card => card.document === 'textbook').length;
  await click(`[data-candidate="${candidate.id}"]`);
  assert.equal(await evaluate('document.getElementById("modal").open'), true);
  assert.equal(await evaluate('document.getElementById("card-draft-question").value'), candidate.question);
  assert.equal((await state()).cards.length, totalSavedBefore);
  await click('[data-action="close-modal"]');
  assert.equal((await state()).cards.length, totalSavedBefore);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-candidate-id="${candidate.id}"]'))`), true);
  await click(`[data-candidate="${candidate.id}"]`);
  const candidateQuestion = `我的核心思路卡：${candidate.question}`;
  await fill('#card-draft-question', candidateQuestion);
  await click('[data-action="save-card-draft"]');
  const retainedCandidate = (await state()).cards.find(card => card.candidateId === candidate.id);
  assert.ok(retainedCandidate);
  assert.equal(retainedCandidate.document, 'textbook');
  assert.equal(retainedCandidate.question, candidateQuestion);
  assert.deepEqual(retainedCandidate.sources.map(item => item.page), candidate.pages);
  assert.ok(retainedCandidate.sources.every(item => item.quote && item.block));
  assert.equal((await state()).cards.length, totalSavedBefore + 1);
  assert.equal((await state()).cards.filter(card => card.document === 'textbook').length, textbookSavedBefore + 1);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-candidate-id="${candidate.id}"]'))`), false);
  passed('Automatic candidates can be cancelled, edited and explicitly retained with every original source');

  await window.reload();
  await until(() => evaluate('Boolean(window.__PDF_STUDY_PROTOTYPE__)'), 'saved automatic candidate reload');
  await click('[data-panel="cards"]');
  assert.equal((await state()).cards.filter(card => card.candidateId === candidate.id).length, 1);
  assert.equal(await evaluate('document.querySelectorAll(".candidate-card").length'), 2);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-candidate-id="${candidate.id}"]'))`), false);
  const savedMarkdownCount = downloads.length;
  await click('[data-action="export"]');
  await until(() => downloads.length > savedMarkdownCount && downloads.at(-1).status === 'completed', 'retained candidate export');
  const retainedMarkdown = fs.readFileSync(downloads.at(-1).path, 'utf8');
  assert.ok(retainedMarkdown.includes(candidateQuestion));
  for (const pageNumber of candidate.pages) assert.ok(retainedMarkdown.includes(`第 ${pageNumber} 页`));
  const unsavedQuestions = await evaluate('[...document.querySelectorAll(".candidate-card h3")].map(element=>element.textContent)');
  assert.ok(unsavedQuestions.every(question => !retainedMarkdown.includes(`### ${question}`)), 'Unconfirmed candidate cards stay out of Markdown export');
  for (const scenario of ['scan', 'indexing', 'stale']) {
    await choose('#scenario-select', scenario);
    assert.equal(await evaluate('document.querySelectorAll(".candidate-card").length'), 0);
    assert.equal((await state()).cards.filter(card => card.candidateId === candidate.id).length, 1);
    await choose('#scenario-select', 'ready');
    assert.equal(await evaluate('document.querySelectorAll(".candidate-card").length'), 2);
  }
  passed('Retained candidates survive reload once; unconfirmed suggestions stay out of export and unavailable-source states');

  await click('.document-tab[data-document="paper"]');
  await click('[data-panel="cards"]');
  const paperCandidates = await evaluate('[...document.querySelectorAll(".candidate-card")].map(card=>({id:card.dataset.candidateId,type:card.querySelector(".card-tag").textContent}))');
  assert.equal(paperCandidates.length, 3);
  assert.ok(paperCandidates.every(item => item.id.startsWith('paper:')));
  assert.ok(paperCandidates.some(item => item.type.includes('研究思路')));
  assert.equal((await state()).cards.filter(card => card.candidateId === candidate.id).length, 1);
  await click('.document-tab[data-document="textbook"]');
  assert.equal(await evaluate('document.querySelectorAll(".candidate-card").length'), 2);
  await capture('learning-cards', 1440, 1000, 'light', 'cards', 'textbook');
  passed('Candidate suggestions and retained learning cards stay isolated per document');

  assert.deepEqual(errors, [], 'No renderer runtime errors');
  assert.deepEqual(networkRequests, [], 'Prototype must make no HTTP requests');
  const report = { checkedAt: new Date().toISOString(), result: 'passed', checkCount: checks.length, hidden: !window.isVisible(), focused: window.isFocused(), checks, screenshots, downloads, errors, networkRequests };
  fs.writeFileSync(path.join(runRoot, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, checks: checks.length, report: path.join(runRoot, 'acceptance.json'), screenshots: screenshots.map(item => item.imagePath), downloads: downloads.map(item => item.path) }, null, 2));
  clearTimeout(watchdog);
  app.exit(0);
})().catch(error => {
  fs.writeFileSync(path.join(runRoot, 'failure.json'), JSON.stringify({ operation, message: error.message, stack: error.stack, checks, screenshots, errors, networkRequests }, null, 2));
  console.error(error);
  clearTimeout(watchdog);
  app.exit(1);
});
