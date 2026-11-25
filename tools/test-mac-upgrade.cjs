'use strict';

// Usage: node tools/test-mac-upgrade.cjs <previous DMG or .app> <new DMG or .app>
// The test installs both releases only under its generated Applications directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const { jsPDF } = require('../vendor/jspdf.umd.min.js');

assert.equal(process.platform, 'darwin', 'macOS upgrade tests require a Mac');
assert.equal(process.argv.length, 4, 'Pass the previous version and the new version as .dmg or .app paths');
const sourcePaths = process.argv.slice(2).map(file => path.resolve(file));
assert.notEqual(sourcePaths[0], sourcePaths[1], 'Use two independent packages for the upgrade');
const outputRoot = path.resolve('.tmp-test', 'mac-upgrade');
fs.mkdirSync(outputRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(outputRoot, 'run-'));
const applicationDirectory = path.join(output, 'Applications');
const profile = path.join(output, 'profile');
const stateFile = path.join(profile, 'state', 'editor-state-v1.json');
const pdfPath = path.join(output, '论文研读升级验收.pdf');
fs.mkdirSync(applicationDirectory);
const env = { ...process.env, NODE_ENV: 'test', GUANYI_TEST_USER_DATA: profile, GUANYI_TEST_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.GUANYI_TEST_FOREGROUND;

const report = { status: 'running', output, checks: [], rendererErrors: [] };
const appName = '观译阅读器.app';
const installed = path.join(applicationDirectory, appName);
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 120000 }).trim();
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const plist = (bundle, field) => command('/usr/libexec/PlistBuddy', ['-c', `Print :${field}`, path.join(bundle, 'Contents', 'Info.plist')]);
const asar = bundle => path.join(bundle, 'Contents', 'Resources', 'app.asar');
const check = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`); };
let application;
let browser;
let page;
let executable;

async function until(checkCondition, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await checkCondition()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function usePackage(source, label, useBundle) {
  if (source.endsWith('.app')) return useBundle(source);
  assert.ok(source.endsWith('.dmg'), 'Package path must end with .dmg or .app');
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'guanyi-upgrade-mount-'));
  let attached = false;
  try {
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, source]);
    attached = true;
    const bundles = fs.readdirSync(mount).filter(name => name.endsWith('.app'));
    assert.deepEqual(bundles, [appName], 'Installer must offer exactly one stable app bundle');
    assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications');
    check(`${label} installer: single app with Applications shortcut`, { image: source });
    return await useBundle(path.join(mount, appName));
  } finally {
    if (attached) command('/usr/bin/hdiutil', ['detach', mount]);
    fs.rmdirSync(mount);
  }
}

async function install(source, label) {
  return usePackage(source, label, bundle => {
    assert.equal(path.basename(bundle), appName, 'Finder relies on the same bundle file name for Replace');
    const identity = {
      version: plist(bundle, 'CFBundleShortVersionString'),
      packageVersion: plist(bundle, 'CFBundleVersion'),
      id: plist(bundle, 'CFBundleIdentifier'),
      executable: plist(bundle, 'CFBundleExecutable'),
      asar: hash(asar(bundle))
    };
    assert.equal(identity.id, 'com.guanyi.md');
    const alreadyInstalled = fs.existsSync(installed);
    assert.equal(alreadyInstalled, label === 'new', 'upgrade must start with the previous version installed');
    if (alreadyInstalled) fs.rmSync(installed, { recursive: true });
    command('/usr/bin/ditto', [bundle, installed]);
    assert.deepEqual(fs.readdirSync(applicationDirectory), [appName], 'only one installed copy');
    assert.equal(plist(installed, 'CFBundleShortVersionString'), identity.version);
    assert.equal(hash(asar(installed)), identity.asar);
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    executable = path.join(installed, 'Contents', 'MacOS', identity.executable);
    check(`${label} bundle: same install path and verified package`, { path: installed, ...identity });
    return identity;
  });
}

async function start(version) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(() => resolve(selected));
    });
  });
  const log = fs.openSync(path.join(output, `app-${version}.log`), 'w');
  application = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env, cwd: output, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let startError;
  application.once('error', error => { startError = error; });
  const address = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (startError) throw startError;
    assert.equal(application.exitCode, null, 'packaged process terminated before opening');
    return fetch(`${address}/json/version`).then(response => response.ok, () => false);
  }, `packaged app ${version} CDP`);
  browser = await chromium.connectOverCDP(address);
  await until(() => {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('/app.asar/index.html'));
    return !!page;
  }, `packaged app ${version} renderer`);
  page.on('pageerror', error => report.rendererErrors.push({ version, message: error.message }));
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => !!window.__MD_EDITOR_TEST__);
  assert.equal(await page.evaluate(() => window.guanyiDesktop.app.getVersion()), version);
  return page;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stop() {
  if (!application) return;
  if (page && !page.isClosed()) {
    const closed = page.waitForEvent('close', { timeout: 15000 });
    await page.evaluate(() => { setTimeout(() => window.close(), 0); });
    await closed;
  }
  if (browser?.isConnected()) await browser.close().catch(() => {});
  if (!exited(application)) application.kill('SIGTERM');
  await until(() => exited(application), 'stop test application', 10000);
  application = null;
  browser = null;
  page = null;
}

async function openPdf() {
  const opener = spawn(executable, [pdfPath], { env, cwd: output, stdio: 'ignore' });
  await until(() => exited(opener), 'PDF native second-instance handler');
  assert.equal(opener.exitCode, 0);
  await page.waitForFunction(file => {
    const state = window.__MD_EDITOR_TEST__.getState();
    return state.docs.some(doc => doc.desktopPath === file && doc.id === state.currentDocId);
  }, pdfPath);
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').waitFor();
  return page.evaluate(() => window.__MD_EDITOR_TEST__.getState().currentDocId);
}

async function notesPanel() {
  await page.locator('.app-reader-toolbar:not([hidden]) .guanyi-study-toggle').click();
  const panel = page.locator('.app-reader-container:not([hidden]) .guanyi-study-panel');
  await panel.locator('[data-study-tab="notes"]').click();
  return panel;
}

async function oldState() {
  const markdown = '# 升级测试\n\n这段内容应从旧版保留。\n';
  const draft = `${markdown}\n这段未保存的编辑也应保留。\n`;
  const doc = await page.evaluate(initial => window.__MD_EDITOR_TEST__.createDoc({
    name: '覆盖安装验证', content: initial
  }), markdown);
  assert.equal(doc.storageKind, 'managed');
  assert.ok(doc.desktopPath.startsWith(path.join(profile, 'documents') + path.sep));
  assert.equal(fs.readFileSync(doc.desktopPath, 'utf8'), markdown);
  const sourceTab = page.locator('#view-seg [data-view="source"] button');
  await sourceTab.click();
  await page.locator('#source-editor').fill(draft);
  await page.waitForFunction(() => window.__MD_EDITOR_TEST__.isDocDirty());
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.locator('#btn-theme').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');

  const pdf = new jsPDF();
  pdf.text('Original PDF evidence remains unchanged when adding a study note.', 20, 30);
  fs.writeFileSync(pdfPath, Buffer.from(pdf.output('arraybuffer')));
  const originalPdfHash = hash(pdfPath);
  const pdfId = await openPdf();
  const panel = await notesPanel();
  const note = '这条 PDF 批注来自升级前的正式客户端。';
  await panel.getByRole('button', { name: '新建笔记', exact: true }).click();
  await panel.getByRole('textbox', { name: '研读笔记', exact: true }).fill(note);
  await panel.getByRole('button', { name: '保存研读笔记', exact: true }).click();
  await panel.getByText(note, { exact: true }).waitFor();
  await panel.locator('[data-study-tab="ask"]').click();
  const question = '原文证据怎样支持这篇论文？';
  await panel.getByRole('textbox', { name: '研读问题', exact: true }).fill(question);
  await page.waitForFunction(({ pdfId, question }) =>
    window.__MD_EDITOR_TEST__.getState().docs.find(doc => doc.id === pdfId).readerStudy?.draft === question,
  { pdfId, question });
  await stop();
  assert.ok(fs.existsSync(stateFile));
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.docs.find(item => item.id === doc.id).content, draft);
  const savedStudy = saved.docs.find(item => item.id === pdfId).readerStudy;
  assert.equal(savedStudy.notes[0].text, note);
  assert.equal(savedStudy.draft, question);
  assert.equal(hash(pdfPath), originalPdfHash);
  assert.equal(fs.readFileSync(doc.desktopPath, 'utf8'), markdown);
  check('previous version: saved Markdown, unsaved draft, theme, native PDF and research data created');
  return { doc, markdown, draft, pdfId, originalPdfHash, note, question };
}

async function verifyPersisted(saved) {
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  const { doc, markdown, draft, pdfId, originalPdfHash, note, question } = saved;
  const matches = await page.evaluate(file => window.__MD_EDITOR_TEST__.getState().docs.filter(doc => doc.desktopPath === file), doc.desktopPath);
  assert.equal(matches.length, 1, 'upgrade does not duplicate managed documents');
  assert.equal(matches[0].id, doc.id);
  assert.equal(matches[0].content, draft);
  assert.equal(matches[0].lastSavedContent, markdown);
  assert.equal(fs.readFileSync(doc.desktopPath, 'utf8'), markdown);
  assert.equal(hash(pdfPath), originalPdfHash);
  check('upgrade restores personal settings and unsaved edit without overwriting the Markdown file');

  assert.equal(await openPdf(), pdfId, 'native reopening reuses the original PDF ID');
  const panel = await notesPanel();
  assert.equal(await panel.getByText(note, { exact: true }).count(), 1);
  await panel.locator('[data-study-tab="ask"]').click();
  assert.equal(await panel.getByRole('textbox', { name: '研读问题', exact: true }).inputValue(), question);
  assert.equal(hash(pdfPath), originalPdfHash);
  check('upgrade retains the PDF note and question draft without changing the original PDF');
}

async function main() {
  const before = await install(sourcePaths[0], 'old');
  await start(before.version);
  const saved = await oldState();
  // A directory merge would retain this test-only file. The replacement must not.
  const oldOnly = path.join(installed, 'Contents', 'Resources', 'upgrade-test-old-only');
  fs.writeFileSync(oldOnly, 'This file belongs to the disposable previous installation.\n');
  const after = await install(sourcePaths[1], 'new');
  assert.match(after.version, /^\d+\.\d+\.\d+$/);
  assert.ok(after.version.localeCompare(before.version, 'en', { numeric: true }) > 0, 'replacement version is newer');
  assert.equal(after.executable, before.executable);
  assert.notEqual(after.asar, before.asar);
  assert.equal(fs.existsSync(oldOnly), false);
  check('replacement leaves one bundled app and removes old-only resources');
  await start(after.version);
  await verifyPersisted(saved);
  await stop();
  assert.deepEqual(report.rendererErrors, []);
  report.status = 'passed';
}

(async () => {
  try {
    await main();
  } catch (error) {
    report.status = 'failed';
    report.failure = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (application && !exited(application)) {
      application.kill('SIGTERM');
      await until(() => exited(application), 'cleanup test application', 10000).catch(() => {});
    }
    if (!application || exited(application)) fs.rmSync(installed, { recursive: true, force: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Upgrade report: ${path.join(output, 'report.json')}`);
  }
})();
