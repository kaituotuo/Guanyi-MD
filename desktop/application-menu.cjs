const APPLICATION_MENU_COMMANDS = new Set([
  'app.settings',
  'document.new',
  'document.open',
  'document.add-directory',
  'document.refresh-directories',
  'document.open-location',
  'document.save',
  'document.close-tab',
  'document.export.raw',
  'document.export.pdf',
  'document.export.image',
  'edit.undo',
  'edit.redo',
  'edit.find',
  'edit.replace',
  'search.library',
  'format.bold',
  'format.italic',
  'format.strike',
  'format.link',
  'format.inlinecode',
  'format.codeblock',
  'format.ul',
  'format.ol',
  'format.task',
  'format.quote',
  'format.hr',
  'view.source',
  'view.preview',
  'view.split',
  'view.theme.light',
  'view.theme.dark'
]);

const MENU_STATE_IDS = Object.freeze({
  document: [
    'menu-document-open-location',
    'menu-document-save',
    'menu-document-close-tab',
    'menu-document-export'
  ],
  directory: ['menu-document-refresh-directories'],
  undo: ['menu-edit-undo'],
  redo: ['menu-edit-redo'],
  markdown: ['menu-format']
});

function commandItem(actions, command, label, options = {}) {
  if (!APPLICATION_MENU_COMMANDS.has(command)) throw new Error(`Unknown application menu command: ${command}`);
  return {
    id: options.id || `menu-${command.replace(/\./g, '-')}`,
    label,
    ...(options.accelerator ? { accelerator: options.accelerator } : {}),
    ...(options.type ? { type: options.type } : {}),
    ...(options.checked !== undefined ? { checked: options.checked } : {}),
    click: () => actions.command(command)
  };
}

function formatSubmenu(actions) {
  return [
    commandItem(actions, 'format.bold', '粗体', { accelerator: 'CommandOrControl+B' }),
    commandItem(actions, 'format.italic', '斜体', { accelerator: 'CommandOrControl+I' }),
    commandItem(actions, 'format.strike', '删除线'),
    commandItem(actions, 'format.link', '链接', { accelerator: 'CommandOrControl+K' }),
    commandItem(actions, 'format.inlinecode', '行内代码'),
    { type: 'separator' },
    commandItem(actions, 'format.ul', '无序列表'),
    commandItem(actions, 'format.ol', '有序列表'),
    commandItem(actions, 'format.task', '任务列表'),
    commandItem(actions, 'format.quote', '引用'),
    commandItem(actions, 'format.codeblock', '代码块'),
    commandItem(actions, 'format.hr', '分割线')
  ];
}

function buildApplicationMenuTemplate(options = {}) {
  const platform = options.platform || process.platform;
  const productName = options.productName || '观译阅读器';
  const actions = {
    command: typeof options.actions?.command === 'function' ? options.actions.command : () => {},
    help: typeof options.actions?.help === 'function' ? options.actions.help : () => {},
    diagnostics: typeof options.actions?.diagnostics === 'function' ? options.actions.diagnostics : () => {}
  };
  const replaceAccelerator = platform === 'darwin' ? 'Alt+Command+F' : 'CommandOrControl+H';
  const template = [];

  if (platform === 'darwin') {
    template.push({
      label: productName,
      submenu: [
        { role: 'about', label: `关于${productName}` },
        commandItem(actions, 'app.settings', '设置…', { accelerator: 'Command+,' }),
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏${productName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出${productName}` }
      ]
    });
  }

  template.push(
    {
      label: '文件',
      submenu: [
        commandItem(actions, 'document.new', '新建文档', { accelerator: 'CommandOrControl+N' }),
        commandItem(actions, 'document.open', '打开文档…', { accelerator: 'CommandOrControl+O' }),
        { type: 'separator' },
        commandItem(actions, 'document.add-directory', '添加目录…'),
        commandItem(actions, 'document.refresh-directories', '刷新已添加目录', { id: 'menu-document-refresh-directories' }),
        commandItem(actions, 'document.open-location', '打开文件位置', { id: 'menu-document-open-location' }),
        { type: 'separator' },
        commandItem(actions, 'document.save', '保存', { accelerator: 'CommandOrControl+S', id: 'menu-document-save' }),
        commandItem(actions, 'document.close-tab', '关闭当前页签', { accelerator: 'CommandOrControl+W' }),
        {
          id: 'menu-document-export',
          label: '导出',
          submenu: [
            commandItem(actions, 'document.export.raw', 'Markdown / TXT 原文'),
            commandItem(actions, 'document.export.pdf', 'PDF'),
            commandItem(actions, 'document.export.image', 'PNG 长图')
          ]
        },
        { type: 'separator' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        commandItem(actions, 'edit.undo', '撤销', { accelerator: 'CommandOrControl+Z', id: 'menu-edit-undo' }),
        commandItem(actions, 'edit.redo', '重做', { accelerator: 'Shift+CommandOrControl+Z', id: 'menu-edit-redo' }),
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        commandItem(actions, 'edit.find', '查找当前文档…', { accelerator: 'CommandOrControl+F' }),
        commandItem(actions, 'edit.replace', '查找与替换…', { accelerator: replaceAccelerator }),
        commandItem(actions, 'search.library', '搜索文档库…', { accelerator: 'Shift+CommandOrControl+F' }),
        { type: 'separator' },
        { id: 'menu-format', label: 'Markdown 格式', submenu: formatSubmenu(actions) }
      ]
    },
    {
      label: '查看',
      submenu: [
        commandItem(actions, 'view.source', '源码视图', { id: 'menu-view-source', type: 'radio' }),
        commandItem(actions, 'view.preview', '预览视图', { id: 'menu-view-preview', type: 'radio' }),
        commandItem(actions, 'view.split', '分栏视图', { id: 'menu-view-split', type: 'radio', checked: true }),
        { type: 'separator' },
        commandItem(actions, 'view.theme.light', '亮色主题', { id: 'menu-theme-light', type: 'radio', checked: true }),
        commandItem(actions, 'view.theme.dark', '暗色主题', { id: 'menu-theme-dark', type: 'radio' }),
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '切换全屏' },
        { type: 'separator' },
        { role: 'minimize', label: '最小化' },
        ...(platform === 'darwin' ? [{ role: 'zoom', label: '缩放窗口' }] : [])
      ]
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: '观译阅读器使用指南', click: () => actions.help('guide') },
        { label: 'Markdown 快速参考', click: () => actions.help('markdown') },
        { label: '键盘快捷键', click: () => actions.help('shortcuts') },
        { type: 'separator' },
        { label: '本地搜索与索引', click: () => actions.help('search') },
        { label: '数据与隐私', click: () => actions.help('privacy') },
        { type: 'separator' },
        { label: '打开诊断日志文件夹', click: () => actions.diagnostics() }
      ]
    }
  );

  return template;
}

function normalizedMenuState(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  return {
    hasDocument: !!state.hasDocument,
    hasDiskPath: !!state.hasDiskPath,
    hasDirectories: !!state.hasDirectories,
    canUndo: !!state.canUndo,
    canRedo: !!state.canRedo,
    plainText: !!state.plainText,
    viewMode: ['source', 'preview', 'split'].includes(state.viewMode) ? state.viewMode : 'split',
    theme: state.theme === 'dark' ? 'dark' : 'light'
  };
}

function updateApplicationMenuState(menu, rawState) {
  if (!menu || typeof menu.getMenuItemById !== 'function') return;
  const state = normalizedMenuState(rawState);
  const setEnabled = (ids, enabled) => ids.forEach((id) => {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = !!enabled;
  });
  setEnabled(MENU_STATE_IDS.document, state.hasDocument);
  setEnabled(['menu-document-open-location'], state.hasDiskPath);
  setEnabled(MENU_STATE_IDS.directory, state.hasDirectories);
  setEnabled(MENU_STATE_IDS.undo, state.canUndo);
  setEnabled(MENU_STATE_IDS.redo, state.canRedo);
  setEnabled(MENU_STATE_IDS.markdown, state.hasDocument && !state.plainText);
  for (const mode of ['source', 'preview', 'split']) {
    const item = menu.getMenuItemById(`menu-view-${mode}`);
    if (item) item.checked = state.viewMode === mode;
  }
  for (const theme of ['light', 'dark']) {
    const item = menu.getMenuItemById(`menu-theme-${theme}`);
    if (item) item.checked = state.theme === theme;
  }
}

module.exports = {
  APPLICATION_MENU_COMMANDS,
  buildApplicationMenuTemplate,
  normalizedMenuState,
  updateApplicationMenuState
};
