const { contextBridge, ipcRenderer } = require('electron');

let openFilesHandler = null;
let queuedOpenFiles = [];
let menuCommandHandler = null;
let queuedMenuCommands = [];
const APPLICATION_MENU_COMMANDS = new Set([
  'app.settings',
  'document.new', 'document.open', 'document.add-directory', 'document.refresh-directories',
  'document.open-location', 'document.save', 'document.close-tab', 'document.export.raw', 'document.export.pdf', 'document.export.image',
  'edit.undo', 'edit.redo', 'edit.find', 'edit.replace', 'search.library',
  'format.bold', 'format.italic', 'format.strike', 'format.link', 'format.inlinecode', 'format.codeblock',
  'format.ul', 'format.ol', 'format.task', 'format.quote', 'format.hr',
  'view.source', 'view.preview', 'view.split', 'view.theme.light', 'view.theme.dark'
]);

ipcRenderer.on('guanyi:open-files', (_event, paths) => {
  const safePaths = Array.isArray(paths) ? paths : [];
  if (openFilesHandler) openFilesHandler(safePaths);
  else queuedOpenFiles.push(...safePaths);
});

ipcRenderer.on('guanyi:command', (_event, command) => {
  if (!APPLICATION_MENU_COMMANDS.has(command)) return;
  if (menuCommandHandler) menuCommandHandler(command);
  else queuedMenuCommands.push(command);
});

contextBridge.exposeInMainWorld('guanyiDesktop', Object.freeze({
  platform: process.platform,
  files: Object.freeze({
    choose: () => ipcRenderer.invoke('guanyi-files:choose'),
    saveAs: (suggestedName, content) => ipcRenderer.invoke('guanyi-files:save-as', { suggestedName, content }),
    saveBinaryAs: (suggestedName, bytes) => ipcRenderer.invoke('guanyi-files:save-binary-as', { suggestedName, bytes }),
    cacheBinary: (id, bytes) => ipcRenderer.invoke('guanyi-files:cache-binary', { id, bytes }),
    readCachedBinary: (id) => ipcRenderer.invoke('guanyi-files:read-cached-binary', id),
    createManaged: (suggestedName, content) => ipcRenderer.invoke('guanyi-files:create-managed', { suggestedName, content }),
    onOpen: (callback) => {
      openFilesHandler = typeof callback === 'function' ? callback : null;
      if (openFilesHandler && queuedOpenFiles.length) {
        const paths = [...new Set(queuedOpenFiles)];
        queuedOpenFiles = [];
        queueMicrotask(() => openFilesHandler?.(paths));
      }
      return () => { openFilesHandler = null; };
    },
    read: (paths) => ipcRenderer.invoke('guanyi-files:read', paths),
    readAsset: (documentPath, source) => ipcRenderer.invoke('guanyi-files:read-asset', { documentPath, source }),
    write: (filePath, content) => ipcRenderer.invoke('guanyi-files:write', { filePath, content }),
    stat: (filePath) => ipcRenderer.invoke('guanyi-files:stat', filePath),
    transaction: (payload) => ipcRenderer.invoke('guanyi-files:transaction', payload),
    showInFolder: (filePath) => ipcRenderer.invoke('guanyi-files:show-in-folder', filePath),
    rename: (filePath, nextName) => ipcRenderer.invoke('guanyi-files:rename', { filePath, nextName }),
    readSibling: (documentPath, name) => ipcRenderer.invoke('guanyi-files:read-sibling', { documentPath, name }),
    writeSibling: (documentPath, name, content) => ipcRenderer.invoke('guanyi-files:write-sibling', { documentPath, name, content })
  }),
  directories: Object.freeze({
    choose: (options) => ipcRenderer.invoke('guanyi-directories:choose', options),
    inspect: (rootPath) => ipcRenderer.invoke('guanyi-directories:inspect', rootPath),
    scan: (rootPath) => ipcRenderer.invoke('guanyi-directories:scan', rootPath),
    read: (rootPath, relativePath) => ipcRenderer.invoke('guanyi-directories:read', { rootPath, relativePath }),
    rename: (rootPath, relativePath, nextRelativePath) => ipcRenderer.invoke('guanyi-directories:rename', { rootPath, relativePath, nextRelativePath }),
    storeAsset: (rootPath, documentRelativePath, fileName, bytes) => ipcRenderer.invoke('guanyi-directories:store-asset', {
      rootPath, documentRelativePath, fileName, bytes
    }),
    removeAsset: (assetPath) => ipcRenderer.invoke('guanyi-directories:remove-asset', assetPath)
  }),
  state: Object.freeze({
    load: () => ipcRenderer.invoke('guanyi-state:load'),
    save: (payload) => ipcRenderer.invoke('guanyi-state:save', payload)
  }),
  app: Object.freeze({
    getVersion: () => ipcRenderer.invoke('guanyi-app:version')
  }),
  menu: Object.freeze({
    onCommand: (callback) => {
      menuCommandHandler = typeof callback === 'function' ? callback : null;
      if (menuCommandHandler && queuedMenuCommands.length) {
        const commands = queuedMenuCommands;
        queuedMenuCommands = [];
        queueMicrotask(() => commands.forEach((command) => menuCommandHandler?.(command)));
      }
      return () => { menuCommandHandler = null; };
    },
    updateState: (state) => {
      const value = state && typeof state === 'object' ? state : {};
      ipcRenderer.send('guanyi-menu:state', {
        hasDocument: !!value.hasDocument,
        hasDiskPath: !!value.hasDiskPath,
        hasDirectories: !!value.hasDirectories,
        canUndo: !!value.canUndo,
        canRedo: !!value.canRedo,
        plainText: !!value.plainText,
        viewMode: ['source', 'preview', 'split'].includes(value.viewMode) ? value.viewMode : 'split',
        theme: value.theme === 'dark' ? 'dark' : 'light'
      });
    }
  }),
  ai: Object.freeze({
    chat: (request) => ipcRenderer.invoke('guanyi-ai:chat', request),
    models: (request) => ipcRenderer.invoke('guanyi-ai:models', request),
    cancel: (requestId) => ipcRenderer.invoke('guanyi-ai:cancel', requestId)
  }),
  semantic: Object.freeze({
    status: () => ipcRenderer.invoke('guanyi-semantic:status'),
    indexDocuments: (documents, options) => ipcRenderer.invoke('guanyi-semantic:index', { documents, options }),
    search: (query, limit, options) => ipcRenderer.invoke('guanyi-semantic:search', { query, limit, options }),
    onProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('guanyi-semantic:progress', listener);
      return () => ipcRenderer.removeListener('guanyi-semantic:progress', listener);
    }
  })
}));
