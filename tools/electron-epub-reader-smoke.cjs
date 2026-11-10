const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const JSZip = require('jszip');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '.tmp-test', 'epub-reader'));
app.setPath('userData', path.join(output, `profile-${process.pid}`));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let phase = 'startup';
const watchdog = setTimeout(() => {
  console.error(`EPUB smoke timed out after 60 seconds during: ${phase}`);
  app.exit(1);
}, 60000);
function stage(name) {
  phase = name;
  console.log(`[EPUB smoke] ${name}`);
}

async function createFixture() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">guanyi-epub-test</dc:identifier><dc:title>阅读与批注验收</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-11-09T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="image" href="image.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="text/chapter1.xhtml">第一章 阅读</a></li><li><a href="chapter2.xhtml">第二章 思考</a></li></ol></nav></body></html>');
  zip.file('OPS/text/chapter1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title><style>body{line-height:1.8;padding:15px;}p{margin:1em 0;}</style><script>parent.__epubScriptRan=true;</script></head><body onload="parent.__epubEventRan=true"><h1>第一章 阅读</h1><p id="select-me">阅读使我们看见更广阔的世界，并在自己的经验之外理解他人的生活。</p><a href="../chapter2.xhtml" id="internal-link">继续第二章</a><img src="../image.png" alt="测试图片"/><img src="https://epub-invalid.example/beacon.png" alt="远程图片"/>' + '<p>把值得回味的段落留下，在书页之间记录自己的思考。这是用于分页验收的正文。</p>'.repeat(32) + '</body></html>');
  zip.file('OPS/chapter2.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章 思考</h1><p id="chapter-two">一段新的阅读旅程，从一个认真提出的问题开始。</p></body></html>');
  zip.file('OPS/image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function run() {
  stage('creating EPUB fixture');
  await app.whenReady();
  if (process.env.GUANYI_TEST_FOREGROUND !== '1' && process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }
  await fs.mkdir(output, { recursive: true });
  const bytes = await createFixture();
  await fs.writeFile(path.join(output, '阅读与批注验收.epub'), bytes);
  const url = (relative) => pathToFileURL(path.join(root, relative)).href;
  const index = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const sprite = index.match(/<svg[^>]*class="gicon-sprite"[\s\S]*?<\/svg>/)?.[0] || '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${url('css/app.css')}"><link rel="stylesheet" href="${url('css/reader-host.css')}"><link rel="stylesheet" href="${url('css/epub-reader.css')}"><style>body{margin:0;height:100vh;display:flex;flex-direction:column;background:#fff;font-family:system-ui;}#reader{flex:1;min-height:0;position:relative}.app-reader-toolbar{flex-shrink:0}svg{width:18px;height:18px}</style></head><body>${sprite}<div class="app-reader-toolbar" id="toolbar"></div><main id="reader"></main><script src="${url('vendor/jszip.min.js')}"></script><script src="${url('vendor/epub.min.js')}"></script><script src="${url('js/epub-reader.js')}"></script></body></html>`;
  const htmlPath = path.join(output, 'reader.html');
  await fs.writeFile(htmlPath, html);
  // epub.js schedules pagination and location reporting with animation frames.
  // The suite must keep rendering when another app covers this test window.
  const win = new BrowserWindow({ width: 1080, height: 760, show: process.env.GUANYI_TEST_FOREGROUND === '1', webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const failures = [];
  const runtimeFailures = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') { failures.push(event.message); if (/Uncaught|TypeError|ReferenceError/.test(event.message)) runtimeFailures.push(event.message); } });
  const requests = [];
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { requests.push(details.url); callback({ cancel: true }); });
  await win.loadFile(htmlPath);
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  stage('opening first chapter');
  await evaluate(`window.sourceBytes = Uint8Array.from(${JSON.stringify([...bytes])}); window.changes=[]; window.lastPosition=null; window.messages=[];
    window.openReader=async(edits={},position=null)=>{window.reader=await GuanyiEpubReader.open({bytes:sourceBytes,container:document.querySelector('#reader'),toolbar:document.querySelector('#toolbar'),icon:(n)=>'<span class="ui-icon gicon"><svg viewBox="0 0 16 16"><use href="#gicon-'+n+'"></use></svg></span>',onChange:(e)=>changes.push(e),onPosition:(p)=>lastPosition=p,notify:(m)=>messages.push(m),edits,position});}; openReader();`);
  async function until(expression, message) {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (await evaluate(expression)) return;
      await pause(80);
    }
    throw new Error(`${message}\n${failures.join('\n')}`);
  }
  await until(`Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('select-me'))`, 'First chapter not rendered');
  assert.equal(await evaluate(`document.querySelector('select[aria-label="EPUB 章节目录"]').options.length`), 2);
  assert.equal(await evaluate(`!!window.__epubScriptRan || !!window.__epubEventRan`), false);
  assert.equal(await evaluate(`document.querySelector('iframe').sandbox.contains('allow-scripts')`), false);
  assert.equal(await evaluate(`document.querySelector('iframe').contentDocument.querySelector('script')`), null);
  await until(`document.querySelector('iframe').contentDocument.querySelector('img').naturalWidth > 0`, 'Archived image failed');
  stage('checking keyboard pagination');
  const firstPageCfi = await evaluate(`lastPosition.cfi`);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`);
  await until(`lastPosition.cfi !== ${JSON.stringify(firstPageCfi)}`, 'Host ArrowRight did not advance the EPUB');
  const secondPageCfi = await evaluate(`lastPosition.cfi`);
  await evaluate(`document.querySelector('iframe').contentDocument.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`);
  await until(`lastPosition.cfi !== ${JSON.stringify(secondPageCfi)}`, 'Chapter ArrowLeft did not go back in the EPUB');
  const restoredPageCfi = await evaluate(`lastPosition.cfi`);
  assert.equal(restoredPageCfi, firstPageCfi);
  await evaluate(`{const input=document.createElement('input');input.id='keyboard-safety';document.body.append(input);input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));}`);
  await pause(250);
  assert.equal(await evaluate(`lastPosition.cfi`), restoredPageCfi, 'Typing controls must retain their arrow-key behavior');
  await evaluate(`{document.querySelector('#keyboard-safety').remove();const tab=document.createElement('div');tab.id='keyboard-tab';tab.setAttribute('role','tab');tab.tabIndex=0;document.body.append(tab);tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));}`);
  await pause(250);
  assert.equal(await evaluate(`lastPosition.cfi`), restoredPageCfi, 'Document-tab keyboard navigation must not be stolen by the EPUB reader');
  await evaluate(`{document.querySelector('#keyboard-tab').remove();const modal=document.createElement('div');modal.className='app-modal-backdrop';modal.id='keyboard-modal';document.body.append(modal);document.body.focus();document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));}`);
  await pause(250);
  assert.equal(await evaluate(`lastPosition.cfi`), restoredPageCfi, 'An open application modal must block background EPUB pagination');
  await evaluate(`document.querySelector('#keyboard-modal').remove();document.body.focus()`);
  await until(`Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('select-me'))`, 'First page was not ready after keyboard pagination');
  stage('checking highlight and notes');
  await evaluate(`{const d=document.querySelector('iframe').contentDocument; const r=d.createRange();const t=d.querySelector('#select-me').firstChild;r.setStart(t,0);r.setEnd(t,12);const s=d.getSelection();s.removeAllRanges();s.addRange(r);d.dispatchEvent(new Event('selectionchange'));}`);
  await until(`!document.querySelector('[data-epub-action="highlight"]').disabled`, 'Selection not recognized');
  await evaluate(`document.querySelector('[data-epub-action="highlight"]').click()`);
  await until(`changes.length===1`, 'Highlight not persisted');
  assert.match(await evaluate(`changes[0].annotations[0].cfi`), /^epubcfi\(/);
  await evaluate(`document.querySelector('[data-epub-action="note"]').click();const n=document.querySelector('.epub-reader__note textarea');n.value='这是我的中文笔记 <img src=x onerror=alert(1)>';n.dispatchEvent(new Event('input',{bubbles:true}));const color=document.querySelector('select[aria-label="高亮颜色"]');color.value='green';color.dispatchEvent(new Event('change'));`);
  assert.match(await evaluate(`reader.exportNotes()`), /这是我的中文笔记/);
  assert.equal(await evaluate(`document.querySelector('.epub-reader__notes img')`), null);
  await pause(1200);
  stage('capturing highlight screenshot');
  await fs.writeFile(path.join(output, 'epub-highlight-notes.png'), (await win.webContents.capturePage()).toPNG());
  const saved = await evaluate(`changes.at(-1)`);
  assert.equal(saved.annotations[0].color, 'green');
  const serialized = await evaluate(`reader.serialize().then(b=>Array.from(b))`);
  assert.deepEqual(Buffer.from(serialized), bytes);
  stage('navigating to second chapter');
  await evaluate(`{const s=document.querySelector('select[aria-label="EPUB 章节目录"]');document.querySelector('iframe').contentDocument.querySelector('#internal-link').click();}`);
  await until(`Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('chapter-two'))`, 'Chapter navigation failed');
  await until(`lastPosition?.cfi?.startsWith('epubcfi(/6/4')`, 'Position not emitted');
  const position = await evaluate(`lastPosition`);
  stage('reopening saved reading position');
  await evaluate(`reader.dispose();openReader(${JSON.stringify(saved)},${JSON.stringify(position)})`);
  await until(`Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('chapter-two'))`, 'Reading position failed to restore');
  assert.match(await evaluate(`reader.exportNotes()`), /这是我的中文笔记/);
  stage('checking narrow dark layout');
  await evaluate(`document.querySelector('[data-epub-action="notes"]').click();document.documentElement.dataset.theme='dark';`);
  win.setSize(520, 640);
  await until(`Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('chapter-two')) && document.querySelector('iframe').style.visibility === 'visible'`, 'Narrow view disappeared after resize');
  assert.match(await evaluate(`lastPosition.cfi`), /^epubcfi\(\/6\/4/);
  await pause(250);
  stage('capturing narrow dark screenshot');
  await fs.writeFile(path.join(output, 'epub-narrow-dark.png'), (await win.webContents.capturePage()).toPNG());
  stage('checking removal and malformed EPUB');
  await evaluate(`document.querySelector('button[aria-label="移除此标注"]').click()`);
  assert.equal(await evaluate(`changes.at(-1).annotations.length`), 0);
  assert.deepEqual(requests, [], 'EPUB attempted external network access');
  assert.deepEqual(runtimeFailures, [], 'Reader emitted uncaught runtime errors');
  await evaluate(`reader.dispose()`);
  assert.equal(await evaluate(`document.querySelectorAll('iframe').length`), 0);
  await evaluate(`window.invalidHandled=false;GuanyiEpubReader.open({bytes:new Uint8Array([80,75]),container:document.querySelector('#reader'),toolbar:document.querySelector('#toolbar')}).catch(()=>invalidHandled=true)`);
  await until(`invalidHandled`, 'Malformed EPUB not rejected');
  clearTimeout(watchdog);
  console.log(`EPUB reader passed: reading, keyboard pagination, input safety, images, sandbox, annotation/notes, color/remove, export, restore, narrow dark layout. Screenshots: ${output}`);
  win.destroy();
  app.quit();
}
run().catch((error) => { clearTimeout(watchdog); console.error(`EPUB smoke failed during: ${phase}`, error); app.exit(1); });
