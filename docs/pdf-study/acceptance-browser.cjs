/* Browser fallback for visual and design-contract acceptance.
 * Set GUANYI_PLAYWRIGHT_MODULE when Playwright is provided outside this repo. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const playwrightModule = process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightModule);
const prototypeRoot = __dirname;
const projectRoot = path.resolve(prototypeRoot, '../..');
const outputRoot = path.join(projectRoot, '.tmp-test', 'pdf-study-prototype');
fs.mkdirSync(outputRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(outputRoot, 'browser-run-'));
const screenshots = [];
const checks = [];
const errors = [];
const externalRequests = [];

function passed(name) {
  checks.push({ name, status: 'passed' });
  console.log(`PASS ${name}`);
}

(async () => {
  const launchOptions = { headless: true };
  if (process.env.GUANYI_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.GUANYI_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });

  const state = () => page.evaluate(() => window.__PDF_STUDY_PROTOTYPE__.getState());
  const currentUrl = pathToFileURL(path.join(prototypeRoot, 'current.html')).href;
  await page.goto(currentUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__PDF_STUDY_PROTOTYPE__) && document.documentElement.dataset.prototypeVersion);

  const contract = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const tabs = [...document.querySelectorAll('.document-tab')];
    const iconButtons = [...document.querySelectorAll('.icon-button')];
    document.getElementById('theme-button').focus();
    return {
      designSystem: document.documentElement.dataset.designSystem,
      prototypeVersion: document.documentElement.dataset.prototypeVersion,
      scenario: document.querySelector('meta[name="prototype-scenario"]')?.content,
      baseline: document.querySelector('meta[name="prototype-baseline"]')?.content,
      difference: document.querySelector('meta[name="prototype-difference"]')?.content,
      narrow: document.querySelector('meta[name="prototype-narrow-screen"]')?.content,
      sidebar: root.getPropertyValue('--guanyi-sidebar-width').trim(),
      toolbar: root.getPropertyValue('--guanyi-formatbar-height').trim(),
      status: root.getPropertyValue('--guanyi-statusbar-height').trim(),
      selectedTabs: tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length,
      tabbableTabs: tabs.filter(tab => tab.tabIndex === 0).length,
      unnamedIcons: iconButtons.filter(button => !button.getAttribute('aria-label') && !button.textContent.trim()).length,
      focusOutline: getComputedStyle(document.getElementById('theme-button')).outlineWidth,
      themePressed: document.getElementById('theme-button').getAttribute('aria-pressed'),
      studyExpanded: document.getElementById('study-toggle').getAttribute('aria-expanded'),
      libraryExpanded: document.getElementById('library-toggle').getAttribute('aria-expanded')
    };
  });
  assert.equal(contract.designSystem, 'guanyi-v1.0');
  assert.equal(contract.prototypeVersion, 'v0.3-ds-v1');
  assert.equal(contract.scenario, 'PDF 文档智能研读');
  assert.match(contract.baseline, /V1\.0/);
  assert.match(contract.difference, /模拟 PDF/);
  assert.match(contract.narrow, /1180px.*760px/);
  assert.deepEqual([contract.sidebar, contract.toolbar, contract.status], ['268px', '49px', '26px']);
  assert.deepEqual([contract.selectedTabs, contract.tabbableTabs, contract.unnamedIcons], [1, 1, 0]);
  assert.deepEqual([contract.focusOutline, contract.themePressed, contract.studyExpanded, contract.libraryExpanded], ['2px', 'false', 'true', 'true']);
  passed('Design-system metadata, semantic tokens and accessible control states');

  await page.locator('.document-tab[data-document="textbook"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await state()).document, 'paper');
  assert.equal(await page.locator('.document-tab[data-document="paper"]').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft');
  assert.equal((await state()).document, 'textbook');
  passed('Document tabs support a single selected tab and arrow-key navigation');

  async function setStudyState(panel, documentId, theme) {
    if ((await state()).document !== documentId) await page.locator(`.document-tab[data-document="${documentId}"]`).click();
    if (await page.locator('#study-panel').evaluate(element => element.classList.contains('is-hidden'))) await page.locator('#study-toggle').click();
    if ((await state()).panel !== panel) await page.locator(`[data-panel="${panel}"]`).click();
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-button').click();
    await page.locator('#scenario-select').selectOption('ready');
    await page.waitForTimeout(80);
  }

  async function capture(name, width, height, theme, panel = 'guide', documentId = 'textbook') {
    await page.setViewportSize({ width, height });
    await setStudyState(panel, documentId, theme);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metrics = await page.evaluate(() => {
      const rect = selector => {
        const element = document.querySelector(selector);
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height, visible: Boolean(element.getClientRects().length) && getComputedStyle(element).display !== 'none' };
      };
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        prototype: rect('.prototype-bar'),
        toolbar: rect('.reader-toolbar'),
        panel: rect('#study-panel'),
        content: rect('#panel-content'),
        footer: rect('.app-status'),
        library: rect('#library'),
        tabs: rect('.document-tabs'),
        tabTitlesVisible: [...document.querySelectorAll('.document-tab > span:last-child')].every(element => getComputedStyle(element).display !== 'none'),
        scrim: rect('#workspace-scrim')
      };
    });
    assert.equal(metrics.width, width);
    assert.ok(metrics.scrollWidth <= width + 1, `${name}: horizontal page overflow`);
    assert.ok(metrics.panel.left >= -1 && metrics.panel.right <= width + 1, `${name}: panel outside viewport`);
    assert.ok(metrics.panel.top >= metrics.prototype.bottom, `${name}: panel covers prototype metadata`);
    assert.ok(metrics.panel.bottom <= metrics.footer.top + 1, `${name}: panel covers status bar`);
    assert.ok(metrics.content.height >= 200, `${name}: panel has no useful work area`);
    assert.ok(Math.abs(metrics.footer.height - 26) <= 1, `${name}: status bar is not 26px`);
    assert.ok(Math.abs(metrics.toolbar.height - (width <= 760 ? 47 : 49)) <= 1, `${name}: toolbar baseline drift`);
    if (width >= 1180) {
      assert.ok(Math.abs(metrics.library.width - 268) <= 1, `${name}: sidebar is not 268px`);
      assert.ok(Math.abs(metrics.panel.width - 360) <= 1, `${name}: panel is not 360px`);
      assert.equal(metrics.scrim.visible, false, `${name}: wide layout shows a scrim`);
      assert.ok(metrics.toolbar.right <= metrics.panel.left + 1, `${name}: wide panel overlays the toolbar`);
    } else {
      assert.ok(metrics.panel.top >= metrics.toolbar.bottom - 1, `${name}: drawer covers PDF commands`);
      assert.ok(metrics.panel.width <= 361, `${name}: drawer exceeds 360px`);
      assert.equal(metrics.scrim.visible, true, `${name}: drawer lacks a scrim`);
    }
    if (width > 760) assert.ok(Math.abs(metrics.library.width - 268) <= 1, `${name}: visible sidebar width drift`);
    if (width <= 760) {
      assert.ok(metrics.tabs.width >= 80, `${name}: tab scroll viewport collapsed`);
      assert.equal(metrics.tabTitlesVisible, true, `${name}: inactive document title was hidden`);
    }
    const imagePath = path.join(prototypeRoot, `preview-v1-${name}.png`);
    await page.screenshot({ path: imagePath });
    screenshots.push({ name, imagePath, metrics });
  }

  await capture('textbook-light', 1440, 1000, 'light', 'guide', 'textbook');

  await page.locator('[data-block-id="oxygen-use"]').click();
  await page.locator('[data-selection-action="explain"]').click();
  await page.waitForFunction(() => !window.__PDF_STUDY_PROTOTYPE__.getState().pending);
  assert.equal((await state()).panel, 'ask');
  assert.match(await page.locator('#panel-content').innerText(), /耗氧量|供氧能力/);
  await capture('textbook-answer', 1440, 1000, 'light', 'ask', 'textbook');
  passed('Selection explanation reaches document chat with source-grounded demo content');

  await capture('learning-cards', 1440, 1000, 'light', 'cards', 'textbook');
  assert.equal(await page.locator('.candidate-card').count(), 3);
  await capture('paper-light', 1440, 1000, 'light', 'guide', 'paper');
  assert.match(await page.locator('#panel-content').innerText(), /48 名|48/);
  await capture('paper-dark', 1440, 1000, 'dark', 'ask', 'paper');
  assert.equal(await page.locator('#theme-button').getAttribute('aria-pressed'), 'true');
  passed('Guide, learning-card, paper and dark-theme states render with the refreshed shell');

  await capture('tablet', 1024, 768, 'light', 'ask', 'textbook');
  await page.setViewportSize({ width: 900, height: 780 });
  await page.waitForTimeout(60);
  assert.equal(await page.locator('#library').isVisible(), true);
  assert.equal(await page.locator('#library-toggle').getAttribute('aria-expanded'), 'true');
  await page.locator('#library-toggle').click();
  assert.equal(await page.locator('#library').isVisible(), false);
  assert.equal(await page.locator('#library-toggle').getAttribute('aria-expanded'), 'false');
  await page.locator('#library-toggle').click();
  assert.equal(await page.locator('#library').isVisible(), true);
  assert.equal(await page.locator('#library-toggle').getAttribute('aria-expanded'), 'true');
  await capture('narrow', 760, 800, 'dark', 'ask', 'paper');
  await capture('mobile', 360, 844, 'light', 'ask', 'textbook');

  await page.locator('#study-close').click();
  assert.equal(await page.locator('#study-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'study-toggle');
  await page.locator('#library-toggle').click();
  assert.equal(await page.locator('#library-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('library-drawer-open')), true);
  await page.locator('#workspace-scrim').click({ position: { x: 350, y: 200 } });
  assert.equal(await page.locator('#library-toggle').getAttribute('aria-expanded'), 'false');
  await page.locator('#study-toggle').click();
  assert.equal(await page.locator('#study-toggle').getAttribute('aria-expanded'), 'true');
  passed('Tablet and narrow drawers preserve PDF commands, dismissal and focus return');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#help-button').click();
  assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), false);
  passed('Dialog, theme and drawer controls retain keyboard-visible semantics');

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  const report = { checkedAt: new Date().toISOString(), result: 'passed', checkCount: checks.length, checks, screenshots, errors, externalRequests };
  fs.writeFileSync(path.join(runRoot, 'browser-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(`Browser acceptance passed: ${checks.length} groups; report ${path.join(runRoot, 'browser-acceptance.json')}`);
  await browser.close();
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
