'use strict';

// Runs the built application unchanged. All writes and the model fixture stay in
// a generated test profile under .tmp-test; the installed application is unused.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const JSZip = require('jszip');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');

const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || 'release/mac-arm64/观译阅读器.app/Contents/MacOS/观译阅读器');
const expectedVersion = process.env.GUANYI_EXPECTED_VERSION || require('../package.json').version;
const resources = path.resolve(path.dirname(executable), '..', 'Resources');
const asarPath = path.join(resources, 'app.asar');
const outputRoot = path.join(root, '.tmp-test', 'packaged-home-study');
fs.mkdirSync(outputRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(outputRoot, 'run-'));
const profile = path.join(output, 'profile');
const sourcePath = path.join(output, 'Packaged study source.pdf');
const noAbstractPath = path.join(output, 'Packaged PDF without abstract.pdf');
const markdownPath = path.join(output, '旧版工具栏验收.md');
const textPath = path.join(output, '纯文本工具栏验收.txt');
const epubPath = path.join(output, 'EPUB 智能审阅验收.epub');
const chapterOneQuote = '阅读需要核对证据与条件，不能脱离原文推论。';
const chapterTwoQuote = '第二章秘密词：远山之约。结论必须保留来源。';
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = [];
const errors = [];
const quickTakeaway = '摘要以方法、结果以及适用条件串起阅读过程。';
const studySummary = '原文三页分别说明核对出处、检验条件和回顾依据。';
const assistantReply = '这是本地验收模型的直接对话回复，可以开始阅读或写一篇 Markdown。';
let application;
let browser;
let page;
let modelServer;
let modelPort;
let cdpPort;
let run = 0;

async function until(check, label, timeout = 45000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function generatedPdf() {
  const pdf = new jsPDF();
  pdf.text('Abstract: Reading uses source evidence and stated conditions.', 20, 30);
  pdf.text('The reading process ends with a personal review of the evidence.', 20, 40);
  pdf.text('Keywords: evidence, reading', 20, 50);
  pdf.text('Evidence remains linked to the original source.', 20, 65);
  pdf.addPage();
  pdf.text('A conclusion is valid only under stated conditions.', 20, 30);
  pdf.text('Learning cards support review and self assessment.', 20, 50);
  pdf.addPage();
  pdf.text('Review the evidence only after reading the original source.', 20, 30);
  pdf.text('LAST_PAGE_STUDY_MARKER', 20, 45);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function generatedEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">guanyi-packaged-review-fixture</dc:identifier><dc:title>EPUB 智能审阅验收</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-11-14T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章 阅读</a></li><li><a href="chapter2.xhtml">第二章 思考</a></li></ol></nav></body></html>');
  zip.file('OPS/chapter1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章 阅读</title><script>parent.__epubScriptRan=true;</script></head><body><h1>第一章 阅读</h1><p id="epub-quote-one">${chapterOneQuote}</p><p id="outside-selection">这是尚未选中的独特上下文：青石小径。</p>${'<p>把值得回味的段落留下，在书页之间记录自己的思考。</p>'.repeat(8)}</body></html>`);
  zip.file('OPS/chapter2.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章 思考</title></head><body><h1>第二章 思考</h1><p id="epub-quote-two">${chapterTwoQuote}</p></body></html>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function startModelFixture() {
  modelServer = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer packaged-fixture-only');
      assert.equal(payload.model, 'packaged-study-fixture');
      const messages = payload.messages || [];
      const requestContent = messages.at(-1)?.content;
      const images = Array.isArray(requestContent) ? requestContent.filter(part => part.type === 'image_url') : [];
      const requestText = Array.isArray(requestContent) ? requestContent.find(part => part.type === 'text' && part.text.startsWith('{'))?.text : requestContent;
      let study;
      try { study = JSON.parse(requestText); } catch (_) { /* free conversation */ }
      let kind = 'home-direct';
      let content = assistantReply;
      const system = messages[0]?.content || '';
      if (messages.length === 1 && messages[0].content === '只回复 OK。') {
        kind = 'connection-test'; content = 'OK';
      } else if (/summary/.test(system) && /risks/.test(system)) {
        kind = 'epub-summary';
        assert.ok(study?.evidence?.every(item => item.id && typeof item.text === 'string'), 'EPUB summary gets opaque evidence text');
        assert.doesNotMatch(JSON.stringify(study), /epubcfi\(|OPS\/|chapter[12]\.xhtml|sourceHash|sectionIndex|[a-f0-9]{64}/i);
        const quote = study.evidence.find(item => item.text.includes('阅读需要'))?.text;
        assert.ok(quote, 'EPUB summary reads the current chapter source');
        assert.ok(!JSON.stringify(study).includes('远山之约'), 'EPUB summary excludes the other chapter');
        content = JSON.stringify({ summary: [{ title: '证据边界', text: '结论需要受原文条件约束。' }], details: [{ title: '可核验原文', text: '保留阅读依据。', quote }], risks: [] });
      } else if (study?.evidence?.some(item => typeof item.quote === 'string')) {
        kind = 'epub-work';
        assert.ok(study.evidence.every(item => /^W\d+$/.test(item.id) && typeof item.quote === 'string'), 'EPUB work gets Wn and quote, not PDF text');
        assert.doesNotMatch(JSON.stringify(study), /epubcfi\(|OPS\/|chapter[12]\.xhtml|sourceHash|sectionIndex|[a-f0-9]{64}/i);
        content = JSON.stringify({ answer: '阅读需要核对证据与条件，并保留原文来源。', evidence: [{ id: study.evidence[0].id, explanation: '这是提供的章节原文。' }], supported: true, confidence: 'high' });
      } else if (study?.stage) {
        assert.ok(study.evidence.length > 0, 'the native PDF must provide real evidence');
        assert.ok(study.evidence.every(item => typeof item.id === 'string' && item.text));
        const text = study.evidence.map(item => item.text).join('\n');
        const textPages = [...new Set(study.evidence.map(item => item.page))];
        const imagePages = (study.visuals || []).map(item => item.page);
        assert.equal(images.length, imagePages.length);
        const evidenceIds = [study.evidence[0].id];
        if (study.stage === 'quick-abstract') {
          kind = 'study-abstract';
          assert.deepEqual(textPages, [1]);
          assert.deepEqual(imagePages, []);
          assert.match(text, /Reading uses source evidence/);
          assert.doesNotMatch(text, /Keywords|Evidence remains linked|LAST_PAGE_STUDY_MARKER/);
          assert.doesNotMatch(system, /摘要没有交代的对象、样本或指标标明缺项/);
          content = JSON.stringify({ takeaway: quickTakeaway,
            method: '摘要说明了如何依据来源阅读，受试者人数、年龄及统计方法均为缺项。',
            finding: '阅读后对照原文做一次回顾。', boundary: '摘要未说明样本数。', evidenceIds });
        } else if (study.stage === 'prepare-document') {
          kind = 'study-guide';
          assert.deepEqual(textPages, [1, 2, 3]);
          assert.deepEqual(imagePages, [1, 2, 3]);
          assert.match(text, /Evidence remains linked/);
          assert.match(text, /A conclusion is valid only/);
          assert.match(text, /LAST_PAGE_STUDY_MARKER/);
          const pageTwoImage = study.visuals.find(item => item.page === 2).id;
          content = JSON.stringify({
            reading: { title: '从原文到自己的理解', documentType: '研究资料',
              summary: { body: studySummary, evidenceIds },
              sections: [{ kind: 'method', title: '查阅第二页的条件', body: '回到第二页核对适用条件。',
                readingCue: '对照原页中的限定条件。', basis: 'source', evidenceIds: [pageTwoImage] }],
              wrapUp: { body: '阅读后回顾证据的适用条件。', basis: 'source', evidenceIds: [pageTwoImage] } },
            cards: [{ type: '方法', question: '阅读后如何形成自己的理解？', answer: '核对原文来源，并写下自己的 Markdown 笔记。', evidenceIds }]
          });
        } else {
          assert.equal(study.stage, 'answer-document');
          kind = 'study-question';
          const linked = study.question === '阅读后应该如何保留依据？';
          assert.deepEqual(textPages, linked ? [2] : [1, 2, 3]);
          assert.deepEqual(imagePages, textPages);
          if (linked) assert.doesNotMatch(text, /LAST_PAGE_STUDY_MARKER/);
          const imageIds = [study.visuals.find(item => item.page === 2).id];
          content = JSON.stringify({ answer: '依据所选原文，阅读后应保留来源并写下自己的 Markdown 笔记。',
            evidenceIds: imageIds, insufficient: false,
            ...(linked ? { card: { type: '方法', question: '为什么需要核对原文条件？', answer: '不同条件决定结论适用范围。', evidenceIds: imageIds } } : {}) });
        }
      }
      calls.push({ kind, path: request.url, stage: study?.stage, question: study?.question,
        pages: study?.evidence?.map(entry => entry.page).filter(page => Number.isInteger(page)),
        imagePages: study?.visuals?.map(entry => entry.page), imageCount: images.length });
      const body = JSON.stringify({ id: `local-fixture-${calls.length}`, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    } catch (error) {
      errors.push(`fixture: ${error.message}`);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  modelPort = modelServer.address().port;
}

function applicationEnv() {
  const env = { ...process.env, NODE_ENV: 'test', GUANYI_TEST_USER_DATA: profile, GUANYI_TEST_BACKGROUND: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GUANYI_TEST_FOREGROUND;
  return env;
}

async function startApplication() {
  run += 1;
  cdpPort = await freePort();
  const log = fs.openSync(path.join(output, `application-${run}.log`), 'w');
  application = spawn(executable, [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1'], {
    cwd: output, env: applicationEnv(), stdio: ['ignore', log, log]
  });
  fs.closeSync(log);
  application.on('error', error => errors.push(`application: ${error.message}`));
  await until(async () => {
    assert.equal(application.exitCode, null, 'packaged application must remain running');
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    return response.ok;
  }, 'packaged CDP endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  await until(() => browser.contexts().some(context => context.pages().some(candidate => candidate.url().includes('index.html'))), 'packaged app renderer');
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html'));
  page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(`renderer: ${error.message}`));
  await page.waitForFunction(() => Boolean(window.__MD_EDITOR_TEST__));
  assert.match(page.url(), /\.app\/Contents\/Resources\/app\.asar\/index\.html/);
  assert.equal(await page.evaluate(() => window.guanyiDesktop.app.getVersion()), expectedVersion);
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().workspaceView), 'home');
  assert.equal((await page.locator('.app-topbar__tagline').textContent()).trim(), '俯仰观物，译述我心');
  assert.equal((await page.locator('#about-modal .app-modal__header p').textContent()).trim(), '俯仰观物，译述我心');
  await page.locator('.app-home-view[data-home-view="home"]').waitFor({ state: 'visible' });
}

async function stopApplication() {
  if (!application) return;
  const processToStop = application;
  if (page && !page.isClosed()) {
    await page.evaluate(async () => {
      await window.GuanyiReaderHost?.flush?.();
    });
    // Closing the actual BrowserWindow exercises its native persistence guard.
    const closed = page.waitForEvent('close', { timeout: 15000 });
    await page.evaluate(() => { setTimeout(() => window.close(), 0); });
    await closed;
  }
  if (browser?.isConnected()) await browser.close().catch(() => {});
  if (processToStop.exitCode === null) {
    processToStop.kill('SIGTERM');
    await until(() => processToStop.exitCode !== null || processToStop.signalCode !== null, 'test application exit', 10000);
  }
  application = null;
  browser = null;
  page = null;
}

async function openNativeFile(file) {
  // macOS file-open and second-instance paths use the shipping import handler.
  const opener = spawn(executable, [file], { cwd: output, env: applicationEnv(), stdio: 'ignore' });
  await until(() => opener.exitCode !== null || opener.signalCode !== null, 'native second-instance opener', 15000);
  assert.equal(opener.exitCode, 0);
  await page.waitForFunction(filePath => {
    const state = window.__MD_EDITOR_TEST__.getState();
    return state.workspaceView === 'document' && state.docs.some(doc => doc.desktopPath === filePath && doc.id === state.currentDocId);
  }, file);
}

async function assertEditingToolbar(plainText = false) {
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().documentMode), 'editing');
  assert.equal(await page.locator('#fmtbar').isVisible(), true);
  assert.equal(await page.locator('#document-reading-toolbar').isVisible(), false);
  assert.equal(await page.locator('#source-editor').evaluate(element => element.readOnly), false);
  for (const selector of ['#btn-heading', '[data-fmt="bold"]', '#btn-find-replace', '#btn-comments', '#view-seg', '#btn-save', '#btn-save-more', '#btn-export', '#btn-theme']) {
    assert.equal(await page.locator(`#fmtbar ${selector}`).isVisible(), true, `old toolbar control remains visible: ${selector}`);
  }
  assert.equal(await page.locator('#fmtbar [data-fmt="bold"]').isDisabled(), plainText);
  assert.equal(await page.locator('#doc-list').isVisible(), false, 'document view keeps the Home folder list hidden');
}

async function assertHitTarget(locator, label) {
  await locator.waitFor({ state: 'visible' });
  const hit = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { hit: target === element || element.contains(target), target: target?.className || target?.tagName };
  });
  assert.equal(hit.hit, true, `${label} is covered by ${hit.target}`);
}

async function openGlobalModelSettings(label) {
  assert.equal(await page.locator('#app-menu [data-app-command="model-settings"]').count(), 1, `${label}: one model entry`);
  assert.equal(await page.locator('#btn-model-settings,#btn-model-config,[data-home-action="configure-model"]').count(), 0, `${label}: old model buttons removed`);
  assert.equal(await page.locator('.guanyi-study-notice button').count(), 0);
  await assertHitTarget(page.locator('#btn-app-menu'), `${label}: menu trigger`);
  await page.locator('#btn-app-menu').click();
  const menu = page.locator('#app-menu');
  await menu.waitFor({ state: 'visible' });
  for (const command of ['settings', 'model-settings', 'update', 'help', 'about']) {
    await assertHitTarget(menu.locator(`[data-app-command="${command}"]`), `${label}: ${command}`);
  }
  await menu.locator('[data-app-command="about"]').click();
  await page.locator('#about-modal').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#about-version').textContent()).trim(), expectedVersion);
  assert.equal((await page.locator('#about-modal .app-modal__header p').textContent()).trim(), '俯仰观物，译述我心');
  await page.locator('#btn-about-close').click();
  await page.locator('#btn-app-menu').click();
  await menu.locator('[data-app-command="model-settings"]').click();
  await page.locator('#model-modal').waitFor({ state: 'visible' });
  assert.equal(await menu.isVisible(), false);
}

async function verifyStudyComposer(panel,label) {
  const wrapper=panel.locator('.guanyi-study-composer-input');
  const send=wrapper.getByRole('button',{name:'发送',exact:true});
  assert.equal(await wrapper.getByRole('textbox',{name:'研读问题',exact:true}).count(),1,`${label}: question belongs to input wrapper`);
  assert.equal(await send.innerText(),'',`${label}: send uses only an icon`);
  assert.equal(await send.locator('svg[aria-hidden="true"]').count(),1,`${label}: decorative SVG and accessible send name`);
  const geometry=await wrapper.evaluate(el=>{
    const box=el.getBoundingClientRect(),input=el.querySelector('textarea').getBoundingClientRect(),button=el.querySelector('.guanyi-study-send').getBoundingClientRect();
    const r=rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height});
    return {box:r(box),input:r(input),button:r(button)};
  });
  assert.ok(geometry.button.width>=28&&geometry.button.height>=28,`${label}: usable send target`);
  assert.ok(geometry.button.left>=geometry.input.left&&geometry.button.right<=geometry.input.right+1,`${label}: send remains inside textarea width`);
  assert.ok(geometry.button.top>=geometry.input.top+geometry.input.height/2&&geometry.button.bottom<=geometry.input.bottom+1,`${label}: send remains inside lower textarea half`);
  assert.ok(geometry.input.right-geometry.button.right<=16&&geometry.input.bottom-geometry.button.bottom<=16,`${label}: send is at input bottom-right`);
  assert.ok(geometry.box.height<=geometry.input.height+2,`${label}: send does not occupy a separate row`);
  await assertHitTarget(send,`${label}: send`);
  return {iconOnly:true,bottomRight:true,noSeparateRow:true};
}

async function verifyStudyNoteCard(panel,text,label,expectedPage) {
  assert.equal(await panel.getByRole('textbox',{name:'研读笔记',exact:true}).count(),0,`${label}: notes defaults to cards`);
  assert.equal(await panel.getByRole('button',{name:'新建笔记',exact:true}).isVisible(),true,`${label}: new note remains available`);
  const card=panel.locator('.guanyi-study-note-card[data-note-kind="study"]').filter({has:page.getByText(text,{exact:true})});
  await card.waitFor({state:'visible'});
  assert.equal(await card.count(),1,`${label}: note appears once`);
  assert.equal(await card.locator('button.app-comment-card__quote').count(),1,`${label}: source is clickable`);
  assert.match(await card.locator('button.app-comment-card__quote').textContent(), new RegExp(`第\\s*${expectedPage}\\s*页`),`${label}: page-only source matches the active PDF page`);
  assert.equal(await card.getByRole('button',{name:'编辑笔记',exact:true}).count(),1,`${label}: edit action`);
  assert.equal(await card.getByRole('button',{name:'删除笔记',exact:true}).count(),1,`${label}: remove action`);
  assert.ok((await card.locator('small').textContent()).trim(),`${label}: metadata present`);
  const geometry=await card.evaluate(el=>{const box=el.getBoundingClientRect(),panel=el.closest('.guanyi-study-panel').getBoundingClientRect();return{left:box.left,right:box.right,height:box.height,panelLeft:panel.left,panelRight:panel.right};});
  assert.ok(geometry.height>40&&geometry.left>=geometry.panelLeft-1&&geometry.right<=geometry.panelRight+1,`${label}: card geometry stays inside panel`);
  return {defaultList:true,savedCard:true,localSource:true,metadata:true,editAndDelete:true};
}

async function verifySidebarChrome(kind) {
  const pdf = kind === 'pdf';
  const epub = kind === 'epub';
  const panel = page.locator(pdf ? '.app-reader-container:not([hidden]) .guanyi-study-panel' : '#collab-drawer');
  const heading = panel.locator(pdf ? '.guanyi-study-heading' : '.app-drawer__header');
  const toggle = page.locator(pdf ? '.app-reader-toolbar:not([hidden]) .guanyi-study-toggle' : (epub ? '[data-epub-action="review"]' : '#btn-comments'));
  const close = panel.locator(pdf ? '.guanyi-study-close' : '#btn-close-drawer');
  const mask = page.locator(pdf ? '.app-reader-container:not([hidden]) .guanyi-study-mask' : '#drawer-mask');
  const draft = panel.locator(pdf ? '[aria-label="研读问题"]' : '#reading-question');
  const draftValue = `${kind} draft stays through menu and close`;
  const selectQuestion = async () => {
    await panel.locator(pdf ? '[data-study-tab="ask"]' : '[data-collab-panel="works"]').click();
  };
  const assertOpen = async () => assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const assertClosed = async () => {
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await mask.isVisible(), false);
    assert.equal(await toggle.evaluate(element => document.activeElement === element), true, `${kind}: close returns focus`);
  };
  await selectQuestion();
  await draft.fill(draftValue);
  if(pdf) await verifyStudyComposer(panel,`${kind} wide composer`);
  assert.equal(await heading.evaluate(element => Math.round(element.getBoundingClientRect().height)), 54);
  assert.equal(await close.locator('svg').count(), 1);
  assert.equal((await close.textContent()).trim(), '');
  if (pdf || epub) {
    assert.equal(await toggle.locator('svg[viewBox="0 0 16 16"]').count(), 1);
    assert.equal((await toggle.textContent()).trim(), '');
    assert.equal(await toggle.getAttribute('aria-label'), pdf ? '智能研读' : '智能审阅');
    assert.equal(await toggle.getAttribute('title'), pdf ? '智能研读' : '智能审阅');
  }
  await openGlobalModelSettings(`${kind} open sidebar`);
  await page.locator('#btn-model-close').click();
  await assertOpen();
  assert.equal(await draft.inputValue(), draftValue);
  await close.click(); await assertClosed();
  await toggle.click(); await selectQuestion();
  assert.equal(await draft.inputValue(), draftValue);
  await draft.focus(); await page.keyboard.press('Escape'); await assertClosed();
  await toggle.click(); await selectQuestion();
  await page.setViewportSize({ width: 1024, height: 920 });
  if(pdf) await verifyStudyComposer(panel,`${kind} narrow composer`);
  await mask.waitFor({ state: 'visible' });
  assert.equal(await mask.isVisible(), true);
  await assertHitTarget(page.locator('#btn-app-menu'), `${kind}: menu above narrow overlay`);
  await page.locator('#btn-app-menu').click();
  await assertHitTarget(page.locator('#app-menu [data-app-command="model-settings"]'), `${kind}: model entry above narrow overlay`);
  await page.keyboard.press('Escape'); await assertOpen();
  await mask.click({ position: { x: 4, y: 8 } }); await assertClosed();
  await toggle.click(); await selectQuestion();
  assert.equal(await draft.inputValue(), draftValue);
  await close.click(); await assertClosed();
  await page.setViewportSize({ width: 1440, height: 920 });
  await toggle.click(); await selectQuestion();
  await draft.fill('');
  return { headerHeight: 54, sharedCloseIcon: true, escape: true, mask: true, focusReturn: true, draftRetained: true, globalModelMenu: true, pureSvgToggle: pdf || epub };
}

async function verifyPdfNativeToolbarAndScroll() {
  await page.waitForFunction(() => !!document.querySelector('.guanyi-pdf-frame')?.contentWindow?.PDFViewerApplication?.pdfDocument);
  const nativeChrome = await page.locator('.guanyi-pdf-frame').evaluate(frame => {
    const doc = frame.contentDocument;
    const toolbar = doc.getElementById('toolbarContainer'), style = frame.contentWindow.getComputedStyle(toolbar);
    const scroll = frame.contentWindow.getComputedStyle(doc.getElementById('viewerContainer'));
    return { height: toolbar.getBoundingClientRect().height, padding: style.padding, border: style.borderWidth, shadow: style.boxShadow,
      viewerOverflowX: scroll.overflowX, viewerOverflowY: scroll.overflowY, viewerTop: doc.getElementById('viewerContainer').getBoundingClientRect().top };
  });
  assert.deepEqual(nativeChrome, { height: 0, padding: '0px', border: '0px', shadow: 'none', viewerOverflowX: 'auto', viewerOverflowY: 'auto', viewerTop: 0 }, 'hidden PDF.js toolbar leaves no padding, border or second shadow; document scrolling remains enabled');
  await page.locator('.guanyi-pdf-frame').evaluate(frame => { frame.contentWindow.PDFViewerApplication.pdfViewer.currentScaleValue = '3'; });
  await page.waitForFunction(() => {
    const frame = document.querySelector('.guanyi-pdf-frame');
    const viewer = frame.contentWindow.PDFViewerApplication.pdfViewer;
    const scroll = frame.contentDocument.getElementById('viewerContainer');
    return Math.abs(viewer.currentScale - 3) < 0.001 && scroll.scrollWidth > scroll.clientWidth + 100;
  });
  assert.equal(await page.locator('.guanyi-pdf-frame').evaluate(frame => {
    const scroll = frame.contentDocument.getElementById('viewerContainer');
    scroll.scrollLeft = 160;
    return scroll.scrollLeft >= 100;
  }), true, '300% PDF can actually scroll horizontally instead of clipping the page');
  await page.screenshot({ path: path.join(output, '14-pdf-300-percent-scroll.png') });
  await page.locator('.guanyi-pdf-zoom-select').selectOption('page-width');
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-frame').contentWindow.PDFViewerApplication.pdfViewer.currentScaleValue === 'page-width');
  return { nativeChrome, zoom300: true, realHorizontalScroll: true };
}

async function epubReady(target = 'epub-quote-one') {
  await page.waitForFunction(target => !!document.querySelector('.epub-reader iframe')?.contentDocument?.getElementById(target), target);
}

async function selectEpubQuote() {
  await page.evaluate(() => {
    const doc = document.querySelector('.epub-reader iframe').contentDocument;
    const text = doc.getElementById('epub-quote-one').firstChild, range = doc.createRange();
    range.selectNodeContents(text);
    const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => !document.querySelector('[data-epub-action="highlight"]')?.disabled);
}

async function openEpubReview() {
  if (await page.locator('#collab-drawer').getAttribute('aria-hidden') === 'true') await page.locator('[data-epub-action="review"]').click();
  await page.waitForFunction(() => document.querySelector('#collab-drawer').getAttribute('aria-hidden') === 'false');
}

async function verifyEpubReview(originalHash) {
  await openNativeFile(epubPath); await epubReady();
  const id = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().currentDocId);
  const beforeCalls = calls.length;
  const toggle = page.locator('[data-epub-action="review"]');
  assert.equal(await toggle.getAttribute('aria-controls'), 'collab-drawer');
  assert.equal(await page.locator('#fmtbar').isVisible(), false);
  assert.equal(await page.locator('#doc-list').isVisible(), false);
  assert.equal(await page.locator('.epub-reader iframe').evaluate(frame => frame.sandbox.contains('allow-scripts')), false);
  assert.equal(await page.evaluate(() => !!window.__epubScriptRan), false);
  await openEpubReview();
  assert.deepEqual(await page.locator('[data-collab-panel]').evaluateAll(nodes => nodes.map(node => node.dataset.collabPanel).sort()), ['comments', 'reading', 'works']);
  assert.equal(calls.length, beforeCalls, 'opening EPUB review does not automatically send a model request');
  for (const tab of ['comments', 'reading', 'works']) {
    await page.locator(`[data-collab-panel="${tab}"]`).click();
    assert.equal(await page.locator(`[data-collab-content="${tab}"]`).isVisible(), true);
  }
  const sidebar = await verifySidebarChrome('epub');
  await page.locator('[data-collab-panel="comments"]').click();
  await selectEpubQuote();
  await page.locator('[data-epub-action="note"]').click();
  const note = '实包 EPUB 独立批注 <img src=x onerror=alert(1)>';
  await page.locator('#epub-review-comments .epub-reader__note textarea').fill(note);
  await page.locator('#epub-review-comments select[aria-label="高亮颜色"]').selectOption('green');
  await page.waitForFunction(({ id, note }) => JSON.parse(window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id).content).annotations?.[0]?.note === note, { id, note });
  const annotation = await page.evaluate(id => JSON.parse(window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id).content).annotations[0], id);
  assert.equal(annotation.quote, chapterOneQuote); assert.equal(annotation.color, 'green'); assert.match(annotation.cfi, /^epubcfi\(/);
  assert.equal(await page.locator('#epub-review-comments img').count(), 0);
  assert.equal(await page.evaluate(id => window.__MD_EDITOR_TEST__.getReviewState().documents[id]?.comments?.length || 0, id), 0, 'EPUB annotations retain native data instead of Markdown line comments');
  await page.screenshot({ path: path.join(output, '15-epub-native-annotations.png') });
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter2.xhtml'); await epubReady('epub-quote-two');
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter1.xhtml'); await epubReady();
  await page.locator('[data-collab-panel="reading"]').click();
  const summaryStart = calls.length;
  await page.locator('#btn-generate-summary').click();
  await page.waitForFunction(id => !!window.__MD_EDITOR_TEST__.getReviewState().documents[id]?.ai?.result?.details?.length, id);
  assert.ok(calls.slice(summaryStart).some(call => call.kind === 'epub-summary'));
  const ai = await page.evaluate(id => window.__MD_EDITOR_TEST__.getReviewState().documents[id].ai, id);
  assert.match(ai.scopeLabel, /当前章节/);
  assert.equal(ai.result.details[0].quote.normalize('NFKC'), chapterOneQuote.normalize('NFKC'));
  assert.equal(ai.result.details[0].evidence.sourceHash, originalHash);
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter2.xhtml'); await epubReady('epub-quote-two');
  await page.locator('#summary-results button').filter({ hasText: '定位原文' }).first().click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="EPUB 章节目录"]').value === 'chapter1.xhtml'); await epubReady();
  await page.screenshot({ path: path.join(output, '16-epub-ai-source-location.png') });
  await page.locator('[data-collab-panel="works"]').click();
  await page.locator('#reading-scope').selectOption('current');
  const historyCount = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().workHistory.length);
  const workStart = calls.length;
  await page.locator('#reading-question').fill('证据与条件为什么需要核对？'); await page.locator('#btn-ask-work').click();
  await page.waitForFunction(count => window.__MD_EDITOR_TEST__.getState().workHistory.length > count && window.__MD_EDITOR_TEST__.getState().workHistory.at(-1)?.status === 'complete', historyCount);
  const work = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().workHistory.at(-1));
  assert.ok(calls.slice(workStart).some(call => call.kind === 'epub-work'));
  assert.equal(work.generatedByModel, true, 'packaged EPUB work uses the real configured model transport');
  assert.ok(work.evidence.length > 0);
  assert.ok(work.evidence.every(item => item.docId === id && item.readerFormat === 'epub' && item.sourceHash === originalHash));
  assert.ok(work.evidence.some(item => item.quote.normalize('NFKC').includes(chapterOneQuote.normalize('NFKC'))));
  await page.locator('select[aria-label="EPUB 章节目录"]').selectOption('chapter2.xhtml'); await epubReady('epub-quote-two');
  await page.locator('.app-reading-evidence-card__actions button').filter({ hasText: '定位原文' }).first().click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="EPUB 章节目录"]').value === 'chapter1.xhtml'); await epubReady();
  await page.screenshot({ path: path.join(output, '17-epub-sourced-work.png') });
  const draft = '实包重启后保留的 EPUB 未发送问题。';
  await page.locator('#reading-question').fill(draft);
  await page.locator('#btn-close-drawer').click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.evaluate(element => document.activeElement === element), true);
  assert.equal(hashFile(epubPath), originalHash);
  return { id, sourceHash: originalHash, note, draft, annotationCfi: annotation.cfi, workId: work.id,
    nativeImport: true, originalArchiveUnchanged: true, sharedTabs: ['comments', 'reading', 'works'], sidebar,
    currentChapterAi: true, chapterQuoteLocated: true, sourcedWork: true, workQuoteLocated: true, modelPrivacy: true };
}

async function verifyPersistedEpubReview(contract) {
  await page.evaluate(id => window.__MD_EDITOR_TEST__.switchDoc(id), contract.id); await epubReady(); await openEpubReview();
  await page.locator('[data-collab-panel="comments"]').click();
  assert.equal(await page.locator('#epub-review-comments .epub-reader__note textarea').inputValue(), contract.note);
  assert.equal(await page.locator('#epub-review-comments select[aria-label="高亮颜色"]').inputValue(), 'green');
  const persisted = await page.evaluate(id => ({ doc: window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id), review: window.__MD_EDITOR_TEST__.getReviewState().documents[id], work: window.__MD_EDITOR_TEST__.getState().workHistory }), contract.id);
  assert.equal(persisted.doc.readerSourceHash, contract.sourceHash);
  assert.equal(JSON.parse(persisted.doc.content).annotations[0].cfi, contract.annotationCfi);
  assert.ok(persisted.review.ai.result.details[0].evidence.sourceHash === contract.sourceHash);
  assert.ok(persisted.work.some(turn => turn.id === contract.workId && turn.status === 'complete' && turn.generatedByModel));
  await page.locator('[data-collab-panel="works"]').click();
  assert.equal(await page.locator('#reading-question').inputValue(), contract.draft);
  assert.equal(hashFile(epubPath), contract.sourceHash);
  await page.screenshot({ path: path.join(output, '18-restarted-epub-review.png') });
  await page.locator('#btn-close-drawer').click();
  return { ...contract, nativeNotesPersisted: true, aiAndWorkPersisted: true, draftPersisted: true, restartPersistence: true };
}

async function verifyPreviewOutline() {
  const before = await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown());
  const toggle = page.locator('#btn-toggle-outline');
  const outline = page.locator('.app-document-outline');
  assert.equal(await outline.isVisible(), false, 'outline starts collapsed');
  for (const view of ['preview', 'split']) {
    await page.locator(`#view-seg [data-view="${view}"] button`).click();
    assert.equal(await toggle.isVisible(), true);
    await toggle.click();
    assert.equal(await outline.isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.app-preview-pane > .app-document-outline').count(), 1);
    assert.equal(await page.locator('.app-preview-pane > #preview-wrap').count(), 1);
    const bounds = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; };
      return { source: rect('#source-editor'), pane: rect('.app-preview-pane'), outline: rect('.app-document-outline'), preview: rect('#preview-wrap') };
    });
    if (bounds.pane.width > 560) assert.ok(bounds.outline.right <= bounds.preview.x + 1, `${view}: outline is at the left of the preview`);
    else assert.ok(Math.abs(bounds.outline.x - bounds.preview.x) < 2, `${view}: outline overlays only its narrow preview pane`);
    if (view === 'split') assert.ok(bounds.source.right <= bounds.outline.x + 1, 'source remains left of outline and preview');
    await page.screenshot({ path: path.join(output, `12-outline-${view}.png`) });
    await outline.locator('.app-outline__item').last().click();
    assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), before);
    await toggle.click();
    assert.equal(await outline.isVisible(), false);
  }
  await page.setViewportSize({ width: 1024, height: 920 });
  await toggle.click();
  assert.equal(await outline.isVisible(), true);
  await page.screenshot({ path: path.join(output, '13-outline-split-narrow-overlay.png') });
  const outlineMask = page.locator('.app-document-outline-mask');
  const maskWidth = await outlineMask.evaluate(element => element.getBoundingClientRect().width);
  await outlineMask.click({ position: { x: maskWidth - 8, y: 8 } });
  assert.equal(await outline.isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.locator('#view-seg [data-view="source"] button').click();
  assert.equal(await toggle.isVisible(), false);
  assert.equal(await outline.isVisible(), false);
  return { defaultCollapsed: true, preview: true, splitOrder: 'source | divider | outline + preview', headingNavigation: true, sourceHidden: true };
}

async function verifyRestoredToolbar() {
  const initial = '# Toolbar regression\n\nKeep the original editor and review functions.\n\n## Reading outline\n\nHeadings stay next to the preview.\n';
  const expected = initial.replace('Keep the original', '**Keep** the original');
  fs.writeFileSync(markdownPath, initial);
  fs.writeFileSync(textPath, '纯文本保留真实文本内容，不插入 Markdown 格式。\n');
  await openNativeFile(markdownPath);
  const markdownId = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().currentDocId);
  await assertEditingToolbar();
  for (const view of ['source', 'preview', 'split']) {
    await page.locator(`#view-seg [data-view="${view}"] button`).click();
    assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().viewMode), view);
    assert.equal(await page.locator('#source-editor').isVisible(), view !== 'preview');
    assert.equal(await page.locator('#preview-wrap').isVisible(), view !== 'source');
  }
  await page.locator('#view-seg [data-view="source"] button').click();
  await page.locator('#source-editor').evaluate(element => {
    element.focus();
    const start = element.value.indexOf('Keep');
    element.setSelectionRange(start, start + 4);
  });
  await page.locator('#fmtbar [data-fmt="bold"]').click();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), expected);
  await page.locator('#btn-undo').click();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), initial);
  await page.locator('#btn-redo').click();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), expected);
  await page.locator('#btn-save').click();
  await until(() => fs.readFileSync(markdownPath, 'utf8') === expected, 'native Markdown save from restored toolbar');
  await page.locator('#btn-save-more').click();
  assert.equal(await page.locator('#save-menu').isVisible(), true);
  for (const command of ['save', 'save-as', 'move', 'open-location']) assert.equal(await page.locator(`#save-menu [data-file-command="${command}"]`).isVisible(), true);
  await page.locator('#btn-save-more').click();
  await page.locator('#btn-export').click();
  for (const selector of ['#btn-md', '#btn-pdf', '#btn-img']) assert.equal(await page.locator(selector).isVisible(), true);
  await page.locator('#btn-export').click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.locator('#btn-theme').click();
  assert.notEqual(await page.locator('html').getAttribute('data-theme'), theme);
  await page.locator('#btn-theme').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  await page.locator('#btn-find-replace').click();
  await page.locator('#content-find-input').fill('original');
  await page.waitForFunction(() => document.querySelector('#content-find-count').textContent !== '0/0');
  await page.locator('#btn-content-find-close').click();
  const outline = await verifyPreviewOutline();
  await page.locator('#source-editor').evaluate(element => { element.focus(); element.setSelectionRange(0, 0); });
  await page.locator('#btn-comments').click();
  assert.equal(await page.locator('#collab-drawer').getAttribute('aria-hidden'), 'false');
  for (const panel of ['comments', 'reading', 'works']) {
    await page.locator(`[data-collab-panel="${panel}"]`).click();
    assert.equal(await page.locator(`[data-collab-panel="${panel}"]`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`[data-collab-content="${panel}"]`).isVisible(), true);
    assert.equal(await page.locator('#fmtbar').isVisible(), true, 'the old review drawer does not hide the toolbar');
  }
  await page.locator('[data-collab-panel="reading"]').click();
  const sidebar = await verifySidebarChrome('markdown');
  await page.locator('[data-collab-panel="reading"]').click();
  await page.screenshot({ path: path.join(output, '09-restored-markdown-toolbar-and-review.png') });
  await page.locator('#btn-close-drawer').click();
  assert.equal(await page.locator('#collab-drawer').getAttribute('aria-hidden'), 'true');
  await page.locator('#document-return-reading').click();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().documentMode), 'reading');
  assert.equal(await page.locator('#document-reading-toolbar').isVisible(), true);
  assert.equal(await page.locator('#source-editor').evaluate(element => element.readOnly), true);
  assert.equal(await page.locator('#preview-editor').evaluate(element => element.isContentEditable), false);
  await page.locator('#source-editor').evaluate(element => { element.value = 'readonly attempted overwrite'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), expected);
  await page.locator('#document-edit-toggle').click();
  await assertEditingToolbar();
  await openNativeFile(textPath);
  const textId = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().currentDocId);
  await assertEditingToolbar(true);
  assert.equal(await page.locator('#btn-comments').isEnabled(), true);
  assert.equal(await page.locator('#btn-export').isEnabled(), true);
  await page.screenshot({ path: path.join(output, '10-restored-text-toolbar.png') });
  await page.evaluate(id => window.__MD_EDITOR_TEST__.switchDoc(id), markdownId);
  await assertEditingToolbar();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().viewMode), 'source');
  return { markdownId, textId, markdownPath, textPath, expected, defaultEditing: true, fullToolbar: true, formatUndoRedo: true,
    views: ['source', 'preview', 'split'], save: true, exportMenu: true, theme: true, find: true,
    reviewPanels: ['comments', 'reading', 'works'], explicitReadonly: true, outline, sidebar };
}

async function getStudy(id) {
  return page.evaluate(docId => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === docId)?.readerStudy, id);
}

async function verifyConversationLifecycle(documentId) {
  const draftText = '档案里应保留尚未发送的草稿';
  const tabs = page.locator('.app-workspace-chat-tab');
  await tabs.click();
  const originalId = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().homeWorkspace.activeConversationId);
  const input = page.locator('[data-chat-input]');
  const original = page.locator(`button.app-conversation-item[data-conversation-id="${originalId}"]`);
  const actionMenu = page.locator('#conversation-action-menu');
  const newChat = page.locator('.app-conversation-new');
  await input.fill(draftText);
  assert.equal(await original.locator('[data-conversation-action]').count(), 0, 'no end-of-row menu button');
  for (const edge of ['x', 'width']) {
    assert.ok(Math.abs((await original.boundingBox())[edge] - (await newChat.boundingBox())[edge]) < 1, 'conversation row aligns with new conversation');
  }
  await original.press('Shift+F10');
  await actionMenu.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await actionMenu.waitFor({ state: 'hidden' });
  assert.equal(await original.evaluate(row => row === document.activeElement), true);
  await newChat.click();
  const otherId = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().homeWorkspace.activeConversationId);
  assert.notEqual(otherId, originalId);
  const other = page.locator(`button.app-conversation-item[data-conversation-id="${otherId}"]`);
  await other.click({ button: 'right' });
  await actionMenu.locator('[data-conversation-action="delete"]').click();
  await other.waitFor({ state: 'detached' });
  assert.equal(await input.inputValue(), draftText, 'when active chat is deleted, fallback restores the previous draft');
  await original.click({ button: 'right' });
  await actionMenu.locator('[data-conversation-action="delete"]').click();
  await original.waitFor({ state: 'detached' });
  await page.locator(`.app-document-tab[data-doc-id="${documentId}"]`).click();
  const originalMarkdown = await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown());
  await page.locator('#btn-app-menu').click();
  await page.locator('[data-app-command="conversation-history"]').click();
  const history = page.locator('[data-home-history-dialog]');
  await history.locator('[data-history-filter="deleted"]').click();
  await history.locator(`[data-history-open="${originalId}"]`).click();
  assert.match(await history.innerText(), new RegExp(draftText));
  await history.getByText(assistantReply, { exact: true }).waitFor();
  assert.equal(await history.locator('textarea').count(), 0);
  await history.locator(`[data-history-restore="${originalId}"]`).click();
  await page.waitForFunction(id => !window.__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.find(chat => chat.id === id)?.deletedAt, originalId);
  await page.keyboard.press('Escape');
  await history.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.id === 'btn-app-menu');
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), originalMarkdown);
  await tabs.click();
  await original.click();
  assert.equal(await input.inputValue(), draftText);
  await page.locator('[data-chat-messages]').getByText(assistantReply, { exact: true }).waitFor();
  return { originalId, otherId, draftText, alignedRows: true, keyboardMenu: true, rightClick: true, softDelete: true, restore: true, documentStayedOpen: true };
}

async function verifyRecentSearch(documentId) {
  await page.locator('.app-workspace-home-tab').click();
  const recent = page.locator('.app-home-recent');
  const search = recent.getByRole('searchbox', { name: '搜索最近打开的文档' });
  await search.waitFor();
  assert.equal(await search.evaluate(input => Boolean(input.closest('.app-home-section-heading'))), true);
  const results = recent.locator('.app-home-document-open');
  const originalCount = await results.count();
  assert.ok(originalCount > 1);
  await page.keyboard.press('Meta+k');
  assert.equal(await search.evaluate(input => input === document.activeElement), true);
  await search.fill('不存在的验收文档-492');
  assert.equal(await results.count(), 0);
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
  assert.equal(await results.count(), originalCount);
  await search.fill('旧版工具栏验收');
  assert.equal(await results.count(), 1);
  assert.equal(await results.first().getAttribute('data-home-open'), documentId);
  await search.press('Enter');
  await page.waitForFunction(id => window.__MD_EDITOR_TEST__.getState().currentDocId === id && window.__MD_EDITOR_TEST__.getState().workspaceView === 'document', documentId);
  return { adjacentToRecents: true, shortcutFocus: true, emptyAndEscape: true, enterOpen: true };
}

async function verifyStudyResize(panel) {
  const resizer = panel.getByRole('separator', { name: '调整智能研读面板宽度' });
  const width = () => panel.evaluate(element => Math.round(element.getBoundingClientRect().width));
  const minimum = Number(await resizer.getAttribute('aria-valuemin'));
  const maximum = Number(await resizer.getAttribute('aria-valuemax'));
  const halfWidth = await page.evaluate(() => Math.floor(innerWidth / 2));
  assert.equal(minimum, 360);
  assert.equal(maximum, halfWidth);
  await resizer.press('End');
  assert.equal(await width(), maximum);
  assert.equal(await panel.getByRole('tab').count(), 4);
  await resizer.press('Home');
  assert.equal(await width(), minimum);
  const handle = await resizer.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 60);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 165, handle.y + 60, { steps: 5 });
  await page.mouse.up();
  assert.equal(await width(), minimum + 165);
  await resizer.dblclick();
  assert.equal(await width(), minimum);
  return { drag: true, keyboardBounds: true, halfWidth, reset: true };
}

async function main() {
  assert.equal(process.platform, 'darwin', 'this test targets the macOS application');
  assert.ok(fs.existsSync(executable), `missing packaged application: ${executable}`);
  assert.ok(fs.existsSync(asarPath), 'run a packaged .app, not a development Electron checkout');
  const packageHash = hashFile(asarPath);
  fs.writeFileSync(sourcePath, generatedPdf());
  const noAbstract = new jsPDF();
  noAbstract.text('An ordinary chapter without a recognized abstract.', 20, 30);
  fs.writeFileSync(noAbstractPath, Buffer.from(noAbstract.output('arraybuffer')));
  fs.writeFileSync(epubPath, await generatedEpub());
  const originalHash = hashFile(sourcePath);
  const originalEpubHash = hashFile(epubPath);
  await startModelFixture();
  await startApplication();
  assert.equal(await page.locator('[data-home-search]').getAttribute('type'), 'search');
  assert.equal(await page.locator('.app-home-ai').isVisible(), true);
  assert.equal(await page.locator('#doc-list').count(), 1);
  await page.screenshot({ path: path.join(output, '01-cold-home.png') });

  // Configure an ordinary custom provider through the product UI, in this profile only.
  await page.locator('[data-home-prompt]').fill('开始本地验收对话');
  await page.locator('[data-home-view="home"] [data-home-action="send"]').click();
  await openGlobalModelSettings('home direct conversation');
  await page.locator('#model-provider').selectOption('custom');
  await page.locator('#model-base-url').fill(`http://127.0.0.1:${modelPort}`);
  await page.locator('#model-api-key').fill('packaged-fixture-only');
  await page.locator('#model-name-custom').fill('packaged-study-fixture');
  await page.locator('#btn-model-add').click();
  await page.locator('#remember-api-key').check();
  await page.locator('#btn-model-test').click();
  await page.locator('#model-connection-status').filter({ hasText: '模型连接成功' }).waitFor({ state: 'visible' });
  assert.ok(calls.some(call => call.kind === 'connection-test' && call.path === '/v1/chat/completions'), 'UI connection test normalizes a bare provider origin to the compatible chat endpoint');
  await page.locator('#model-form button[type="submit"]').click();
  await page.locator('[data-chat-messages]').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => window.__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.some(chat => chat.turns.some(turn => turn.status === 'complete')));
  assert.ok(calls.some(call => call.kind === 'home-direct'));
  await page.screenshot({ path: path.join(output, '02-home-direct-chat.png') });

  const restoredToolbar = await verifyRestoredToolbar();
  const conversations = await verifyConversationLifecycle(restoredToolbar.markdownId);
  const recentSearch = await verifyRecentSearch(restoredToolbar.markdownId);
  console.log('PASS packaged Home conversation, model connection and restored Markdown/TXT toolbar');
  const epubReview = await verifyEpubReview(originalEpubHash);
  console.log('PASS packaged EPUB native annotations, shared review and sourced AI/work transport');
  await openNativeFile(sourcePath);
  const pdfId = await page.evaluate(filePath => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.desktopPath === filePath).id, sourcePath);
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().workspaceView), 'document');
  assert.equal(await page.locator('#fmtbar').isVisible(), false, 'PDF keeps its format-specific toolbar');
  const pdfLayout = await verifyPdfNativeToolbarAndScroll();
  await page.evaluate(id => window.__MD_EDITOR_TEST__.switchDoc(id), restoredToolbar.markdownId);
  await assertEditingToolbar();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().viewMode), 'source', 'returning from PDF restores the Markdown view');
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), restoredToolbar.expected);
  await page.evaluate(id => window.__MD_EDITOR_TEST__.switchDoc(id), pdfId);
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#doc-list').isVisible(), false, 'reading view must hide the folder list');
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').click();
  const panel = page.locator('.app-reader-container:not([hidden]) .guanyi-study-panel');
  await panel.waitFor({ state: 'visible' });
  const studySidebar = await verifySidebarChrome('pdf');
  const studyResize = await verifyStudyResize(panel);
  await panel.locator('[data-study-tab="guide"]').click();
  const modelCallsBeforeQuick = calls.length;
  await panel.getByRole('button', { name: '摘要快读', exact: true }).click();
  await panel.getByText(quickTakeaway, { exact: true }).waitFor();
  const quick = panel.locator('.guanyi-study-quick');
  assert.deepEqual(await quick.locator('dt').allTextContents(), ['对象与方法', '主要发现']);
  assert.doesNotMatch(await quick.innerText(), /缺项|样本数/);
  assert.equal(calls.length, modelCallsBeforeQuick + 1);
  assert.equal(calls.at(-1).kind, 'study-abstract');
  assert.equal((await getStudy(pdfId)).preparations.length, 0);
  await panel.getByRole('button', { name: '研读全文', exact: true }).click();
  await panel.getByText(studySummary, { exact: true }).waitFor();
  await page.waitForFunction(id => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id)?.readerStudy?.preparations.some(prep => prep.status === 'ready'), pdfId);
  const prepared = (await getStudy(pdfId)).preparations.find(prep => prep.status === 'ready');
  assert.equal(prepared.start, 1);
  assert.equal(prepared.end, 3);
  assert.equal(prepared.sourceHash, originalHash);
  assert.ok(prepared.reading.summary.sources.every(source => source.sourceHash === originalHash && source.page === 1));
  assert.equal(prepared.reading.sections[0].sources[0].page, 2);
  assert.match(prepared.reading.wrapUp.body, /阅读后回顾证据/);
  const guideRequest = calls.find(call => call.kind === 'study-guide');
  assert.deepEqual([...new Set(guideRequest.pages)], [1, 2, 3]);
  assert.deepEqual(guideRequest.imagePages, [1, 2, 3]);
  assert.equal((await getStudy(pdfId)).cards.length, 0);
  await page.screenshot({ path: path.join(output, '03-pdf-study-guide.png') });

  await panel.getByRole('button', { name: '存为学习卡', exact: true }).click();
  const dialog = page.locator('.guanyi-study-dialog[open]');
  await dialog.getByRole('textbox', { name: '学习卡问题' }).fill('如何把阅读转化为自己的理解？');
  await dialog.getByRole('button', { name: '确认保留', exact: true }).click();
  await page.waitForFunction(id => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id)?.readerStudy?.cards.length === 1, pdfId);
  await panel.locator('[data-study-tab="cards"]').click();
  await panel.getByRole('button', { name: '开始自测', exact: true }).click();
  await panel.getByRole('button', { name: '显示答案', exact: true }).click();
  await panel.getByRole('button', { name: '基本理解', exact: true }).click();
  await page.waitForFunction(id => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id)?.readerStudy?.cards[0]?.reviews.length === 1, pdfId);
  await page.screenshot({ path: path.join(output, '04-study-card.png') });

  await panel.locator('[data-study-tab="ask"]').click();
  const questionInput = panel.getByRole('textbox', { name: '研读问题' });
  const draft = '切换证据时还没有发送的草稿';
  await questionInput.fill(draft);
  const modelCallsBeforeShortcut = calls.length;
  const shortcut = panel.getByRole('button', { name: '这份文档主要回答什么问题？', exact: true });
  await shortcut.click();
  await panel.getByText('依据所选原文，阅读后应保留来源并写下自己的 Markdown 笔记。', { exact: true }).waitFor();
  assert.equal(calls.length, modelCallsBeforeShortcut + 1);
  assert.equal(calls.at(-1).question, '这份文档主要回答什么问题？');
  assert.equal(await questionInput.inputValue(), draft, 'shortcut sends without replacing the unsent draft');
  await panel.locator('[data-study-tab="guide"]').click();
  const chapter = panel.locator('.guanyi-study-chapter').filter({ has: page.getByRole('button', { name: '查阅第二页的条件', exact: true }) });
  await chapter.getByRole('button', { name: '查阅第二页的条件', exact: true }).click();
  await chapter.locator('.guanyi-study-source-preview > summary').click();
  const pageSource = chapter.locator('.guanyi-study-source-excerpt').filter({ hasText: '文件第 2 页' });
  const modelCallsBeforeSource = calls.length;
  await pageSource.getByRole('button', { name: '基于此处追问', exact: true }).click();
  assert.equal(calls.length, modelCallsBeforeSource);
  assert.equal(await questionInput.inputValue(), draft);
  await questionInput.fill('阅读后应该如何保留依据？');
  const studyComposer=await verifyStudyComposer(panel,'packaged PDF question');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(id => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id)?.readerStudy?.messages.some(message => message.status === 'ready' && message.question === '阅读后应该如何保留依据？'), pdfId);
  const linkedAnswer = (await getStudy(pdfId)).messages.at(-1);
  assert.equal(linkedAnswer.context.start, 2);
  assert.ok(linkedAnswer.sources.every(source => source.sourceHash === originalHash && source.page === 2));
  assert.deepEqual(calls.at(-1).imagePages, [2]);
  const linkedTurn = panel.locator('.guanyi-study-chat').filter({ hasText: '阅读后应该如何保留依据？' });
  await linkedTurn.getByRole('button', { name: '预览建议学习卡', exact: true }).waitFor();
  assert.equal((await getStudy(pdfId)).cards.length, 1);
  await page.screenshot({ path: path.join(output, '05-study-question.png') });

  await linkedTurn.locator('.guanyi-study-source-preview > summary').click();
  const saveExcerpt = linkedTurn.getByRole('button', { name: '存为研究摘录', exact: true });
  await saveExcerpt.click();
  const excerpt = page.getByRole('dialog', { name: '存为研究摘录', exact: true });
  const researchText = '用第二页的限定条件核对论点。';
  await excerpt.getByText('文件第 2 页', { exact: true }).waitFor();
  await excerpt.getByRole('textbox', { name: '研读笔记', exact: true }).fill(researchText);
  await excerpt.getByRole('button', { name: '关闭存为研究摘录', exact: true }).click();
  await excerpt.waitFor({ state: 'hidden' });
  assert.equal((await getStudy(pdfId)).notes.length, 0);
  await saveExcerpt.click();
  assert.equal(await excerpt.getByRole('textbox', { name: '研读笔记', exact: true }).inputValue(), researchText);
  await excerpt.getByRole('button', { name: '保存摘录', exact: true }).click();
  await excerpt.waitFor({ state: 'hidden' });
  await page.waitForFunction(id => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id)?.readerStudy?.notes.length === 1, pdfId);
  const researchNote = (await getStudy(pdfId)).notes[0];
  assert.equal(researchNote.kind, 'research-excerpt');
  assert.equal(researchNote.sources[0].page, 2);
  assert.equal(researchNote.sources[0].kind, 'page-image');
  assert.equal(researchNote.text, researchText);

  await panel.locator('button.app-comment-card__quote').first().click();
  await page.waitForFunction(() => document.querySelector('.guanyi-pdf-page-number')?.value === '2');
  await panel.locator('[data-study-tab="notes"]').click();
  assert.equal(await panel.getByRole('textbox',{name:'研读笔记',exact:true}).count(),0,'PDF notes starts as a list without an open editor');
  await panel.getByRole('button',{name:'新建笔记',exact:true}).click();
  assert.equal(await panel.getByRole('button',{name:'保存研读笔记',exact:true}).isDisabled(),true,'empty notes cannot be saved');
  const studyNoteText='我的理解：先核对原文，再写自己的 Markdown 笔记。';
  await panel.getByRole('textbox', { name: '研读笔记' }).fill(studyNoteText);
  await panel.getByRole('button', { name: '保存研读笔记', exact: true }).click();
  await page.waitForFunction(id => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id)?.readerStudy?.notes.length === 2, pdfId);
  const noteCards=await verifyStudyNoteCard(panel,studyNoteText,'new packaged PDF note',2);
  await panel.locator('[data-study-tab="ask"]').click();await panel.locator('[data-study-tab="notes"]').click();
  await verifyStudyNoteCard(panel,studyNoteText,'PDF note after tab roundtrip',2);
  await page.screenshot({path:path.join(output,'19-pdf-note-cards.png')});
  await panel.getByRole('button', { name: '整理为 Markdown', exact: true }).click();
  const markdownDialog = page.getByRole('dialog', { name: '整理为 Markdown', exact: true });
  await markdownDialog.getByRole('checkbox', { name: /摘要快读与原文依据/ }).check();
  await markdownDialog.getByRole('checkbox', { name: /已完成的文档对话/ }).check();
  await page.locator('.guanyi-study-dialog[open]').getByRole('button', { name: '创建 Markdown 笔记', exact: true }).click();
  await page.waitForFunction(() => window.__MD_EDITOR_TEST__.getState().docs.some(doc => doc.name.includes('研读笔记') && doc.content.includes('我的理解：先核对原文')));
  const markdownDoc = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.name.includes('研读笔记') && doc.content.includes('我的理解：先核对原文')));
  assert.match(markdownDoc.content, /我的批注/);
  assert.match(markdownDoc.content, /学习卡/);
  assert.match(markdownDoc.content, /文档对话（AI）/);
  assert.match(markdownDoc.content, /摘要快读/);
  assert.ok(markdownDoc.content.includes(researchText));
  assert.doesNotMatch(markdownDoc.content, /缺项|摘要未说明样本数|data:image/);
  assert.ok(markdownDoc.content.includes(originalHash));
  assert.equal(markdownDoc.storageKind, 'managed');
  assert.ok(markdownDoc.desktopPath.startsWith(profile), 'created Markdown belongs to the isolated test profile');
  assert.equal(fs.readFileSync(markdownDoc.desktopPath, 'utf8'), markdownDoc.content);
  await page.screenshot({ path: path.join(output, '06-created-markdown.png') });

  await page.evaluate(() => window.__MD_EDITOR_TEST__.showHome());
  await page.locator('[data-home-search]').fill('');
  const recents = await page.locator('[data-home-recent-list] .app-home-document-open').evaluateAll(nodes => nodes.map(node => node.dataset.homeOpen));
  assert.equal(recents[0], markdownDoc.id);
  assert.ok(recents.includes(pdfId));
  await page.screenshot({ path: path.join(output, '07-home-recent-documents.png') });
  await openNativeFile(noAbstractPath);
  const negativePanel = page.locator('.app-reader-container:not([hidden]) .guanyi-study-panel');
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').click();
  const modelCallsBeforeNegative = calls.length;
  await negativePanel.getByRole('button', { name: '摘要快读', exact: true }).click();
  await negativePanel.getByText(/(?:未找到|无法确定|未识别|无法识别|没有找到|没有识别).*摘要/).first().waitFor();
  assert.equal(calls.length, modelCallsBeforeNegative, 'opening body text is not sent as an abstract');
  assert.ok(await negativePanel.getByRole('button', { name: '研读全文', exact: true }).isEnabled());

  await stopApplication();
  await startApplication();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().workspaceView), 'home');
  await page.locator(`.app-home-document-open[data-home-open="${restoredToolbar.markdownId}"]`).click();
  await assertEditingToolbar();
  assert.equal(await page.evaluate(() => window.__MD_EDITOR_TEST__.getCurrentMarkdown()), restoredToolbar.expected);
  assert.equal(fs.readFileSync(markdownPath, 'utf8'), restoredToolbar.expected);
  await page.screenshot({ path: path.join(output, '11-restarted-markdown-toolbar.png') });
  await page.evaluate(() => window.__MD_EDITOR_TEST__.showHome());
  assert.equal(await page.locator(`.app-home-document-open[data-home-open="${pdfId}"]`).count(), 1);
  await page.locator(`.app-home-document-open[data-home-open="${pdfId}"]`).click();
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').waitFor({ state: 'visible' });
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').click();
  const persisted = await getStudy(pdfId);
  assert.equal(persisted.preparations[0].status, 'ready');
  assert.equal(persisted.cards.length, 1);
  assert.equal(persisted.cards[0].reviews.length, 1);
  assert.equal(persisted.messages[0].status, 'ready');
  assert.equal(persisted.notes.length, 2);
  assert.ok(persisted.notes.some(note => note.text.includes('我的理解')));
  assert.ok(persisted.notes.some(note => note.id === researchNote.id && note.sources[0].page === 2));
  assert.equal(persisted.quickReading.takeaway, quickTakeaway);
  assert.equal(persisted.quickReading.boundary, undefined);
  await page.locator('.app-reader-container:not([hidden]) .guanyi-study-panel [data-study-tab="notes"]').click();
  await verifyStudyNoteCard(page.locator('.app-reader-container:not([hidden]) .guanyi-study-panel'),studyNoteText,'restarted PDF note',2);
  assert.equal(await page.evaluate(id => window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === id)?.content, markdownDoc.id), markdownDoc.content);
  const persistedConversations = await page.evaluate(() => window.__MD_EDITOR_TEST__.getState().homeWorkspace.conversations);
  assert.equal(persistedConversations.find(chat => chat.id === conversations.originalId).turns[0].status, 'complete');
  assert.equal(persistedConversations.find(chat => chat.id === conversations.originalId).draft, conversations.draftText);
  assert.ok(persistedConversations.find(chat => chat.id === conversations.otherId).deletedAt);
  await page.screenshot({ path: path.join(output, '08-restarted-study.png') });
  const persistedEpubReview = await verifyPersistedEpubReview(epubReview);
  assert.equal(hashFile(sourcePath), originalHash, 'intelligent study must preserve the source PDF bytes');
  assert.equal(hashFile(epubPath), originalEpubHash, 'intelligent review must preserve the source EPUB archive bytes');
  assert.equal(hashFile(asarPath), packageHash, 'the test must not modify the built application');
  assert.deepEqual(errors, []);
  assert.ok(calls.some(call => call.kind === 'study-question'));
  fs.writeFileSync(path.join(output, 'fixture-requests.json'), `${JSON.stringify(calls, null, 2)}\n`);
  const report = { version: expectedVersion, executable, profile, appAsarSha256: packageHash, sourcePdfSha256: originalHash, sourceEpubSha256: originalEpubHash,
    sourcePdfUnchanged: true, applicationUnchanged: true, nativeImport: true, coldHome: true, directHomeConversation: true,
    parsedPages: [1, 2, 3], guide: true, savedCards: persisted.cards.length, cardReviews: persisted.cards[0].reviews.length,
    sourcedAnswers: persisted.messages.filter(message => message.status === 'ready').length, savedNotes: persisted.notes.length,
    createdMarkdown: { id: markdownDoc.id, path: markdownDoc.desktopPath }, restartPersistence: true,
    restoredToolbar: { ...restoredToolbar, pdfSwitchSessionRestored: true, restartDefaultEditing: true },
    studySidebar, studyResize, studyComposer, noteCards:{...noteCards,restartPersistence:true}, pdfLayout, epubReview: persistedEpubReview,
    recentSearch, conversations: { ...conversations, restartPersistence: true },
    abstractQuickRead: { oneTextOnlyRequest: true, omittedMissingItems: true, noAbstractNoRequest: true, restartPersistence: true },
    researchFlow: { shortcutSentDirectly: true, sourceLockedPage: linkedAnswer.context.start, suggestedCardUnconfirmed: true,
      researchExcerptPage: researchNote.sources[0].page, exportedMarkdown: true, restartPersistence: true },
    bareModelOriginConnection: true, normalizedModelPath: '/v1/chat/completions',
    modelTransport: 'shipping desktop IPC to localhost fixture', modelCalls: calls.map(call => call.kind), errors };
  fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await stopApplication();
  console.log(`Packaged ${expectedVersion} Home, intelligent study and EPUB review passed: ${output}`);
}

main().catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack || error}\n`);
  fs.writeFileSync(path.join(output, 'fixture-errors.json'), `${JSON.stringify(errors, null, 2)}\n`);
  fs.writeFileSync(path.join(output, 'fixture-requests.json'), `${JSON.stringify(calls, null, 2)}\n`);
  if (page && !page.isClosed()) await page.evaluate(() => ({ state: window.__MD_EDITOR_TEST__?.getState(), review: window.__MD_EDITOR_TEST__?.getReviewState() }))
    .then(value => fs.writeFileSync(path.join(output, 'failure-state.json'), `${JSON.stringify(value, null, 2)}\n`)).catch(() => {});
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await stopApplication().catch(() => { application?.kill('SIGTERM'); });
  process.exitCode = 1;
}).finally(async () => {
  if (modelServer) await new Promise(resolve => modelServer.close(resolve));
});
