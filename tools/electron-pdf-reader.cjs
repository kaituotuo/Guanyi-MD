const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'pdf-reader');
app.setPath('userData', path.join(output, `profile-${process.pid}`));
app.on('window-all-closed', () => {});

function fixturePDF() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['Readable first page and annotation test', 'Second page stays searchable'].map(text => {
      const content = `BT /F1 20 Tf 40 720 Td (${text}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
    })
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(run, label) {
  const start = Date.now();
  while (Date.now() - start < 25000) {
    if (await run()) return;
    await delay(90);
  }
  throw new Error(`Timeout: ${label}`);
}
async function main() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  const source = fixturePDF();
  await fs.writeFile(path.join(output, 'source.pdf'), source);
  await fs.writeFile(path.join(output, 'fixture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <base href="${pathToFileURL(root + path.sep).href}"><link rel="stylesheet" href="css/app.css"><link rel="stylesheet" href="css/pdf-reader.css">
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}.app-reader-toolbar{height:48px;display:flex;gap:5px;align-items:center}#container{height:calc(100vh - 48px)}</style>
  </head><body><div id="toolbar" class="app-reader-toolbar"></div><div id="container"></div><script src="js/pdf-reader.js"></script></body></html>`);
  const window = new BrowserWindow({ width: 1100, height: 850, show: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.on('console-message', (_e, _level, message) => console.log(message));
  const evaluate = expression => window.webContents.executeJavaScript(`(async()=>{return ${expression}})()`);
  const run = statements => window.webContents.executeJavaScript(`(async()=>{${statements}})()`);
  await window.loadFile(path.join(output, 'fixture.html'));
  await run(`window.changes=[];window.snapshots=[];window.notices=[];window.session=await GuanyiPdfReader.open({bytes:new Uint8Array(${JSON.stringify([...source])}),container:document.getElementById('container'),toolbar:document.getElementById('toolbar'),icon:()=>'<span>•</span>',onChange:e=>changes.push(e),onSnapshot:async(b,r)=>snapshots.push({bytes:Array.from(b),revision:r}),notify:m=>notices.push(m),onPosition:p=>window.position=p,edits:{}});`);
  const child = `document.querySelector('iframe').contentWindow`;
  const childDoc = `${child}.document`;
  await until(() => evaluate(`${childDoc}.querySelectorAll('.textLayer span').length>0`), 'PDF text layer');
  assert.equal(await evaluate(`${child}.PDFViewerApplication.pdfDocument.numPages`), 2);
  // Use upstream FreeText editor through the adapter's public toolbar.
  await evaluate(`document.querySelector('[aria-label="文字笔记"]').click()`);
  await until(() => evaluate(`${child}.PDFViewerApplication.pdfViewer.annotationEditorMode===3`), 'FreeText mode');
  const point = await evaluate(`(()=>{const f=document.querySelector('iframe').getBoundingClientRect();const l=${childDoc}.querySelector('.annotationEditorLayer').getBoundingClientRect();return {x:Math.round(f.x+l.x+120),y:Math.round(f.y+l.y+180)}})()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await until(() => evaluate(`!!${childDoc}.querySelector('.freeTextEditor [contenteditable="true"]')`), 'FreeText field');
  await evaluate(`(()=>{const el=${childDoc}.querySelector('.freeTextEditor [contenteditable="true"]');el.textContent='中文阅读笔记';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'中文阅读笔记'}));})()`);
  let saved = await evaluate(`Array.from(await session.serialize())`);
  const originalRect = await evaluate(`Array.from(${child}.PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values())[0].rect`);
  assert.ok(await evaluate('changes.length > 0 && snapshots.length > 0'));
  await fs.writeFile(path.join(output, 'with-note.pdf'), Buffer.from(saved));
  await fs.writeFile(path.join(output, 'note.png'), await window.webContents.capturePage().then(image => image.toPNG()));
  await run(`await session.dispose();document.getElementById('toolbar').replaceChildren();window.session=await GuanyiPdfReader.open({bytes:new Uint8Array(${JSON.stringify(saved)}),container:document.getElementById('container'),toolbar:document.getElementById('toolbar'),icon:()=>'<span>•</span>',onChange:e=>changes.push(e),onSnapshot:async(b,r)=>snapshots.push({bytes:Array.from(b),revision:r}),notify:m=>notices.push(m),edits:{}});`);
  const annotations = await evaluate(`(await (await ${child}.PDFViewerApplication.pdfDocument.getPage(1)).getAnnotations()).map(a=>({subtype:a.subtype,contents:a.contentsObj?.str,text:a.textContent,rect:a.rect}))`);
  const reopenedRect = annotations.find(a => a.subtype === 'FreeText').rect;
  assert.ok(originalRect.every((value, index) => Math.abs(value - reopenedRect[index]) < 0.01), 'Note position must survive reopening');
  assert.ok(annotations.some(annotation => annotation.subtype === 'FreeText' && (annotation.contents?.includes('中文阅读笔记') || annotation.text?.join('').includes('中文阅读笔记'))), JSON.stringify(annotations));
  assert.equal(await evaluate(`${child}.PDFViewerApplication.pdfDocument.numPages`), 2);
  await until(() => evaluate(`${childDoc}.querySelectorAll('.textLayer span').length>0`), 'reopened text layer');
  await evaluate(`(()=>{const d=${childDoc};const span=[...d.querySelectorAll('.textLayer span')].find(s=>s.textContent.includes('Readable'));const range=d.createRange();range.selectNodeContents(span);const s=d.getSelection();s.removeAllRanges();s.addRange(range);})()`);
  await evaluate(`document.querySelector('[aria-label="高亮批注"]').click()`);
  await delay(500);
  saved = await evaluate(`Array.from(await session.serialize())`);
  const highlightCheck = await evaluate(`(async()=>{const lib=await import('./vendor/pdfjs/build/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('vendor/pdfjs/build/pdf.worker.mjs',document.baseURI).href;const task=lib.getDocument({data:new Uint8Array(${JSON.stringify(saved)}),isEvalSupported:false});const pdf=await task.promise;const ann=await(await pdf.getPage(1)).getAnnotations();await task.destroy();return ann.map(a=>a.subtype)})()`);
  assert.ok(highlightCheck.includes('Highlight'), JSON.stringify(highlightCheck));
  await fs.writeFile(path.join(output, 'with-note-highlight.pdf'), Buffer.from(saved));
  await fs.writeFile(path.join(output, 'highlight.png'), await window.webContents.capturePage().then(image => image.toPNG()));
  await evaluate(`document.querySelector('[aria-label="高亮批注"]').click()`);
  await until(() => evaluate(`${child}.PDFViewerApplication.pdfViewer.annotationEditorMode===0`), 'reading mode');
  await until(() => evaluate(`${childDoc}.querySelector('.textLayer span')?.checkVisibility()`), 'visible text layer after mode change');
  await evaluate(`(()=>{const d=${childDoc};const span=[...d.querySelectorAll('.textLayer span')].find(s=>s.textContent.includes('Readable'));const range=d.createRange();range.selectNodeContents(span);const s=d.getSelection();s.removeAllRanges();s.addRange(range);document.querySelector('[aria-label="评论笔记"]').click()})()`);
  await until(() => evaluate(`${childDoc}.getElementById('commentManagerDialog').open`), 'comment dialog');
  await evaluate(`(()=>{const el=${childDoc}.getElementById('commentManagerTextInput');el.value='评论笔记保存测试';el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  // Do not blur or click Save: the close/save bridge must commit native dialog input.
  saved = await evaluate(`Array.from(await session.flush())`);
  await until(() => evaluate(`!${childDoc}.getElementById('commentManagerDialog').open`), 'comment committed');
  const commentCheck = await evaluate(`(async()=>{const lib=await import('./vendor/pdfjs/build/pdf.mjs');const task=lib.getDocument({data:new Uint8Array(${JSON.stringify(saved)}),isEvalSupported:false});const pdf=await task.promise;const ann=await(await pdf.getPage(1)).getAnnotations();await task.destroy();return ann.map(a=>({subtype:a.subtype,contents:a.contentsObj?.str}))})()`);
  assert.ok(commentCheck.some(annotation => annotation.contents?.includes('评论笔记保存测试')), JSON.stringify(commentCheck));
  await fs.writeFile(path.join(output, 'with-comment.pdf'), Buffer.from(saved));
  assert.ok(await evaluate('snapshots.length > 0'));
  await fs.writeFile(path.join(output, 'comment.png'), await window.webContents.capturePage().then(image => image.toPNG()));
  // Undo and redo go through the official editor, then produce fresh binary data.
  await evaluate(`document.querySelector('[aria-label="撤销批注"]').click()`);
  const undone = await evaluate(`(async()=>{const snapshot=await session.serializeSnapshot();return {bytes:Array.from(snapshot.bytes),revision:snapshot.revision,latest:changes.at(-1).revision}})()`);
  assert.equal(undone.revision, undone.latest);
  await evaluate(`document.querySelector('[aria-label="恢复批注"]').click()`);
  const redone = await evaluate(`(async()=>{const snapshot=await session.serializeSnapshot();return {bytes:Array.from(snapshot.bytes),revision:snapshot.revision,latest:changes.at(-1).revision}})()`);
  assert.equal(redone.revision, redone.latest);
  assert.notEqual(undone.revision, redone.revision);
  const undoRedoCheck = await evaluate(`(async()=>{const lib=await import('./vendor/pdfjs/build/pdf.mjs');const results=[];for(const bytes of ${JSON.stringify([undone.bytes,redone.bytes])}){const task=lib.getDocument({data:new Uint8Array(bytes),isEvalSupported:false});const pdf=await task.promise;const ann=await(await pdf.getPage(1)).getAnnotations();results.push(ann.some(a=>a.contentsObj?.str==='评论笔记保存测试'));await task.destroy()}return results})()`);
  assert.deepEqual(undoRedoCheck, [false, true]);
  // There must not be a delayed false dirty revision after an awaited save.
  await delay(600);
  assert.equal(await evaluate('changes.at(-1).revision'), redone.revision);
  // Keep the annotated viewer mounted: acknowledged drafts must not be blocked
  // by the GENERIC viewer's standalone-browser download warning on native close.
  await evaluate('await session.flush()');
  window.close();
  await until(() => Promise.resolve(window.isDestroyed()), 'native close with saved PDF annotation storage');
  console.log('Official PDF.js viewer: read, Chinese note and position, persisted reopen, highlight, focused comment flush, undo/redo, exact binary draft revisions, and native close checks passed.');
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
