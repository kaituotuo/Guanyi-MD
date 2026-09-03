const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('missing screenshot output directory');

app.setPath('userData', path.join(outputDirectory, `user-data-${process.pid}`));

function waitForRenderer(window, timeout = 12000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const state = await window.webContents.executeJavaScript(`({
          ready: Boolean(window.__MD_EDITOR_TEST__),
          error: window.__MD_EDITOR_BOOT_ERROR__ || '',
          tabs: document.querySelectorAll('#document-tabs .app-document-tab').length
        })`);
        if (state.error) return reject(new Error(state.error));
        if (state.ready && state.tabs) return resolve();
      } catch (error) {
        if (Date.now() - startedAt >= timeout) return reject(error);
      }
      if (Date.now() - startedAt >= timeout) return reject(new Error('renderer boot timed out'));
      setTimeout(poll, 80);
    };
    poll();
  });
}

function assertClose(actual, expected, label, tolerance = 1) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

async function inspectLayout(window, name, dimensions, theme) {
  window.setContentSize(dimensions.width, dimensions.height);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await window.webContents.executeJavaScript(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    while (document.querySelectorAll('#document-tabs .app-document-tab').length < 4) {
      document.getElementById('btn-new-tab').click();
    }
    if (!document.getElementById('collab-drawer').classList.contains('is-open')) {
      document.getElementById('btn-comments').click();
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 220));

  const layout = await window.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector).getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    const tabs = [...document.querySelectorAll('#document-tabs .app-document-tab')].map((tab) => ({
      ...rect('#document-tabs .app-document-tab[data-doc-id="' + CSS.escape(tab.dataset.docId) + '"]'),
      selected: tab.getAttribute('aria-selected') === 'true'
    }));
    const selected = document.querySelector('#document-tabs .app-document-tab[aria-selected="true"]');
    return {
      theme: document.documentElement.dataset.theme,
      topbar: rect('.app-topbar'),
      identity: rect('.app-topbar__identity'),
      sidebar: rect('.app-sidebar'),
      tabsBar: rect('.app-document-tabs-bar'),
      formatbar: rect('.app-fmtbar'),
      drawer: rect('.app-collab-drawer'),
      statusbar: rect('.app-statusbar'),
      newTab: rect('#btn-new-tab'),
      menu: rect('#btn-app-menu'),
      tabs,
      selectedRadius: selected ? getComputedStyle(selected).borderRadius : '',
      brandVisible: Boolean(document.querySelector('.app-topbar__brand')?.getClientRects().length),
      sloganVisible: Boolean(document.querySelector('.app-topbar__tagline')?.getClientRects().length),
      drawerOpen: document.getElementById('collab-drawer').classList.contains('is-open')
    };
  })()`);

  if (layout.theme !== theme) throw new Error(`${name}: theme did not apply`);
  if (!layout.brandVisible || !layout.sloganVisible) throw new Error(`${name}: desktop brand or slogan is hidden`);
  if (!layout.drawerOpen) throw new Error(`${name}: collaboration drawer did not open`);
  if (layout.tabs.length < 4) throw new Error(`${name}: multiple tabs were not rendered`);
  assertClose(layout.topbar.bottom, layout.formatbar.top, `${name}: formatbar must follow topbar`);
  assertClose(layout.formatbar.bottom, layout.drawer.top, `${name}: drawer must start below formatbar`);
  assertClose(layout.drawer.bottom, layout.statusbar.top, `${name}: drawer must stop above statusbar`);
  assertClose(layout.identity.right, layout.sidebar.right, `${name}: brand boundary must align with sidebar`);
  assertClose(layout.tabsBar.left, layout.identity.right, `${name}: tabs must start after brand region`);
  if (layout.selectedRadius !== '10px 10px 0px 0px') throw new Error(`${name}: selected tab radius is ${layout.selectedRadius}`);
  for (let index = 1; index < layout.tabs.length; index += 1) {
    if (layout.tabs[index].left + 1 < layout.tabs[index - 1].right) {
      throw new Error(`${name}: document tabs overlap at index ${index}`);
    }
  }
  const lastTab = layout.tabs.at(-1);
  if (layout.newTab.left + 1 < lastTab.right) throw new Error(`${name}: new-tab button overlaps the final tab`);
  if (layout.newTab.right > layout.menu.left + 1) throw new Error(`${name}: new-tab button exceeds the available titlebar space`);

  const image = await window.webContents.capturePage();
  if (image.isEmpty() || image.getSize().width < dimensions.width || image.getSize().height < dimensions.height) {
    throw new Error(`${name}: captured screenshot is empty or undersized`);
  }
  const screenshot = path.join(outputDirectory, `${name}.png`);
  await fs.promises.writeFile(screenshot, image.toPNG());
  return screenshot;
}

async function main() {
  await app.whenReady();
  const consoleErrors = [];
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: '#f6f4f1',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  window.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'error' || Number(level) >= 3) consoleErrors.push(String(message || 'unknown renderer error'));
  });
  window.webContents.on('did-fail-load', (_event, code, description) => {
    consoleErrors.push(`load ${code}: ${description}`);
  });
  await window.loadFile(path.join(projectRoot, 'index.html'), { query: { client: 'desktop' } });
  await waitForRenderer(window);
  const screenshots = [];
  screenshots.push(await inspectLayout(window, 'desktop-light-1440x920', { width: 1440, height: 920 }, 'light'));
  screenshots.push(await inspectLayout(window, 'desktop-dark-920x640', { width: 920, height: 640 }, 'dark'));
  if (consoleErrors.length) throw new Error(`renderer console errors: ${consoleErrors.join(' | ')}`);
  window.destroy();
  process.stdout.write(`Electron layout smoke passed: ${screenshots.join(', ')}\n`);
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
