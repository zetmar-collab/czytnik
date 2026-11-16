// Kanały IPC nowszych funkcji: adnotacje, półki/tagi, duplikaty, statystyki.
// Wszystkie dane z renderera są walidowane (renderer wyświetla cudzą treść — jest niezaufany).
const db = require('./db');
const V = require('./validate');

const ANN_TYPES = new Set(['highlight', 'note', 'bookmark']);
const COLOR = /^#[0-9a-fA-F]{6}$/;

function register(ipcMain) {
  // ---- adnotacje ----
  ipcMain.handle('ann:list', (_e, bookId) => db.listAnnotations(V.asId(bookId)));

  ipcMain.handle('ann:add', (_e, a) => {
    if (!a || !ANN_TYPES.has(a.type)) throw new Error('Nieprawidłowy typ adnotacji');
    const loc = V.asString(a.loc, 2000);
    if (!loc) throw new Error('Brak lokalizacji adnotacji');
    return db.addAnnotation({
      book_id: V.asId(a.book_id),
      type: a.type,
      loc,
      text: V.asString(a.text, 3000),
      note: V.asString(a.note, 8000),
      color: COLOR.test(a.color || '') ? a.color : null,
    });
  });

  ipcMain.handle('ann:update', (_e, uid, fields) => {
    const f = {};
    if (fields && 'note' in fields) f.note = V.asString(fields.note, 8000);
    if (fields && 'color' in fields && COLOR.test(fields.color || '')) f.color = fields.color;
    return db.updateAnnotation(V.asString(uid, 80), f);
  });

  ipcMain.handle('ann:delete', (_e, uid) => { db.deleteAnnotation(V.asString(uid, 80)); return true; });

  // ---- półki (kolekcje), tagi, serie ----
  ipcMain.handle('col:list', () => db.listCollections());
  ipcMain.handle('col:create', (_e, name) => db.createCollection(V.asString(name, 80)));
  ipcMain.handle('col:rename', (_e, id, name) => { db.renameCollection(V.asId(id), V.asString(name, 80)); return true; });
  ipcMain.handle('col:delete', (_e, id) => { db.deleteCollection(V.asId(id)); return true; });
  ipcMain.handle('col:ofBook', (_e, bookId) => db.getBookCollections(V.asId(bookId)));
  ipcMain.handle('col:setForBook', (_e, bookId, ids) => { db.setBookCollections(V.asId(bookId), V.asIdList(ids)); return true; });
  ipcMain.handle('col:addBooks', (_e, bookIds, collectionId) => {
    db.addBooksToCollection(V.asIdList(bookIds), V.asId(collectionId));
    return true;
  });
  ipcMain.handle('tags:list', () => db.listTags());
  ipcMain.handle('series:list', () => db.listSeries());

  // ---- duplikaty ----
  ipcMain.handle('dups:find', () => db.findDuplicates());

  // ---- czas czytania ----
  ipcMain.handle('stats:addSeconds', (_e, bookId, seconds) => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    db.addReadingSeconds(V.asId(bookId), Number(seconds) || 0, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    return true;
  });
  ipcMain.handle('stats:get', () => db.getStats());

  // ---- wyszukiwanie w treści całej biblioteki ----
  const fulltext = require('./fulltext');
  ipcMain.handle('fts:status', () => fulltext.status());
  ipcMain.handle('fts:build', async (e) => {
    const sender = e.sender;
    return await fulltext.indexAll((p) => { if (!sender.isDestroyed()) sender.send('fts:progress', p); });
  });
  ipcMain.handle('fts:cancel', () => { fulltext.cancel(); return true; });
  ipcMain.handle('fts:search', (_e, q) => fulltext.search(V.asString(q, 200)));
}

// ---- kopia zapasowa i synchronizacja przez folder ----
function registerSync(ipcMain, { dialog, BrowserWindow, getWin, onChanged }) {
  const sync = require('./sync');
  const fs = require('fs');
  let watcher = null;
  let timer = null;
  let busy = false;

  const parent = (e) => BrowserWindow.fromWebContents(e.sender) || getWin();

  async function runSync() {
    const dir = db.getSetting('syncDir', null);
    if (!dir || busy) return null;
    busy = true;
    try {
      const rep = await sync.syncFolder(dir);
      db.setSetting('syncLast', { at: rep.syncedAt, files: rep.files, errors: rep.errors });
      if (rep.annotationsAdded || rep.annotationsUpdated || rep.progress || rep.collections || rep.reading) onChanged?.(rep);
      return rep;
    } catch (err) {
      db.setSetting('syncLast', { at: Date.now(), files: 0, errors: [err.message] });
      return { error: err.message };
    } finally {
      busy = false;
    }
  }

  function startWatch() {
    stopWatch();
    const dir = db.getSetting('syncDir', null);
    if (!dir) return;
    try {
      let t = null;
      watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (!name || !String(name).endsWith(sync.SYNC_SUFFIX) || String(name).startsWith(sync.deviceId())) return;
        clearTimeout(t);
        t = setTimeout(runSync, 3000); // plik z chmury bywa zapisywany kilkoma zdarzeniami
      });
      watcher.on('error', () => {});
    } catch { /* folder chwilowo niedostępny — odpali okresowa synchronizacja */ }
    timer = setInterval(runSync, 5 * 60 * 1000);
  }
  function stopWatch() {
    try { watcher?.close(); } catch { /* ignoruj */ }
    clearInterval(timer);
    watcher = null;
    timer = null;
  }

  ipcMain.handle('backup:export', async (e) => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const res = await dialog.showSaveDialog(parent(e), {
      title: 'Zapisz kopię zapasową biblioteki',
      defaultPath: `Czytnik-kopia-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`,
      filters: [{ name: 'Kopia zapasowa Czytnika', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    return { ...(await sync.exportToFile(res.filePath)), file: res.filePath };
  });
  ipcMain.handle('backup:import', async (e) => {
    const res = await dialog.showOpenDialog(parent(e), {
      title: 'Wczytaj kopię zapasową',
      properties: ['openFile'],
      filters: [{ name: 'Kopia zapasowa Czytnika', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const rep = await sync.importFromFile(res.filePaths[0]);
    onChanged?.(rep);
    return rep;
  });

  ipcMain.handle('sync:status', () => ({ dir: db.getSetting('syncDir', null), last: db.getSetting('syncLast', null) }));
  ipcMain.handle('sync:pickFolder', async (e) => {
    const res = await dialog.showOpenDialog(parent(e), {
      title: 'Wybierz folder synchronizacji (np. w OneDrive lub Dropbox)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    db.setSetting('syncDir', res.filePaths[0]);
    startWatch();
    return { dir: res.filePaths[0], report: await runSync() };
  });
  ipcMain.handle('sync:now', () => runSync());
  ipcMain.handle('sync:disable', () => { db.setSetting('syncDir', null); stopWatch(); return true; });

  return { start() { startWatch(); setTimeout(runSync, 4000); }, runSync, stop: stopWatch };
}

module.exports = { register, registerSync };
