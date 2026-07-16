const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const db = require('./src/db');
const scanner = require('./src/scanner');
const metadata = require('./src/metadata');

let win = null;
let coversDir = null;

// tryb testowy: osobny, tymczasowy katalog danych
if (process.env.CZYTNIK_SMOKE) {
  const os = require('os');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'czytnik-smoke-')));
}

// Własny protokół app:// — dzięki niemu w rendererze działają moduły ES,
// fetch() (wymagany przez foliate-js do PDF) oraz web workery.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

function registerAppProtocol() {
  const root = __dirname;
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    // app://covers/<plik> -> katalog okładek w danych użytkownika
    if (url.hostname === 'covers') {
      const file = path.normalize(path.join(coversDir, pathname));
      if (!file.startsWith(coversDir)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    }
    const file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
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
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
  });
  win.loadURL('app://bundle/renderer/index.html');
}

app.whenReady().then(async () => {
  coversDir = path.join(app.getPath('userData'), 'covers');
  fs.mkdirSync(coversDir, { recursive: true });
  await db.open(app.getPath('userData'));
  registerAppProtocol();
  createWindow();
  if (process.env.CZYTNIK_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      require('./test/ui-smoke')(win, app);
    });
  }
});

app.on('window-all-closed', () => {
  db.persist();
  app.quit();
});
app.on('before-quit', () => db.persist());

// ---------- IPC: biblioteka ----------

ipcMain.handle('books:list', (_e, filters) => db.listBooks(filters || {}));
ipcMain.handle('books:get', (_e, id) => db.getBook(id));
ipcMain.handle('books:update', (_e, id, fields) => {
  db.updateBook(id, fields);
  return db.getBook(id);
});
ipcMain.handle('books:remove', (_e, id) => {
  const book = db.getBook(id);
  if (book?.cover && book.cover.startsWith(coversDir)) {
    try { fs.unlinkSync(book.cover); } catch { /* ignoruj */ }
  }
  db.removeBook(id);
  return true;
});
ipcMain.handle('books:prune', () => db.pruneMissing());
ipcMain.handle('books:removeMany', (_e, ids) => {
  let removed = 0;
  for (const id of ids) {
    const book = db.getBook(id);
    if (!book) continue;
    if (book.cover && book.cover.startsWith(coversDir)) {
      try { fs.unlinkSync(book.cover); } catch { /* ignoruj */ }
    }
    db.removeBook(id);
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
  const result = await scanner.scan(dirs, coversDir, (p) => {
    win?.webContents.send('scan:progress', p);
  }, formats);
  db.persist();
  return result;
});
ipcMain.handle('scan:cancel', () => scanner.cancelScan());

// ---------- IPC: czytanie plików ----------

ipcMain.handle('book:read', async (_e, id) => {
  const book = db.getBook(id);
  if (!book) throw new Error('Nie znaleziono książki');
  const data = await fsp.readFile(book.path);
  db.updateBook(id, { last_opened: Date.now() });
  return { name: path.basename(book.path), format: book.format, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

ipcMain.handle('book:progress', (_e, id, progress, pct) => {
  db.updateBook(id, { progress, progress_pct: pct });
  return true;
});

ipcMain.handle('book:saveCover', async (_e, id, arrayBuffer, ext) => {
  const file = path.join(coversDir, `${id}.${ext || 'jpg'}`);
  await fsp.writeFile(file, Buffer.from(arrayBuffer));
  db.updateBook(id, { cover: file });
  return file;
});

ipcMain.handle('book:pickCover', async (_e, id) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Wybierz plik okładki',
    properties: ['openFile'],
    filters: [{ name: 'Obrazy', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const src = res.filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase() || 'jpg';
  const dest = path.join(coversDir, `${id}.${ext}`);
  await fsp.copyFile(src, dest);
  db.updateBook(id, { cover: dest, meta_source: 'reczne' });
  return dest;
});

ipcMain.handle('book:showInFolder', (_e, id) => {
  const book = db.getBook(id);
  if (book) shell.showItemInFolder(book.path);
});

// ---------- IPC: metadane z internetu ----------

ipcMain.handle('meta:search', async (_e, source, query) => {
  return await metadata.search(source, query);
});

ipcMain.handle('meta:apply', async (_e, id, candidate) => {
  const full = await metadata.details(candidate);
  const fields = { meta_source: full.source };
  if (full.title) fields.title = full.title;
  if (full.author) fields.author = full.author;
  if (full.description) fields.description = full.description;
  if (full.publisher) fields.publisher = full.publisher;
  if (full.year) fields.year = full.year;
  if (full.isbn) fields.isbn = full.isbn;
  if (full.rating != null) fields.rating = full.rating;
  if (full.coverUrl) {
    try {
      const { buf, ext } = await metadata.downloadCover(full.coverUrl);
      const file = path.join(coversDir, `${id}.${ext}`);
      await fsp.writeFile(file, buf);
      fields.cover = file;
    } catch { /* okładka opcjonalna */ }
  }
  db.updateBook(id, fields);
  return db.getBook(id);
});

// ---------- IPC: ustawienia ----------

ipcMain.handle('settings:get', (_e, key, def) => db.getSetting(key, def));
ipcMain.handle('settings:set', (_e, key, value) => {
  db.setSetting(key, value);
  return true;
});

// Zamiana ścieżki okładki na URL app://covers/...
ipcMain.handle('cover:url', (_e, coverPath) => {
  if (!coverPath) return null;
  return 'app://covers/' + encodeURIComponent(path.basename(coverPath));
});
