const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const db = require('./src/db');
const scanner = require('./src/scanner');
const metadata = require('./src/metadata');
const bulkmeta = require('./src/bulkmeta');
const covers = require('./src/covers');
const tts = require('./src/tts');
const V = require('./src/validate');

let win = null;
let coversDir = null;
let pendingBookPath = null; // plik wskazany przy starcie (dwuklik w Eksploratorze)

const { READABLE, bookPathFromArgv } = require('./src/cli');

// tryb testowy: osobny, tymczasowy katalog danych
const TEST_MODE = !app.isPackaged && !!(process.env.CZYTNIK_SMOKE || process.env.CZYTNIK_SHOTS || process.env.CZYTNIK_CHECK || process.env.CZYTNIK_TTS_PDF_CHECK);
if (TEST_MODE) {
  const os = require('os');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'czytnik-smoke-')));
}

// Jedna instancja aplikacji — kolejne uruchomienia (np. dwuklik na pliku)
// przekazują ścieżkę do już działającego okna zamiast otwierać drugie.
if (!TEST_MODE) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', async (_e, argv) => {
      const file = bookPathFromArgv(argv);
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
        if (file) await openBookFromPath(file);
      }
    });
  }
}

// Własny protokół app:// — dzięki niemu w rendererze działają moduły ES,
// fetch() (wymagany przez foliate-js do PDF) oraz web workery.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

// Z protokołu app:// serwujemy wyłącznie interfejs i bibliotekę foliate-js (nie całe drzewo aplikacji).
const APP_ALLOWED = ['renderer', path.join('node_modules', 'foliate-js')];

function registerAppProtocol() {
  const root = __dirname;
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    try {
      // app://covers/<plik> -> katalog okładek w danych użytkownika
      if (url.hostname === 'covers') {
        return net.fetch(pathToFileURL(V.safeJoin(coversDir, '.' + pathname)).toString());
      }
      const file = V.safeJoin(root, '.' + pathname);
      if (!APP_ALLOWED.some((dir) => V.isInside(path.join(root, dir), file))) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1c1b1a',
    autoHideMenuBar: true,
    title: 'Czytnik',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') {
      console.log(`[renderer] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
  });
  win.loadURL('app://bundle/renderer/index.html');
}

// Dodaje plik do biblioteki (jeśli jeszcze go nie ma) i każe rendererowi
// otworzyć go od razu w czytniku.
async function openBookFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!READABLE.includes(ext)) return null;
  await scanner.importFiles([filePath], coversDir);
  db.persist();
  const book = db.getBookByPath(filePath);
  if (!book) return null;
  win?.webContents.send('open-book', book.id);
  return book;
}

// Błąd krytyczny przy starcie: pokazujemy komunikat i kończymy, zamiast zostawiać proces bez okna.
function fatalStartup(err) {
  try {
    dialog.showErrorBox('Czytnik nie może się uruchomić', String(err && err.message || err));
  } catch { /* ignoruj */ }
  app.exit(1);
}
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

app.whenReady().then(async () => {
  try {
    coversDir = path.join(app.getPath('userData'), 'covers');
    fs.mkdirSync(coversDir, { recursive: true });
    await db.open(app.getPath('userData'));
    require('./src/fulltext').init(app.getPath('userData'));
  } catch (err) {
    fatalStartup(err);
    return;
  }
  registerAppProtocol();
  pendingBookPath = bookPathFromArgv(process.argv);
  createWindow();
  win.webContents.once('did-finish-load', async () => {
    if (TEST_MODE && process.env.CZYTNIK_SMOKE) {
      require('./test/ui-smoke')(win, app);
      return;
    }
    if (TEST_MODE && process.env.CZYTNIK_SHOTS) {
      require('./test/store-screenshots')(win, app);
      return;
    }
    if (TEST_MODE && process.env.CZYTNIK_CHECK) {
      require('./test/check-pdf')(win, app);
      return;
    }
    if (TEST_MODE && process.env.CZYTNIK_TTS_PDF_CHECK) {
      require('./test/tts-pdf-check')(win, app);
      return;
    }
    syncCtl.start();
    require('./src/sync').autoBackup(app.getPath('userData')).catch(() => {});
    toolsCtl.startupCheck(win);
    if (db.openInfo.recovered) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Odzyskano bazę biblioteki',
        message: 'Plik bazy danych był uszkodzony, więc utworzono nową, pustą bibliotekę.',
        detail: (db.openInfo.corruptCopy ? `Uszkodzony plik zachowano jako:
${db.openInfo.corruptCopy}

` : '') +
          'Możesz przywrócić ostatnią kopię z folderu backups w katalogu danych aplikacji albo ponownie przeskanować dyski.',
      });
    }
    if (pendingBookPath) {
      await openBookFromPath(pendingBookPath);
      pendingBookPath = null;
    }
  });
});

app.on('window-all-closed', () => {
  db.persist();
  tts.dispose();
  app.quit();
});
app.on('before-quit', () => {
  db.persist();
  tts.dispose();
});

// ---------- IPC: biblioteka ----------

ipcMain.handle('books:list', (_e, filters) => db.listBooks(filters || {}));
ipcMain.handle('books:get', (_e, id) => db.getBook(V.asId(id)));
// Pola, które renderer może zapisać. Ścieżka pliku, okładka i postęp mają własne, walidowane kanały.
const RENDERER_FIELDS = ['title', 'author', 'description', 'publisher', 'year', 'isbn', 'series', 'rating', 'meta_source', 'tags', 'tts_section', 'tts_chunk'];
ipcMain.handle('books:update', (_e, id, fields) => {
  id = V.asId(id);
  const clean = {};
  for (const k of RENDERER_FIELDS) {
    if (!fields || !(k in fields)) continue;
    const v = fields[k];
    if (k === 'rating' || k === 'tts_section' || k === 'tts_chunk') clean[k] = v == null ? null : Number(v);
    else clean[k] = V.asString(v, k === 'description' ? 20000 : 500);
  }
  db.updateBook(id, clean);
  return db.getBook(id);
});
ipcMain.handle('books:remove', (_e, id) => {
  id = V.asId(id);
  const book = db.getBook(id);
  if (book?.cover && book.cover.startsWith(coversDir)) {
    try { fs.unlinkSync(book.cover); } catch { /* ignoruj */ }
  }
  db.removeBook(id);
  require('./src/fulltext').removeIndex(id);
  return true;
});
ipcMain.handle('books:prune', () => db.pruneMissing());
ipcMain.handle('books:removeMany', (_e, ids) => {
  let removed = 0;
  for (const id of V.asIdList(ids)) {
    const book = db.getBook(id);
    if (!book) continue;
    if (book.cover && V.isInside(coversDir, book.cover)) {
      try { fs.unlinkSync(book.cover); } catch { /* ignoruj */ }
    }
    db.removeBook(id);
    require('./src/fulltext').removeIndex(id);
    removed++;
  }
  return removed;
});
ipcMain.handle('books:addFiles', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Wybierz pliki książek',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'E-booki', extensions: ['epub', 'mobi', 'azw3', 'pdf'] },
      { name: 'Wszystkie pliki', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const result = await scanner.importFiles(res.filePaths, coversDir);
  db.persist();
  return result;
});
// Otwiera dowolny e-book z dysku prosto w czytniku (i dopisuje go do biblioteki,
// dzięki czemu zapamiętywany jest postęp czytania).
ipcMain.handle('books:openExternal', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Otwórz e-booka',
    properties: ['openFile'],
    filters: [
      { name: 'E-booki', extensions: ['epub', 'mobi', 'azw3', 'pdf'] },
      { name: 'EPUB', extensions: ['epub'] },
      { name: 'MOBI / AZW3', extensions: ['mobi', 'azw3'] },
      { name: 'PDF', extensions: ['pdf'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  if (!READABLE.includes(path.extname(filePath).toLowerCase())) {
    throw new Error('Nieobsługiwany format pliku');
  }
  await scanner.importFiles([filePath], coversDir);
  db.persist();
  return db.getBookByPath(filePath);
});

ipcMain.handle('books:addFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Wybierz folder z książkami',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const result = await scanner.scan(res.filePaths, coversDir, (p) => {
    win?.webContents.send('scan:progress', p);
  });
  db.persist();
  return result;
});
ipcMain.handle('books:clear', async () => {
  // czyści bibliotekę (pliki książek na dysku zostają nietknięte) + pamięć okładek
  const count = db.clearBooks();
  try {
    for (const f of fs.readdirSync(coversDir)) {
      fs.unlinkSync(path.join(coversDir, f));
    }
  } catch { /* ignoruj */ }
  return count;
});

// ---------- IPC: skanowanie ----------

ipcMain.handle('scan:drives', () => scanner.listDrives());
ipcMain.handle('scan:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Wybierz foldery do skanowania',
    properties: ['openDirectory', 'multiSelections'],
  });
  return res.canceled ? [] : res.filePaths;
});
ipcMain.handle('scan:start', async (_e, dirs, formats) => {
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string' && path.isAbsolute(d))) throw new Error('Nieprawidłowe foldery');
  formats = Array.isArray(formats) ? formats.filter((f) => ['epub', 'mobi', 'azw3', 'pdf'].includes(f)) : null;
  const result = await scanner.scan(dirs, coversDir, (p) => {
    win?.webContents.send('scan:progress', p);
  }, formats);
  db.persist();
  return result;
});
ipcMain.handle('scan:cancel', () => scanner.cancelScan());

// ---------- IPC: czytanie plików ----------

ipcMain.handle('book:read', async (_e, id) => {
  id = V.asId(id);
  const book = db.getBook(id);
  if (!book) throw new Error('Nie znaleziono książki');
  const data = await fsp.readFile(book.path);
  db.updateBook(id, { last_opened: Date.now() });
  return { name: path.basename(book.path), format: book.format, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

ipcMain.handle('book:progress', (_e, id, progress, pct) => {
  const frac = Math.min(1, Math.max(0, Number(pct) || 0));
  db.updateBook(V.asId(id), { progress: V.asString(progress, 2000), progress_pct: frac });
  return true;
});

ipcMain.handle('book:saveCover', async (_e, id, arrayBuffer, ext) => {
  id = V.asId(id);
  const data = Buffer.from(arrayBuffer);
  if (data.length > 15 * 1024 * 1024) throw new Error('Okładka jest zbyt duża');
  const file = V.safeJoin(coversDir, `${id}.${V.sniffImage(data) || V.asImageExt(ext)}`);
  await fsp.writeFile(file, data);
  db.updateBook(id, { cover: file });
  return file;
});

ipcMain.handle('book:pickCover', async (_e, id) => {
  id = V.asId(id);
  const res = await dialog.showOpenDialog(win, {
    title: 'Wybierz plik okładki',
    properties: ['openFile'],
    filters: [{ name: 'Obrazy', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const src = res.filePaths[0];
  const data = await fsp.readFile(src);
  if (data.length > 15 * 1024 * 1024) throw new Error('Okładka jest zbyt duża');
  const ext = V.sniffImage(data);
  if (!ext) throw new Error('Wybrany plik nie jest obrazem');
  const dest = V.safeJoin(coversDir, `${id}.${ext}`);
  await fsp.writeFile(dest, data);
  db.updateBook(id, { cover: dest, meta_source: 'reczne' });
  return dest;
});

ipcMain.handle('book:showInFolder', (_e, id) => {
  const book = db.getBook(V.asId(id));
  if (book) shell.showItemInFolder(book.path);
});

// ---------- IPC: metadane z internetu ----------

ipcMain.handle('meta:search', async (_e, source, query) => {
  return await metadata.search(String(source), V.asString(query, 300) || '');
});

ipcMain.handle('meta:apply', async (_e, id, candidate) => {
  id = V.asId(id);
  if (!candidate || typeof candidate !== 'object') throw new Error('Nieprawidłowy kandydat');
  return await bulkmeta.applyCandidate(id, candidate, coversDir);
});

// Masowe uzupełnianie metadanych książek znanych tylko z pliku.
ipcMain.handle('bulk:pending', () => bulkmeta.pending().length);
ipcMain.handle('bulk:run', async (e) => {
  const sender = e.sender;
  return await bulkmeta.run(coversDir, { onProgress: (p) => { if (!sender.isDestroyed()) sender.send('bulk:progress', p); } });
});
ipcMain.handle('bulk:cancel', () => { bulkmeta.cancel(); return true; });

// ---------- IPC: wyszukiwanie okładek ----------

ipcMain.handle('covers:search', async (_e, query) => {
  return await covers.searchCovers(V.asString(query, 300) || '');
});

ipcMain.handle('covers:apply', async (_e, id, url) => {
  id = V.asId(id);
  const { buf, ext } = await covers.download(String(url));
  const file = V.safeJoin(coversDir, `${id}.${ext}`);
  await fsp.writeFile(file, buf);
  db.updateBook(id, { cover: file });
  db.persist();
  return db.getBook(id);
});

const features = require('./src/ipc-features');
features.register(ipcMain);
const toolsCtl = require('./src/ipc-tools').registerTools(ipcMain, {
  app, dialog, shell, net, BrowserWindow, scanner, testMode: TEST_MODE,
  getWin: () => win, getCoversDir: () => coversDir,
});
ipcMain.handle('lib:count', () => db.get('SELECT COUNT(*) AS c FROM books').c);
ipcMain.handle('backup:autoStatus', () => ({
  on: db.getSetting('metaBackupAuto', true) !== false, last: db.getSetting('metaBackupAt', 0),
  dir: path.join(app.getPath('userData'), 'backups'),
}));
ipcMain.handle('backup:autoSet', (_e, on) => { db.setSetting('metaBackupAuto', !!on); return true; });
ipcMain.handle('backup:openFolder', async () => {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return await shell.openPath(dir);
});
const syncCtl = features.registerSync(ipcMain, {
  dialog, BrowserWindow, getWin: () => win,
  onChanged: () => { if (win && !win.isDestroyed()) win.webContents.send('data-changed'); },
});

// ---------- IPC: czytanie na głos (TTS) ----------

ipcMain.handle('tts:supported', () => tts.supported);
ipcMain.handle('tts:listVoices', () => tts.listVoices());
ipcMain.handle('tts:speak', (_e, text, opts) => {
  const o = opts || {};
  return tts.speak(V.asString(text, 5000) || '', {
    voice: o.voice ? V.asString(o.voice, 200) : undefined,
    rate: Number.isFinite(o.rate) ? Math.max(-10, Math.min(10, Math.round(o.rate))) : undefined,
  });
});
ipcMain.handle('tts:pause', () => tts.pause());
ipcMain.handle('tts:resume', () => tts.resume());
ipcMain.handle('tts:stop', () => tts.stop());

// ---------- IPC: ustawienia ----------

ipcMain.handle('settings:get', (_e, key, def) => {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(String(key))) throw new Error('Nieprawidłowy klucz ustawienia');
  return db.getSetting(String(key), def);
});
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
// Klawisze multimedialne przechwytujemy tylko na czas czytania na głos — inaczej odbierałyby je odtwarzaczom muzyki.
const MEDIA_KEYS = { MediaPlayPause: 'play-pause', MediaStop: 'stop', MediaNextTrack: 'next', MediaPreviousTrack: 'prev' };
function setMediaKeys(on) {
  for (const [accel, name] of Object.entries(MEDIA_KEYS)) {
    try {
      if (!on) globalShortcut.unregister(accel);
      else if (!globalShortcut.isRegistered(accel)) {
        globalShortcut.register(accel, () => { if (win && !win.isDestroyed()) win.webContents.send('media-key', name); });
      }
    } catch { /* skrót zajęty przez inną aplikację */ }
  }
}
ipcMain.handle('tts:active', (_e, active) => { setMediaKeys(!!active); return true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

const RESERVED_SETTINGS = new Set(['syncDir', 'syncLast', 'deviceId', 'deviceImportDir', 'updateAuto', 'updateSkip', 'updateCheckedAt', 'metaBackupAt', 'metaBackupAuto']); // zmienia je tylko proces główny
ipcMain.handle('settings:set', (_e, key, value) => {
  if (!SETTING_KEY.test(String(key))) throw new Error('Nieprawidłowy klucz ustawienia');
  if (RESERVED_SETTINGS.has(String(key))) throw new Error('To ustawienie jest zarezerwowane');
  if (JSON.stringify(value ?? null).length > 100000) throw new Error('Wartość ustawienia jest zbyt duża');
  db.setSetting(String(key), value);
  return true;
});

// Zamiana ścieżki okładki na URL app://covers/...
ipcMain.handle('cover:url', (_e, coverPath) => {
  if (!coverPath || !V.isInside(coversDir, String(coverPath))) return null;
  // Znacznik świeżości bierzemy z daty samego pliku okładki — inaczej po
  // podmianie okładki (metadane z sieci, własny plik) przeglądarka
  // pokazywałaby starą grafikę z pamięci podręcznej.
  let version = 0;
  try {
    version = Math.floor(fs.statSync(coverPath).mtimeMs);
  } catch { /* brak pliku — URL i tak zwróci 404 */ }
  return 'app://covers/' + encodeURIComponent(path.basename(coverPath)) + '?v=' + version;
});
