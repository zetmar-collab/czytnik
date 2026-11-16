// Kopia zapasowa i synchronizacja przez folder (OneDrive/Dropbox/dysk sieciowy).
// Oba mechanizmy używają tego samego, przenośnego "zrzutu" danych użytkownika, w którym książki są
// identyfikowane stabilnym kluczem (ISBN albo tytuł+autor+format), a nie ścieżką — dzięki temu
// działa między komputerami, na których te same książki leżą w różnych folderach.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const FORMAT = 'czytnik-backup';
const VERSION = 1;
const SYNC_SUFFIX = '.czytnik.json';
const MAX_FILE = 64 * 1024 * 1024;
const SETTINGS_KEYS = ['appTheme', 'readerSettings', 'ttsSettings'];
const META_FIELDS = ['title', 'author', 'description', 'publisher', 'year', 'isbn', 'series', 'rating'];
const ANN_TYPES = new Set(['highlight', 'note', 'bookmark']);

// ---------- zrzut lokalnych danych ----------

function snapshot({ withSettings = true } = {}) {
  const rows = db.all('SELECT * FROM books');
  const keyById = new Map();
  const books = {};
  for (const b of rows) {
    const key = db.bookKey(b);
    keyById.set(b.id, key);
    if (books[key]) continue; // duplikaty (ten sam klucz) — zachowaj pierwszy wpis
    books[key] = {
      title: b.title, author: b.author, description: b.description, publisher: b.publisher, year: b.year,
      isbn: b.isbn, series: b.series, rating: b.rating, tags: b.tags, format: b.format,
      progress: b.progress, progress_pct: b.progress_pct, progress_at: b.progress_at,
      tts_section: b.tts_section, tts_chunk: b.tts_chunk, tts_at: b.tts_at, last_opened: b.last_opened,
      meta_source: b.meta_source, file: path.basename(b.path || ''),
    };
  }
  const annotations = db.all('SELECT * FROM annotations').filter((a) => keyById.has(a.book_id)).map((a) => ({
    key: keyById.get(a.book_id), uid: a.uid, type: a.type, loc: a.loc, text: a.text, note: a.note, color: a.color,
    created_at: a.created_at, updated_at: a.updated_at, deleted: a.deleted ? 1 : 0,
  }));
  const collections = {};
  for (const c of db.all('SELECT id, name FROM collections')) collections[c.name] = [];
  for (const r of db.all(`SELECT c.name, bc.book_id FROM book_collections bc JOIN collections c ON c.id = bc.collection_id`)) {
    const k = keyById.get(r.book_id);
    if (k && !collections[r.name].includes(k)) collections[r.name].push(k);
  }
  const reading = db.all('SELECT book_id, day, seconds FROM reading_days')
    .filter((r) => keyById.has(r.book_id)).map((r) => ({ key: keyById.get(r.book_id), day: r.day, seconds: r.seconds }));
  const settings = {};
  if (withSettings) for (const k of SETTINGS_KEYS) { const v = db.getSetting(k, undefined); if (v !== undefined) settings[k] = v; }
  return { format: FORMAT, version: VERSION, exportedAt: Date.now(), books, annotations, collections, reading, settings };
}

// ---------- walidacja zewnętrznego pliku ----------

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) throw new Error('To nie jest plik kopii zapasowej Czytnika');
  if (!(raw.version >= 1) || raw.version > VERSION) throw new Error('Plik pochodzi z nowszej wersji Czytnika — zaktualizuj aplikację');
  const out = { books: {}, annotations: [], collections: {}, reading: [], settings: {}, exportedAt: num(raw.exportedAt) || 0 };
  for (const [key, b] of Object.entries(raw.books && typeof raw.books === 'object' ? raw.books : {})) {
    if (!/^(isbn:[0-9X]{10,13}|ta:[0-9a-f]{20})$/.test(key) || !b || typeof b !== 'object') continue;
    out.books[key] = {
      title: str(b.title, 500), author: str(b.author, 500), description: str(b.description, 20000),
      publisher: str(b.publisher, 300), year: str(b.year, 20), isbn: str(b.isbn, 40), series: str(b.series, 300),
      rating: num(b.rating), tags: str(b.tags, 1000), progress: str(b.progress, 2000), progress_pct: num(b.progress_pct),
      progress_at: num(b.progress_at), tts_section: num(b.tts_section), tts_chunk: num(b.tts_chunk), tts_at: num(b.tts_at),
      last_opened: num(b.last_opened), meta_source: str(b.meta_source, 40),
    };
  }
  for (const a of Array.isArray(raw.annotations) ? raw.annotations : []) {
    if (!a || !(a.key in out.books) || !ANN_TYPES.has(a.type)) continue;
    const uid = str(a.uid, 80);
    const loc = str(a.loc, 2000);
    if (!uid || !loc) continue;
    out.annotations.push({
      key: a.key, uid, type: a.type, loc, text: str(a.text, 3000), note: str(a.note, 8000),
      color: /^#[0-9a-fA-F]{6}$/.test(a.color || '') ? a.color : null,
      created_at: num(a.created_at) || 0, updated_at: num(a.updated_at) || 0, deleted: a.deleted ? 1 : 0,
    });
  }
  for (const [name, keys] of Object.entries(raw.collections && typeof raw.collections === 'object' ? raw.collections : {})) {
    const n = name.trim().slice(0, 80);
    if (n && Array.isArray(keys)) out.collections[n] = keys.filter((k) => typeof k === 'string' && k in out.books);
  }
  for (const r of Array.isArray(raw.reading) ? raw.reading : []) {
    if (!r || !(r.key in out.books) || !/^\d{4}-\d{2}-\d{2}$/.test(r.day || '')) continue;
    const s = num(r.seconds);
    if (s > 0 && s < 86400) out.reading.push({ key: r.key, day: r.day, seconds: Math.round(s) });
  }
  if (raw.settings && typeof raw.settings === 'object') {
    for (const k of SETTINGS_KEYS) if (k in raw.settings) out.settings[k] = raw.settings[k];
  }
  return out;
}

// ---------- scalanie ----------

function mergeSnapshot(snap, { settings = false } = {}) {
  const rep = { matched: 0, unmatched: 0, progress: 0, annotationsAdded: 0, annotationsUpdated: 0, collections: 0, reading: 0 };
  const idByKey = new Map();
  const local = new Map();
  for (const b of db.all('SELECT * FROM books')) {
    const k = db.bookKey(b);
    if (!idByKey.has(k)) { idByKey.set(k, b.id); local.set(k, b); }
  }

  for (const [key, r] of Object.entries(snap.books)) {
    const b = local.get(key);
    if (!b) { rep.unmatched++; continue; }
    rep.matched++;
    const upd = {};
    for (const f of META_FIELDS) if ((b[f] == null || b[f] === '') && r[f] != null && r[f] !== '') upd[f] = r[f];
    if (r.tags) {
      const merged = [...new Set([...(b.tags || '').split(','), ...r.tags.split(',')].map((t) => t.trim()).filter(Boolean))].join(', ');
      if (merged !== (b.tags || '')) upd.tags = merged;
    }
    // pozycja czytania: wygrywa nowszy znacznik czasu (a gdy go brak — dalszy postęp)
    const newer = (r.progress_at || 0) > (b.progress_at || 0) || (!(r.progress_at) && !(b.progress_at) && (r.progress_pct || 0) > (b.progress_pct || 0));
    if (newer && r.progress != null && (r.progress_pct || 0) >= 0) {
      Object.assign(upd, { progress: r.progress, progress_pct: r.progress_pct || 0, progress_at: r.progress_at || Date.now() });
      rep.progress++;
    }
    if ((r.tts_at || 0) > (b.tts_at || 0) && r.tts_section != null) {
      Object.assign(upd, { tts_section: r.tts_section, tts_chunk: r.tts_chunk || 0, tts_at: r.tts_at });
    }
    if ((r.last_opened || 0) > (b.last_opened || 0)) upd.last_opened = r.last_opened;
    if (Object.keys(upd).length) db.updateBook(b.id, upd);
  }

  const have = new Map(db.all('SELECT uid, updated_at FROM annotations').map((a) => [a.uid, a.updated_at || 0]));
  for (const a of snap.annotations) {
    const id = idByKey.get(a.key);
    if (!id) continue;
    if (!have.has(a.uid)) {
      db.addAnnotation({ ...a, book_id: id });
      if (a.deleted) db.run('UPDATE annotations SET deleted = 1, updated_at = ? WHERE uid = ?', [a.updated_at, a.uid]);
      have.set(a.uid, a.updated_at);
      rep.annotationsAdded++;
    } else if (a.updated_at > have.get(a.uid)) {
      db.run('UPDATE annotations SET note=?, color=?, text=?, deleted=?, updated_at=? WHERE uid=?',
        [a.note, a.color, a.text, a.deleted, a.updated_at, a.uid]);
      have.set(a.uid, a.updated_at);
      rep.annotationsUpdated++;
    }
  }

  for (const [name, keys] of Object.entries(snap.collections)) {
    const ids = keys.map((k) => idByKey.get(k)).filter(Boolean);
    if (!ids.length && db.get('SELECT id FROM collections WHERE name = ? COLLATE NOCASE', [name])) continue;
    const cid = db.createCollection(name);
    const before = db.get('SELECT COUNT(*) AS c FROM book_collections WHERE collection_id = ?', [cid]).c;
    db.addBooksToCollection(ids, cid);
    const after = db.get('SELECT COUNT(*) AS c FROM book_collections WHERE collection_id = ?', [cid]).c;
    rep.collections += after - before;
  }

  for (const r of snap.reading) {
    const id = idByKey.get(r.key);
    if (!id) continue;
    const cur = db.get('SELECT seconds FROM reading_days WHERE book_id = ? AND day = ?', [id, r.day]);
    if (!cur) {
      db.run('INSERT INTO reading_days (book_id, day, seconds) VALUES (?, ?, ?)', [id, r.day, r.seconds]);
      rep.reading++;
    } else if (r.seconds > cur.seconds) {
      // ten sam dzień na dwóch urządzeniach: bierzemy większą wartość (suma liczyłaby podwójnie po każdej synchronizacji)
      db.run('UPDATE reading_days SET seconds = ? WHERE book_id = ? AND day = ?', [r.seconds, id, r.day]);
      rep.reading++;
    }
  }

  if (settings) for (const [k, v] of Object.entries(snap.settings)) db.setSetting(k, v);
  return rep;
}

// ---------- kopia zapasowa (plik) ----------

async function exportToFile(file) {
  const data = JSON.stringify(snapshot(), null, 1);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, file);
  const snap = JSON.parse(data);
  return { books: Object.keys(snap.books).length, annotations: snap.annotations.filter((a) => !a.deleted).length, bytes: Buffer.byteLength(data) };
}

async function readSnapshotFile(file) {
  const st = await fsp.stat(file);
  if (st.size > MAX_FILE) throw new Error('Plik jest zbyt duży');
  let raw;
  try { raw = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { throw new Error('Plik jest uszkodzony (nieprawidłowy JSON)'); }
  return sanitize(raw);
}

async function importFromFile(file) {
  const snap = await readSnapshotFile(file);
  return mergeSnapshot(snap, { settings: true });
}

// ---------- synchronizacja przez folder ----------

function deviceId() {
  let id = db.getSetting('deviceId', null);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) { id = crypto.randomUUID(); db.setSetting('deviceId', id); }
  return id;
}

// Każde urządzenie zapisuje wyłącznie własny plik <id>.czytnik.json i tylko czyta pozostałe,
// więc nie ma konfliktów zapisu nawet przy równoczesnej pracy.
async function syncFolder(dir) {
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('Folder synchronizacji jest niedostępny');
  const me = deviceId();
  const total = { files: 0, matched: 0, progress: 0, annotationsAdded: 0, annotationsUpdated: 0, collections: 0, reading: 0, errors: [] };
  for (const name of await fsp.readdir(dir)) {
    if (!name.endsWith(SYNC_SUFFIX) || name === me + SYNC_SUFFIX) continue;
    try {
      const rep = mergeSnapshot(await readSnapshotFile(path.join(dir, name)));
      total.files++;
      for (const k of ['matched', 'progress', 'annotationsAdded', 'annotationsUpdated', 'collections', 'reading']) total[k] += rep[k];
    } catch (err) {
      total.errors.push(`${name}: ${err.message}`);
    }
  }
  const out = path.join(dir, me + SYNC_SUFFIX);
  const tmp = out + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(snapshot({ withSettings: false })), 'utf8');
  await fsp.rename(tmp, out);
  total.syncedAt = Date.now();
  return total;
}

// ---------- automatyczna kopia metadanych (co kilka dni, ostatnie N sztuk) ----------

const AUTO_RE = /^metadata-\d{4}-\d{2}-\d{2}\.json$/;

async function autoBackup(userDir, { days = 7, keep = 10, now = Date.now() } = {}) {
  if (db.getSetting('metaBackupAuto', true) === false) return { skipped: 'wyłączona' };
  const last = db.getSetting('metaBackupAt', 0);
  if (last && now - last < days * 86400000) return { skipped: 'niedawno wykonana', last };
  const dir = path.join(userDir, 'backups');
  await fsp.mkdir(dir, { recursive: true });
  const d = new Date(now);
  const p2 = (n) => String(n).padStart(2, '0');
  const file = path.join(dir, `metadata-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.json`);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(snapshot()), 'utf8');
  await fsp.rename(tmp, file);
  const old = (await fsp.readdir(dir)).filter((n) => AUTO_RE.test(n)).sort().reverse().slice(keep);
  for (const n of old) await fsp.rm(path.join(dir, n), { force: true });
  db.setSetting('metaBackupAt', now);
  return { file, removed: old.length };
}

module.exports = { autoBackup, snapshot, sanitize, mergeSnapshot, exportToFile, importFromFile, syncFolder, deviceId, SYNC_SUFFIX };
