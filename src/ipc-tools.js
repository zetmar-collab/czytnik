// Kanały IPC: konwersja książek, synchronizacja z czytnikami USB, aktualizacje z GitHuba.
// Renderer jest niezaufany: wszystkie identyfikatory sprawdzamy, urządzenia wskazujemy wyłącznie spośród
// faktycznie wykrytych, a adres i plik aktualizacji pochodzą z ostatniego sprawdzenia po stronie głównej.
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const db = require('./db');
const V = require('./validate');
const convert = require('./convert');
const devices = require('./devices');
const updater = require('./updater');

function registerTools(ipcMain, ctx) {
  const { app, dialog, shell, net, BrowserWindow, getWin, getCoversDir, scanner, testMode } = ctx;
  const parent = (e) => BrowserWindow.fromWebContents(e.sender) || getWin();
  const emit = (e, ch, p) => { if (!e.sender.isDestroyed()) e.sender.send(ch, p); };
  const busy = new Set();
  const exclusive = async (name, fn) => {
    if (busy.has(name)) throw new Error('Ta operacja już trwa');
    busy.add(name);
    try { return await fn(); } finally { busy.delete(name); }
  };

  // ---------- konwersja ----------

  async function printPdf(htmlFile, outFile) {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false } });
    try {
      await w.loadFile(htmlFile);
      const buf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: false, margins: { marginType: 'default' } });
      await fsp.writeFile(outFile, buf);
    } finally {
      w.destroy();
    }
  }
  const convOpts = { printPdf, tmpDir: os.tmpdir() };
  const fmt = (f) => { if (!convert.FORMATS[String(f)]) throw new Error('Nieobsługiwany format'); return String(f); };

  ipcMain.handle('convert:book', async (e, id, format) => {
    const book = db.getBook(V.asId(id));
    if (!book) throw new Error('Nie ma takiej książki');
    format = fmt(format);
    const res = await dialog.showSaveDialog(parent(e), {
      title: 'Zapisz skonwertowaną książkę',
      defaultPath: convert.defaultFileName(book, format),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    return await exclusive('convert', async () => ({ file: await convert.convertBook(book, format, res.filePath, convOpts) }));
  });

  ipcMain.handle('convert:many', async (e, ids, format) => {
    ids = V.asIdList(ids);
    format = fmt(format);
    const res = await dialog.showOpenDialog(parent(e), { title: 'Wybierz folder docelowy', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const dir = res.filePaths[0];
    return await exclusive('convert', async () => {
      const rep = { ok: [], failed: [], dir };
      for (let i = 0; i < ids.length; i++) {
        const book = db.getBook(ids[i]);
        if (!book) continue;
        emit(e, 'convert:progress', { done: i, total: ids.length, current: book.title });
        try {
          let out = path.join(dir, convert.defaultFileName(book, format));
          for (let n = 2; await fsp.access(out).then(() => true, () => false); n++) {
            out = path.join(dir, convert.defaultFileName(book, format).replace(/\.(\w+)$/, ` (${n}).$1`));
          }
          await convert.convertBook(book, format, out, convOpts);
          rep.ok.push({ id: book.id, title: book.title, file: out });
        } catch (err) {
          rep.failed.push({ id: book.id, title: book.title || book.path, error: err.message });
        }
      }
      emit(e, 'convert:progress', { done: ids.length, total: ids.length, current: null });
      return rep;
    });
  });

  // ---------- czytniki USB ----------

  const importDir = () => db.getSetting('deviceImportDir', null) || path.join(app.getPath('documents'), 'Czytnik');
  const pickDevice = async (root) => {
    const dev = (await devices.listDevices()).find((d) => d.root === String(root));
    if (!dev) throw new Error('Urządzenie nie jest już podłączone');
    return dev;
  };
  const sendBooks = async (e, dev, opts) => {
    const ids = opts.scope === 'selected' ? V.asIdList(opts.ids) : null;
    const collectionId = opts.scope === 'shelf' ? V.asId(opts.collectionId) : null;
    const books = devices.booksForExport({ ids: ids || undefined, collectionId });
    return await devices.exportBooks(dev, books, {
      folderPerShelf: opts.folderPerShelf !== false,
      onProgress: (p) => emit(e, 'dev:progress', { phase: 'send', ...p }),
    });
  };
  const receiveBooks = async (e, dev) => devices.importFromDevice(dev, {
    libraryDir: importDir(),
    importer: (paths) => scanner.importFiles(paths, getCoversDir()),
    onProgress: (p) => emit(e, 'dev:progress', { phase: 'receive', ...p }),
  });

  ipcMain.handle('dev:list', () => devices.listDevices());
  ipcMain.handle('dev:count', async (_e, root) => (await devices.listDeviceBooks(await pickDevice(root))).length);
  ipcMain.handle('dev:send', (e, root, opts) => exclusive('device', async () => sendBooks(e, await pickDevice(root), opts || {})));
  ipcMain.handle('dev:receive', (e, root) => exclusive('device', async () => {
    return await receiveBooks(e, await pickDevice(root));
  }));
  ipcMain.handle('dev:sync', (e, root, opts) => exclusive('device', async () => {
    const dev = await pickDevice(root);
    const sent = await sendBooks(e, dev, opts || {});
    const received = await receiveBooks(e, dev);
    return { sent, received };
  }));
  ipcMain.handle('dev:importDir', () => importDir());
  ipcMain.handle('dev:pickImportDir', async (e) => {
    const res = await dialog.showOpenDialog(parent(e), { title: 'Folder na książki pobrane z czytnika', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    db.setSetting('deviceImportDir', res.filePaths[0]);
    return { dir: res.filePaths[0] };
  });

  // ---------- aktualizacje ----------

  const isStore = !!process.windowsStore;
  const UA = { 'User-Agent': 'Czytnik-updater', Accept: 'application/vnd.github+json' };
  const fetchJson = async (url) => {
    const res = await net.fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
    return await res.json();
  };
  let last = null;      // ostatni wynik sprawdzenia (źródło adresu pobierania)
  let downloaded = null; // { file, version }

  async function check({ silent }) {
    const info = await updater.checkForUpdate({ currentVersion: app.getVersion(), fetchJson, isStore });
    db.setSetting('updateCheckedAt', Date.now());
    last = info;
    if (silent && info.version && db.getSetting('updateSkip', '') === info.version) return { ...info, available: false, skipped: true };
    return info;
  }

  ipcMain.handle('update:check', () => check({ silent: false }));
  ipcMain.handle('update:prefs', () => ({
    auto: db.getSetting('updateAuto', true) !== false, skip: db.getSetting('updateSkip', ''),
    store: isStore, current: app.getVersion(), checkedAt: db.getSetting('updateCheckedAt', 0),
  }));
  ipcMain.handle('update:setAuto', (_e, on) => { db.setSetting('updateAuto', !!on); return true; });
  ipcMain.handle('update:skip', (_e, version) => { db.setSetting('updateSkip', V.asString(version, 40)); return true; });

  ipcMain.handle('update:download', (e) => exclusive('update', async () => {
    if (isStore) throw new Error('Wersja ze sklepu Microsoft Store aktualizuje się przez sklep');
    if (!last?.available || !last.asset) throw new Error('Brak dostępnej aktualizacji do pobrania');
    let sha = null;
    if (last.checksumUrl) {
      try {
        updater.assertReleaseUrl(last.checksumUrl);
        const res = await net.fetch(last.checksumUrl, { headers: UA });
        if (res.ok) sha = updater.sha512FromYml(await res.text(), last.asset.name);
      } catch { /* bez sumy kontrolnej — UI pokaże ostrzeżenie */ }
    }
    const dest = path.join(app.getPath('downloads'), last.asset.name);
    const out = await updater.download({
      url: last.asset.url, destFile: dest, expectedSha512: sha, expectedSize: last.asset.size,
      fetchRaw: (u, o) => net.fetch(u, { ...o, headers: UA }),
      onProgress: (p) => emit(e, 'update:progress', p),
    });
    downloaded = { file: out.file, version: last.version };
    return { ...out, version: last.version };
  }));

  ipcMain.handle('update:install', async (e) => {
    if (!downloaded) throw new Error('Najpierw pobierz aktualizację');
    if (process.platform !== 'win32') { shell.showItemInFolder(downloaded.file); return { revealed: true }; }
    const ask = await dialog.showMessageBox(parent(e), {
      type: 'question', buttons: ['Zainstaluj i zamknij Czytnika', 'Anuluj'], defaultId: 1, cancelId: 1,
      title: 'Aktualizacja Czytnika', message: `Zainstalować wersję ${downloaded.version}?`,
      detail: 'Czytnik zostanie zamknięty, a instalator uruchomi się automatycznie.',
    });
    if (ask.response !== 0) return { canceled: true };
    const err = await shell.openPath(downloaded.file);
    if (err) throw new Error(err);
    setTimeout(() => app.quit(), 800);
    return { started: true };
  });

  // Sprawdzenie w tle po starcie (raz na dobę), o ile użytkownik go nie wyłączył.
  return {
    async startupCheck(win) {
      if (isStore || testMode || db.getSetting('updateAuto', true) === false) return;
      if (Date.now() - db.getSetting('updateCheckedAt', 0) < 20 * 3600 * 1000) return;
      try {
        const info = await check({ silent: true });
        if (info.available && win && !win.isDestroyed()) win.webContents.send('update:available', info);
      } catch { /* brak sieci — spróbujemy następnym razem */ }
    },
  };
}

module.exports = { registerTools };
