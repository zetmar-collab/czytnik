const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // biblioteka
  listBooks: (filters) => ipcRenderer.invoke('books:list', filters),
  getBook: (id) => ipcRenderer.invoke('books:get', id),
  updateBook: (id, fields) => ipcRenderer.invoke('books:update', id, fields),
  removeBook: (id) => ipcRenderer.invoke('books:remove', id),
  pruneMissing: () => ipcRenderer.invoke('books:prune'),
  clearLibrary: () => ipcRenderer.invoke('books:clear'),
  removeMany: (ids) => ipcRenderer.invoke('books:removeMany', ids),
  addFiles: () => ipcRenderer.invoke('books:addFiles'),
  addFolder: () => ipcRenderer.invoke('books:addFolder'),

  // skanowanie
  listDrives: () => ipcRenderer.invoke('scan:drives'),
  pickFolder: () => ipcRenderer.invoke('scan:pickFolder'),
  startScan: (dirs, formats) => ipcRenderer.invoke('scan:start', dirs, formats),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  onScanProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },

  // czytanie
  readBook: (id) => ipcRenderer.invoke('book:read', id),
  saveProgress: (id, progress, pct) => ipcRenderer.invoke('book:progress', id, progress, pct),
  saveCover: (id, arrayBuffer, ext) => ipcRenderer.invoke('book:saveCover', id, arrayBuffer, ext),
  pickCover: (id) => ipcRenderer.invoke('book:pickCover', id),
  showInFolder: (id) => ipcRenderer.invoke('book:showInFolder', id),

  // metadane online
  searchMeta: (source, query) => ipcRenderer.invoke('meta:search', source, query),
  applyMeta: (id, candidate) => ipcRenderer.invoke('meta:apply', id, candidate),

  // ustawienia
  getSetting: (key, def) => ipcRenderer.invoke('settings:get', key, def),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  coverUrl: (coverPath) => ipcRenderer.invoke('cover:url', coverPath),
});
