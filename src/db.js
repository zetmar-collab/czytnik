// Warstwa bazy danych — SQLite (sql.js, WASM), plik zapisywany w katalogu danych aplikacji.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { likePattern } = require('./validate');

let db = null;
let dbFile = null;
let userDir = null;
let saveTimer = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  format TEXT NOT NULL,
  size INTEGER,
  mtime INTEGER,
  title TEXT,
  author TEXT,
  description TEXT,
  publisher TEXT,
  year TEXT,
  isbn TEXT,
  series TEXT,
  rating REAL,
  cover TEXT,
  meta_source TEXT DEFAULT 'plik',
  added_at INTEGER,
  last_opened INTEGER,
  progress TEXT,
  progress_pct REAL DEFAULT 0,
  tts_section INTEGER,
  tts_chunk INTEGER,
  tags TEXT,
  progress_at INTEGER,
  tts_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE NOT NULL,
  book_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  loc TEXT NOT NULL,
  text TEXT,
  note TEXT,
  color TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ann_book ON annotations(book_id);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS book_collections (
  book_id INTEGER NOT NULL,
  collection_id INTEGER NOT NULL,
  PRIMARY KEY (book_id, collection_id)
);

CREATE TABLE IF NOT EXISTS reading_days (
  book_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, day)
);

CREATE TABLE IF NOT EXISTS fulltext_meta (
  book_id INTEGER PRIMARY KEY,
  mtime INTEGER,
  indexed_at INTEGER
);
`;

// Kolumny dopisywane do baz założonych w starszych wersjach
// (SQLite nie ma "ADD COLUMN IF NOT EXISTS", więc sprawdzamy ręcznie).
const ADDED_COLUMNS = [
  ['tts_section', 'INTEGER'],
  ['tts_chunk', 'INTEGER'],
  ['tags', 'TEXT'],
  ['progress_at', 'INTEGER'],
  ['tts_at', 'INTEGER'],
];

function migrate() {
  const cols = new Set(all('PRAGMA table_info(books)').map((r) => r.name));
  for (const [name, type] of ADDED_COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE books ADD COLUMN ${name} ${type}`);
  }
}

// Wynik ostatniego otwarcia bazy (np. odzyskiwanie po uszkodzeniu pliku).
const openInfo = { recovered: false, corruptCopy: null, error: null };

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// Raz dziennie kopiuje poprawną bazę do backups/ i zostawia 3 najnowsze.
function rotateBackup() {
  try {
    const dir = path.join(userDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `biblioteka-${stamp()}.sqlite`);
    if (!fs.existsSync(target)) fs.copyFileSync(dbFile, target);
    const files = fs.readdirSync(dir).filter((f) => /^biblioteka-\d{8}\.sqlite$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 3))) fs.unlinkSync(path.join(dir, f));
  } catch { /* kopia zapasowa jest dodatkiem — nie blokuje startu */ }
}

async function open(userDataDir) {
  userDir = userDataDir;
  dbFile = path.join(userDataDir, 'biblioteka.sqlite');
  openInfo.recovered = false;
  openInfo.corruptCopy = null;
  openInfo.error = null;
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f),
  });

  let loaded = false;
  if (fs.existsSync(dbFile)) {
    try {
      db = new SQL.Database(fs.readFileSync(dbFile));
      db.exec(SCHEMA);
      migrate();
      all('SELECT COUNT(*) AS c FROM books'); // sprawdza, czy baza jest czytelna
      loaded = true;
    } catch (err) {
      // uszkodzony plik: odkładamy go na bok i zaczynamy od nowej bazy
      openInfo.recovered = true;
      openInfo.error = String(err && err.message || err);
      openInfo.corruptCopy = `${dbFile}.corrupt-${Date.now()}`;
      try { db?.close(); } catch { /* ignoruj */ }
      try { fs.renameSync(dbFile, openInfo.corruptCopy); } catch { openInfo.corruptCopy = null; }
    }
  }
  if (!loaded) {
    db = new SQL.Database();
    db.exec(SCHEMA);
    migrate();
  } else {
    rotateBackup();
  }
  persist();
  return db;
}

function persist() {
  if (!db || !dbFile) return;
  const data = Buffer.from(db.export());
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dbFile);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 1500);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  scheduleSave();
}

function lastId() {
  return get('SELECT last_insert_rowid() AS id').id;
}

const uid = () => crypto.randomUUID();

// Stabilny klucz książki niezależny od ścieżki — do synchronizacji i importu między komputerami.
function normalizeText(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, ' ').trim();
}
function bookKey(b) {
  const isbn = String(b.isbn || '').replace(/[^0-9Xx]/g, '');
  if (isbn.length >= 10) return 'isbn:' + isbn.toUpperCase();
  const base = normalizeText(b.title) + '|' + normalizeText(b.author) + '|' + (b.format || '');
  return 'ta:' + crypto.createHash('sha1').update(base).digest('hex').slice(0, 20);
}

// --- operacje na książkach ---

function upsertBook(b) {
  const existing = get('SELECT id, size, mtime FROM books WHERE path = ?', [b.path]);
  if (existing) {
    const changed = existing.size !== b.size || Math.floor(existing.mtime || 0) !== Math.floor(b.mtime || 0);
    if (changed) run('UPDATE books SET size=?, mtime=? WHERE id=?', [b.size, b.mtime, existing.id]);
    return { id: existing.id, isNew: false, changed };
  }
  run(
    `INSERT INTO books (path, format, size, mtime, title, author, description, publisher, year, isbn, cover, meta_source, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.path, b.format, b.size, b.mtime, b.title || null, b.author || null,
     b.description || null, b.publisher || null, b.year || null, b.isbn || null,
     b.cover || null, b.meta_source || 'plik', Date.now()]
  );
  return { id: lastId(), isNew: true, changed: true };
}

function listBooks({ search = '', format = '', sort = 'added_desc', collection = null, tag = '', series = '' } = {}) {
  let sql = 'SELECT * FROM books';
  const cond = [];
  const params = [];
  if (search) {
    cond.push("(title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
    const s = likePattern(search);
    params.push(s, s, s, s);
  }
  if (format) {
    cond.push('format = ?');
    params.push(format);
  }
  if (collection) {
    cond.push('id IN (SELECT book_id FROM book_collections WHERE collection_id = ?)');
    params.push(Number(collection));
  }
  if (tag) {
    cond.push("(',' || REPLACE(COALESCE(tags,''), ', ', ',') || ',') LIKE ? ESCAPE '\\'");
    params.push('%,' + String(tag).trim().replace(/[\\%_]/g, (c) => '\\' + c) + ',%');
  }
  if (series) {
    cond.push('series = ?');
    params.push(series);
  }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  const sorts = {
    added_desc: 'added_at DESC',
    title_asc: 'title COLLATE NOCASE ASC',
    author_asc: 'author COLLATE NOCASE ASC',
    opened_desc: 'last_opened DESC',
    series_asc: "COALESCE(series,'~') COLLATE NOCASE ASC, title COLLATE NOCASE ASC",
  };
  sql += ' ORDER BY ' + (sorts[sort] || sorts.added_desc);
  return all(sql, params);
}

function getBook(id) {
  return get('SELECT * FROM books WHERE id = ?', [id]);
}

function getBookByPath(filePath) {
  return get('SELECT * FROM books WHERE path = ?', [filePath]);
}

const EDITABLE = ['title', 'author', 'description', 'publisher', 'year', 'isbn', 'series', 'rating', 'cover', 'meta_source',
  'progress', 'progress_pct', 'last_opened', 'tts_section', 'tts_chunk', 'tags', 'progress_at', 'tts_at'];

function updateBook(id, fields) {
  const f = { ...fields };
  const now = Date.now();
  if (('progress' in f || 'progress_pct' in f) && !('progress_at' in f)) f.progress_at = now;
  if (('tts_section' in f || 'tts_chunk' in f) && !('tts_at' in f)) f.tts_at = now;
  const keys = Object.keys(f).filter((k) => EDITABLE.includes(k));
  if (!keys.length) return;
  const sql = 'UPDATE books SET ' + keys.map((k) => `${k}=?`).join(', ') + ' WHERE id=?';
  run(sql, [...keys.map((k) => f[k]), id]);
}

function removeBook(id) {
  run('DELETE FROM book_collections WHERE book_id = ?', [id]);
  run('DELETE FROM annotations WHERE book_id = ?', [id]);
  run('DELETE FROM reading_days WHERE book_id = ?', [id]);
  run('DELETE FROM fulltext_meta WHERE book_id = ?', [id]);
  run('DELETE FROM books WHERE id = ?', [id]);
}

function clearBooks() {
  const count = get('SELECT COUNT(*) AS c FROM books').c;
  for (const t of ['book_collections', 'annotations', 'reading_days', 'fulltext_meta', 'books']) run(`DELETE FROM ${t}`);
  persist();
  return count;
}

function pruneMissing() {
  const rows = all('SELECT id, path FROM books');
  let removed = 0;
  for (const r of rows) {
    if (!fs.existsSync(r.path)) {
      removeBook(r.id);
      removed++;
    }
  }
  return removed;
}

// --- ustawienia ---

function getSetting(key, def = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return def; }
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}

// --- adnotacje: zakładki, zakreślenia, notatki ---

function listAnnotations(bookId, { includeDeleted = false } = {}) {
  return all(`SELECT * FROM annotations WHERE book_id = ? ${includeDeleted ? '' : 'AND deleted = 0'} ORDER BY created_at ASC`, [bookId]);
}

function addAnnotation(a) {
  const now = Date.now();
  const row = {
    uid: a.uid || uid(), book_id: a.book_id, type: a.type, loc: a.loc,
    text: a.text || null, note: a.note || null, color: a.color || null,
    created_at: a.created_at || now, updated_at: a.updated_at || now,
  };
  run('INSERT INTO annotations (uid, book_id, type, loc, text, note, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [row.uid, row.book_id, row.type, row.loc, row.text, row.note, row.color, row.created_at, row.updated_at]);
  return get('SELECT * FROM annotations WHERE uid = ?', [row.uid]);
}

function updateAnnotation(annUid, fields) {
  const keys = Object.keys(fields).filter((k) => ['note', 'color', 'text', 'loc'].includes(k));
  if (!keys.length) return get('SELECT * FROM annotations WHERE uid = ?', [annUid]);
  run('UPDATE annotations SET ' + keys.map((k) => `${k}=?`).join(', ') + ', updated_at=? WHERE uid=?',
    [...keys.map((k) => fields[k]), Date.now(), annUid]);
  return get('SELECT * FROM annotations WHERE uid = ?', [annUid]);
}

function deleteAnnotation(annUid) {
  run('UPDATE annotations SET deleted = 1, updated_at = ? WHERE uid = ?', [Date.now(), annUid]);
}

// --- kolekcje (półki) i tagi ---

function listCollections() {
  return all(`SELECT c.id, c.name, COUNT(bc.book_id) AS count FROM collections c
              LEFT JOIN book_collections bc ON bc.collection_id = c.id GROUP BY c.id ORDER BY c.name COLLATE NOCASE`);
}

function createCollection(name) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw new Error('Podaj nazwę półki');
  const ex = get('SELECT id FROM collections WHERE name = ? COLLATE NOCASE', [n]);
  if (ex) return ex.id;
  run('INSERT INTO collections (name, created_at) VALUES (?, ?)', [n, Date.now()]);
  return lastId();
}

function renameCollection(id, name) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw new Error('Podaj nazwę półki');
  run('UPDATE collections SET name = ? WHERE id = ?', [n, id]);
}

function deleteCollection(id) {
  run('DELETE FROM book_collections WHERE collection_id = ?', [id]);
  run('DELETE FROM collections WHERE id = ?', [id]);
}

function getBookCollections(bookId) {
  return all('SELECT collection_id AS id FROM book_collections WHERE book_id = ?', [bookId]).map((r) => r.id);
}

function setBookCollections(bookId, ids) {
  run('DELETE FROM book_collections WHERE book_id = ?', [bookId]);
  for (const cid of new Set(ids)) run('INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)', [bookId, cid]);
}

function addBooksToCollection(bookIds, collectionId) {
  for (const b of bookIds) run('INSERT OR IGNORE INTO book_collections (book_id, collection_id) VALUES (?, ?)', [b, collectionId]);
}

function listTags() {
  const set = new Map();
  for (const r of all("SELECT tags FROM books WHERE tags IS NOT NULL AND tags <> ''")) {
    for (const t of r.tags.split(',').map((x) => x.trim()).filter(Boolean)) set.set(t, (set.get(t) || 0) + 1);
  }
  return [...set.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
}

function listSeries() {
  return all("SELECT series AS name, COUNT(*) AS count FROM books WHERE series IS NOT NULL AND series <> '' GROUP BY series ORDER BY series COLLATE NOCASE");
}

// --- duplikaty ---

function findDuplicates() {
  const books = all('SELECT id, title, author, isbn, format, size, path, cover, description, meta_source, progress_pct FROM books');
  const groups = new Map();
  for (const b of books) {
    const isbn = String(b.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    const ta = normalizeText(b.title) + '|' + normalizeText(b.author);
    const keys = [];
    if (isbn.length >= 10) keys.push('isbn:' + isbn);
    if (normalizeText(b.title).length >= 3) keys.push('ta:' + ta);
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k).add(b.id);
    }
  }
  // łączymy grupy, które współdzielą książki (ta sama książka może trafić pod isbn i pod tytuł+autor)
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const ids of groups.values()) {
    const arr = [...ids];
    for (const i of arr) if (!parent.has(i)) parent.set(i, i);
    for (let i = 1; i < arr.length; i++) parent.set(find(arr[i]), find(arr[0]));
  }
  const merged = new Map();
  const byId = new Map(books.map((b) => [b.id, b]));
  for (const [id] of parent) {
    const r = find(id);
    if (!merged.has(r)) merged.set(r, []);
    merged.get(r).push(byId.get(id));
  }
  return [...merged.values()].filter((g) => g.length > 1);
}

// --- czas czytania ---

function addReadingSeconds(bookId, seconds, day) {
  const sec = Math.max(0, Math.min(3600, Math.round(seconds)));
  if (!sec) return;
  run(`INSERT INTO reading_days (book_id, day, seconds) VALUES (?, ?, ?)
       ON CONFLICT(book_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`, [bookId, day, sec]);
}

function getStats() {
  const days = all('SELECT day, SUM(seconds) AS seconds FROM reading_days GROUP BY day ORDER BY day');
  const total = days.reduce((a, d) => a + d.seconds, 0);
  const perBook = all(`SELECT b.id, b.title, b.author, SUM(r.seconds) AS seconds FROM reading_days r
                       JOIN books b ON b.id = r.book_id GROUP BY b.id ORDER BY seconds DESC LIMIT 10`);
  const finished = get('SELECT COUNT(*) AS c FROM books WHERE progress_pct >= 0.97').c;
  const inProgress = get('SELECT COUNT(*) AS c FROM books WHERE progress_pct > 0.02 AND progress_pct < 0.97').c;
  return { days, total, perBook, finished, inProgress };
}

module.exports = {
  open, openInfo, persist, all, get, run, upsertBook, listBooks, getBook, getBookByPath, updateBook, removeBook,
  clearBooks, pruneMissing, getSetting, setSetting,
  listAnnotations, addAnnotation, updateAnnotation, deleteAnnotation,
  listCollections, createCollection, renameCollection, deleteCollection, getBookCollections, setBookCollections,
  addBooksToCollection, listTags, listSeries, findDuplicates, addReadingSeconds, getStats,
  bookKey, normalizeText, uid,
};
