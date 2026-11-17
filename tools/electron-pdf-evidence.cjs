const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'pdf-evidence');
app.setPath('userData', path.join(output, `profile-${process.pid}`));
app.on('window-all-closed', () => {});

function fixture() {
  const streams = [
    ['BT /F1 18 Tf 40 720 Td (Repeated evidence sentence.) Tj ET', 'BT /F1 18 Tf 40 650 Td (Repeated evidence sentence.) Tj ET', 'BT /F1 18 Tf 40 580 Td (First page context is local.) Tj ET'].join('\n'),
    'BT /F1 18 Tf 40 720 Td (Second page evidence permits a cross-page selection.) Tj ET'
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /PageLabels 11 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [12 0 R 13 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    '<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>',
    '<< /Title (Chapter One) /Parent 8 0 R /Dest [3 0 R /Fit] /Next 10 0 R >>',
    '<< /Title (Chapter Two) /Parent 8 0 R /Dest [4 0 R /Fit] /Prev 9 0 R >>',
    '<< /Nums [0 << /S /r >> 1 << /S /D /St 1 >>] >>',
    '<< /Type /Annot /Subtype /Text /Rect [50 520 72 542] /Contents (Native note stays separate from evidence.) /Name /Comment >>',
    '<< /Type /Annot /Subtype /Highlight /Rect [40 712 280 739] /QuadPoints [40 739 280 739 40 712 280 712] /Contents (Imported highlight comment.) /C [0.2 0.7 0.3] /M (D:20241110113000Z) /CreationDate (D:20241109100000Z) /Popup 14 0 R >>',
    '<< /Type /Annot /Subtype /Popup /Rect [620 640 800 740] /Parent 13 0 R >>'
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(run, label) {
  const started = Date.now();
  while (Date.now() - started < 25000) { if (await run()) return; await delay(80); }
  throw new Error(`Timeout: ${label}`);
}

async function main() {
  await app.whenReady();
  if (process.env.GUANYI_TEST_FOREGROUND !== '1' && process.platform === 'darwin') { app.setActivationPolicy('accessory'); app.dock?.hide(); }
  await fs.mkdir(output, { recursive: true });
  const requests = [];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { requests.push(details.url); callback({ cancel: true }); });
  const bytes = fixture(); const sourceHash = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(output, 'source.pdf'), bytes);
  await fs.writeFile(path.join(output, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><base href="${pathToFileURL(root + path.sep).href}"><link rel="stylesheet" href="css/app.css"><link rel="stylesheet" href="css/pdf-reader.css"><link rel="stylesheet" href="css/pdf-study.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#toolbar{height:50px;display:flex;gap:6px}#container{height:calc(100vh - 50px)}</style></head><body><div id="toolbar"></div><div id="container"></div><script src="vendor/jszip.min.js"></script><script src="js/pdf-evidence.js"></script><script src="js/pdf-reader.js"></script><script src="js/pdf-study.js"></script></body></html>`);
  const window = new BrowserWindow({ width: 1180, height: 900, show: process.env.GUANYI_TEST_FOREGROUND === '1', webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const evaluate = expression => window.webContents.executeJavaScript(`(async()=>(${expression}))()`);
  const run = source => window.webContents.executeJavaScript(`(async()=>{${source}})()`);
  await window.loadFile(path.join(output, 'fixture.html'));
  await run(`window.bytes=new Uint8Array(${JSON.stringify([...bytes])});window.changes=[];window.notices=[];window.reader=await GuanyiPdfReader.open({bytes,sourceHash:${JSON.stringify(sourceHash)},title:'Evidence fixture',container:document.getElementById('container'),toolbar:document.getElementById('toolbar'),icon:()=>'<span>•</span>',notify:m=>notices.push(m),onChange:e=>changes.push(e),edits:{},position:{page:1,zoom:'1'}});window.child=document.querySelector('iframe').contentWindow;window.pdf=child.PDFViewerApplication;`);
  await until(() => evaluate(`child.document.querySelectorAll('.page[data-page-number="1"] .textLayer span').length>=3`), 'native text layer');
  assert.equal(await evaluate('reader.study.info.sourceHash'), sourceHash);
  const page = await evaluate('reader.study.page(1)');
  assert.equal(page.blocks.length, 3);
  assert.equal(page.label, 'i');
  assert.equal(page.blocks[0].text, page.blocks[1].text);
  assert.notEqual(page.blocks[0].id, page.blocks[1].id);
  assert.deepEqual(await evaluate('reader.study.outline()'), [{ title: 'Chapter One', page: 1 }, { title: 'Chapter Two', page: 2 }]);
  await run(`const d=child.document;const span=[...d.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(s=>s.textContent.includes('Repeated evidence'))[1];const range=d.createRange();range.selectNodeContents(span);const selection=d.getSelection();selection.removeAllRanges();selection.addRange(range);window.selected=await reader.study.captureSelection();`);
  const selected = await evaluate('selected');
  assert.equal(selected.sources.length, 1);
  assert.equal(selected.sources[0].page, 1);
  assert.ok(selected.sources[0].rects.every(rect => rect[3] < 700), 'the second repeated phrase must keep its own coordinates');
  assert.ok(selected.sources[0].blockIds.includes(page.blocks[1].id));
  await run(`child.document.getSelection().removeAllRanges();pdf.pdfViewer.currentPageNumber=2;`);
  await until(() => evaluate(`child.document.querySelectorAll('.page[data-page-number="2"] .textLayer span').length>0`), 'rotated second-page text');
  await run('window.returnPoint=reader.study.position();window.annotationHash=pdf.pdfDocument.annotationStorage.serializable.hash;window.located=await reader.study.locate(selected.sources[0]);');
  assert.equal(await evaluate('located.precise'), true);
  assert.equal(await evaluate('pdf.pdfViewer.currentPageNumber'), 1);
  assert.equal(await evaluate('pdf.pdfDocument.annotationStorage.serializable.hash===annotationHash'), true);
  assert.equal(await evaluate('changes.length'), 0);
  assert.ok(await evaluate('child.document.querySelectorAll(".guanyi-evidence-layer span").length') > 0);
  await run('pdf.pdfViewer.pagesRotation=90;pdf.pdfViewer.currentScaleValue="1.25";');
  await delay(300);
  assert.equal(await evaluate(`(()=>{const layer=child.document.querySelector('.guanyi-evidence-layer');const box=layer?.firstElementChild;const a=layer?.getBoundingClientRect();const b=box?.getBoundingClientRect();return !!a&&!!b&&b.width>0&&b.height>0&&b.left>=a.left-2&&b.right<=a.right+2&&b.top>=a.top-2&&b.bottom<=a.bottom+2})()`), true, 'highlight transforms with rotation and zoom');
  await run('await reader.study.restore(returnPoint);');
  assert.equal(await evaluate('pdf.pdfViewer.pagesRotation'), 0);
  assert.equal(await evaluate('pdf.pdfViewer.currentPageNumber'), 2);
  assert.equal(await evaluate('child.document.querySelectorAll(".guanyi-evidence-layer").length'), 0);
  await run(`const record=await reader.study.page(1);const members=record.blocks.slice(0,2);window.groupedEvidence={...members[0],text:members.map(item=>item.text).join(String.fromCharCode(10)),blockIds:members.map(item=>item.id),rects:[[0,0,9999,9999]]};await reader.study.locate(groupedEvidence);`);
  assert.equal(await evaluate('child.document.querySelectorAll(".guanyi-evidence-layer span").length'), page.blocks.slice(0,2).reduce((count,item)=>count+item.rects.length,0), 'a verified contiguous excerpt highlights every native line and ignores supplied coordinates');
  await run(`await reader.study.locate({...groupedEvidence,text:groupedEvidence.text+' invented text'});`);
  assert.equal(await evaluate('child.document.querySelectorAll(".guanyi-evidence-layer span").length'), page.blocks[0].rects.length, 'mismatched grouped text falls back to the known original block');
  await run(`const record=await reader.study.page(1);await reader.study.locate({...groupedEvidence,blockIds:[record.blocks[0].id,record.blocks[2].id],text:record.blocks[0].text+String.fromCharCode(10)+record.blocks[2].text});`);
  assert.equal(await evaluate('child.document.querySelectorAll(".guanyi-evidence-layer span").length'), page.blocks[0].rects.length, 'nonadjacent source IDs cannot create a trusted paragraph highlight');
  assert.equal(await evaluate('pdf.pdfDocument.annotationStorage.serializable.hash===annotationHash'), true);
  await run('await reader.study.restore(returnPoint);');
  await run(`const d=child.document;const a=[...d.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find(s=>s.textContent.includes('Repeated'));const b=d.querySelector('.page[data-page-number="2"] .textLayer span');const range=d.createRange();range.setStart(a.firstChild,3);range.setEnd(b.firstChild,10);const selection=d.getSelection();selection.removeAllRanges();selection.addRange(range);window.cross=await reader.study.captureSelection();`);
  assert.deepEqual(await evaluate('cross.sources.map(source=>source.page)'), [1, 2]);
  await run('child.document.getSelection().removeAllRanges();');
  const annotations = await evaluate('reader.study.annotations()');
  assert.ok(annotations.some(item => item.text.includes('Native note stays separate')));
  const originalComment = annotations.find(item => item.nativeId === '12R');
  assert.equal(originalComment.kind, 'comment');
  assert.equal(originalComment.subtype, 'Text');
  assert.equal(originalComment.createdAt, undefined, 'missing native dates must not be invented');
  const originalHighlight = annotations.find(item => item.nativeId === '13R');
  assert.equal(originalHighlight.comment, 'Imported highlight comment.');
  assert.equal(originalHighlight.kind, 'highlight');
  assert.equal(originalHighlight.subtype, 'Highlight');
  assert.equal(originalHighlight.color, '#33b24c');
  assert.equal(originalHighlight.createdAt, Date.UTC(2024, 10, 9, 10));
  assert.equal(originalHighlight.updatedAt, Date.UTC(2024, 10, 10, 11, 30));
  assert.equal(await evaluate('pdf.pdfDocument.annotationStorage.serializable.hash===annotationHash'), true);
  assert.equal(await evaluate('reader.study.locate({...selected.sources[0],sourceHash:"changed"}).then(()=>false,()=>true)'), true);
  const local = await evaluate(`GuanyiPdfEvidence.readPdf(bytes,{sourceHash:${JSON.stringify(sourceHash)},maxPages:1})`);
  assert.equal(local.coverage.complete, false);
  assert.deepEqual(local.coverage.processedPages, [1]);
  assert.equal(local.evidence[0].text, 'Repeated evidence sentence.');
  const epub = await evaluate(`(async()=>{const zip=new JSZip();zip.file('META-INF/container.xml','<?xml version="1.0"?><container><rootfiles><rootfile full-path="book/content.opf"/></rootfiles></container>');zip.file('book/content.opf','<?xml version="1.0"?><package><manifest><item id="one" href="one.xhtml"/></manifest><spine><itemref idref="one"/></spine></package>');zip.file('book/one.xhtml','<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Local chapter</h1><p>Evidence from the selected EPUB only.</p><img src="https://example.invalid/never-fetch.png"/></body></html>');const data=await zip.generateAsync({type:'uint8array'});return GuanyiPdfEvidence.readEpub(data,{sourceHash:'epub-source'});})()`);
  assert.equal(epub.coverage.complete, true);
  assert.ok(epub.evidence.some(item => item.text === 'Evidence from the selected EPUB only.' && item.page === null));
  assert.deepEqual(requests, [], 'evidence extraction cannot contact remote services or resources');
  assert.equal(await evaluate('changes.length'), 0);
  const exported = Buffer.from(await evaluate('reader.serialize().then(bytes=>Array.from(bytes))'));
  assert.equal(createHash('sha256').update(exported).digest('hex'), sourceHash, 'temporary evidence cannot alter the PDF');
  await fs.writeFile(path.join(output, 'evidence.png'), await window.webContents.capturePage().then(image => image.toPNG()));
  // Exercise actual native editors/dialogs. The study bridge must project the
  // current PDF.js change store, not a separately copied annotation list.
  await run(`window.nativeFrame=document.querySelector('iframe');window.frameLoads=0;nativeFrame.addEventListener('load',()=>frameLoads++);window.nativePdfDocument=pdf.pdfDocument;window.studyOptions={doc:{id:'pdf-evidence',name:'Evidence fixture'},reader:reader.study,container:document.getElementById('container'),toolbar:document.getElementById('toolbar'),persist:async()=>{}};window.studyUi=GuanyiPdfStudy.mount(studyOptions);studyUi.show('notes');`);
  const waitNativeCards = async (count, comments = []) => {
    await until(() => evaluate(`(()=>{const cards=[...document.querySelectorAll('.guanyi-study-note-card[data-note-kind="native"]')];return cards.length===${count}&&document.querySelector('.guanyi-study-notes-toolbar span')?.textContent===${JSON.stringify(`${count} 条批注`)}&&${JSON.stringify(comments)}.every(comment=>cards.some(card=>[...card.querySelectorAll('p')].some(p=>p.textContent===comment)))})()`), 'live native annotation cards');
  };
  await waitNativeCards(2, ['Native note stays separate from evidence.', 'Imported highlight comment.']);
  assert.equal(await evaluate('nativeFrame.contentWindow.PDFViewerApplication===pdf && pdf.pdfDocument===nativePdfDocument && frameLoads===0'), true, 'mounting the live notes panel preserves the native viewer');
  await run(`window.annotationEvents=[];window.stopAnnotations=reader.study.onAnnotationsChanged((...args)=>annotationEvents.push(args));await reader.study.restore({page:1,zoom:'1',rotation:0});const d=child.document;const span=[...d.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(s=>s.textContent.includes('Repeated'))[1];const range=d.createRange();range.selectNodeContents(span);const selection=d.getSelection();selection.removeAllRanges();selection.addRange(range);document.querySelector('[aria-label="评论笔记"]').click();`);
  await until(() => evaluate(`child.document.getElementById('commentManagerDialog').open`), 'new native comment dialog');
  const saveNativeComment = async text => {
    await run(`const input=child.document.getElementById('commentManagerTextInput');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));child.document.getElementById('commentManagerSaveButton').click();`);
    await until(() => evaluate(`!child.document.getElementById('commentManagerDialog').open`), 'native comment committed');
    // PDF.js closes the dialog with a short transition before permitting reopen.
    await delay(160);
  };
  const waitAnnotationEvent = async previousCount => until(() => evaluate(`annotationEvents.length>${previousCount}`), 'native annotation invalidation');
  await saveNativeComment('新建原生评论：保留真实原文。');
  await waitAnnotationEvent(0);
  const nativeNew = (await evaluate('reader.study.annotations()')).find(item => item.comment === '新建原生评论：保留真实原文。');
  assert.ok(nativeNew, 'popup.contents must expose the actual new native comment');
  assert.equal(nativeNew.text, nativeNew.comment, 'legacy text field keeps native comment content');
  assert.equal(nativeNew.kind, 'highlight');
  assert.match(nativeNew.color, /^#[0-9a-f]{6}$/);
  assert.ok(Number.isFinite(nativeNew.createdAt) && Number.isFinite(nativeNew.updatedAt));
  assert.equal(nativeNew.quote, 'Repeated evidence sentence.');
  await waitNativeCards(3, [nativeNew.comment]);
  await run(`window.createdNativeId=${JSON.stringify(nativeNew.nativeId)};window.annotationEventCount=annotationEvents.length;const manager=pdf.pdfViewer._layerProperties.annotationEditorUIManager;const editor=[...manager.getEditors(0)].find(item=>item.id===createdNativeId);editor.editComment();`);
  await until(() => evaluate(`child.document.getElementById('commentManagerDialog').open`), 'edit new native comment');
  await saveNativeComment('修改原生评论：不能显示旧内容。');
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  const nativeUpdated = (await evaluate('reader.study.annotations()')).find(item => item.nativeId === nativeNew.nativeId);
  assert.equal(nativeUpdated.comment, '修改原生评论：不能显示旧内容。');
  assert.ok(nativeUpdated.updatedAt >= nativeNew.updatedAt);
  assert.equal(nativeUpdated.createdAt, nativeNew.createdAt);
  await waitNativeCards(3, [nativeUpdated.comment]);
  assert.equal(await evaluate(`document.querySelector('.guanyi-study-body').textContent.includes(${JSON.stringify(nativeNew.comment)})`), false, 'native editing replaces the card comment without a manual refresh');
  await run(`pdf.pdfViewer.currentPageNumber=2;window.cardLocateHash=pdf.pdfDocument.annotationStorage.serializable.hash;[...document.querySelectorAll('[data-note-kind="native"]')].find(card=>card.dataset.noteId===${JSON.stringify(nativeNew.id)}).querySelector('.app-comment-card__quote').click();`);
  await until(() => evaluate(`pdf.pdfViewer.currentPageNumber===1&&child.document.querySelectorAll('.guanyi-evidence-layer span').length>0`), 'native card quote location');
  assert.ok(nativeNew.rects.every(rect => rect[3] < 700), 'the new native card keeps the second repeated text coordinates');
  assert.equal(await evaluate('pdf.pdfDocument.annotationStorage.serializable.hash===cardLocateHash'), true, 'native card quote location does not change annotations');
  assert.equal(await evaluate(`(()=>{const span=child.document.querySelector('.guanyi-evidence-layer span');const view=pdf.pdfViewer.getPageView(0).viewport;const rect=${JSON.stringify(nativeNew.rects[0])};const a=view.convertToViewportPoint(rect[0],rect[1]);const b=view.convertToViewportPoint(rect[2],rect[3]);return Math.abs(parseFloat(span.style.top)-Math.min(a[1],b[1])/view.height*100)<.01})()`), true, 'clicking the card quote marks its exact native geometry');
  await fs.writeFile(path.join(output, 'native-annotation-cards.png'), await window.webContents.capturePage().then(image => image.toPNG()));
  await run(`window.annotationEventCount=annotationEvents.length;const manager=pdf.pdfViewer._layerProperties.annotationEditorUIManager;const editor=[...manager.getEditors(0)].find(item=>item.id===createdNativeId);manager.setSelected(editor);`);
  await until(() => evaluate(`child.document.getElementById(createdNativeId)?.querySelector('.editToolbar .deleteButton')`), 'new annotation native delete button');
  await run(`child.document.getElementById(createdNativeId).querySelector('.editToolbar .deleteButton').click();`);
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  assert.ok(!(await evaluate('reader.study.annotations()')).some(item => item.nativeId === nativeNew.nativeId), 'native deletion removes new annotations');
  await waitNativeCards(2);
  await run(`window.annotationEventCount=annotationEvents.length;document.querySelector('[aria-label="撤销批注"]').click();`);
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  assert.equal((await evaluate('reader.study.annotations()')).find(item => item.nativeId === nativeNew.nativeId)?.comment, nativeUpdated.comment, 'native undo restores comment metadata');
  await waitNativeCards(3, [nativeUpdated.comment]);
  await delay(160);
  await run(`window.annotationEventCount=annotationEvents.length;document.querySelector('[aria-label="恢复批注"]').click();`);
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  assert.ok(!(await evaluate('reader.study.annotations()')).some(item => item.nativeId === nativeNew.nativeId), 'native redo removes the annotation again');
  await waitNativeCards(2);
  await run(`const manager=pdf.pdfViewer._layerProperties.annotationEditorUIManager;const editor=[...manager.getEditors(0)].find(item=>item.annotationElementId==='13R');window.annotationEventCount=annotationEvents.length;editor.editComment();`);
  await until(() => evaluate(`child.document.getElementById('commentManagerDialog').open`), 'edit imported highlight comment');
  await saveNativeComment('导入高亮的最新原生评论。');
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  const importedUpdated = (await evaluate('reader.study.annotations()')).filter(item => item.nativeId === '13R');
  assert.equal(importedUpdated.length, 1, 'native changes merge by original ID without duplicating imported annotations');
  assert.equal(importedUpdated[0].comment, '导入高亮的最新原生评论。');
  assert.equal(importedUpdated[0].color, originalHighlight.color);
  assert.equal(importedUpdated[0].createdAt, originalHighlight.createdAt);
  await waitNativeCards(2, [importedUpdated[0].comment]);
  await run(`window.annotationEventCount=annotationEvents.length;const manager=pdf.pdfViewer._layerProperties.annotationEditorUIManager;const editor=[...manager.getEditors(0)].find(item=>item.annotationElementId==='13R');manager.deleteComment(editor,editor.comment);`);
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  const importedNoComment = (await evaluate('reader.study.annotations()')).find(item => item.nativeId === '13R');
  assert.ok(importedNoComment, 'deleting only a popup preserves its underlying highlight');
  assert.equal(importedNoComment.comment, '', 'popup.deleted cannot revive the original imported comment');
  assert.equal(importedNoComment.text, '高亮批注');
  await waitNativeCards(2);
  assert.equal(await evaluate(`document.querySelector('.guanyi-study-body').textContent.includes(${JSON.stringify(importedUpdated[0].comment)})`), false, 'native popup deletion clears the card comment automatically');
  await run(`window.annotationEventCount=annotationEvents.length;document.querySelector('[aria-label="撤销批注"]').click();`);
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  assert.equal((await evaluate('reader.study.annotations()')).find(item => item.nativeId === '13R')?.comment, importedUpdated[0].comment, 'undo restores an imported comment without duplicating its highlight');
  await waitNativeCards(2, [importedUpdated[0].comment]);
  await run(`window.annotationEventCount=annotationEvents.length;const manager=pdf.pdfViewer._layerProperties.annotationEditorUIManager;window.importedNativeEditor=[...manager.getEditors(0)].find(item=>item.annotationElementId==='13R');manager.setSelected(importedNativeEditor);`);
  await until(() => evaluate(`importedNativeEditor.div?.querySelector('.editToolbar .deleteButton')`), 'imported annotation native delete button');
  await run(`importedNativeEditor.div.querySelector('.editToolbar .deleteButton').click();`);
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  assert.ok(!(await evaluate('reader.study.annotations()')).some(item => item.nativeId === '13R'), 'native deleted tombstone removes the imported base annotation');
  await waitNativeCards(1);
  await run(`window.annotationEventCount=annotationEvents.length;document.querySelector('[aria-label="撤销批注"]').click();`);
  await waitAnnotationEvent(await evaluate('annotationEventCount'));
  assert.equal((await evaluate('reader.study.annotations()')).find(item => item.nativeId === '13R')?.comment, importedUpdated[0].comment);
  await waitNativeCards(2, [importedUpdated[0].comment]);
  assert.equal(await evaluate('annotationEvents.every(args=>args.length===0)'), true, 'annotation subscriptions are argument-free invalidation signals');
  await delay(160);
  await run(`stopAnnotations();window.annotationEventCount=annotationEvents.length;document.querySelector('[aria-label="恢复批注"]').click();`);
  await delay(40);
  assert.equal(await evaluate('annotationEvents.length'), await evaluate('annotationEventCount'), 'unsubscribed readers receive no callbacks');
  await waitNativeCards(1);
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(output, 'source.pdf'))).digest('hex'), sourceHash, 'native editing never rewrites the source PDF');
  assert.equal(await evaluate(`crypto.subtle.digest('SHA-256',bytes).then(hash=>[...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join(''))`), sourceHash, 'the imported source buffer stays unchanged');
  console.log('Native PDF annotations: real comment create/edit, popup delete, imported highlight tombstones, undo/redo, color/dates, no-argument invalidation, live study card text/count, exact quote location, unsubscribe and unchanged source SHA-256 passed.');
  await delay(200);
  assert.equal(await evaluate('nativeFrame.contentWindow.PDFViewerApplication===pdf && pdf.pdfDocument===nativePdfDocument'), true, 'study mounting preserves the loaded viewer and PDF document');
  assert.equal(await evaluate('frameLoads'), 0, 'study mounting must not reload the iframe');
  await run(`studyOptions.container.hidden=true;await studyUi.dispose();`);
  await delay(200);
  assert.equal(await evaluate('nativeFrame.contentWindow.PDFViewerApplication===pdf && pdf.pdfDocument===nativePdfDocument'), true, 'hidden study teardown preserves the native viewer until its checkpoint completes');
  assert.equal(await evaluate('frameLoads'), 0, 'study teardown must not reload the iframe');
  await run(`studyOptions.container.hidden=false;Object.defineProperty(studyOptions.container,'moveBefore',{value:undefined,configurable:true});window.studyFallback=GuanyiPdfStudy.mount(studyOptions);`);
  await delay(200);
  assert.equal(await evaluate('nativeFrame.contentWindow.PDFViewerApplication===pdf && frameLoads===0'), true, 'fallback study layout preserves the viewer without atomic DOM move support');
  await run('studyOptions.container.hidden=true;await studyFallback.dispose();delete studyOptions.container.moveBefore;');
  await delay(100);
  assert.equal(await evaluate('nativeFrame.contentWindow.PDFViewerApplication===pdf && frameLoads===0'), true, 'fallback teardown preserves the iframe browsing context');
  await run(`await Promise.race([reader.dispose(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Hidden PDF native disposal timed out')),8000))]);`);
  assert.deepEqual(errors, []);
  window.destroy();
  console.log('PDF evidence: exact source SHA-256, stable repeated-text blocks, labels/outline, cross-page selection, rotation/zoom overlays, return position, native notes, bounded standalone PDF, inert EPUB extraction, preserved iframe identity through study mounting/fallback/hidden teardown and native disposal passed; no external requests or PDF changes.');
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
