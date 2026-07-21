// Skaner dysków: przeszukuje foldery w poszukiwaniu plików EPUB/MOBI/AZW3/PDF,
// wyciąga metadane z plików i zapisuje książki do bazy.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const db = require('./db');
const { parseEpub } = require('./epub-meta');
const { parseMobi } = require('./mobi-meta');

const EXTS = { '.epub': 'epub', '.mobi': 'mobi', '.azw3': 'azw3', '.pdf': 'pdf' };

const SKIP_DIRS = new Set([
  // Windows
  'windows', '$recycle.bin', 'system volume information', 'programdata',
  'program files', 'program files (x86)', 'appdata', 'node_modules',
  '$windows.~bt', '$windows.~ws', 'recovery', 'perflogs',
  'windows.old', 'msocache', 'onedrivetemp',
  // Linux / ogólne
  'proc', 'sys', 'dev', 'run', 'snap', '.cache', '.git',
]);

function listDrivesWindows() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i) + ':\\';
    try {
      fs.accessSync(letter);
      drives.push(letter);
    } catch { /* brak dysku */ }
  }
  return drives;
}

function listDrivesLinux() {
  const roots = new Set([os.homedir()]);
  const mediaRoots = [
    '/media',
    `/media/${os.userInfo().username}`,
    `/run/media/${os.userInfo().username}`,
    '/mnt',
  ];
  for (const dir of mediaRoots) {
    try {
      for (const name of fs.readdirSync(dir)) {
        roots.add(path.join(dir, name));
      }
    } catch { /* brak katalogu / uprawnień */ }
  }
  return [...roots].filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

function listDrives() {
  return process.platform === 'win32' ? listDrivesWindows() : listDrivesLinux();
}

async function* walk(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue; // brak uprawnień itp.
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('$')) {
          stack.push(full);
        }
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (EXTS[ext]) yield { path: full, format: EXTS[ext] };
      }
    }
  }
}

function titleFromFilename(p) {
  return path.basename(p, path.extname(p)).replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function extractFileMeta(filePath, format) {
  try {
    const buf = await fsp.readFile(filePath);
    if (format === 'epub') return await parseEpub(buf);
    if (format === 'mobi' || format === 'azw3') return parseMobi(buf);
  } catch { /* uszkodzony plik — użyjemy nazwy pliku */ }
  return null;
}

// Dodaje jeden plik do bazy (wraz z metadanymi i okładką z pliku).
async function importFile(filePath, format, coversDir) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch { return null; }

  const existing = db.upsertBook({
    path: filePath,
    format,
    size: stat.size,
    mtime: stat.mtimeMs,
    title: titleFromFilename(filePath),
  });

  if (existing.isNew) {
    const meta = await extractFileMeta(filePath, format);
    if (meta) {
      const fields = {};
      if (meta.title) fields.title = meta.title;
      if (meta.author) fields.author = meta.author;
      if (meta.description) fields.description = meta.description;
      if (meta.publisher) fields.publisher = meta.publisher;
      if (meta.year) fields.year = meta.year;
      if (meta.isbn) fields.isbn = meta.isbn;
      if (meta.coverBuf) {
        const coverPath = path.join(coversDir, `${existing.id}.${meta.coverExt}`);
        try {
          await fsp.writeFile(coverPath, meta.coverBuf);
          fields.cover = coverPath;
        } catch { /* pomiń okładkę */ }
      }
      if (Object.keys(fields).length) db.updateBook(existing.id, fields);
    }
  }
  return existing;
}

// Import listy plików wskazanych ręcznie przez użytkownika.
async function importFiles(paths, coversDir) {
  fs.mkdirSync(coversDir, { recursive: true });
  let added = 0, skipped = 0;
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    if (!EXTS[ext]) { skipped++; continue; }
    const result = await importFile(p, EXTS[ext], coversDir);
    if (result?.isNew) added++;
    else skipped++;
  }
  return { added, skipped };
}

let cancelled = false;
function cancelScan() { cancelled = true; }

async function scan(dirs, coversDir, onProgress, formats = null) {
  cancelled = false;
  const wanted = formats && formats.length ? new Set(formats) : null;
  let scanned = 0, added = 0, updated = 0;
  fs.mkdirSync(coversDir, { recursive: true });

  for (const dir of dirs) {
    for await (const file of walk(dir)) {
      if (cancelled) return { scanned, added, updated, cancelled: true };
      if (wanted && !wanted.has(file.format)) continue;
      scanned++;
      const result = await importFile(file.path, file.format, coversDir);
      if (!result) continue;
      if (result.isNew) added++;
      else updated++;

      if (scanned % 20 === 0) {
        onProgress({ scanned, added, current: file.path });
        await new Promise((r) => setImmediate(r));
      }
    }
  }
  onProgress({ scanned, added, current: null });
  return { scanned, added, updated, cancelled: false };
}

module.exports = { scan, cancelScan, listDrives, importFiles };
