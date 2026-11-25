'use strict';
// Full built-app acceptance with generated documents and an isolated browser
// profile. Model responses are fixtures; no cloud keys or user files are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp-test', 'home-study-integration');
fs.mkdirSync(output, { recursive:true });
const conversationOutput = path.join(root, '.tmp-test', 'conversation-management');
fs.mkdirSync(conversationOutput, { recursive:true });
const mime = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm'};
const server = http.createServer((req,res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url,'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url,'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file,(error,bytes) => { if(error)res.writeHead(404).end();else{res.setHeader('content-type',mime[path.extname(file)] || 'application/octet-stream');res.end(bytes);} });
});
let browser;
const watchdog=setTimeout(()=>{console.error('Home/study integration exceeded 180 seconds');browser?.close();},180000);
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.GUANYI_CHROMIUM_EXECUTABLE?{executablePath:process.env.GUANYI_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.setDefaultTimeout(20000);
  const errors=[],requests=[];let mode='normal';
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('md-editor-model-config-v1',JSON.stringify({provider:'openai-compatible',baseUrl:'https://model.fixture.invalid/v1',model:'fixture-model'}));
    sessionStorage.setItem('md-editor-model-session-key-v1','fixture-key');
    window.showSaveFilePicker=undefined;
  });
  await page.route('**/*',async route=>{
    const request=route.request(),url=request.url();
    if(url.startsWith('https://model.fixture.invalid/')){
      const payload=request.postDataJSON();requests.push(payload);
      if(mode==='wait'){await new Promise(resolve=>setTimeout(resolve,600));if(mode==='wait')return route.abort();}
      let input;try{const content=payload.messages.at(-1).content;input=JSON.parse(Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).find(text=>text.trim().startsWith('{')):content);}catch(_){input={};}
      const system=payload.messages[0].content;let answer;
      if((!input.stage&&input.task)||/prepare|read-batch|synthesize-reading/.test(input.stage||''))answer={reading:{title:'理解资料的边界',documentType:'研究资料',summary:{body:'这是测试资料提出的条件。',evidenceIds:['E1']},sections:[{kind:'methods',title:'研究方法',body:'从原文核对证据。',basis:'source',evidenceIds:['E1']},{kind:'results',title:'研究结论',body:'需要核对证据及其条件。',basis:'author',evidenceIds:['E1']}],wrapUp:{body:'结论仅适用于原文描述的条件。',basis:'explanation',evidenceIds:['E1']},terms:[],quotes:[],related:[]},guide:[{title:'理解资料的边界',body:'这是测试资料提出的条件。',evidenceIds:['E1']}],questions:[{question:'材料的条件是什么？',evidenceIds:['E1']}],cards:[{question:'理解结论前需要核对什么？',answer:'需要核对证据及其条件。',type:'方法',evidenceIds:['E1']}]};
      else if(/evidenceIds/.test(system))answer={answer:'需要根据提供的原文核对证据及其条件。',evidenceIds:[mode==='invalid'?'E999':'E1'],insufficient:false};
      else if(/citations/.test(system))answer={answer:'所选文档说明需要核对证据及其条件。',citations:[mode==='invalid'?'unknown':JSON.parse(system.split('已提供的原文证据：\n')[1])[0].id],insufficient:false};
      else answer='可以从阅读问题开始组织自己的笔记。';
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:typeof answer==='string'?answer:JSON.stringify(answer)}}]})});
    }
    if(url.startsWith(origin)||url.startsWith('blob:')||url.startsWith('data:'))return route.continue();
    return route.abort();
  });
  await page.goto(origin);await page.waitForFunction(()=>window.__MD_EDITOR_TEST__);
  async function assertHitTarget(locator,label) {
    const hit=await locator.evaluate(el=>{
      const rect=el.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
      const target=document.elementFromPoint(x,y);
      return {hit:!!target&&(target===el||el.contains(target)),inside:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,target:target?.id||target?.className||target?.tagName};
    });
    assert.ok(hit.inside,`${label} remains inside the viewport`);
    assert.ok(hit.hit,`${label} is covered by ${hit.target}`);
  }
  async function openAppMenu(label) {
    await assertHitTarget(page.locator('#btn-app-menu'),`${label}: menu trigger`);
    await page.locator('#btn-app-menu').click();
    await page.waitForSelector('#app-menu:not([hidden])');
    assert.equal(await page.locator('#btn-app-menu').getAttribute('aria-expanded'),'true');
    const commands=await page.locator('#app-menu [data-app-command]').evaluateAll(items=>items.map(item=>item.dataset.appCommand));
    assert.deepEqual([...commands].sort(),['settings','switch-model','conversation-history','model-settings','update','help','about'].sort());
    for(const command of commands) await assertHitTarget(page.locator(`#app-menu [data-app-command="${command}"]`),`${label}: ${command}`);
  }
  async function exerciseAppMenu(label,screenshot) {
    for(const command of ['settings','model-settings','update','help','about']) {
      await openAppMenu(label);
      if(screenshot&&command==='settings') await page.screenshot({path:path.join(output,screenshot)});
      await page.locator(`#app-menu [data-app-command="${command}"]`).click();
      assert.equal(await page.locator('#app-menu').isVisible(),false,`${label}: ${command} closes menu`);
      assert.equal(await page.locator('#btn-app-menu').getAttribute('aria-expanded'),'false');
      const modal={settings:['#settings-modal','#btn-settings-close'],'model-settings':['#model-modal','#btn-model-close'],about:['#about-modal','#btn-about-close'],update:['#about-modal','#btn-about-close']}[command];
      if(modal) {
        assert.equal(await page.locator(modal[0]).isVisible(),true,`${label}: ${command} opens dialog`);
        if(command==='about' || command==='update') {
          assert.equal(await page.locator('#about-modal .app-modal__header p').textContent(),'俯仰观物，译述我心');
          assert.equal(await page.locator('#about-version').textContent(),'Web 预览版');
          const note=page.locator('#about-update-note');
          const update=page.getByRole('button',{name:'更新方式',exact:true});
          assert.equal(await note.isVisible(),command==='update');
          if(command==='about') await update.click();
          assert.equal(await update.getAttribute('aria-expanded'),'true');
          assert.match(await note.innerText(),/刷新页面.*Web/);
        }
        await page.locator(modal[1]).click();
        assert.equal(await page.locator(modal[0]).isVisible(),false);
      } else {
        assert.equal(await page.locator('#tip').isVisible(),true);
        assert.match(await page.locator('#tip').textContent(),/帮助/);
      }
    }
  }
  async function assertGlobalModelEntry(label) {
    assert.equal(await page.locator('.app-topbar__tagline').textContent(),'俯仰观物，译述我心',`${label}: consistent product slogan`);
    assert.equal(await page.title(),'观译阅读器｜俯仰观物，译述我心');
    assert.equal(await page.locator('#app-menu [data-app-command="model-settings"]').count(),1,`${label}: one global model entry`);
    assert.equal(await page.locator('#btn-model-settings,#btn-model-config,[data-home-action="configure-model"]').count(),0,`${label}: old model configuration buttons removed`);
    assert.equal(await page.locator('.guanyi-study-notice button').count(),0,`${label}: study notices use the global menu`);
    await openAppMenu(label);
    await page.locator('#app-menu [data-app-command="model-settings"]').click();
    assert.equal(await page.locator('#model-modal').isVisible(),true);
    await page.locator('#btn-model-close').click();
  }
  async function waitReview(open) {
    await page.waitForFunction(open=>{
      const drawer=document.querySelector('#collab-drawer');
      const rect=drawer.getBoundingClientRect();
      return drawer.getAttribute('aria-hidden')===String(!open)&&(open?rect.right<=innerWidth+.5:rect.left>=innerWidth-.5);
    },open);
    assert.equal(await page.locator('#btn-comments').getAttribute('aria-expanded'),String(open));
  }
  async function assertReviewClosed(label) {
    await waitReview(false);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'btn-comments',`${label}: focus returns to review toggle`);
  }
  async function assertStudyClosed(label) {
    assert.equal(await page.locator('.guanyi-study-panel').isVisible(),false,label);
    assert.equal(await page.locator('.guanyi-study-toggle').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('.guanyi-study-toggle').evaluate(el=>el===document.activeElement),true,`${label}: focus returns to study toggle`);
  }
  async function assertStudyComposer(panel,label) {
    const wrapper=panel.locator('.guanyi-study-composer-input');
    const send=wrapper.getByRole('button',{name:'发送',exact:true});
    assert.equal(await wrapper.getByRole('textbox',{name:'研读问题',exact:true}).count(),1,`${label}: question belongs to composer input`);
    assert.equal(await send.innerText(),'',`${label}: send uses an icon without a text row`);
    assert.equal(await send.locator('svg[aria-hidden="true"]').count(),1,`${label}: send icon is decorative`);
    const geometry=await wrapper.evaluate(el=>{
      const box=el.getBoundingClientRect(),input=el.querySelector('textarea').getBoundingClientRect(),button=el.querySelector('.guanyi-study-send').getBoundingClientRect();
      const r=rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height});
      return {box:r(box),input:r(input),button:r(button)};
    });
    assert.ok(geometry.button.width>=28&&geometry.button.height>=28,`${label}: send retains a usable target`);
    assert.ok(geometry.button.left>=geometry.input.left&&geometry.button.right<=geometry.input.right+1,`${label}: send stays horizontally inside input`);
    assert.ok(geometry.button.top>=geometry.input.top+geometry.input.height/2&&geometry.button.bottom<=geometry.input.bottom+1,`${label}: send sits inside lower input half`);
    assert.ok(geometry.input.right-geometry.button.right<=16&&geometry.input.bottom-geometry.button.bottom<=16,`${label}: send occupies the bottom-right corner`);
    assert.ok(geometry.box.height<=geometry.input.height+2,`${label}: send does not allocate a separate row`);
    await assertHitTarget(send,`${label}: send icon`);
  }
  async function assertStudyNoteCard(panel,text,label) {
    assert.equal(await panel.getByRole('textbox',{name:'研读笔记',exact:true}).count(),0,`${label}: list does not keep an editor open`);
    assert.equal(await panel.getByRole('button',{name:'新建笔记',exact:true}).isVisible(),true,`${label}: list offers creation`);
    const card=panel.locator('.guanyi-study-note-card[data-note-kind="study"]').filter({has:page.getByText(text,{exact:true})});
    await card.waitFor({state:'visible'});
    assert.equal(await card.count(),1,`${label}: saved note appears as one card`);
    assert.equal(await card.locator('button.app-comment-card__quote').count(),1,`${label}: card retains its local page source`);
    assert.match(await card.locator('button.app-comment-card__quote').textContent(),/第\s*1\s*页/,`${label}: page-only source is explicit`);
    assert.equal(await card.getByRole('button',{name:'编辑笔记',exact:true}).count(),1,`${label}: saved note can be edited`);
    assert.equal(await card.getByRole('button',{name:'删除笔记',exact:true}).count(),1,`${label}: saved note can be removed`);
    assert.ok((await card.locator('small').textContent()).trim(),`${label}: card has metadata`);
    const geometry=await card.evaluate(el=>{const r=el.getBoundingClientRect(),panel=el.closest('.guanyi-study-panel').getBoundingClientRect();return{left:r.left,right:r.right,height:r.height,panelLeft:panel.left,panelRight:panel.right};});
    assert.ok(geometry.height>40&&geometry.left>=geometry.panelLeft-1&&geometry.right<=geometry.panelRight+1,`${label}: card remains inside its panel`);
  }
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().workspaceView),'home');
  assert.equal(await page.locator('#fmtbar').isVisible(),false);
  assert.equal(await page.locator('.app-workspace-home-tab').count(),1);
  assert.equal(await page.locator('.app-workspace-chat-tab').count(),1,'AI chat is a persistent destination alongside home');
  assert.equal(await page.locator('.app-home-document-open').count(),0,'seeded examples have never been opened');
  assert.equal(await page.locator('.app-home-section-heading').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  await assertGlobalModelEntry('home');
  const pdf=new jsPDF();
  for(let i=1;i<=3;i++){if(i>1)pdf.addPage();pdf.text(`Evidence and conditions on page ${i}.`,20,30);pdf.text('A conclusion depends on evidence and its conditions.',20,50);}
  const pdfBytes=Buffer.from(pdf.output('arraybuffer'));
  const zip=new JSZip();zip.file('mimetype','application/epub+zip');
  zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
  zip.file('book.opf','<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Evidence</title></head><body><h1>Conditions</h1><p>EPUB evidence and its conditions.</p></body></html>');
  const files=[{name:'阅读笔记.md',bytes:[...Buffer.from('# Evidence\n\nA conclusion needs evidence and conditions.\n\n- [ ] Keep the original task.')]},{name:'摘录.txt',bytes:[...Buffer.from('TXT evidence and conditions.')]},{name:'资料.epub',bytes:[...await zip.generateAsync({type:'nodebuffer'})]},{name:'研究.pdf',bytes:[...pdfBytes]}];
  await page.evaluate(async files=>{await __MD_EDITOR_TEST__.importLocalFiles(files.map(file=>new File([new Uint8Array(file.bytes)],file.name,{lastModified:1700000000000})));},files);
  await page.waitForSelector('.guanyi-study-toggle');
  assert.equal(await page.locator('.guanyi-study-toggle').innerText(),'','study toolbar uses an icon without a visible text label');
  assert.equal(await page.locator('.guanyi-study-toggle svg[aria-hidden="true"]').count(),1);
  assert.equal(await page.locator('.guanyi-study-toggle').getAttribute('title'),'智能研读');
  assert.equal(await page.locator('.guanyi-study-toggle').getAttribute('aria-label'),'智能研读');
  assert.equal(await page.locator('.guanyi-study-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.guanyi-study-toggle').getAttribute('aria-controls'),await page.locator('.guanyi-study-panel').getAttribute('id'));
  await assertGlobalModelEntry('PDF reader');
  const ids=await page.evaluate(()=>Object.fromEntries(__MD_EDITOR_TEST__.getState().docs.filter(d=>['阅读笔记.md','摘录.txt','资料.epub','研究.pdf'].includes(d.localFileName)).map(d=>[d.localFileName,d.id])));
  assert.equal(Object.keys(ids).length,4);
  const sourceHash=await page.evaluate(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerSourceHash);
  assert.match(sourceHash,/^[a-f0-9]{64}$/);
  assert.equal(await page.locator('.app-sidebar').isVisible(),false);
  assert.equal(await page.evaluate(id=>__MD_EDITOR_TEST__.switchDoc(id),ids['阅读笔记.md']),true);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().documentMode),'editing');
  assert.equal(await page.locator('#document-reading-toolbar').isVisible(),false);
  assert.equal(await page.locator('#fmtbar').isVisible(),true);
  assert.equal(await page.locator('#source-editor').evaluate(el=>el.readOnly),false);
  // Keep every 1.0.40 toolbar entry reachable on opening an existing Markdown.
  for(const selector of ['#btn-heading','[data-fmt=bold]','[data-fmt=italic]','[data-fmt=strike]','[data-fmt=link]','[data-fmt=codeblock]','[data-fmt=inlinecode]','[data-fmt=ul]','[data-fmt=ol]','[data-fmt=task]','#btn-table','#btn-image','[data-fmt=quote]','[data-fmt=hr]','#btn-find-replace','#btn-comments','#view-seg','#btn-save','#btn-save-more','#btn-export','#btn-theme']) {
    assert.equal(await page.locator('#fmtbar').locator(selector).isVisible(),true,selector);
  }
  const original=await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown());
  for(const view of ['source','preview','split']) {
    await page.locator(`#view-seg [data-view=${view}]`).click();
    assert.equal(await page.locator('#editor-container').getAttribute('data-view'),view);
  }
  // The Markdown outline is a preview-side navigator and must not cover source editing.
  assert.equal(await page.locator('#btn-toggle-outline').count(),1,'editing outline toggle exists');
  assert.equal(await page.locator('#btn-toggle-outline svg').count(),1,'editing outline toggle is an icon');
  await page.locator('#view-seg [data-view=source]').click();
  assert.equal(await page.locator('#btn-toggle-outline').isVisible(),false,'source view hides the outline toggle');
  assert.equal(await page.locator('.app-preview-pane').isVisible(),false,'source view hides preview pane and outline');
  await page.locator('#view-seg [data-view=preview]').click();
  assert.equal(await page.locator('#btn-toggle-outline').isVisible(),true);
  assert.equal(await page.locator('.app-preview-pane').isVisible(),true);
  assert.equal(await page.locator('#document-outline').isVisible(),false,'outline is closed by default');
  await page.locator('#btn-toggle-outline').click();
  assert.equal(await page.locator('#document-outline').isVisible(),true);
  assert.equal(await page.locator('#btn-toggle-outline').getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#document-outline').getAttribute('aria-label'),'文档大纲');
  assert.equal(await page.locator('#document-outline .app-outline__title').textContent(), '文档大纲');
  assert.equal(await page.locator('#btn-close-outline').getAttribute('aria-label'),'隐藏文档大纲');
  await page.locator('#view-seg [data-view=split]').click();
  assert.equal(await page.locator('#document-outline').isVisible(),true,'split view keeps the outline state');
  assert.equal(await page.locator('#btn-toggle-outline').getAttribute('aria-expanded'),'true');
  const geometry=await page.evaluate(()=>Object.fromEntries(['source-editor','split-resizer','document-outline','preview-wrap'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}];})));
  assert.ok(geometry['source-editor'].right<=geometry['split-resizer'].left+1,'source remains left of the split divider');
  assert.ok(geometry['split-resizer'].right<=geometry['document-outline'].left+1,'outline belongs to the preview pane');
  assert.ok(geometry['document-outline'].right<=geometry['preview-wrap'].left+1,'wide preview places outline beside its paper');
  assert.ok(geometry['preview-wrap'].width>250,'outline leaves a readable preview');
  await page.locator('#document-outline .app-outline__item').first().click();
  assert.deepEqual(await page.locator('#source-editor').evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,'# Evidence'.length],'outline navigates to the corresponding Markdown heading');
  await page.locator('#view-seg [data-view=source]').click();
  assert.equal(await page.locator('#document-outline').isVisible(),false,'source view never overlays the editor');
  await page.locator('#view-seg [data-view=split]').click();
  assert.equal(await page.locator('#document-outline').isVisible(),true,'returning to split restores outline state');
  await page.setViewportSize({width:390,height:960});
  const narrowGeometry=await page.evaluate(()=>{
    const source=document.querySelector('#source-editor').getBoundingClientRect(),pane=document.querySelector('.app-preview-pane').getBoundingClientRect(),outline=document.querySelector('#document-outline').getBoundingClientRect(),mask=document.querySelector('.app-document-outline-mask').getBoundingClientRect();
    const center=document.elementFromPoint(source.left+source.width/2,source.top+Math.min(source.height/2,80));
    return {sourceRight:source.right,paneLeft:pane.left,paneRight:pane.right,outlineLeft:outline.left,outlineRight:outline.right,maskLeft:mask.left,maskRight:mask.right,sourceHit:center?.id};
  });
  assert.ok(narrowGeometry.outlineLeft>=narrowGeometry.paneLeft-1,'narrow outline stays within preview');
  assert.ok(narrowGeometry.maskLeft>=narrowGeometry.paneLeft-1&&narrowGeometry.maskRight<=narrowGeometry.paneRight+1,'outline backdrop only covers preview');
  assert.equal(narrowGeometry.sourceHit,'source-editor','narrow outline leaves source editing reachable');
  const outlineItem=page.locator('#document-outline .app-outline__item').first();
  assert.ok(await outlineItem.count(),'outline contains a heading navigation item');
  const targetId=await page.locator('#preview-editor h1, #preview-editor h2, #preview-editor h3').first().getAttribute('id');
  await outlineItem.click();
  assert.equal(await page.locator('#document-outline').isVisible(),false,'narrow title navigation closes the overlay');
  assert.equal(await page.locator('#btn-toggle-outline').getAttribute('aria-expanded'),'false');
  assert.ok(targetId,'preview heading retains a navigation id');
  await page.locator('#btn-toggle-outline').click();
  const outlineMask=page.locator('.app-document-outline-mask');
  assert.equal(await outlineMask.isVisible(),true);
  const maskBounds=await outlineMask.boundingBox(),outlineBounds=await page.locator('#document-outline').boundingBox();
  await page.mouse.click(maskBounds.x+maskBounds.width-3,maskBounds.y+Math.min(maskBounds.height/2,80));
  assert.equal(await page.locator('#document-outline').isVisible(),false,'preview backdrop closes narrow outline');
  await page.setViewportSize({width:1440,height:960});
  await page.locator('#view-seg [data-view=preview]').click();
  await page.locator('#btn-toggle-outline').click();
  await page.locator('#btn-close-outline').click();
  assert.equal(await page.locator('#document-outline').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'btn-toggle-outline','outline close returns focus to its toggle');
  await page.locator('#view-seg [data-view=source]').click();
  const word=original.indexOf('Evidence');
  await page.locator('#source-editor').evaluate((el,word)=>{el.focus();el.setSelectionRange(word,word+8);},word);
  await page.locator('#fmtbar [data-fmt=bold]').click();
  assert.match(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),/\*\*Evidence\*\*/);
  await page.locator('#btn-undo').click();
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),original);
  await page.locator('#btn-redo').click();
  assert.match(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),/\*\*Evidence\*\*/);
  await page.locator('#btn-undo').click();
  await page.locator('#source-editor').evaluate(el=>{el.setSelectionRange(0,0);el.blur();});
  await page.locator('#btn-find-replace').click();
  await page.locator('#content-find-input').fill('Evidence');
  assert.notEqual(await page.locator('#content-find-count').textContent(),'0/0');
  await page.locator('#btn-content-find-close').click();
  await page.locator('#btn-save-more').click();
  assert.equal(await page.locator('#save-menu').isVisible(),true);
  for(const command of ['save','save-as','move','open-location']) assert.equal(await page.locator(`#save-menu [data-file-command="${command}"]`).isVisible(),true);
  await page.keyboard.press('Escape');
  await page.locator('#btn-export').click();
  for(const id of ['btn-md','btn-pdf','btn-img']) assert.equal(await page.locator('#'+id).isVisible(),true);
  const download=page.waitForEvent('download');await page.locator('#btn-md').click();await download;
  assert.equal(await page.evaluate(()=>window.__MD_EDITOR_LAST_MD__.content),original);
  const initialTheme=await page.locator('html').getAttribute('data-theme');
  await page.locator('#btn-theme').click();
  assert.notEqual(await page.locator('html').getAttribute('data-theme'),initialTheme);
  await page.locator('#btn-theme').click();
  await page.locator('#btn-comments').click();
  for(const name of ['comments','reading','works']) {
    await page.locator(`[data-collab-panel=${name}]`).click();
    assert.equal(await page.locator(`[data-collab-panel=${name}]`).getAttribute('aria-selected'),'true');
    assert.equal(await page.locator(`[data-collab-content=${name}]`).isVisible(),true);
  }
  assert.equal(await page.locator('#btn-close-drawer svg').count(),1,'review close uses the shared X icon');
  const reviewDraft='菜单和关闭操作应保留这条未发送的作品问题。';
  await page.locator('#reading-question').fill(reviewDraft);
  for(const theme of ['light','dark']) for(const width of [1440,1024,760,390]) {
    const label=`review ${theme} ${width}px`;
    await page.setViewportSize({width,height:960});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    assert.equal(await page.locator('.app-drawer__header').evaluate(el=>el.getBoundingClientRect().height),54,`${label}: fixed header height`);
    for(const tab of ['comments','reading','works']) {
      await page.locator(`[data-collab-panel=${tab}]`).click();
      await openAppMenu(`${label} ${tab}`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#app-menu').isVisible(),false);
      assert.equal(await page.locator('#collab-drawer').getAttribute('aria-hidden'),'false',`${label}: Escape closes only the menu`);
    }
    assert.equal(await page.locator('#reading-question').inputValue(),reviewDraft);
    await exerciseAppMenu(label,`review-menu-${theme}-${width}.png`);
    assert.equal(await page.locator('#collab-drawer').getAttribute('aria-hidden'),'false',`${label}: dialogs preserve the review panel`);
    await page.locator('#btn-close-drawer').click();
    await assertReviewClosed(`${label}: X`);
    await page.locator('#btn-comments').click();await waitReview(true);
    await page.locator('[data-collab-panel=works]').click();
    assert.equal(await page.locator('#reading-question').inputValue(),reviewDraft);
    await page.locator('#reading-question').focus();await page.keyboard.press('Escape');
    await assertReviewClosed(`${label}: Escape`);
    await page.locator('#btn-comments').click();await waitReview(true);
    await page.locator('[data-collab-panel=works]').click();
    assert.equal(await page.locator('#reading-question').inputValue(),reviewDraft);
    if(width<1180) {
      await page.locator('#drawer-mask').click({position:{x:4,y:8}});
      await assertReviewClosed(`${label}: backdrop`);
      await page.locator('#btn-comments').click();await waitReview(true);
      await page.locator('[data-collab-panel=works]').click();
      assert.equal(await page.locator('#reading-question').inputValue(),reviewDraft);
    }
  }
  await page.locator('#btn-close-drawer').click();await assertReviewClosed('review final close');
  await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await assertGlobalModelEntry('Markdown editor');
  console.log('PASS built app: light/dark 1440/1024/760/390 review layers, every global menu action, shared 54px header, X/Escape/backdrop, focus and draft retention');
  await page.locator('#view-seg [data-view=split]').click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(output,'markdown-default-toolbar-1440.png')});
  // Reading remains an explicit, protected option rather than the default.
  await page.locator('#document-return-reading').click();
  assert.equal(await page.locator('#document-reading-toolbar').isVisible(),true);
  assert.equal(await page.locator('#fmtbar').isVisible(),false);
  assert.equal(await page.locator('#source-editor').evaluate(el=>el.readOnly),true);
  await assertGlobalModelEntry('Markdown reading');
  await page.locator('#source-editor').evaluate(el=>{el.value='bad change';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));});
  await page.locator('#preview-editor input[type=checkbox]').evaluate(el=>el.click());
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),original);
  await page.locator('#document-edit-toggle').click();
  assert.equal(await page.locator('#document-reading-toolbar').isVisible(),false);
  assert.equal(await page.locator('#fmtbar').isVisible(),true);
  await page.evaluate(()=>__MD_EDITOR_TEST__.setCurrentMarkdown(__MD_EDITOR_TEST__.getCurrentMarkdown()+'\n\nMy new thought.'));
  const openedAt=await page.evaluate(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.id===__MD_EDITOR_TEST__.getState().currentDocId).lastOpenedAt);
  await page.locator('#btn-save').click();
  await page.waitForFunction(()=>window.__MD_EDITOR_LAST_SAVE__);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.id===__MD_EDITOR_TEST__.getState().currentDocId).lastOpenedAt),openedAt);
  await page.locator('#document-return-reading').click();
  await page.evaluate(id=>__MD_EDITOR_TEST__.switchDoc(id),ids['摘录.txt']);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().documentMode),'editing');
  assert.equal(await page.locator('#fmtbar').isVisible(),true);
  assert.equal(await page.locator('#fmtbar [data-fmt=bold]').isDisabled(),true,'TXT keeps plain-text format restrictions');
  await page.evaluate(id=>__MD_EDITOR_TEST__.switchDoc(id),ids['资料.epub']);
  await assertGlobalModelEntry('EPUB reader');
  await page.evaluate(id=>__MD_EDITOR_TEST__.switchDoc(id,{mode:'editing'}),ids['阅读笔记.md']);
  await page.evaluate(()=>__MD_EDITOR_TEST__.showHome());
  const recent=await page.locator('.app-home-document-open').evaluateAll(nodes=>nodes.map(n=>n.dataset.homeOpen));assert.equal(recent[0],ids['阅读笔记.md']);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(output,'home-light-1440.png')});
  console.log('PASS built app: cold home, full default text toolbar/actions and legacy review, explicit reading protection, recent open ordering and save');

  await page.locator('[data-home-prompt]').fill('如何组织阅读笔记？');await page.locator('[data-home-action=send]').click();
  await page.waitForFunction(()=>__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.at(-1)?.turns.at(-1)?.status==='complete');
  assert.equal(requests.length,1);assert.ok(!JSON.stringify(requests[0]).includes('Keep the original task'));
  assert.equal(await page.locator('#doc-list').isVisible(),false,'chat replaces files with conversation history');
  assert.equal(await page.locator('.app-sidebar__header').isVisible(),false,'file actions are hidden in chat');
  assert.equal(await page.locator('.app-conversation-sidebar').isVisible(),true);
  assert.equal(await page.locator('.app-conversation-item[aria-current="true"]').innerText(),'如何组织阅读笔记？');
  assert.equal(await page.locator('[data-chat-history]').count(),0,'history is only shown in the sidebar');
  const originalChatId=await page.evaluate(()=>__MD_EDITOR_TEST__.getState().homeWorkspace.activeConversationId);
  await page.locator('[data-chat-input]').fill('这个会话尚未发送的草稿');
  await page.locator('.app-conversation-new').click();
  assert.equal(await page.locator('.app-home-chat').isVisible(),true,'new conversation stays in chat');
  assert.equal(await page.locator('[data-chat-input]').inputValue(),'');
  assert.equal(await page.locator('.app-home-message').count(),0);
  await page.locator(`button.app-conversation-item[data-conversation-id="${originalChatId}"]`).click();
  assert.equal(await page.locator('[data-chat-input]').inputValue(),'这个会话尚未发送的草稿');
  for(const width of [760,390]) {
    await page.setViewportSize({width,height:844});
    const topbarGeometry=await page.evaluate(()=>{
      const box=selector=>{const rect=document.querySelector(selector).getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width};};
      return {brand:box('.app-topbar__brand'),identity:box('.app-topbar__identity'),tabs:box('.app-document-tabs-bar'),documentCount:document.querySelectorAll('.app-document-tab[data-doc-id]').length};
    });
    assert.ok(topbarGeometry.documentCount>=4,'narrow navigation is tested with multiple document tabs');
    assert.ok(topbarGeometry.brand.width>0&&topbarGeometry.tabs.width>0,`${width}px brand and tab track remain visible`);
    assert.ok(topbarGeometry.brand.right<=topbarGeometry.tabs.left+.5,`${width}px brand does not overlap the tab track`);
    assert.ok(topbarGeometry.identity.right<=topbarGeometry.tabs.left+.5,`${width}px brand container reserves its own width`);
    const toggle=page.locator('[data-home-action="toggle-conversations"]');
    assert.equal(await toggle.isVisible(),true,'narrow chat has an accessible history toggle');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    await assertHitTarget(page.locator('.app-conversation-new'),'narrow chat new conversation');
    await page.locator('.app-conversation-sidebar__close').click();
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await toggle.evaluate(node=>node===document.activeElement),true,'closing history restores toggle focus');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(output,`chat-clean-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:960});
  await page.locator('[data-home-action=export]').click();await page.waitForFunction(()=>__MD_EDITOR_TEST__.getState().workspaceView==='document');
  assert.match(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),/可以从阅读问题/);
  const exportedDocId=await page.evaluate(()=>__MD_EDITOR_TEST__.getState().currentDocId);
  const exportedMarkdown=await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown());
  await page.locator('.app-workspace-chat-tab').click();
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().workspaceView),'chat');
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().homeWorkspace.activeConversationId),originalChatId,'returning from a document restores the active conversation');
  assert.equal(await page.locator('[data-chat-input]').inputValue(),'这个会话尚未发送的草稿');
  assert.match(await page.locator('[data-chat-messages]').innerText(),/可以从阅读问题/);
  for(const key of ['Enter','Space']) {
    await page.locator('.app-workspace-home-tab').press(key);
    await page.waitForFunction(()=>document.activeElement?.matches('.app-workspace-home-tab')&&__MD_EDITOR_TEST__.getState().workspaceView==='home');
    assert.equal(await page.locator('.app-workspace-home-tab').getAttribute('aria-selected'),'true');
    await page.locator('.app-workspace-chat-tab').press(key);
    await page.waitForFunction(()=>document.activeElement?.matches('.app-workspace-chat-tab')&&__MD_EDITOR_TEST__.getState().workspaceView==='chat');
    assert.equal(await page.locator('.app-workspace-chat-tab').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('[data-chat-input]').inputValue(),'这个会话尚未发送的草稿',`${key} workspace navigation preserves the active draft`);
  }
  await page.locator(`.app-document-tab[data-doc-id="${exportedDocId}"]`).click();
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),exportedMarkdown,'chat navigation does not change the document');
  await openAppMenu('document history');
  await page.locator('[data-app-command="conversation-history"]').click();
  const historyDialog=page.locator('[data-home-history-dialog]');
  await historyDialog.waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().workspaceView),'document','history overlays the existing document workspace');
  await historyDialog.locator(`[data-history-open="${originalChatId}"]`).click();
  assert.match(await historyDialog.innerText(),/可以从阅读问题/);
  assert.equal(await historyDialog.locator('textarea').count(),0,'history is read-only');
  await page.keyboard.press('Escape');
  assert.equal(await historyDialog.isVisible(),false);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().workspaceView),'document');
  await page.waitForFunction(()=>document.activeElement?.id==='btn-app-menu');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'btn-app-menu','history Escape restores its global menu trigger');
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),exportedMarkdown);
  await page.locator('.app-workspace-chat-tab').click();
  const otherChatId=await page.evaluate(original=>__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.find(chat=>chat.id!==original&&!chat.deletedAt).id,originalChatId);
  await page.locator(`.app-conversation-item[data-conversation-id="${otherChatId}"]`).click({button:'right'});
  await page.locator('#conversation-action-menu [data-conversation-action="delete"]').click();
  await page.waitForFunction(id=>!!__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.find(chat=>chat.id===id)?.deletedAt,otherChatId);
  assert.equal(await page.locator(`button.app-conversation-item[data-conversation-id="${otherChatId}"]`).count(),0);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().homeWorkspace.activeConversationId),originalChatId,'deleting another row preserves the active chat');
  await page.locator(`button.app-conversation-item[data-conversation-id="${originalChatId}"]`).click({button:'right'});
  await page.locator('#conversation-action-menu [data-conversation-action="delete"]').click();
  await page.waitForFunction(id=>!!__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.find(chat=>chat.id===id)?.deletedAt,originalChatId);
  assert.equal(await page.locator('button.app-conversation-item').count(),0,'deleting the last visible chat leaves an empty conversation list');
  assert.equal(await page.locator('[data-chat-input]').isVisible(),true);
  await openAppMenu('deleted conversation history');
  await page.locator('[data-app-command="conversation-history"]').click();
  await historyDialog.locator('[data-history-filter="deleted"]').click();
  for(const theme of ['light','dark']) for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.screenshot({path:path.join(conversationOutput,`history-deleted-${theme}-${width}.png`)});
    await historyDialog.locator(`[data-history-open="${originalChatId}"]`).click();
    assert.match(await historyDialog.innerText(),/这个会话尚未发送的草稿/);
    await assertHitTarget(historyDialog.getByRole('button',{name:'关闭历史对话记录',exact:true}),`history ${theme} ${width}px X`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(conversationOutput,`history-detail-${theme}-${width}.png`)});
    await historyDialog.locator('[data-history-back]').click();
  }
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await historyDialog.locator(`[data-history-open="${originalChatId}"]`).click();
  assert.match(await historyDialog.innerText(),/可以从阅读问题/);
  assert.equal(await historyDialog.locator('textarea').count(),0);
  await historyDialog.locator(`[data-history-restore="${originalChatId}"]`).click();
  await page.waitForFunction(id=>!__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.find(chat=>chat.id===id)?.deletedAt,originalChatId);
  await historyDialog.getByRole('button',{name:'关闭历史对话记录',exact:true}).click();
  assert.equal(await historyDialog.isVisible(),false);
  await page.locator(`button.app-conversation-item[data-conversation-id="${originalChatId}"]`).click();
  assert.equal(await page.locator('[data-chat-input]').inputValue(),'这个会话尚未发送的草稿','history restore retains the unsent draft');
  assert.match(await page.locator('[data-chat-messages]').innerText(),/可以从阅读问题/);
  console.log('PASS built app: persistent AI tab returns from documents, row menu/right-click soft deletion and read-only history restore preserve drafts');
  await page.evaluate(()=>__MD_EDITOR_TEST__.showHome());
  assert.equal(await page.locator('#doc-list').isVisible(),true,'home restores the file list');
  assert.equal(await page.locator('.app-conversation-sidebar').isVisible(),false);
  await page.locator('[data-home-action=sources]').first().click();
  await page.locator(`[data-home-source-dialog] input[value="${ids['研究.pdf']}"]`).check();
  await page.locator('[data-home-action=confirm-sources]').click();
  await page.locator('[data-home-prompt]').fill('证据有哪些条件？');await page.locator('[data-home-action=send]').click();
  await page.waitForFunction(()=>__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.at(-1)?.turns.at(-1)?.status==='complete');
  const citation=await page.evaluate(()=>__MD_EDITOR_TEST__.getState().homeWorkspace.conversations.at(-1).turns.at(-1).evidence[0]);
  assert.ok(citation.rects?.length,'PDF home citation keeps local coordinates');
  await page.locator('.app-home-answer-sources > summary').first().click();
  await page.locator('.app-home-source-evidence summary').first().click();await page.locator('.app-home-source-evidence button').first().click();
  await page.waitForSelector('.guanyi-study-toggle');await page.waitForFunction(()=>document.querySelector('iframe.guanyi-pdf-frame')?.contentDocument.querySelector('.guanyi-evidence-layer'));
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().currentDocId),ids['研究.pdf']);
  console.log('PASS built app: default free chat, sourced real PDF extraction, verified citation location, Markdown creation');

  await page.locator('.guanyi-study-toggle').click();const panel=page.locator('.guanyi-study-panel');
  await openAppMenu('PDF study history');
  await page.locator('[data-app-command="conversation-history"]').click();
  await historyDialog.waitFor({state:'visible'});
  await page.keyboard.press('Escape');
  assert.equal(await historyDialog.isVisible(),false);
  assert.equal(await panel.isVisible(),true,'history Escape does not also close the PDF study panel underneath');
  await page.waitForFunction(()=>document.activeElement?.id==='btn-app-menu');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'btn-app-menu');
  const studyDraft='关闭和切换全局菜单后，保留尚未发送的研读问题。';
  for(const theme of ['light','dark']) for(const width of [1440,1024,760,390]) {
    const label=`study ${theme} ${width}px`;
    await page.setViewportSize({width,height:960});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    assert.equal(await page.locator('.guanyi-study-heading').evaluate(el=>el.getBoundingClientRect().height),54,`${label}: same header height as review`);
    assert.equal(await page.locator('.guanyi-study-close svg').count(),1,`${label}: X icon`);
    assert.equal(await page.locator('.guanyi-study-close').getAttribute('title'),'关闭智能研读');
    assert.equal(await page.locator('.guanyi-study-close').getAttribute('aria-label'),'关闭智能研读');
    assert.equal(await page.locator('.guanyi-study-close').innerText(),'');
    assert.equal(await page.locator('.guanyi-study-toggle').getAttribute('aria-expanded'),'true');
    await panel.getByRole('tab',{name:'文档对话',exact:true}).click();
    await panel.getByRole('textbox',{name:'研读问题',exact:true}).fill(studyDraft);
    await assertStudyComposer(panel,label);
    await openAppMenu(label);
    await page.screenshot({path:path.join(output,`study-menu-${theme}-${width}.png`)});
    await page.keyboard.press('Escape');
    assert.equal(await panel.isVisible(),true,`${label}: Escape closes menu without closing study`);
    await page.locator('.guanyi-study-close').click();await assertStudyClosed(`${label}: X`);
    await page.locator('.guanyi-study-toggle').click();
    assert.equal(await panel.getByRole('textbox',{name:'研读问题',exact:true}).inputValue(),studyDraft);
    await panel.getByRole('textbox',{name:'研读问题',exact:true}).focus();await page.keyboard.press('Escape');
    await assertStudyClosed(`${label}: Escape inside panel`);
    await page.locator('.guanyi-study-toggle').click();
    assert.equal(await panel.getByRole('textbox',{name:'研读问题',exact:true}).inputValue(),studyDraft);
    await page.locator('.guanyi-study-toggle').focus();await page.keyboard.press('Escape');
    await assertStudyClosed(`${label}: Escape on toggle`);
    await page.locator('.guanyi-study-toggle').click();
    if(width<1180) {
      await page.locator('.guanyi-study-mask').click({position:{x:4,y:8}});
      await assertStudyClosed(`${label}: backdrop`);
      await page.locator('.guanyi-study-toggle').click();
      assert.equal(await panel.getByRole('textbox',{name:'研读问题',exact:true}).inputValue(),studyDraft);
    }
  }
  await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await assertGlobalModelEntry('PDF study');
  await openAppMenu('study modal Escape priority');
  await page.locator('#app-menu [data-app-command=model-settings]').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#model-modal').isVisible(),false,'Escape closes model configuration');
  assert.equal(await panel.isVisible(),true,'Escape in configuration keeps study panel open');
  await panel.getByRole('tab',{name:'导读',exact:true}).click();
  console.log('PASS built app: PDF icon semantics, light/dark wide/narrow shared header, menu layer, X/Escape/backdrop focus, draft retention and modal Escape priority');
  await panel.getByRole('button',{name:'研读全文',exact:true}).click();
  await page.waitForFunction(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerStudy?.preparations[0]?.status==='ready');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(output,'study-light-1440.png')});
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerStudy.cards.length),0);
  await panel.getByRole('tab',{name:'学习卡 0',exact:true}).click();await panel.getByRole('button',{name:'预览与编辑',exact:true}).click();
  await page.locator('.guanyi-study-dialog').getByRole('button',{name:'确认保留',exact:true}).click();
  await panel.getByRole('button',{name:'开始自测',exact:true}).click();assert.equal(await panel.getByRole('button',{name:'显示答案',exact:true}).count(),1);
  await panel.getByRole('button',{name:'显示答案',exact:true}).click();await panel.getByRole('button',{name:'基本理解',exact:true}).click();
  await panel.getByRole('tab',{name:'文档对话',exact:true}).click();await panel.getByRole('textbox',{name:'研读问题',exact:true}).fill('结论为什么需要证据？');await assertStudyComposer(panel,'PDF ready question');await panel.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForFunction(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerStudy.messages.at(-1)?.status==='ready');
  const evidence = panel.locator('.guanyi-study-chat').last().locator('.guanyi-study-source-preview');
  assert.equal(await evidence.evaluate(node => node.open), false, 'answer evidence starts collapsed');
  await evidence.locator('summary').click();
  await evidence.locator('.guanyi-study-source-locate').first().click();
  await page.locator('.guanyi-study-return').click();
  await page.locator('.guanyi-study-return').waitFor({state:'hidden'});
  await panel.getByRole('tab',{name:'批注',exact:true}).click();
  assert.equal(await panel.getByRole('textbox',{name:'研读笔记',exact:true}).count(),0,'notes starts with the card list');
  await panel.getByRole('button',{name:'新建笔记',exact:true}).click();
  assert.equal(await panel.getByRole('button',{name:'保存研读笔记',exact:true}).isDisabled(),true,'an empty note cannot be saved');
  const noteText='我要进一步核对证据的适用条件。';
  await panel.getByRole('textbox',{name:'研读笔记',exact:true}).fill(noteText);await panel.getByRole('button',{name:'保存研读笔记',exact:true}).click();
  await page.waitForFunction(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerStudy.notes.length===1);
  await assertStudyNoteCard(panel,noteText,'saved PDF note');
  await panel.getByRole('tab',{name:'文档对话',exact:true}).click();await panel.getByRole('tab',{name:'批注',exact:true}).click();
  await assertStudyNoteCard(panel,noteText,'note after tab roundtrip');
  await page.screenshot({path:path.join(output,'study-note-cards-light-1440.png')});
  await panel.getByRole('button',{name:'整理为 Markdown',exact:true}).click();await page.locator('.guanyi-study-dialog').getByRole('button',{name:'创建 Markdown 笔记',exact:true}).click();
  await page.waitForFunction(()=>__MD_EDITOR_TEST__.getState().workspaceView==='document'&&__MD_EDITOR_TEST__.getState().docs.find(d=>d.id===__MD_EDITOR_TEST__.getState().currentDocId)?.readerFormat!=='pdf');
  assert.match(await page.evaluate(()=>__MD_EDITOR_TEST__.getCurrentMarkdown()),/我要进一步核对/);
  await page.evaluate(id=>__MD_EDITOR_TEST__.switchDoc(id),ids['研究.pdf']);await page.waitForSelector('.guanyi-study-toggle');
  const studyRecord=await page.evaluate(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerStudy);assert.equal(studyRecord.cards.length,1);assert.equal(studyRecord.cards[0].reviews.length,1);
  await page.evaluate(()=>__MD_EDITOR_TEST__.showHome());await page.reload();await page.waitForFunction(()=>window.__MD_EDITOR_TEST__);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().workspaceView),'home');
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerStudy.cards.length),1);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().docs.find(d=>d.readerFormat==='pdf').readerSourceHash),sourceHash);
  console.log('PASS built app: real PDF guide, candidate confirmation, self-test, question, origin/return, note, Markdown and reload');
  for(const width of [1440,1024,760,390]){
    await page.setViewportSize({width,height:900});await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`home ${width}px overflow`);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:path.join(output,`home-dark-${width}.png`)});
    await page.evaluate(id=>__MD_EDITOR_TEST__.switchDoc(id),ids['研究.pdf']);await page.waitForSelector('.guanyi-study-toggle');await page.locator('.guanyi-study-toggle').click();
    await panel.getByRole('tab',{name:'批注',exact:true}).click();await assertStudyNoteCard(panel,noteText,`reloaded note ${width}px`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`study ${width}px overflow`);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:path.join(output,`study-dark-${width}.png`)});
    await page.evaluate(()=>__MD_EDITOR_TEST__.showHome());
  }
  // Home must remain a separate destination after every document tab closes.
  await page.setViewportSize({width:1440,height:960});
  for(const id of await page.evaluate(()=>[...__MD_EDITOR_TEST__.getState().openDocIds])) {
    await page.locator(`.app-document-tab[data-doc-id="${id}"] .app-document-tab__close`).click();
    await page.waitForFunction(id=>!__MD_EDITOR_TEST__.getState().openDocIds.includes(id),id);
  }
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().workspaceView),'home');
  assert.equal(await page.locator('.app-workspace-home-tab').count(),1);
  await page.reload();await page.waitForFunction(()=>window.__MD_EDITOR_TEST__);
  assert.equal(await page.evaluate(()=>__MD_EDITOR_TEST__.getState().openDocIds.length),0);
  assert.deepEqual(errors,[]);assert.ok(requests.every(r=>!JSON.stringify(r).includes(root)));
  console.log('PASS built app: 1440/1024/760/390 dark layouts, last-tab closure/reload, no page errors or local paths in model requests');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);await browser?.close();server.close();});
