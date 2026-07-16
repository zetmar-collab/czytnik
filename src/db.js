// Warstwa bazy danych — SQLite (sql.js, WASM), plik zapisywany w katalogu danych aplikacji.
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

let db = null;
let dbFile = null;
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
  progress_pct REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
`;

async function open(userDataDir) {
  dbFile = path.join(userDataDir, 'biblioteka.sqlite');
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f),
  });
  if (fs.existsSync(dbFile)) {
    db = new SQL.Database(fs.readFileSync(dbFile));
  } else {
    db = new SQL.Database();
  }
  db.exec(SCHEMA);
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

// --- operacje na książkach ---

function upsertBook(b) {
  const existing = get('SELECT id FROM books WHERE path = ?', [b.path]);
  if (existing) {
    run('UPDATE books SET size=?, mtime=? WHERE id=?', [b.size, b.mtime, existing.id]);
    return { id: existing.id, isNew: false };
  }
  run(
    `INSERT INTO books (path, format, size, mtime, title, author, description, publisher, year, isbn, cover, meta_source, added_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.path, b.format, b.size, b.mtime, b.title || null, b.author || null,
     b.description || null, b.publisher || null, b.year || null, b.isbn || null,
     b.cover || null, b.meta_source || 'plik', Date.now()]
  );
  return { id: lastId(), isNew: true };
}

function listBooks({ search = '', format = '', sort = 'added_desc' } = {}) {
  let sql = 'SELECT * FROM books';
  const cond = [];
  const params = [];
  if (search) {
    cond.push('(title LIKE ? OR author LIKE ? OR path LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (format) {
    cond.push('format = ?');
    params.push(format);
  }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  const sorts = {
    added_desc: 'added_at DESC',
    title_asc: 'title COLLATE NOCASE ASC',
    author_asc: 'author COLLATE NOCASE ASC',
    opened_desc: 'last_opened DESC',
  };
  sql += ' ORDER BY ' + (sorts[sort] || sorts.added_desc);
  return all(sql, params);
}

function getBook(id) {
  return get('SELECT * FROM books WHERE id = ?', [id]);
}

const EDITABLE = ['title', 'author', 'description', 'publisher', 'year', 'isbn', 'series', 'rating', 'cover', 'meta_source', 'progress', 'progress_pct', 'last_opened'];

function updateBook(id, fields) {
  const keys = Object.keys(fields).filter((k) => EDITABLE.includes(k));
  if (!keys.length) return;
  const sql = 'UPDATE books SET ' + keys.map((k) => `${k}=?`).join(', ') + ' WHERE id=?';
  run(sql, [...keys.map((k) => fields[k]), id]);
}

function removeBook(id) {
  run('DELETE FROM books WHERE id = ?', [id]);
}

function clearBooks() {
  const count = get('SELECT COUNT(*) AS c FROM books').c;
  run('DELETE FROM books');
  persist();
  return count;
}

function pruneMissing() {
  const rows = all('SELECT id, path FROM books');
  let removed = 0;
  for (const r of rows) {
    if (!fs.existsSync(r.path)) {
      run('DELETE FROM books WHERE id = ?', [r.id]);
      removed++;
    }
  }
  return removed;
}

// --- ustawienia ---

function getSetting(key, def = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : def;
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}

module.exports = {
  open, persist, upsertBook, listBooks, getBook, updateBook, removeBook,
  clearBooks, pruneMissing, getSetting, setSetting,
};
