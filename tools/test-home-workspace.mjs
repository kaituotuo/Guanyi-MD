import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [productCss, css, js, marked] = await Promise.all(['css/app.css', 'css/home-workspace.css', 'js/home-workspace.js', 'vendor/marked.min.js'].map(path => readFile(resolve(root, path), 'utf8')));
const browser = await chromium.launch({ headless: true, ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const screenshotDir = process.env.GUANYI_HOME_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const screenshot = name => screenshotDir ? page.screenshot({ path: resolve(screenshotDir, name) }) : Promise.resolve();
let passed = 0;
const pass = label => { passed += 1; console.log('PASS ' + label); };
try {
  await page.setContent('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="home" style="width:100%"></main></body></html>');
  await page.addStyleTag({ content: productCss + '\n' + css + '\nhtml,body{height:100%;margin:0}body{display:flex}' });
  await page.addScriptTag({ content: marked });
  await page.addScriptTag({ content: js });
  await page.evaluate(() => {
    window.fixture = {
      docs: [
        { id: 'note', name: '阅读笔记', content: '内容', lastOpenedAt: 1000, savedAt: 9000000 },
        { id: 'paper', name: '研究文档', readerFormat: 'pdf', lastOpenedAt: 3000, directoryId: 'research', readerPosition: { page: 2 } },
        { id: 'text', name: '会议摘录.txt', localFileName: '会议摘录.txt', lastOpenedAt: 2000 },
        { id: 'unsafe', name: '<img src=x onerror=alert(1)>', lastOpenedAt: 1500 },
        { id: 'unopened', name: '从未打开', lastOpenedAt: 0 }
      ],
      calls: [], configured: true, requestMode: 'normal', answer: '这是自由对话回答。', saved: 0, configuredCount: 0
    };
    window.homeState = {};
    window.mount = () => window.home = window.GuanyiHomeWorkspace.create({
      container: document.getElementById('home'), state: window.homeState,
      getDocuments: () => fixture.docs, getDirectories: () => [{ id: 'research', name: '研究资料' }],
      documentType: doc => doc.readerFormat || (doc.localFileName?.endsWith('.txt') ? 'txt' : 'md'),
      openDocument: (id, options) => { fixture.calls.push({ type: 'open', id, options }); },
      createMarkdown: value => { fixture.calls.push({ type: 'markdown', value }); },
      openFiles: () => { fixture.calls.push({ type: 'files' }); },
      modelReady: () => fixture.configured, configureModel: () => { fixture.configuredCount += 1; },
      persist: () => {
        fixture.saved += 1;
        if (fixture.persistMode === 'reject') return Promise.reject(new Error('fixture storage unavailable'));
        if (fixture.persistMode === 'false') return Promise.resolve(false);
        fixture.lastSavedState = JSON.parse(JSON.stringify(homeState));
        return Promise.resolve(true);
      },
      onView: view => { fixture.view = view; },
      onConversationsChanged: () => { fixture.conversationUpdates = (fixture.conversationUpdates || 0) + 1; },
      toggleFolders: () => { fixture.calls.push({ type: 'folders' }); },
      notify: message => { fixture.calls.push({ type: 'notice', message }); },
      readSources: (ids, options) => {
        fixture.calls.push({ type: 'read', ids, query: options.query });
        return Promise.resolve({ evidence: [{ id: 'E1', originalId: 'pdf:source-v1:p2:b0', docId: 'paper', title: '研究文档', text: '这是一段可以核对的原文。', page: 2, sourceHash: 'source-v1', rects: [[10, 20, 180, 40], [1, 2, 3]], blockIds: ['block-1', 'block-1', null], itemStart: 4, itemEnd: 9, precise: true, extractionStatus: 'native', section: '方法', sectionIndex: 0, locationType: 'page', start: 0, end: 16, ignoredMetadata: 'discard this' }], scopeLabel: '研究文档', coverage: '已读取第 2 页 · 1 个原文片段' });
      },
      openEvidence: evidence => { fixture.calls.push({ type: 'evidence', evidence }); return fixture.evidenceOpenResult; },
      request: (messages, { signal }) => {
        fixture.calls.push({ type: 'request', messages });
        if (fixture.requestMode === 'delayed') {
          signal.addEventListener('abort', () => { fixture.aborted = true; });
          return new Promise(resolve => { fixture.resolveRequest = resolve; });
        }
        return Promise.resolve(fixture.answer);
      }
    });
    mount(); home.show();
  });
  assert.deepEqual(await page.locator('.app-home-recent-row .app-home-document-open').evaluateAll(nodes => nodes.map(node => node.dataset.homeOpen)), ['paper', 'text', 'unsafe', 'note']);
  assert.equal(await page.locator('#home img').count(), 0);
  assert.match(await page.locator('[data-home-recent-list]').textContent(), /<img src=x/);
  assert.equal(await page.locator('.app-home-section-heading').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('.app-home-section-heading').evaluate(node => getComputedStyle(node).borderBottomWidth), '0px');
  await screenshot('home-desktop.png');
  await page.locator('[data-home-search]').fill('研究');
  assert.equal(await page.locator('.app-home-recent-row').count(), 1);
  await page.locator('[data-home-search]').press('Enter');
  assert.equal(await page.evaluate(() => fixture.calls.at(-1).id), 'paper');
  await page.locator('[data-home-search]').press('Escape');
  await page.locator('[data-home-filter="txt"]').click();
  assert.equal(await page.locator('.app-home-recent-row').count(), 1);
  await page.locator('[data-home-filter="all"]').click();
  await page.locator('[data-home-folder]').selectOption('研究资料');
  assert.equal(await page.locator('.app-home-recent-row').count(), 1);
  await page.locator('[data-home-folder]').selectOption('all');
  pass('Recent documents use open time, filter safely, and keep search beside the recent list');

  await page.evaluate(() => {
    fixture.answer = JSON.stringify({ answer: '原文说明了可核对的信息。[E1]', citations: ['E1'], insufficient: false });
    home.openChat({ prompt: '这份文档讲了什么？', sourceIds: ['paper'] });
  });
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.type === 'request').length), 0);
  assert.equal(await page.locator('[data-chat-input]').inputValue(), '这份文档讲了什么？');
  await page.locator('[data-chat-send]').click();
  await page.waitForFunction(() => homeState.conversations.at(-1).turns.at(-1).status === 'complete');
  assert.deepEqual(await page.evaluate(() => fixture.calls.find(call => call.type === 'read').ids), ['paper']);
  assert.equal(await page.evaluate(() => fixture.calls.find(call => call.type === 'read').query), '这份文档讲了什么？');
  assert.equal(await page.locator('.app-home-answer-sources').getAttribute('open'), null, 'evidence starts collapsed');
  assert.equal(await page.locator('.app-home-source-evidence summary').isVisible(), false, 'evidence does not interrupt the answer');
  await page.locator('.app-home-answer-sources > summary').click();
  await page.locator('.app-home-source-evidence summary').click();
  await page.locator('.app-home-source-evidence button').click();
  assert.equal(await page.evaluate(() => fixture.calls.at(-1).evidence.page), 2);
  const savedEvidence = await page.evaluate(() => fixture.calls.at(-1).evidence);
  assert.equal(savedEvidence.originalId, 'pdf:source-v1:p2:b0');
  assert.deepEqual(savedEvidence.rects, [[10, 20, 180, 40]]);
  assert.deepEqual(savedEvidence.blockIds, ['block-1']);
  assert.equal(savedEvidence.itemStart, 4);
  assert.equal(savedEvidence.itemEnd, 9);
  assert.equal(savedEvidence.section, '方法');
  assert.equal(savedEvidence.sectionIndex, 0);
  assert.equal(savedEvidence.locationType, 'page');
  assert.equal(savedEvidence.precise, true);
  assert.equal(savedEvidence.extractionStatus, 'native');
  assert.equal(savedEvidence.ignoredMetadata, undefined);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(fixture.calls.find(call => call.type === 'request').messages)), /originalId|rects|blockIds|itemStart|locationType|pdf:source-v1:p2:b0/);
  await page.evaluate(() => { home.dispose(); window.homeState = JSON.parse(JSON.stringify(homeState)); mount(); home.show('chat'); });
  await page.locator('.app-home-answer-sources > summary').click();
  await page.locator('.app-home-source-evidence summary').click();
  await page.locator('.app-home-source-evidence button').click();
  assert.deepEqual(await page.evaluate(() => fixture.calls.at(-1).evidence), savedEvidence);
  await page.locator('[data-home-action="export"]').click();
  assert.match(await page.evaluate(() => fixture.calls.at(-1).value.content), /这是一段可以核对的原文。/);
  assert.match(await page.evaluate(() => fixture.calls.at(-1).value.content), /第 2 页/);
  assert.match(await page.evaluate(() => fixture.calls.at(-1).value.content), /AI 辅助对话整理/);
  assert.match(await page.evaluate(() => fixture.calls.at(-1).value.content), /来源版本：source-v1/);
  await screenshot('chat-desktop.png');
  pass('Document chat requires explicit send and preserves local PDF/EPUB locators through storage without sending them to the model');

  await page.evaluate(() => { fixture.evidenceOpenResult = false; home.openHistory(); });
  const evidenceHistory = page.locator('[data-home-history-dialog]');
  const evidenceChatId = await page.evaluate(() => homeState.activeConversationId);
  await evidenceHistory.locator(`[data-history-open="${evidenceChatId}"]`).click();
  await evidenceHistory.locator('.app-home-answer-sources > summary').click();
  await evidenceHistory.locator('.app-home-source-evidence summary').click();
  await evidenceHistory.getByRole('button', { name: '回到原文', exact: true }).click();
  assert.equal(await evidenceHistory.isVisible(), true, 'failed source navigation retains the history detail');
  assert.equal(await page.evaluate(() => fixture.calls.at(-1).evidence.page), 2);
  await page.evaluate(() => { fixture.evidenceOpenResult = true; });
  await evidenceHistory.getByRole('button', { name: '回到原文', exact: true }).click();
  await evidenceHistory.waitFor({ state: 'hidden' });
  assert.equal(await evidenceHistory.isVisible(), false, 'successful source navigation removes the history overlay');
  await page.evaluate(() => { delete fixture.evidenceOpenResult; });
  pass('History source navigation closes its overlay only after the source opens successfully');

  await page.evaluate(() => {
    fixture.answer = JSON.stringify({ answer: '未核对的结果', citations: ['UNKNOWN'], insufficient: false });
    home.openChat({ prompt: '核对引用', sourceIds: ['paper'] });
  });
  await page.locator('[data-chat-send]').click();
  await page.waitForFunction(() => homeState.conversations.at(-1).turns.at(-1).status === 'error');
  assert.equal(await page.locator('[data-chat-input]').inputValue(), '核对引用');
  assert.doesNotMatch(await page.locator('[data-chat-messages]').textContent(), /未核对的结果/);
  await page.evaluate(() => { fixture.answer = JSON.stringify({ answer: '引用已核对', citations: ['E1'], insufficient: false }); });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => homeState.conversations.at(-1).turns.at(-1).status === 'complete');
  assert.equal(await page.evaluate(() => homeState.conversations.at(-1).turns.length), 1);
  pass('Unknown evidence is rejected, input survives, and retry updates the same turn');

  await page.evaluate(() => { fixture.configured = false; home.openChat({ prompt: '保留这个问题', sourceIds: [] }); });
  const requestsBefore = await page.evaluate(() => fixture.calls.filter(call => call.type === 'request').length);
  await page.locator('[data-chat-send]').click();
  await page.waitForFunction(() => homeState.conversations.at(-1).turns.at(-1).status === 'unconfigured');
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.type === 'request').length), requestsBefore);
  assert.equal(await page.locator('[data-chat-input]').inputValue(), '保留这个问题');
  assert.equal(await page.locator('[data-home-action="configure-model"]').count(), 0, 'model configuration has one global menu entry');
  assert.match(await page.locator('[data-chat-status]').textContent(), /顶部“…”菜单.*模型配置/);
  assert.equal(await page.evaluate(() => fixture.configuredCount), 1, 'sending without a model guides to the global menu');
  await page.evaluate(() => { fixture.configured = true; fixture.answer = '配置后的真实请求回答'; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => homeState.conversations.at(-1).turns.at(-1).status === 'complete');
  pass('Missing model configuration keeps the question and makes no model request');

  await page.evaluate(() => { fixture.requestMode = 'delayed'; home.openChat({ prompt: '可以停止的问题', sourceIds: [] }); });
  await page.locator('[data-chat-send]').click();
  await page.waitForFunction(() => typeof fixture.resolveRequest === 'function');
  await page.locator('[data-home-action="stop"]').click();
  await page.waitForFunction(() => !home.hasPending());
  assert.equal(await page.evaluate(() => fixture.aborted), true);
  assert.equal(await page.locator('[data-chat-input]').inputValue(), '可以停止的问题');
  await page.evaluate(() => fixture.resolveRequest('晚到的回答不能覆盖停止状态'));
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => homeState.conversations.at(-1).turns.at(-1).status), 'cancelled');
  assert.doesNotMatch(await page.locator('[data-chat-messages]').textContent(), /晚到的回答/);
  pass('Stop aborts the request, preserves input, and ignores a late response');

  await page.evaluate(() => {
    homeState.conversations.at(-1).turns.at(-1).status = 'generating';
    home.dispose(); mount(); home.show('chat');
  });
  assert.equal(await page.evaluate(() => homeState.conversations.at(-1).turns.at(-1).status), 'interrupted');
  await page.evaluate(() => { fixture.requestMode = 'normal'; home.show('home'); });
  await page.locator('[data-home-prompt]').fill('拼音输入中');
  const imeRequestsBefore = await page.evaluate(() => fixture.calls.filter(call => call.type === 'request').length);
  await page.locator('[data-home-prompt]').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })));
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.type === 'request').length), imeRequestsBefore);
  await page.locator('[data-home-action="sources"]').first().click();
  await page.locator('.app-home-source-option input[value="paper"]').check();
  await page.locator('[data-home-action="confirm-sources"]').click();
  assert.deepEqual(await page.evaluate(() => homeState.sourceIds), ['paper']);
  await page.locator('[data-home-action="study"]').click();
  assert.deepEqual(await page.evaluate(() => fixture.calls.at(-1)), { type: 'open', id: 'paper', options: { study: true } });
  pass('Interrupted work recovers, IME input does not send, and selected sources drive smart reading');

  await page.evaluate(() => {
    fixture.requestMode = 'delayed'; fixture.resolveRequest = null;
    home.openChat({ prompt: '', sourceIds: [] });
  });
  const input = page.locator('[data-chat-input]');
  const emptyInputHeight = await input.evaluate(node => node.getBoundingClientRect().height);
  await input.fill(Array.from({ length: 30 }, (_, index) => '第 ' + index + ' 行草稿').join('\n'));
  assert.ok(await input.evaluate(node => node.getBoundingClientRect().height > 60 && node.getBoundingClientRect().height <= 220), 'multiline composer grows to a bounded height');
  assert.ok(await input.evaluate(node => node.scrollHeight > node.clientHeight), 'long drafts scroll inside the composer');
  await input.fill('回车发送');
  assert.ok(await input.evaluate(node => node.getBoundingClientRect().height) <= emptyInputHeight + 2, 'short drafts restore the compact height');
  const beforeKeyboardSend = await page.evaluate(() => fixture.calls.filter(call => call.type === 'request').length);
  await input.press('Shift+Enter');
  assert.match(await input.inputValue(), /\n/);
  await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.type === 'request').length), beforeKeyboardSend, 'newline and IME confirmation do not send');
  await input.fill('回车发送');
  await input.press('Enter');
  await page.waitForFunction(() => typeof fixture.resolveRequest === 'function');
  assert.equal(await input.inputValue(), '', 'submitted question immediately leaves the composer');
  assert.equal(await page.locator('[data-chat-send]').isVisible(), false, 'send is replaced while generating');
  assert.equal(await page.getByRole('button', { name: '停止生成', exact: true }).isVisible(), true, 'stop remains accessible');
  const pendingChat = await page.evaluate(() => homeState.activeConversationId);
  const conversationCount = await page.evaluate(() => home.getConversations().length);
  assert.equal(await page.evaluate(() => home.startNewConversation()), false, 'new conversation cannot strand an active request');
  assert.equal(await page.evaluate(() => home.selectConversation(homeState.conversations[0].id)), false, 'history cannot switch while generating');
  assert.equal(await page.evaluate(() => home.getConversations().length), conversationCount);
  await input.fill('生成时写下的新草稿');
  await page.locator('[data-home-action="stop"]').click();
  await page.waitForFunction(() => !home.hasPending());
  assert.equal(await input.inputValue(), '生成时写下的新草稿', 'stop preserves the newer draft');
  assert.equal(await page.locator('[data-chat-send]').isVisible(), true);
  await page.evaluate(() => fixture.resolveRequest('停止后的晚到结果'));
  assert.equal(await page.evaluate(() => homeState.conversations.find(chat => chat.id === homeState.activeConversationId).turns.at(-1).status), 'cancelled');
  pass('Compact composer grows and shrinks, Enter sends, Shift+Enter and IME do not, and stop retains new drafts');

  assert.notEqual(await page.evaluate(() => home.startNewConversation()), false);
  const blankChat = await page.evaluate(() => homeState.activeConversationId);
  assert.notEqual(blankChat, pendingChat);
  assert.equal(await page.evaluate(() => home.getView()), 'chat', 'new conversation stays in the chat surface');
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('.app-home-message').count(), 0);
  await input.fill('新的对话草稿');
  assert.notEqual(await page.evaluate(id => home.selectConversation(id), pendingChat), false);
  assert.equal(await input.inputValue(), '生成时写下的新草稿');
  assert.equal(await page.evaluate(() => home.getConversations().filter(chat => chat.active).length), 1);
  assert.notEqual(await page.evaluate(id => home.selectConversation(id), blankChat), false);
  assert.equal(await input.inputValue(), '新的对话草稿');
  await page.evaluate(() => { home.dispose(); window.homeState = JSON.parse(JSON.stringify(homeState)); mount(); home.show('chat'); });
  assert.equal(await input.inputValue(), '新的对话草稿', 'conversation draft survives remount');
  assert.ok(await page.evaluate(() => fixture.conversationUpdates > 0), 'sidebar is notified of conversation changes');
  assert.equal(await page.locator('[data-chat-history]').count(), 0, 'history is not duplicated in the chat header');
  await page.evaluate(() => { home.openChat({ sourceIds: ['paper'] }); home.startNewConversation(); });
  assert.deepEqual(await page.evaluate(() => homeState.conversations.find(chat => chat.id === homeState.activeConversationId).sourceIds), [], 'new chat clears sources even when the old chat had no messages');
  const sourceTrigger = page.locator('.app-home-chat [data-home-action="sources"]');
  await sourceTrigger.click();
  await page.locator('[data-home-source-dialog]').press('Escape');
  assert.equal(await page.locator('[data-home-source-dialog]').isVisible(), false);
  assert.equal(await sourceTrigger.evaluate(node => document.activeElement === node), true, 'Escape restores source button focus');
  pass('New chat stays in chat and history selection preserves each draft through remount');

  const unexpectedAssets = [];
  await page.route('https://chat-render-fixture.invalid/**', route => { unexpectedAssets.push(route.request().url()); return route.abort(); });
  await page.evaluate(() => {
    fixture.requestMode = 'normal';
    fixture.answer = '## 阅读建议\n\n先明确 **问题**，再核对资料。\n\n- 记录结论\n- 查阅原文\n\n```js\nconst text = "<img src=x onerror=alert(1)>";\n```\n\n[正常链接](https://example.com) [危险链接](javascript:alert(1))\n\n![远程图片](https://chat-render-fixture.invalid/image.png)\n\n<img src="https://chat-render-fixture.invalid/raw.png" onerror="window.chatUnsafeExecuted=true">\n<script>window.chatUnsafeExecuted=true</script>';
  });
  await input.fill('检查回答排版');
  await input.press('Enter');
  await page.waitForFunction(() => homeState.conversations.find(chat => chat.id === homeState.activeConversationId).turns.at(-1).status === 'complete');
  const answer = page.locator('.app-home-message:not(.is-user) .app-home-answer-text');
  assert.equal(await answer.locator('h2').textContent(), '阅读建议');
  assert.equal(await answer.locator('strong').textContent(), '问题');
  assert.equal(await answer.locator('li').count(), 2);
  assert.match(await answer.locator('pre code').textContent(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await answer.locator('img, script, iframe').count(), 0, 'answers never insert active model HTML or images');
  assert.equal(await answer.locator('a[href^="javascript:"]').count(), 0, 'unsafe links are not clickable');
  assert.equal(await answer.locator('a[href="https://example.com/"]').count(), 1);
  assert.equal(await page.evaluate(() => window.chatUnsafeExecuted), undefined);
  assert.deepEqual(unexpectedAssets, [], 'rendering does not fetch model-supplied assets');
  const messageStyle = await page.locator('.app-home-message:not(.is-user)').evaluate(node => ({ border: getComputedStyle(node).borderTopWidth, background: getComputedStyle(node).backgroundColor }));
  assert.deepEqual(messageStyle, { border: '0px', background: 'rgba(0, 0, 0, 0)' }, 'assistant answer has no enclosing card');
  pass('Answers render readable Markdown while keeping raw HTML, remote images and unsafe links inert');

  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; home.show('home'); });
    assert.equal(await page.locator('#home-folder-toggle').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('home-' + width + '-dark.png');
    await page.locator('#home-folder-toggle').click();
    assert.equal(await page.evaluate(() => fixture.calls.at(-1).type), 'folders');
    await page.evaluate(() => home.show('chat'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('chat-' + width + '-dark.png');
  }
  pass('Dark theme and 760px/390px layouts retain controls without horizontal overflow');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    home.dispose();
    fixture.persistMode = 'normal'; fixture.requestMode = 'normal';
    window.homeState = {
      schemaVersion: 1, sourceIds: [], draft: '主页草稿', activeConversationId: 'chat-c',
      conversations: ['a', 'b', 'c'].map((letter, index) => ({
        id: 'chat-' + letter, title: '会话 ' + letter.toUpperCase(), createdAt: (index + 1) * 1000,
        sourceIds: letter === 'a' ? ['paper', 'note'] : [], draft: '草稿 ' + letter.toUpperCase(),
        turns: [{ id: 'turn-' + letter, question: '问题 ' + letter, answer: '回答 ' + letter,
          status: 'complete', sourceIds: [], evidence: [], citations: [] }]
      }))
    };
    mount(); home.show('chat');
  });
  const originalA = await page.evaluate(() => JSON.parse(JSON.stringify(homeState.conversations[0])));
  assert.deepEqual(await page.evaluate(() => home.getConversations().map(chat => chat.id)), ['chat-c', 'chat-b', 'chat-a'], 'legacy conversations keep their order');
  assert.equal(await page.evaluate(() => home.getDeletedConversations().length), 0);
  assert.equal(await page.evaluate(() => home.deleteConversation('chat-a')), true);
  assert.deepEqual(await page.evaluate(() => home.getConversations().map(chat => chat.id)), ['chat-c', 'chat-b']);
  assert.equal(await page.evaluate(() => homeState.activeConversationId), 'chat-c', 'deleting another conversation preserves the active conversation');
  assert.equal(await input.inputValue(), '草稿 C');
  assert.equal(await page.evaluate(() => home.getDeletedConversations()[0].id), 'chat-a');
  assert.equal(await page.evaluate(() => home.selectConversation('chat-a')), false, 'deleted entries cannot reopen through active navigation');
  assert.ok(await page.evaluate(() => Number(homeState.conversations.find(chat => chat.id === 'chat-a').deletedAt) > 0));
  assert.equal(await page.evaluate(() => home.deleteConversation('chat-c')), true);
  assert.equal(await page.evaluate(() => homeState.activeConversationId), 'chat-b', 'deleting the current conversation selects the newest remaining one');
  assert.equal(await input.inputValue(), '草稿 B');
  assert.equal(await page.evaluate(() => home.deleteConversation('chat-b')), true);
  assert.equal(await page.evaluate(() => home.getConversations().length), 0);
  assert.equal(await page.evaluate(() => home.getDeletedConversations().length), 3);
  assert.equal(await page.evaluate(() => home.getView()), 'chat', 'deleting the last conversation retains an empty chat workspace');
  assert.equal(await input.isVisible(), true);
  assert.equal(await input.inputValue(), '');
  await page.evaluate(() => {
    const saved = JSON.parse(JSON.stringify(fixture.lastSavedState));
    home.dispose(); window.homeState = saved; mount(); home.show('chat');
  });
  assert.equal(await page.evaluate(() => home.getConversations().length), 0, 'deleted state survives reload');
  assert.equal(await page.evaluate(() => home.getDeletedConversations().length), 3);
  assert.equal(await page.evaluate(() => home.restoreConversation('chat-a')), true);
  const restoredA = await page.evaluate(() => { const value = JSON.parse(JSON.stringify(homeState.conversations.find(chat => chat.id === 'chat-a'))); delete value.deletedAt; return value; });
  assert.deepEqual(restoredA, originalA, 'restore preserves original messages, source order, draft and timestamps');
  assert.equal(await page.evaluate(() => home.restoreConversation('chat-c')), true);
  assert.equal(await page.evaluate(() => home.restoreConversation('chat-b')), true);
  assert.deepEqual(await page.evaluate(() => home.getConversations().map(chat => chat.id)), ['chat-c', 'chat-b', 'chat-a'], 'restoring does not reorder creation history');
  assert.equal(await page.evaluate(() => home.selectConversation('chat-a')), true);
  assert.equal(await input.inputValue(), '草稿 A');
  assert.deepEqual(await page.evaluate(() => homeState.conversations.find(chat => chat.id === homeState.activeConversationId).sourceIds), ['paper', 'note']);
  pass('Deleting other, current and last conversations persists and restore preserves messages, draft, source order and history order');

  const beforeFailedDelete = await page.evaluate(() => JSON.parse(JSON.stringify({ conversations: homeState.conversations, active: homeState.activeConversationId })));
  const beforeFailedSave = await page.evaluate(() => JSON.parse(JSON.stringify(fixture.lastSavedState)));
  await page.evaluate(() => { fixture.persistMode = 'reject'; });
  assert.equal(await page.evaluate(() => home.deleteConversation('chat-a')), false);
  assert.deepEqual(await page.evaluate(() => ({ conversations: homeState.conversations, active: homeState.activeConversationId })), beforeFailedDelete, 'failed deletion rolls back all visible state');
  assert.deepEqual(await page.evaluate(() => fixture.lastSavedState), beforeFailedSave, 'failed deletion does not replace durable state');
  assert.equal(await input.inputValue(), '草稿 A');
  assert.match(await page.evaluate(() => fixture.calls.filter(call => call.type === 'notice').at(-1).message), /删除|保存/);
  await page.evaluate(() => { fixture.persistMode = 'normal'; });
  assert.equal(await page.evaluate(() => home.deleteConversation('chat-b')), true);
  const beforeFailedRestore = await page.evaluate(() => JSON.parse(JSON.stringify(homeState.conversations)));
  await page.evaluate(() => { fixture.persistMode = 'false'; });
  assert.equal(await page.evaluate(() => home.restoreConversation('chat-b')), false);
  assert.deepEqual(await page.evaluate(() => homeState.conversations), beforeFailedRestore, 'a false persistence result does not falsely restore deleted data');
  assert.equal(await page.evaluate(() => home.getDeletedConversations().some(chat => chat.id === 'chat-b')), true);
  await page.evaluate(() => { fixture.persistMode = 'normal'; });
  pass('Storage rejection and false results keep conversations intact and never falsely report deletion or restoration');

  await page.evaluate(() => {
    fixture.requestMode = 'delayed'; fixture.resolveRequest = null; fixture.aborted = false;
    home.openChat({ prompt: '删除这个生成中的会话', sourceIds: [] });
  });
  const generatingId = await page.evaluate(() => homeState.activeConversationId);
  await page.locator('[data-chat-send]').click();
  await page.waitForFunction(() => typeof fixture.resolveRequest === 'function');
  await input.fill('删除前保留的新草稿');
  assert.equal(await page.evaluate(id => home.deleteConversation(id), generatingId), true);
  await page.waitForFunction(() => !home.hasPending());
  assert.equal(await page.evaluate(() => fixture.aborted), true, 'deleting the active generation cancels its request');
  const deletedPending = await page.evaluate(id => JSON.parse(JSON.stringify(homeState.conversations.find(chat => chat.id === id))), generatingId);
  assert.equal(deletedPending.draft, '删除前保留的新草稿');
  const activeAfterDelete = await page.evaluate(() => homeState.activeConversationId);
  await page.evaluate(() => fixture.resolveRequest('已删除会话的晚到回答绝不能写回'));
  await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(id => homeState.conversations.find(chat => chat.id === id), generatingId), deletedPending, 'late model resolution never mutates the deleted conversation');
  assert.equal(await page.evaluate(() => homeState.activeConversationId), activeAfterDelete);
  assert.doesNotMatch(await page.locator('[data-chat-messages]').textContent(), /已删除会话的晚到回答/);
  assert.equal(await page.evaluate(id => home.restoreConversation(id), generatingId), true);
  assert.equal(await page.evaluate(id => home.selectConversation(id), generatingId), true);
  assert.equal(await input.inputValue(), '删除前保留的新草稿');
  assert.notEqual(await page.evaluate(() => homeState.conversations.find(chat => chat.id === homeState.activeConversationId).turns.at(-1).status), 'generating');
  pass('Deleting an in-flight conversation cancels its request and preserves recovery state without late-result writes');

  assert.deepEqual(errors, []);
  console.log('Home workspace passed (' + passed + ' workflow groups).');
} finally {
  await page.evaluate(() => window.home?.dispose()).catch(() => {});
  await browser.close();
}
