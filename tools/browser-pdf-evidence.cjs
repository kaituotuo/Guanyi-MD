/* Run the engine evidence scenario in headless Chrome when Electron cannot
 * launch. This validates browser/PDF.js behavior, not native desktop lifecycle. */
const { chromium } = require(process.env.GUANYI_PLAYWRIGHT_MODULE || 'playwright');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let browser;
let requestHook;
const app = {
  async whenReady() {
    browser = await chromium.launch({ headless: true,
      ...(process.env.GUANYI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.GUANYI_CHROMIUM_EXECUTABLE } : {}),
      args: ['--allow-file-access-from-files'] });
  },
  setPath() {}, on() {}, setActivationPolicy() {}, dock: { hide() {} },
  exit(code) { browser?.close().then(() => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; }); }
};
class BrowserWindow {
  constructor(options) {
    this.pagePromise = browser.newPage({ viewport: { width: options.width, height: options.height } }).then(async page => {
      await page.route('**/*', route => {
        if (/^https?:/.test(route.request().url()) && requestHook) {
          requestHook({ url: route.request().url() }, result => result.cancel ? route.abort() : route.continue());
        } else route.continue();
      });
      return page;
    });
    this.webContents = {
      on: (name, callback) => this.pagePromise.then(page => {
        if (name === 'console-message') page.on('console', message => callback(null, message.type() === 'error' ? 3 : 1, message.text()));
      }),
      executeJavaScript: async source => (await this.pagePromise).evaluate(source),
      capturePage: async () => { const buffer = await (await this.pagePromise).screenshot(); return { toPNG: () => buffer }; }
    };
  }
  async loadFile(file) { await (await this.pagePromise).goto(pathToFileURL(file).href); }
  destroy() { this.pagePromise.then(page => page.close()); }
}
const adapter = { app, BrowserWindow, session: { defaultSession: { webRequest: {
  onBeforeRequest(_filter, callback) { requestHook = callback; }
} } } };
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) { return name === 'electron' ? adapter : originalLoad.call(this, name, parent, isMain); };
require(path.resolve(__dirname, 'electron-pdf-evidence.cjs'));
