const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'directory-binary-electron');
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(output, 'run-'));
const profile = path.join(fixture, 'profile');
const directoryPath = path.join(fixture, '最近的阅读');
const nestedPath = path.join(directoryPath, '文学名著');
fs.mkdirSync(nestedPath, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.GUANYI_TEST_USER_DATA = profile;

const pdfPath = path.join(directoryPath, '中文 PDF.pdf');
const nestedPdfPath = path.join(nestedPath, '第二本.PDF');
const epubPath = path.join(directoryPath, '中文 EPUB.epub');
const extraEpubPath = path.join(nestedPath, '刷新后新增.epub');
const oversizedPath = path.join(directoryPath, '超限 PDF.pdf');
fs.writeFileSync(path.join(directoryPath, '阅读记录.md'), '# 阅读记录\n\n原始 Markdown。\n');
fs.writeFileSync(path.join(directoryPath, '随手记.txt'), '原始 TXT。\n');
fs.writeFileSync(path.join(directoryPath, '忽略.docx'), 'not a supported document');
const pdf = new jsPDF();
pdf.text('Directory PDF reading test', 20, 30);
fs.writeFileSync(pdfPath, Buffer.from(pdf.output('arraybuffer')));
pdf.addPage();
pdf.text('Nested PDF page', 20, 30);
fs.writeFileSync(nestedPdfPath, Buffer.from(pdf.output('arraybuffer')));
fs.writeFileSync(oversizedPath, '%PDF-1.7\n');
fs.truncateSync(oversizedPath, 1025 * 1024 * 1024);

async function makeEpub(target, title) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">directory-epub-test</dc:identifier><dc:title>${title}</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>`);
  zip.file('OPS/chapter.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>目录中的 EPUB 正文可以阅读。</p></body></html>`);
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>');
  fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

let pickerCalls = 0;
dialog.showOpenDialog = async (_window, options) => {
  assert.ok(options.properties.includes('openDirectory'), 'directory picker must be native');
  pickerCalls += 1;
  return { canceled: false, filePaths: [directoryPath] };
};

require('../desktop/main.cjs');
const watchdog = setTimeout(() => {
  console.error('directory binary Electron smoke timed out');
  app.exit(1);
}, 120000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await predicate();
    if (result) return result;
    await wait(60);
  }
  throw new Error(`Timed out: ${label}`);
}

(async () => {
  await makeEpub(epubPath, '中文 EPUB');
  await app.whenReady();
  for (const [channel, result] of [
    ['guanyi-semantic:status', { available: false, state: 'disabled' }],
    ['guanyi-semantic:index', { available: false, indexed: 0 }],
    ['guanyi-semantic:search', { available: false, results: [] }]
  ]) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async () => result);
  }
  const window = BrowserWindow.getAllWindows()[0];
  assert.ok(window, 'production window must exist');
  window.webContents.setBackgroundThrottling(false);
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (/Uncaught (?:TypeError|ReferenceError|Error)/.test(message)) errors.push(message);
    if (level >= 2) console.log(message.slice(0, 300));
  });
  const evaluate = source => window.webContents.executeJavaScript(source);
  await until(() => evaluate('Boolean(window.__MD_EDITOR_TEST__)').catch(() => false), 'app boot');
  await evaluate("document.getElementById('btn-add-directory').click(); document.getElementById('btn-directory-add').click();");
  await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().directories.some(d => d.rootPath === ${JSON.stringify(directoryPath)})`), 'added directory');
  assert.equal(pickerCalls, 1);
  const scanResult = await until(async () => {
    const result = await evaluate(`(() => {
      const state = window.__MD_EDITOR_TEST__.getState();
      const directory = state.directories.find(d => d.rootPath === ${JSON.stringify(directoryPath)});
      return directory?.lastScanStatus === 'scanning' || directory?.lastScanStatus === 'idle' ? null : {
        directoryId: directory.id, status: directory.lastScanStatus, summary: directory.lastScanSummary
      };
    })()`);
    return result;
  }, 'initial mixed-format scan');
  assert.ok(scanResult.summary.errors >= 1, 'over-limit PDF should be reported');
  assert.ok(scanResult.summary.errorDetails.some(item => item.path === path.basename(oversizedPath)), 'over-limit PDF path should be visible in scan diagnostics');
  const warning = await evaluate("document.querySelector('.app-directory-item__scan-warning')?.textContent || ''");
  assert.ok(warning.includes(path.basename(oversizedPath)) && /1024\s*MB/.test(warning), `oversized PDF warning must be visible in directory manager: ${warning}`);
  await evaluate("document.getElementById('btn-directory-done').click()");
  assert.equal(await evaluate("document.getElementById('directory-modal').hidden"), true);
  await until(() => evaluate("getComputedStyle(document.getElementById('directory-modal')).display === 'none'"), 'directory modal closed');
  await wait(120);
  const directoryId = scanResult.directoryId;
  const docs = await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.filter(d => d.directoryId === ${JSON.stringify(directoryId)}).map(d => ({id:d.id,name:d.name,file:d.localFileName,relativePath:d.relativePath,content:d.content,readerFormat:d.readerFormat}))`);
  for (const file of ['阅读记录.md', '随手记.txt', '中文 PDF.pdf', '中文 EPUB.epub', '第二本.PDF']) {
    assert.ok(docs.some(doc => doc.file === file), `missing directory document: ${file}`);
  }
  assert.ok(!docs.some(doc => doc.file === '忽略.docx'));
  assert.ok(!docs.some(doc => doc.file === path.basename(oversizedPath)));
  assert.equal(docs.find(doc => doc.file === '第二本.PDF').relativePath, '文学名著/第二本.PDF');
  assert.ok(docs.filter(doc => /\.(?:pdf|epub)$/i.test(doc.file)).every(doc => !doc.content.startsWith('%PDF-')), 'binary files must not be decoded as UTF-8');
  const listed = await evaluate(`[...document.querySelectorAll('#doc-list .app-doc-item')].map(item => item.textContent.trim())`);
  assert.ok(listed.some(text => text.includes('中文 PDF.pdf')));
  assert.ok(listed.some(text => text.includes('中文 EPUB.epub')));
  await fs.promises.writeFile(path.join(fixture, 'directory-tree.png'), (await window.capturePage()).toPNG());

  async function clickDoc(id) {
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('#doc-list .app-doc-item')].find(item => item.dataset.docId === ${JSON.stringify(id)});
      if (!item) throw new Error('directory document is not visible');
      item.click();
    })()`);
    await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().currentDocId === ${JSON.stringify(id)}`), 'directory document opened');
    await until(() => evaluate('Boolean(document.querySelector(".app-reader-toolbar:not([hidden]) .app-reader-save"))'), 'reader toolbar');
  }
  const pdfDoc = docs.find(doc => doc.file === '中文 PDF.pdf');
  await clickDoc(pdfDoc.id);
  assert.equal(await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.find(d => d.id === ${JSON.stringify(pdfDoc.id)}).readerFormat`), 'pdf');
  await until(() => evaluate("document.querySelector('.app-reader-container:not([hidden]) iframe')?.contentWindow?.PDFViewerApplication?.pdfDocument?.numPages === 1"), 'directory PDF pages');
  const pdfViewer = "document.querySelector('.app-reader-container:not([hidden]) iframe')?.contentWindow";
  await until(() => evaluate(`Boolean(
    ${pdfViewer}?.document?.getElementById('editorFreeTextButton')
    && !${pdfViewer}?.document?.getElementById('editorFreeTextButton')?.disabled
  )`), 'PDF annotation controls ready');
  await evaluate("document.querySelector('[aria-label=\"文字笔记\"]').click()");
  await until(() => evaluate(`${pdfViewer}.PDFViewerApplication.pdfViewer.annotationEditorMode === 3`), 'PDF text note mode');
  await until(() => evaluate(`Boolean(${pdfViewer}.document.querySelector('.annotationEditorLayer')?.checkVisibility())`), 'PDF annotation layer');
  const notePoint = await evaluate(`(() => {
    const frame = document.querySelector('.app-reader-container:not([hidden]) iframe').getBoundingClientRect();
    const layer = ${pdfViewer}.document.querySelector('.annotationEditorLayer').getBoundingClientRect();
    return {x: Math.round(frame.x + layer.x + 120), y: Math.round(frame.y + layer.y + 180)};
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...notePoint });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...notePoint });
  await until(() => evaluate(`Boolean(${pdfViewer}.document.querySelector('.freeTextEditor [contenteditable=true]'))`), 'PDF note input');
  await evaluate(`(() => {
    const field = ${pdfViewer}.document.querySelector('.freeTextEditor [contenteditable=true]');
    field.textContent = '目录旧版批注保留';
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '目录旧版批注保留' }));
  })()`);
  await evaluate('window.GuanyiReaderHost.flush()');
  await until(() => evaluate(`${pdfViewer}?.PDFViewerApplication?.pdfDocument?.annotationStorage?.size > 0`), 'PDF note committed');
  await until(() => evaluate(`Boolean(window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === ${JSON.stringify(pdfDoc.id)})?.readerDraftKey)`), 'PDF annotation draft cached');
  await fs.promises.writeFile(path.join(fixture, 'directory-pdf.png'), (await window.capturePage()).toPNG());

  const epubDoc = docs.find(doc => doc.file === '中文 EPUB.epub');
  await clickDoc(epubDoc.id);
  assert.equal(await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.find(d => d.id === ${JSON.stringify(epubDoc.id)}).readerFormat`), 'epub');
  await until(() => evaluate("document.querySelector('.epub-reader__viewer iframe')?.contentDocument?.body?.textContent?.includes('目录中的 EPUB 正文')"), 'directory EPUB content');
  await fs.promises.writeFile(path.join(fixture, 'directory-epub.png'), (await window.capturePage()).toPNG());

  await makeEpub(extraEpubPath, '刷新后新增');
  pdf.addPage();
  pdf.text('Externally changed PDF', 20, 30);
  const updatedPdfBytes = Buffer.from(pdf.output('arraybuffer'));
  fs.writeFileSync(pdfPath, updatedPdfBytes);
  const summary = await evaluate(`window.__MD_EDITOR_TEST__.scanDirectory(window.__MD_EDITOR_TEST__.getState().directories.find(d => d.id === ${JSON.stringify(directoryId)}), {interactive:false, announce:false})`);
  assert.ok(summary.added >= 1 && summary.updated >= 1, JSON.stringify(summary));
  const refreshed = await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.filter(d => d.directoryId === ${JSON.stringify(directoryId)}).map(d => ({file:d.localFileName,content:d.content,readerFormat:d.readerFormat}))`);
  assert.ok(refreshed.some(doc => doc.file === '刷新后新增.epub'));
  const changedPdf = refreshed.find(doc => doc.file === '中文 PDF.pdf');
  assert.equal(changedPdf.readerFormat, 'pdf');
  assert.ok(!changedPdf.content.startsWith('%PDF-'), 'changed PDF must not be converted to text');
  const oldPdfStatus = await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.find(d => d.id === ${JSON.stringify(pdfDoc.id)}).syncState`);
  assert.equal(oldPdfStatus, 'updated', 'changed source should flag the old cached reading record');
  await clickDoc(pdfDoc.id);
  await until(() => evaluate(`${pdfViewer}?.PDFViewerApplication?.pdfDocument?.numPages === 1`), 'cached PDF must keep its original page count');
  const originalAnnotations = await until(() => evaluate(`(async () => {
    const page = await ${pdfViewer}.PDFViewerApplication.pdfDocument.getPage(1);
    const values = (await page.getAnnotations()).map(item => item.contentsObj?.str || '');
    return values.some(text => text.includes('目录旧版批注保留')) ? values : null;
  })()`), 'cached PDF note restored');
  assert.ok(originalAnnotations.some(text => text.includes('目录旧版批注保留')));
  const beforeUpdatedOpen = await evaluate('window.__MD_EDITOR_TEST__.getState().docs.length');
  const updateAction = `[...document.querySelectorAll('#doc-list .app-doc-item')].find(item => item.dataset.docId === ${JSON.stringify(pdfDoc.id)})?.querySelector('[data-action="open-updated-reader"]')`;
  await until(() => evaluate(`Boolean(${updateAction})`), 'open updated PDF action');
  await evaluate(`${updateAction}.click()`);
  await until(() => evaluate(`(() => {
    const state = window.__MD_EDITOR_TEST__.getState();
    const current = state.docs.find(doc => doc.id === state.currentDocId);
    return current?.sourceKind === 'local-file' && current.desktopPath === ${JSON.stringify(pdfPath)} && current.id !== ${JSON.stringify(pdfDoc.id)};
  })()`), 'updated PDF opened separately');
  const updatedPdfId = await evaluate('window.__MD_EDITOR_TEST__.getState().currentDocId');
  assert.equal(await evaluate('window.__MD_EDITOR_TEST__.getState().docs.length'), beforeUpdatedOpen + 1);
  await until(() => evaluate(`${pdfViewer}?.PDFViewerApplication?.pdfDocument?.numPages === 3`), 'updated PDF has three pages');
  await fs.promises.writeFile(path.join(fixture, 'directory-pdf-disk-version.png'), (await window.capturePage()).toPNG());
  assert.equal(await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.find(d => d.id === ${JSON.stringify(pdfDoc.id)}).syncState`), 'updated');
  await clickDoc(pdfDoc.id);
  await until(() => evaluate(`${pdfViewer}?.PDFViewerApplication?.pdfDocument?.numPages === 1`), 'old PDF remains available after opening disk version');

  const epubOriginalBytes = fs.readFileSync(epubPath);
  await evaluate("document.getElementById('btn-add-directory').click()");
  const removeAction = `document.querySelector('.app-directory-item[data-directory-id="${directoryId}"] [data-action="remove-directory"]')`;
  await evaluate(`${removeAction}.click()`);
  await evaluate(`document.querySelector('.app-directory-item[data-directory-id="${directoryId}"] [data-action="confirm-remove-directory"]').click()`);
  await until(() => evaluate(`!window.__MD_EDITOR_TEST__.getState().directories.some(d => d.id === ${JSON.stringify(directoryId)})`), 'directory removed');
  const retained = await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.filter(d => [${JSON.stringify(pdfDoc.id)}, ${JSON.stringify(epubDoc.id)}].includes(d.id)).map(d => ({id:d.id,sourceKind:d.sourceKind,directoryId:d.directoryId,contentLoaded:d.contentLoaded,readerFormat:d.readerFormat}))`);
  assert.equal(retained.length, 2, 'loaded PDF and EPUB reading records must be retained');
  assert.ok(retained.every(doc => doc.sourceKind === 'local-file' && !doc.directoryId && doc.contentLoaded), JSON.stringify(retained));
  assert.ok(retained.some(doc => doc.readerFormat === 'pdf') && retained.some(doc => doc.readerFormat === 'epub'));
  const myDocuments = await evaluate(`[...document.querySelectorAll('#doc-list .app-tree-group')][0]?.textContent || ''`);
  assert.ok(myDocuments.includes('中文 PDF') && myDocuments.includes('中文 EPUB'), 'retained books must appear under My Documents');
  assert.deepEqual(fs.readFileSync(pdfPath), updatedPdfBytes, 'removing directory must preserve source PDF');
  assert.deepEqual(fs.readFileSync(epubPath), epubOriginalBytes, 'removing directory must preserve source EPUB');
  await evaluate("document.getElementById('btn-directory-done').click()");
  await until(async () => {
    try {
      const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'state', 'editor-state-v1.json'), 'utf8'));
      return !persisted.directories.some(directory => directory.id === directoryId)
        && persisted.docs.some(doc => doc.id === pdfDoc.id)
        && persisted.docs.some(doc => doc.id === epubDoc.id);
    } catch (_) { return false; }
  }, 'retained reading records persisted');
  await fs.promises.writeFile(path.join(fixture, 'directory-removed.png'), (await window.capturePage()).toPNG());
  await clickDoc(epubDoc.id);
  await until(() => evaluate("document.querySelector('.epub-reader__viewer iframe')?.contentDocument?.body?.textContent?.includes('目录中的 EPUB 正文')"), 'retained EPUB opens after directory removal');
  await clickDoc(pdfDoc.id);
  await until(() => evaluate(`${pdfViewer}?.PDFViewerApplication?.pdfDocument?.numPages === 1`), 'retained old PDF opens after directory removal');
  assert.ok((await evaluate(`(async () => {
    const page = await ${pdfViewer}.PDFViewerApplication.pdfDocument.getPage(1);
    return (await page.getAnnotations()).map(item => item.contentsObj?.str || '');
  })()`)).some(text => text.includes('目录旧版批注保留')), 'retained PDF note must survive directory removal');
  assert.ok(await evaluate(`window.__MD_EDITOR_TEST__.getState().docs.some(d => d.id === ${JSON.stringify(updatedPdfId)})`), 'new disk-version tab must survive directory removal');

  window.webContents.reload();
  await until(() => evaluate('Boolean(window.__MD_EDITOR_TEST__)').catch(() => false), 'reload app');
  await until(() => evaluate(`window.__MD_EDITOR_TEST__.getState().docs.some(d => d.id === ${JSON.stringify(pdfDoc.id)})`), 'retained reading record restored');
  assert.ok(!await evaluate(`window.__MD_EDITOR_TEST__.getState().directories.some(d => d.rootPath === ${JSON.stringify(directoryPath)})`));
  await clickDoc(pdfDoc.id);
  await until(() => evaluate(`${pdfViewer}?.PDFViewerApplication?.pdfDocument?.numPages === 1`), 'retained PDF reopens after reload');
  assert.deepEqual(errors, []);
  console.log('Mixed directory Electron smoke passed: MD/TXT/PDF/EPUB, over-limit warning, cached PDF annotations versus new disk revision, directory removal retention and reload.');
  console.log(fixture);
  clearTimeout(watchdog);
  app.exit(0);
})().catch(async error => {
  console.error(error);
  const window = BrowserWindow.getAllWindows()[0];
  if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript('window.__MD_EDITOR_BOOT_ERROR__ || document.querySelector("#doc-list")?.textContent').catch(() => 'renderer unavailable'));
  clearTimeout(watchdog);
  app.exit(1);
});
