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
  openExternal: () => ipcRenderer.invoke('books:openExternal'),
  onOpenBook: (cb) => {
    const listener = (_e, id) => cb(id);
    ipcRenderer.on('open-book', listener);
    return () => ipcRenderer.removeListener('open-book', listener);
  },

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

  // okładki z internetu
  searchCovers: (query) => ipcRenderer.invoke('covers:search', query),
  applyCover: (id, url) => ipcRenderer.invoke('covers:apply', id, url),

  // adnotacje (zakładki, zakreślenia, notatki)
  listAnnotations: (bookId) => ipcRenderer.invoke('ann:list', bookId),
  addAnnotation: (a) => ipcRenderer.invoke('ann:add', a),
  updateAnnotation: (uid, fields) => ipcRenderer.invoke('ann:update', uid, fields),
  deleteAnnotation: (uid) => ipcRenderer.invoke('ann:delete', uid),

  // półki, tagi, serie, duplikaty, statystyki
  listCollections: () => ipcRenderer.invoke('col:list'),
  createCollection: (name) => ipcRenderer.invoke('col:create', name),
  renameCollection: (id, name) => ipcRenderer.invoke('col:rename', id, name),
  deleteCollection: (id) => ipcRenderer.invoke('col:delete', id),
  getBookCollections: (bookId) => ipcRenderer.invoke('col:ofBook', bookId),
  setBookCollections: (bookId, ids) => ipcRenderer.invoke('col:setForBook', bookId, ids),
  addBooksToCollection: (bookIds, collectionId) => ipcRenderer.invoke('col:addBooks', bookIds, collectionId),
  listTags: () => ipcRenderer.invoke('tags:list'),
  listSeries: () => ipcRenderer.invoke('series:list'),
  findDuplicates: () => ipcRenderer.invoke('dups:find'),
  addReadingSeconds: (bookId, seconds) => ipcRenderer.invoke('stats:addSeconds', bookId, seconds),
  getStats: () => ipcRenderer.invoke('stats:get'),

  // konwersja, czytniki USB, aktualizacje, licznik, autokopia metadanych
  convertBook: (id, format) => ipcRenderer.invoke('convert:book', id, format),
  convertMany: (ids, format) => ipcRenderer.invoke('convert:many', ids, format),
  onConvertProgress: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('convert:progress', l); return () => ipcRenderer.removeListener('convert:progress', l); },
  devList: () => ipcRenderer.invoke('dev:list'),
  devCount: (root) => ipcRenderer.invoke('dev:count', root),
  devSend: (root, opts) => ipcRenderer.invoke('dev:send', root, opts),
  devReceive: (root) => ipcRenderer.invoke('dev:receive', root),
  devSync: (root, opts) => ipcRenderer.invoke('dev:sync', root, opts),
  devImportDir: () => ipcRenderer.invoke('dev:importDir'),
  devPickImportDir: () => ipcRenderer.invoke('dev:pickImportDir'),
  onDevProgress: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('dev:progress', l); return () => ipcRenderer.removeListener('dev:progress', l); },
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updatePrefs: () => ipcRenderer.invoke('update:prefs'),
  updateSetAuto: (on) => ipcRenderer.invoke('update:setAuto', on),
  updateSkip: (version) => ipcRenderer.invoke('update:skip', version),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('update:progress', l); return () => ipcRenderer.removeListener('update:progress', l); },
  onUpdateAvailable: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on('update:available', l); return () => ipcRenderer.removeListener('update:available', l); },
  libraryCount: () => ipcRenderer.invoke('lib:count'),
  autoBackupStatus: () => ipcRenderer.invoke('backup:autoStatus'),
  autoBackupSet: (on) => ipcRenderer.invoke('backup:autoSet', on),
  openBackupFolder: () => ipcRenderer.invoke('backup:openFolder'),

  // masowe dopasowanie metadanych
  bulkPending: () => ipcRenderer.invoke('bulk:pending'),
  bulkRun: () => ipcRenderer.invoke('bulk:run'),
  bulkCancel: () => ipcRenderer.invoke('bulk:cancel'),
  onBulkProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('bulk:progress', listener);
    return () => ipcRenderer.removeListener('bulk:progress', listener);
  },

  // kopia zapasowa i synchronizacja przez folder
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncPickFolder: () => ipcRenderer.invoke('sync:pickFolder'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  syncDisable: () => ipcRenderer.invoke('sync:disable'),
  onDataChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('data-changed', listener);
    return () => ipcRenderer.removeListener('data-changed', listener);
  },

  // wyszukiwanie w treści całej biblioteki
  ftsStatus: () => ipcRenderer.invoke('fts:status'),
  ftsBuild: () => ipcRenderer.invoke('fts:build'),
  ftsCancel: () => ipcRenderer.invoke('fts:cancel'),
  ftsSearch: (q) => ipcRenderer.invoke('fts:search', q),
  onFtsProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('fts:progress', listener);
    return () => ipcRenderer.removeListener('fts:progress', listener);
  },

  // czytanie na głos (SAPI / System.Speech)
  platform: process.platform,
  ttsSupported: () => ipcRenderer.invoke('tts:supported'),
  ttsListVoices: () => ipcRenderer.invoke('tts:listVoices'),
  ttsSpeak: (text, opts) => ipcRenderer.invoke('tts:speak', text, opts),
  ttsPause: () => ipcRenderer.invoke('tts:pause'),
  ttsResume: () => ipcRenderer.invoke('tts:resume'),
  ttsStop: () => ipcRenderer.invoke('tts:stop'),
  ttsActive: (active) => ipcRenderer.invoke('tts:active', !!active),
  onMediaKey: (cb) => {
    const listener = (_e, key) => cb(key);
    ipcRenderer.on('media-key', listener);
    return () => ipcRenderer.removeListener('media-key', listener);
  },

  // ustawienia
  getSetting: (key, def) => ipcRenderer.invoke('settings:get', key, def),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  coverUrl: (coverPath) => ipcRenderer.invoke('cover:url', coverPath),
});
