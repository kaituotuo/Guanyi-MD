const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.tmp-test', 'source-scroll');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
const html = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'index.html');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => app.exit(1), 60000);
(async () => {
  await app.whenReady();
  if (process.env.GUANYI_TEST_FOREGROUND !== '1' && process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }
  const window = new BrowserWindow({ width: 1280, height: 820, show: process.env.GUANYI_TEST_FOREGROUND === '1', webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', (_event, level, message) => { if(level >= 2) console.log(message.slice(0,500)); });
  await window.loadFile(html);
  const run = code => window.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(code)})}catch(e){return {testError:e.stack}}})()`).then(result=>{if(result?.testError)throw new Error(result.testError);return result;});
  for (let i = 0; i < 200 && !(await run('Boolean(window.__MD_EDITOR_TEST__)')); i++) await delay(40);
  const text = Array.from({length:180}, (_,i) => `## Heading ${i}\n\nParagraph ${i} 中文内容.\n\n- [ ] Existing task ${i}\n\n`).join('');
  const setup = async (index) => {
    await run(`window.__MD_EDITOR_TEST__.setCurrentMarkdown(${JSON.stringify(text)}); window.__MD_EDITOR_TEST__.renderPreview();document.querySelector('[data-view="split"]').click();`);
    await delay(250);
    await run(`(() => {const s=document.querySelector('#source-editor');const index=${index};s.focus({preventScroll:true});s.setSelectionRange(index,index);const line=s.value.slice(0,index).split('\\n').length-1;const height=parseFloat(getComputedStyle(s).lineHeight);s.scrollTop=Math.max(0,line*height-180);window.scrollSamples=[];s.onscroll=()=>window.scrollSamples.push(s.scrollTop);})()`);
    await delay(250);
    return run(`({top:document.querySelector('#source-editor').scrollTop,preview:document.querySelector('#preview-wrap').scrollTop,caret:document.querySelector('#source-editor').selectionStart})`);
  };
  for (const action of ['toolbar','enter','typing']) {
    const offset = text.indexOf(action === 'enter' ? 'Existing task 60' : 'Paragraph 60') + (action === 'enter' ? 'Existing task 60'.length : 0);
    const before = await setup(offset);
    if (action === 'toolbar') await run("document.querySelector('[data-fmt=task]').focus();document.querySelector('[data-fmt=task]').click()");
    else if (action === 'enter') {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    } else await window.webContents.insertText('- [ ] ');
    await delay(700);
    const after = await run(`({top:document.querySelector('#source-editor').scrollTop,preview:document.querySelector('#preview-wrap').scrollTop,caret:document.querySelector('#source-editor').selectionStart,max:document.querySelector('#source-editor').scrollHeight-document.querySelector('#source-editor').clientHeight,samples:window.scrollSamples})`);
    console.log(JSON.stringify({action,before,after}));
    assert.ok(Math.abs(after.top-before.top)<65, `${action}: source viewport jumped by ${after.top-before.top}px`);
    assert.ok(Math.abs(after.preview-before.preview)<65, `${action}: preview viewport jumped by ${after.preview-before.preview}px`);
    assert.ok(after.caret>=offset && after.caret<=offset+12, `${action}: caret left edited text`);
    assert.ok(after.samples.every(top=>Math.abs(top-before.top)<65), `${action}: transient viewport jump`);
  }
  fs.writeFileSync(path.join(out,'source-task-stable.png'),(await window.capturePage()).toPNG());
  console.log('Split source editing scroll regression passed.');
  clearTimeout(watchdog);app.exit(0);
})().catch(error=>{console.error(error);clearTimeout(watchdog);app.exit(1);});
