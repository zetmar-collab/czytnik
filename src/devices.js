// Czytniki e-booków i tablety podłączone przez USB jako pamięć masowa (litera dysku / punkt montowania):
// Kindle, Kobo/Tolino, PocketBook, Onyx Boox i inne urządzenia z trybem „USB storage".
// Urządzenia MTP (większość tabletów z Androidem w trybie domyślnym) nie dostają litery dysku —
// takich nie da się obsłużyć jak zwykłego folderu; trzeba w nich włączyć tryb pamięci masowej.
//
// Synchronizacja dwustronna jest bezpieczna: niczego nie usuwa ani nie nadpisuje po żadnej stronie.
// „Półka" w Czytniku odpowiada podfolderowi na urządzeniu (poza Kindle, który nie pokazuje folderów).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const db = require('./db');

const ALL = ['epub', 'mobi', 'azw3', 'pdf'];
const EXT = { '.epub': 'epub', '.mobi': 'mobi', '.azw3': 'azw3', '.azw': 'mobi', '.pdf': 'pdf' };

const PROFILES = {
  kindle: { name: 'Kindle', formats: ['mobi', 'azw3', 'pdf'], dir: 'documents', folders: false },
  kobo: { name: 'Kobo / Tolino', formats: ['epub', 'pdf', 'mobi'], dir: '', folders: true },
  pocketbook: { name: 'PocketBook', formats: ALL, dir: 'Books', folders: true },
  tablet: { name: 'Tablet / Onyx Boox (pamięć masowa)', formats: ALL, dir: 'Books', folders: true },
  generic: { name: 'Urządzenie USB', formats: ALL, dir: 'Books', folders: true },
};

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Rozpoznaje typ urządzenia po znacznikach na dysku i etykiecie woluminu.
function detectKind(root, label = '') {
  if (isDir(path.join(root, '.kobo'))) return 'kobo';
  if (exists(path.join(root, 'system', 'version.txt')) || exists(path.join(root, '.active_content_sandbox')) ||
      (/kindle/i.test(label) && isDir(path.join(root, 'documents')))) return 'kindle';
  if (isDir(path.join(root, 'system', 'config')) || /^(pocketbook|pb\d)/i.test(label)) return 'pocketbook';
  if (isDir(path.join(root, 'Android')) || /boox|onyx/i.test(label)) return 'tablet';
  return 'generic';
}

function describe(root, label, total, free, known) {
  const kind = detectKind(root, label);
  const prof = PROFILES[kind];
  const booksDir = prof.dir ? path.join(root, prof.dir) : root;
  return {
    id: root, root, label: label || path.basename(root) || root, kind, name: prof.name, formats: prof.formats,
    folders: prof.folders, booksDir, total: total || 0, free: free || 0, known,
  };
}

// ---------- wykrywanie ----------

function psJson(cmd) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000, windowsHide: true }, (err, out) => {
      if (err) return resolve([]);
      try { const v = JSON.parse(out); resolve(Array.isArray(v) ? v : [v]); } catch { resolve([]); }
    });
  });
}

async function listDevices() {
  const out = [];
  if (process.platform === 'win32') {
    const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();
    const disks = await psJson('Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType | ConvertTo-Json -Compress');
    for (const d of disks) {
      const root = d.DeviceID + '\\';
      if (!d.DeviceID || d.DeviceID.toUpperCase() === sysDrive || !isDir(root)) continue;
      const dev = describe(root, d.VolumeName || '', Number(d.Size), Number(d.FreeSpace), false);
      // dyski stałe (typ 3) pokazujemy tylko, gdy wyraźnie wyglądają na czytnik
      // (folder „Android” czy etykieta „PB…” na zwykłym dysku nie wystarczają — to bywa dysk twardy komputera)
      if (d.DriveType === 3 && dev.kind !== 'kobo' && dev.kind !== 'kindle') continue;
      dev.known = dev.kind !== 'generic';
      out.push(dev);
    }
  } else {
    const user = os.userInfo().username;
    for (const base of [`/media/${user}`, `/run/media/${user}`, '/media', '/Volumes']) {
      let names = [];
      try { names = await fsp.readdir(base); } catch { continue; }
      for (const n of names) {
        const root = path.join(base, n);
        if (!isDir(root) || out.some((d) => d.root === root)) continue;
        if (base === '/Volumes' && n === 'Macintosh HD') continue;
        let total = 0, free = 0;
        try { const s = await fsp.statfs(root); total = s.blocks * s.bsize; free = s.bavail * s.bsize; } catch { /* brak danych */ }
        const dev = describe(root, n, total, free, false);
        dev.known = dev.kind !== 'generic';
        out.push(dev);
      }
    }
  }
  return out;
}

// ---------- książki na urządzeniu ----------

async function* walk(dir, depth) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !/^(system|android|dcim|\.kobo)$/i.test(e.name)) yield* walk(p, depth - 1); }
    else if (e.isFile()) yield p;
  }
}

// Książki znalezione na urządzeniu; „shelf" to pierwszy podfolder względem katalogu książek.
async function listDeviceBooks(device) {
  const books = [];
  for await (const p of walk(device.booksDir, 4)) {
    const format = EXT[path.extname(p).toLowerCase()];
    if (!format) continue;
    const rel = path.relative(device.booksDir, p);
    const parts = rel.split(path.sep);
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    books.push({ path: p, rel, name: path.basename(p), shelf: parts.length > 1 ? parts[0] : '', format, size: st.size });
  }
  return books;
}

const safeSeg = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim().slice(0, 80);

// ---------- wysyłanie: biblioteka -> urządzenie ----------

// books: [{ id, path, format, title, shelves: [nazwy] }]
async function exportBooks(device, books, { folderPerShelf = true, onProgress = () => {} } = {}) {
  const rep = { copied: [], existing: 0, unsupported: [], missing: [], errors: [], bytes: 0 };
  const supported = new Set(device.formats);
  const todo = [];
  for (const b of books) {
    if (!supported.has(b.format)) { rep.unsupported.push({ id: b.id, title: b.title, format: b.format }); continue; }
    todo.push(b);
  }
  // sprawdzenie miejsca, zanim cokolwiek skopiujemy
  let need = 0;
  const targets = [];
  for (const b of todo) {
    let st;
    try { st = await fsp.stat(b.path); } catch { rep.missing.push({ id: b.id, title: b.title }); continue; }
    const shelf = folderPerShelf && device.folders && b.shelves?.length ? safeSeg(b.shelves[0]) : '';
    const dir = shelf ? path.join(device.booksDir, shelf) : device.booksDir;
    const dest = path.join(dir, path.basename(b.path));
    let have = null;
    try { have = await fsp.stat(dest); } catch { /* nie ma */ }
    if (have && have.size === st.size) { rep.existing++; continue; }
    // ta sama książka w innym folderze urządzenia — nie dubluj
    targets.push({ b, dir, dest, size: st.size });
    need += st.size;
  }
  let free = device.free;
  try { const s = await fsp.statfs(device.root); free = s.bavail * s.bsize; } catch { /* zostaje wartość z listy */ }
  if (free && need > free - 1024 * 1024) {
    throw new Error(`Za mało miejsca na urządzeniu: potrzeba ${(need / 1048576).toFixed(0)} MB, wolne ${(free / 1048576).toFixed(0)} MB`);
  }
  let done = 0;
  for (const t of targets) {
    onProgress({ done, total: targets.length, current: t.b.title });
    try {
      await fsp.mkdir(t.dir, { recursive: true });
      const tmp = t.dest + '.czytnik-part';
      await fsp.copyFile(t.b.path, tmp);
      await fsp.rename(tmp, t.dest);
      rep.copied.push({ id: t.b.id, title: t.b.title, to: t.dest });
      rep.bytes += t.size;
    } catch (err) {
      rep.errors.push(`${t.b.title}: ${err.message}`);
      fsp.rm(t.dest + '.czytnik-part', { force: true }).catch(() => {});
    }
    done++;
  }
  onProgress({ done, total: targets.length, current: null });
  return rep;
}

// ---------- pobieranie: urządzenie -> biblioteka ----------

// importer(paths) -> Promise<{added, skipped}> to scanner.importFiles z zamkniętym katalogiem okładek.
async function importFromDevice(device, { libraryDir, importer, onProgress = () => {} }) {
  const rep = { imported: [], known: 0, duplicates: [], shelvesAssigned: 0, errors: [] };
  const found = await listDeviceBooks(device);
  const local = db.all('SELECT id, path, size, title, author, format, isbn FROM books');
  const byNameSize = new Map(local.map((b) => [path.basename(b.path).toLowerCase() + '|' + b.size, b]));
  const keys = new Set(local.map((b) => db.bookKey(b)));

  const assignShelf = (id, shelf) => {
    if (!shelf) return;
    const cid = db.createCollection(shelf);
    const before = db.get('SELECT COUNT(*) AS c FROM book_collections WHERE collection_id = ?', [cid]).c;
    db.addBooksToCollection([id], cid);
    if (db.get('SELECT COUNT(*) AS c FROM book_collections WHERE collection_id = ?', [cid]).c > before) rep.shelvesAssigned++;
  };

  let done = 0;
  for (const f of found) {
    onProgress({ done, total: found.length, current: f.name });
    done++;
    try {
      const known = byNameSize.get(f.name.toLowerCase() + '|' + f.size);
      if (known) { rep.known++; if (device.folders) assignShelf(known.id, f.shelf); continue; }

      await fsp.mkdir(libraryDir, { recursive: true });
      let dest = path.join(libraryDir, f.name);
      for (let n = 2; exists(dest); n++) dest = path.join(libraryDir, `${path.basename(f.name, path.extname(f.name))} (${n})${path.extname(f.name)}`);
      await fsp.copyFile(f.path, dest);
      await importer([dest]);
      const row = db.getBookByPath(dest);
      if (!row) { rep.errors.push(`${f.name}: nie udało się dodać do biblioteki`); await fsp.rm(dest, { force: true }); continue; }
      const key = db.bookKey(row);
      if (keys.has(key)) {
        // ta sama książka jest już w bibliotece pod inną nazwą — usuń świeżą kopię i wpis
        db.removeBook(row.id);
        await fsp.rm(dest, { force: true });
        rep.duplicates.push(f.name);
        continue;
      }
      keys.add(key);
      byNameSize.set(f.name.toLowerCase() + '|' + f.size, row);
      rep.imported.push({ id: row.id, title: row.title || f.name, from: f.path });
      if (device.folders) assignShelf(row.id, f.shelf);
    } catch (err) {
      rep.errors.push(`${f.name}: ${err.message}`);
    }
  }
  onProgress({ done, total: found.length, current: null });
  return rep;
}

// Dane książek z biblioteki wraz z nazwami półek — wejście dla exportBooks.
function booksForExport({ ids = null, collectionId = null } = {}) {
  let rows;
  if (ids) {
    rows = ids.length ? db.all(`SELECT * FROM books WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  } else if (collectionId) {
    rows = db.all('SELECT b.* FROM books b JOIN book_collections bc ON bc.book_id = b.id WHERE bc.collection_id = ?', [collectionId]);
  } else {
    rows = db.all('SELECT * FROM books');
  }
  const shelves = new Map();
  for (const r of db.all('SELECT bc.book_id, c.name FROM book_collections bc JOIN collections c ON c.id = bc.collection_id ORDER BY c.name')) {
    if (!shelves.has(r.book_id)) shelves.set(r.book_id, []);
    shelves.get(r.book_id).push(r.name);
  }
  return rows.map((b) => ({ id: b.id, path: b.path, format: b.format, title: b.title || path.basename(b.path), shelves: shelves.get(b.id) || [] }));
}

module.exports = { PROFILES, detectKind, listDevices, listDeviceBooks, exportBooks, importFromDevice, booksForExport, describe };
