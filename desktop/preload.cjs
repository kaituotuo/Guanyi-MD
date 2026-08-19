const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guanyiDesktop', Object.freeze({
  platform: process.platform,
  semantic: Object.freeze({
    status: () => ipcRenderer.invoke('guanyi-semantic:status'),
    indexDocuments: (documents, options) => ipcRenderer.invoke('guanyi-semantic:index', { documents, options }),
    search: (query, limit) => ipcRenderer.invoke('guanyi-semantic:search', { query, limit }),
    onProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('guanyi-semantic:progress', listener);
      return () => ipcRenderer.removeListener('guanyi-semantic:progress', listener);
    }
  })
}));
