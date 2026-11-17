const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'readers-integration');
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(output, 'run-'));
const profile = path.join(fixture, 'profile');
process.env.NODE_ENV = 'test';
process.env.GUANYI_TEST_USER_DATA = profile;
const mdPath = path.join(fixture, '原有文档.md');
const txtPath = path.join(fixture, '阅读摘录.txt');
const pdfPath = path.join(fixture, '测试 PDF.pdf');
const epubPath = path.join(fixture, '测试 EPUB.epub');
fs.writeFileSync(mdPath, '# Markdown regression\n\nKeep this original.');
fs.writeFileSync(txtPath, '纯文本阅读摘录。');
const pdf = new jsPDF();
pdf.text('PDF reading test', 20, 30);
pdf.addPage();
pdf.text('Second page', 20, 30);
fs.writeFileSync(pdfPath, Buffer.from(pdf.output('arraybuffer')));
const pdfOriginal = fs.readFileSync(pdfPath);
let selectedPath = mdPath;
let cancelSave = false;
let savedPath;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
dialog.showSaveDialog = async (_window, options) => {
  savedPath = path.join(fixture, path.basename(options.defaultPath));
  return { canceled: cancelSave, filePath: savedPath };
};
require('../desktop/main.cjs');
const watchdog = setTimeout(() => { console.error('reader integration timed out'); app.exit(1); }, 150000);
async function until(predicate, label) {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}`);
}
function parseRgb(value) {
  const channels = String(value || '').match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.equal(channels?.length, 3, `expected an RGB color, received ${value}`);
  return channels;
}
function relativeLuminance(channels) {
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}
function assertClose(actual, expected, label, tolerance = 0.75) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
}
(async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">integration-test</dc:identifier><dc:title>测试 EPUB</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  zip.file('OPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1><p>中文阅读、高亮和批注测试。</p><p>Original content stays readable.</p></body></html>');
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>');
  fs.writeFileSync(epubPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  await app.whenReady();
  for (const channel of ['status','index','search']) {
    ipcMain.removeHandler(`guanyi-semantic:${channel}`);
    ipcMain.handle(`guanyi-semantic:${channel}`, async () => ({ available: false, results: [] }));
  }
  const window = BrowserWindow.getAllWindows()[0];
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('will-prevent-unload', () => console.log('PDF viewer prevented native close'));
  const runtimeErrors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (/Uncaught (?:TypeError|ReferenceError|Error)/.test(message)) runtimeErrors.push(message);
    if(level>=2) console.log(message.slice(0,400));
  });
  const evaluate = code => window.webContents.executeJavaScript(code);
  const ready = () => until(() => evaluate('Boolean(window.__MD_EDITOR_TEST__)').catch(() => false), 'app boot');
  await ready();
  await evaluate("document.querySelector('#btn-open-doc').click()");
  await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().docs.some(d=>d.desktopPath===${JSON.stringify(mdPath)})`), 'Markdown chooser');
  const mdId = await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().documentMode'), 'editing', 'Markdown import opens the full editor');
  assert.notEqual(await evaluate('getComputedStyle(document.getElementById("fmtbar")).display'), 'none');
  selectedPath = txtPath;
  await evaluate("document.querySelector('#btn-open-doc').click()");
  await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().docs.some(d=>d.desktopPath===${JSON.stringify(txtPath)})`), 'TXT chooser');
  const txtId = await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().documentMode'), 'editing', 'TXT import opens the full editor');
  assert.notEqual(await evaluate('getComputedStyle(document.getElementById("fmtbar")).display'), 'none');
  selectedPath = pdfPath;
  await evaluate("document.querySelector('#btn-open-doc').click()");
  await until(() => evaluate('Boolean(document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save"))'), 'PDF viewer ready');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().docs.find(d=>d.id===window.__MD_EDITOR_TEST__.getState().currentDocId).readerFormat'), 'pdf');
  const pdfId = await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#fmtbar")).display'), 'none');
  cancelSave = true;
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.saveCurrentDocument()'), false);
  cancelSave = false;
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.saveCurrentDocument()'), true);
  assert.ok(fs.readFileSync(savedPath).subarray(0, 1024).includes(Buffer.from('%PDF-')));
  assert.deepEqual(fs.readFileSync(pdfPath), pdfOriginal);
  const child = `document.querySelector('.app-reader-container:not([hidden]) iframe').contentWindow`;
  await until(() => evaluate(`${child}.document.querySelectorAll('.textLayer span').length>0`), 'PDF text layer');
  await evaluate(`document.querySelector('[aria-label="文字笔记"]').click()`);
  await until(() => evaluate(`${child}.PDFViewerApplication.pdfViewer.annotationEditorMode===3`), 'PDF note mode');
  await until(() => evaluate(`Boolean(${child}.document.querySelector('.annotationEditorLayer')?.checkVisibility())`), 'PDF annotation layer ready');
  const point = await evaluate(`(()=>{const f=document.querySelector('.app-reader-container:not([hidden]) iframe').getBoundingClientRect();const l=${child}.document.querySelector('.annotationEditorLayer').getBoundingClientRect();return{x:Math.round(f.x+l.x+120),y:Math.round(f.y+l.y+180)}})()`);
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await until(() => evaluate(`Boolean(${child}.document.querySelector('.freeTextEditor [contenteditable=true]'))`), 'PDF note input');
  await evaluate(`(()=>{const el=${child}.document.querySelector('.freeTextEditor [contenteditable=true]');el.focus();})()`);
  await window.webContents.insertText('切换后批注保留');
  await until(() => evaluate(`${child}.document.querySelector('.freeTextEditor [contenteditable=true]')?.textContent.includes('切换后批注保留')`), 'PDF note typed');
  // The last tab click must win even while the first switch waits for a PDF checkpoint.
  await evaluate(`window.__READER_INTEGRATION_OLD_FRAME__ = document.querySelector('.app-reader-container:not([hidden]) iframe');`);
  await evaluate(`document.querySelector('[data-doc-id="${mdId}"] .app-document-tab__activate').click();document.querySelector('[data-doc-id="${pdfId}"] .app-document-tab__activate').click();`);
  await evaluate('window.GuanyiReaderHost.flush()');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId'), pdfId,
    'the last PDF tab click must not be overwritten by an earlier asynchronous switch');
  // Leave and reopen once more so the assertion reads serialized annotations from a new PDF instance.
  await evaluate(`document.querySelector('[data-doc-id="${mdId}"] .app-document-tab__activate').click()`);
  await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().currentDocId===${JSON.stringify(mdId)} && !document.querySelector('.app-reader-container:not([hidden]) iframe')`), 'Markdown after PDF checkpoint');
  await evaluate(`document.querySelector('[data-doc-id="${pdfId}"] .app-document-tab__activate').click()`);
  await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().currentDocId===${JSON.stringify(pdfId)} && Boolean(document.querySelector('.app-reader-toolbar:not([hidden]) .app-reader-save')) && Boolean(document.querySelector('.app-reader-container:not([hidden]) iframe')) && document.querySelector('.app-reader-container:not([hidden]) iframe')!==window.__READER_INTEGRATION_OLD_FRAME__`), 'saved PDF reopened in a new reader');
  const reopenedNotes = await evaluate(`(async()=>{const p=await ${child}.PDFViewerApplication.pdfDocument.getPage(1);return(await p.getAnnotations()).map(a=>a.contentsObj?.str||'')})()`);
  assert.ok(reopenedNotes.some(text=>text.includes('切换后批注保留')), JSON.stringify(reopenedNotes));
  fs.writeFileSync(path.join(fixture, 'pdf-integration.png'), (await window.capturePage()).toPNG());
  selectedPath = epubPath;
  await evaluate("document.querySelector('#btn-open-doc').click()");
  await until(() => evaluate('document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save")?.textContent.includes("导出笔记")'), 'EPUB viewer ready');
  const epubId = await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId');
  const expectedTabIds = { md: mdId, txt: txtId, pdf: pdfId, epub: epubId };
  window.setMinimumSize(320, 480);
  const tabVisualCases = [
    { name: 'wide-light', width: 1200, height: 780, theme: 'light' },
    { name: 'wide-dark', width: 1200, height: 780, theme: 'dark' },
    { name: 'narrow-dark', width: 700, height: 640, theme: 'dark' }
  ];
  const tabVisualReports = {};
  for (const visualCase of tabVisualCases) {
    window.setContentSize(visualCase.width, visualCase.height);
    assert.equal(window.getContentSize()[0], visualCase.width,
      `${visualCase.name} should use the requested content width`);
    await evaluate(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(visualCase.theme)};
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const caseMetrics = [];
    for (const [type, id] of Object.entries(expectedTabIds)) {
      await evaluate(`(() => {
        const tab = [...document.querySelectorAll('#document-tabs .app-document-tab')]
          .find(node => node.dataset.docId === ${JSON.stringify(id)});
        if (!tab) throw new Error('missing ${type} tab');
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const metrics = await evaluate(`(() => {
        const tab = [...document.querySelectorAll('#document-tabs .app-document-tab')]
          .find(node => node.dataset.docId === ${JSON.stringify(id)});
        const icon = tab?.querySelector('.app-document-tab__type');
        const svg = icon?.querySelector(':scope > svg');
        const activate = tab?.querySelector('.app-document-tab__activate');
        const dirty = tab?.querySelector('.app-document-tab__dirty');
        const close = tab?.querySelector('.app-document-tab__close');
        const container = document.getElementById('document-tabs');
        if (!tab || !icon || !svg || !activate || !close || !container) throw new Error('incomplete ${type} tab DOM');
        const rect = (element) => {
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height,
            centerX: value.left + value.width / 2, centerY: value.top + value.height / 2 };
        };
        const glyphBox = svg.getBBox();
        const iconStyle = getComputedStyle(icon);
        const titleStyle = getComputedStyle(activate);
        return {
          type: tab.dataset.documentType,
          iconType: icon.dataset.documentType,
          glyphId: svg.dataset.iconGlyph,
          glyphSignature: svg.innerHTML.replace(/\\s+/g, ' ').trim(),
          svgCount: icon.querySelectorAll(':scope > svg').length,
          viewBox: svg.getAttribute('viewBox'),
          fontSize: parseFloat(titleStyle.fontSize),
          backgroundColor: iconStyle.backgroundColor,
          foregroundColor: iconStyle.color,
          tab: rect(tab),
          icon: rect(icon),
          svg: rect(svg),
          activate: rect(activate),
          dirty: rect(dirty),
          close: rect(close),
          container: rect(container),
          glyphCenterX: glyphBox.x + glyphBox.width / 2,
          glyphCenterY: glyphBox.y + glyphBox.height / 2
        };
      })()`);
      assert.equal(metrics.type, type, `${visualCase.name}: ${type} tab should expose its document type`);
      assert.equal(metrics.iconType, type, `${visualCase.name}: ${type} icon should retain its document type`);
      assert.equal(metrics.glyphId, type, `${visualCase.name}: ${type} should render its own SVG glyph`);
      assert.equal(metrics.svgCount, 1, `${visualCase.name}: ${type} should render exactly one direct SVG glyph`);
      assert.equal(metrics.viewBox, '0 0 16 16', `${visualCase.name}: ${type} should use a 16px SVG canvas`);
      assertClose(metrics.fontSize, 14, `${visualCase.name}: ${type} tab title font size`, 0.25);
      assertClose(metrics.icon.width, 16, `${visualCase.name}: ${type} icon width`, 0.25);
      assertClose(metrics.icon.height, metrics.fontSize + 2, `${visualCase.name}: ${type} icon should be text size + 2px`, 0.25);
      assertClose(metrics.svg.width, metrics.icon.width, `${visualCase.name}: ${type} SVG width`, 0.25);
      assertClose(metrics.svg.height, metrics.icon.height, `${visualCase.name}: ${type} SVG height`, 0.25);
      assertClose(metrics.svg.centerX, metrics.icon.centerX, `${visualCase.name}: ${type} SVG horizontal centering`, 0.25);
      assertClose(metrics.svg.centerY, metrics.icon.centerY, `${visualCase.name}: ${type} SVG vertical centering`, 0.25);
      assertClose(metrics.glyphCenterX, 8, `${visualCase.name}: ${type} glyph horizontal optical center`, 0.5);
      assertClose(metrics.glyphCenterY, 8, `${visualCase.name}: ${type} glyph vertical optical center`, 0.5);
      assertClose(metrics.icon.centerY, metrics.activate.centerY, `${visualCase.name}: ${type} icon/title row centering`);
      assertClose(metrics.icon.centerY, metrics.tab.centerY, `${visualCase.name}: ${type} icon/tab centering`);
      assert.ok(metrics.icon.left >= metrics.tab.left - 0.75 && metrics.icon.right <= metrics.tab.right + 0.75
        && metrics.icon.top >= metrics.tab.top - 0.75 && metrics.icon.bottom <= metrics.tab.bottom + 0.75,
      `${visualCase.name}: ${type} icon should remain inside its tab`);
      assert.ok(metrics.icon.left >= metrics.container.left - 0.75 && metrics.icon.right <= metrics.container.right + 0.75,
        `${visualCase.name}: ${type} icon should remain visible after horizontal scrolling`);
      assert.ok(metrics.icon.right <= metrics.activate.left + 0.75,
        `${visualCase.name}: ${type} icon must not overlap the title`);
      const nextControl = metrics.dirty || metrics.close;
      assert.ok(metrics.activate.width > 0 && metrics.activate.right <= nextControl.left + 0.75,
        `${visualCase.name}: ${type} title must not overlap its trailing control`);
      if (metrics.dirty) {
        assert.ok(metrics.dirty.right <= metrics.close.left + 0.75,
          `${visualCase.name}: ${type} dirty indicator must not overlap the close button`);
      }
      const background = parseRgb(metrics.backgroundColor);
      const foreground = parseRgb(metrics.foregroundColor);
      assert.ok(Math.max(...background) - Math.min(...background) >= 20,
        `${visualCase.name}: ${type} icon tile should be chromatic, received ${metrics.backgroundColor}`);
      assert.ok(contrastRatio(background, foreground) >= 4.5,
        `${visualCase.name}: ${type} white glyph should retain 4.5:1 contrast on ${metrics.backgroundColor}`);
      caseMetrics.push(metrics);
    }
    assert.equal(new Set(caseMetrics.map(({ backgroundColor }) => backgroundColor)).size, 4,
      `${visualCase.name}: the four document types should use four different colors`);
    assert.equal(new Set(caseMetrics.map(({ glyphSignature }) => glyphSignature)).size, 4,
      `${visualCase.name}: the four document types should use four different glyphs`);
    tabVisualReports[visualCase.name] = caseMetrics;
    const screenshot = (await window.capturePage()).toPNG();
    fs.writeFileSync(path.join(fixture, `document-type-tabs-${visualCase.name}.png`), screenshot);
    if (visualCase.name === 'wide-light') {
      fs.writeFileSync(path.join(fixture, 'document-type-tabs.png'), screenshot);
    }
  }
  fs.writeFileSync(path.join(fixture, 'document-type-tabs-metrics.json'), `${JSON.stringify(tabVisualReports, null, 2)}\n`);
  window.setContentSize(1200, 780);
  window.setMinimumSize(920, 640);
  await evaluate(`(() => {
    document.documentElement.dataset.theme = 'light';
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.saveCurrentDocument()'), true);
  assert.ok(savedPath.endsWith('.md'));
  await evaluate(`document.querySelector('[data-doc-id="${mdId}"] .app-document-tab__activate').click()`);
  await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().workspaceView === 'document' && window.__MD_EDITOR_TEST__.getState().currentDocId === ${JSON.stringify(mdId)}`), 'Markdown tab activated');
  // Existing text files retain the 1.0.40 editing toolbar without an extra mode action.
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().documentMode'), 'editing');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("#fmtbar")).display'), 'none');
  assert.equal(await evaluate('document.querySelectorAll(".app-reader-container:not([hidden])").length'), 0);
  // Switch rapidly while a new engine is loading. Stale sessions must never cover Markdown.
  await evaluate(`document.querySelector('[data-doc-id="${pdfId}"] .app-document-tab__activate').click(); document.querySelector('[data-doc-id="${mdId}"] .app-document-tab__activate').click();`);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(await evaluate('document.querySelectorAll(".app-reader-container:not([hidden])").length'), 0);
  await evaluate(`document.querySelector('[data-doc-id="${epubId}"] .app-document-tab__activate').click()`);
  await until(() => evaluate('Boolean(document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save"))'), 'restore EPUB tab');
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await reloaded;
  await ready();
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().workspaceView'), 'home');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId'), epubId);
  await evaluate(`window.__MD_EDITOR_TEST__.switchDoc(${JSON.stringify(epubId)}, { mode: 'reading' })`);
  await until(() => evaluate('Boolean(document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save"))'), 'restore EPUB after reload');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId'), epubId);
  assert.equal(fs.readFileSync(mdPath, 'utf8'), '# Markdown regression\n\nKeep this original.');
  fs.writeFileSync(path.join(fixture, 'epub-integration.png'), (await window.capturePage()).toPNG());
  // Close the real application window with a PDF comment still being typed.
  await evaluate(`document.querySelector('[data-doc-id="${pdfId}"] .app-document-tab__activate').click()`);
  await until(() => evaluate('Boolean(document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save"))'), 'PDF before native close');
  await until(() => evaluate(`${child}.document.querySelectorAll('.textLayer span').length>0`), 'PDF before comment');
  await evaluate(`(()=>{const d=${child}.document;const span=[...d.querySelectorAll('.textLayer span')].find(s=>s.textContent.includes('reading'));const range=d.createRange();range.selectNodeContents(span);const selection=d.getSelection();selection.removeAllRanges();selection.addRange(range);})()`);
  await evaluate(`document.querySelector('[aria-label="评论笔记"]').click()`);
  await until(() => evaluate(`${child}.document.getElementById('commentManagerDialog').open`), 'native PDF comment dialog');
  await evaluate(`(()=>{const d=${child}.document;const field=d.getElementById('commentManagerTextInput');field.value='退出时最后输入的评论';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  window.close();
  await until(() => window.isDestroyed(), 'native close saves comment');
  app.emit('activate');
  await until(() => BrowserWindow.getAllWindows().length > 0, 'new app window');
  const restored = BrowserWindow.getAllWindows()[0];
  restored.webContents.setBackgroundThrottling(false);
  const evaluateRestored = code => restored.webContents.executeJavaScript(code);
  await until(() => evaluateRestored('Boolean(window.__MD_EDITOR_TEST__)').catch(()=>false), 'app boot after native close');
  assert.equal(await evaluateRestored('window.__MD_EDITOR_TEST__.getState().workspaceView'), 'home');
  assert.equal(await evaluateRestored('window.__MD_EDITOR_TEST__.getState().currentDocId'), pdfId);
  await evaluateRestored(`window.__MD_EDITOR_TEST__.switchDoc(${JSON.stringify(pdfId)}, { mode: 'reading' })`);
  await until(() => evaluateRestored('Boolean(document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save"))').catch(()=>false), 'PDF restored after native close');
  assert.equal(await evaluateRestored('window.__MD_EDITOR_TEST__.getState().currentDocId'), pdfId);
  const closedNotes = await evaluateRestored(`(async()=>{const p=await ${child}.PDFViewerApplication.pdfDocument.getPage(1);return(await p.getAnnotations()).map(a=>a.contentsObj?.str||'')})()`);
  assert.ok(closedNotes.some(text=>text.includes('退出时最后输入的评论')), JSON.stringify(closedNotes));
  const previousCount = await evaluateRestored('window.__MD_EDITOR_TEST__.getState().docs.length');
  pdf.addPage();
  pdf.text('Externally updated copy', 20, 30);
  fs.writeFileSync(pdfPath, Buffer.from(pdf.output('arraybuffer')));
  selectedPath = pdfPath;
  await evaluateRestored("document.querySelector('#btn-open-doc').click()");
  await until(() => evaluateRestored(`window.__MD_EDITOR_TEST__.getState().currentDocId!==${JSON.stringify(pdfId)}`), 'externally updated PDF opens separate record');
  const updatedId = await evaluateRestored('window.__MD_EDITOR_TEST__.getState().currentDocId');
  assert.equal(await evaluateRestored('window.__MD_EDITOR_TEST__.getState().docs.length'), previousCount + 1);
  await until(() => evaluateRestored('Boolean(document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save"))'), 'updated PDF ready');
  assert.equal(await evaluateRestored(`${child}.PDFViewerApplication.pdfDocument.numPages`), 3);
  await evaluateRestored("document.querySelector('#btn-open-doc').click()");
  await new Promise(resolve=>setTimeout(resolve, 400));
  assert.equal(await evaluateRestored('window.__MD_EDITOR_TEST__.getState().currentDocId'), updatedId);
  assert.equal(await evaluateRestored('window.__MD_EDITOR_TEST__.getState().docs.length'), previousCount + 1);
  assert.deepEqual(runtimeErrors, []);
  console.log('Reader integration passed: native chooser, format toolbar, PDF save/cancel, EPUB notes export, rapid switching, reload, close with focused PDF comment, original file preservation.');
  console.log(fixture);
  clearTimeout(watchdog);
  app.exit(0);
})().catch(async error => { console.error(error); const w=BrowserWindow.getAllWindows()[0];if(w) console.error(await w.webContents.executeJavaScript('document.querySelector(".app-reader-container")?.textContent')); clearTimeout(watchdog); app.exit(1); });
