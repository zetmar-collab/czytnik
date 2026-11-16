// Indeks pełnotekstowy biblioteki (EPUB, MOBI/AZW3 z kompresją PalmDOC lub bez).
// sql.js nie ma FTS5, a trzymanie całych książek w pliku SQLite rozdęłoby bazę (jest w całości
// w pamięci), więc tekst trafia do osobnych skompresowanych plików obok bazy:
//   fulltext/<id>.t.gz — tekst oryginalny (do fragmentów wyników),
//   fulltext/<id>.f.gz — tekst "złożony" (małe litery, bez ogonków) o IDENTYCZNEJ długości,
//                        więc pozycje trafień w nim odpowiadają pozycjom w oryginale.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const cheerio = require('cheerio');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const db = require('./db');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

let baseDir = null;
const MAX_BOOK_BYTES = 300 * 1024 * 1024;
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

function init(userDataDir) {
  baseDir = path.join(userDataDir, 'fulltext');
  fs.mkdirSync(baseDir, { recursive: true });
}

// ---------- składanie tekstu (1:1 po jednostkach UTF-16) ----------

const cache = new Map();
function foldChar(c) {
  let r = cache.get(c);
  if (r === undefined) {
    if (c === 'ł' || c === 'Ł') r = 'l';
    else {
      r = c.normalize('NFD')[0].toLowerCase();
      if (r.length !== 1) r = '?';
    }
    cache.set(c, r);
  }
  return r;
}
function fold(s) {
  return String(s).replace(/[^\x00-\x7f]/g, foldChar).replace(/[A-Z]/g, (c) => c.toLowerCase());
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// ---------- ekstrakcja tekstu ----------

function htmlToText(html) {
  const spaced = html.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|dd|dt)>|<br\s*\/?>/gi, ' $& ');
  const $ = cheerio.load(spaced);
  $('script, style, nav, head').remove();
  return squash($('body').length ? $('body').text() : $.root().text());
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

async function epubText(file) {
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const container = xml.parse(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = asArray(container?.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
  const opf = xml.parse(await zip.file(opfPath).async('string'))?.package;
  const dir = path.posix.dirname(opfPath);
  const manifest = new Map(asArray(opf?.manifest?.item).map((i) => [i['@_id'], i['@_href']]));
  const parts = [];
  for (const ref of asArray(opf?.spine?.itemref)) {
    const href = manifest.get(ref['@_idref']);
    if (!href) continue;
    const name = decodeURIComponent(dir === '.' ? href : path.posix.join(dir, href));
    const entry = zip.file(name);
    if (!entry || !/\.(x?html?|xml)$/i.test(name)) continue;
    const t = htmlToText(await entry.async('string'));
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

// PalmDOC (LZ77): kompresja używana przez większość plików MOBI/AZW3.
function palmdoc(buf) {
  // najgorszy współczynnik rozwinięcia to 5x (2 bajty -> 10), więc 6x + zapas wystarcza
  const out = Buffer.alloc(buf.length * 6 + 32);
  let o = 0;
  let i = 0;
  while (i < buf.length) {
    const c = buf[i++];
    if (c === 0 || (c >= 9 && c <= 0x7f)) {
      out[o++] = c;
    } else if (c >= 1 && c <= 8) {
      for (let k = 0; k < c && i < buf.length; k++) out[o++] = buf[i++];
    } else if (c >= 0xc0) {
      out[o++] = 0x20;
      out[o++] = c ^ 0x80;
    } else {
      const c2 = buf[i++];
      const dist = (((c << 8) | c2) >> 3) & 0x7ff;
      const len = (c2 & 7) + 3;
      for (let k = 0; k < len; k++) { out[o] = out[o - dist]; o++; }
    }
  }
  return out.slice(0, o);
}

function trailingSize(rec, flags) {
  let size = 0;
  for (let bit = 15; bit >= 1; bit--) {
    if (!(flags & (1 << bit))) continue;
    let v = 0;
    let shift = 0;
    let pos = rec.length - size - 1;
    for (let n = 0; n < 4 && pos >= 0; n++) {
      const b = rec[pos--];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (b & 0x80) break;
    }
    size += v;
  }
  if (flags & 1) size += (rec[rec.length - size - 1] & 3) + 1;
  return size;
}

// Surowy HTML z pliku MOBI/AZW3 (PalmDOC albo bez kompresji); null dla HUFF/CDIC.
async function mobiHtml(file) {
  const buf = await fsp.readFile(file);
  const numRecords = buf.readUInt16BE(76);
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(buf.readUInt32BE(78 + i * 8));
  const r0 = offsets[0];
  const compression = buf.readUInt16BE(r0);
  const textRecords = buf.readUInt16BE(r0 + 8);
  const mobiLen = buf.readUInt32BE(r0 + 20);
  const encoding = buf.readUInt32BE(r0 + 28);
  const flags = mobiLen >= 0xe4 ? buf.readUInt16BE(r0 + 0xf2) : 0;
  if (compression !== 1 && compression !== 2) return null; // HUFF/CDIC — nieobsługiwane
  const chunks = [];
  for (let i = 1; i <= textRecords && i < numRecords; i++) {
    let rec = buf.slice(offsets[i], i + 1 < numRecords ? offsets[i + 1] : buf.length);
    if (flags) rec = rec.slice(0, rec.length - trailingSize(rec, flags));
    chunks.push(compression === 2 ? palmdoc(rec) : rec);
  }
  const raw = Buffer.concat(chunks);
  return encoding === 65001 ? raw.toString('utf8') : raw.toString('latin1');
}

async function mobiText(file) {
  const html = await mobiHtml(file);
  return html == null ? null : htmlToText(html);
}

async function extractBookText(book) {
  const stat = await fsp.stat(book.path);
  if (stat.size > MAX_BOOK_BYTES) return null;
  if (book.format === 'epub') return await epubText(book.path);
  if (book.format === 'mobi' || book.format === 'azw3') return await mobiText(book.path);
  return null; // PDF — bez warstwy tekstu w procesie głównym
}

// ---------- indeksowanie ----------

const files = (id) => ({ t: path.join(baseDir, `${id}.t.gz`), f: path.join(baseDir, `${id}.f.gz`) });

function removeIndex(id) {
  try {
    const p = files(id);
    for (const f of [p.t, p.f]) fs.rmSync(f, { force: true });
    db.run('DELETE FROM fulltext_meta WHERE book_id = ?', [id]);
  } catch { /* ignoruj */ }
}

function clearAll() {
  try { fs.rmSync(baseDir, { recursive: true, force: true }); fs.mkdirSync(baseDir, { recursive: true }); } catch { /* ignoruj */ }
}

function status() {
  const books = db.all("SELECT id, mtime, format FROM books");
  const meta = new Map(db.all('SELECT book_id, mtime, indexed_at FROM fulltext_meta').map((m) => [m.book_id, m]));
  let indexed = 0;
  let pending = 0;
  let unsupported = 0;
  for (const b of books) {
    if (b.format === 'pdf') { unsupported++; continue; }
    const m = meta.get(b.id);
    if (m && Math.floor(m.mtime || 0) === Math.floor(b.mtime || 0)) {
      if (m.indexed_at > 0) indexed++; else unsupported++;
    } else pending++;
  }
  return { total: books.length, indexed, pending, unsupported };
}

let running = false;
let cancelFlag = false;
const cancel = () => { cancelFlag = true; };

async function indexAll(onProgress = () => {}) {
  if (running) throw new Error('Indeksowanie już trwa');
  running = true;
  cancelFlag = false;
  let done = 0;
  try {
    const meta = new Map(db.all('SELECT book_id, mtime FROM fulltext_meta').map((m) => [m.book_id, m.mtime]));
    const todo = db.all("SELECT id, path, format, mtime, title FROM books WHERE format <> 'pdf'")
      .filter((b) => !(meta.has(b.id) && Math.floor(meta.get(b.id) || 0) === Math.floor(b.mtime || 0)));
    for (const book of todo) {
      if (cancelFlag) break;
      onProgress({ done, total: todo.length, current: book.title });
      let text = null;
      try { text = await extractBookText(book); } catch { text = null; }
      if (text && text.length > 20) {
        const p = files(book.id);
        await fsp.writeFile(p.t, await gzip(text));
        await fsp.writeFile(p.f, await gzip(fold(text)));
        db.run('INSERT INTO fulltext_meta (book_id, mtime, indexed_at) VALUES (?, ?, ?) ON CONFLICT(book_id) DO UPDATE SET mtime=excluded.mtime, indexed_at=excluded.indexed_at',
          [book.id, book.mtime, Date.now()]);
      } else {
        removeIndex(book.id);
        db.run('INSERT INTO fulltext_meta (book_id, mtime, indexed_at) VALUES (?, ?, 0) ON CONFLICT(book_id) DO UPDATE SET mtime=excluded.mtime, indexed_at=0', [book.id, book.mtime]);
      }
      done++;
      await new Promise((r) => setImmediate(r));
    }
    onProgress({ done, total: todo.length, current: null, finished: true });
    return { done, total: todo.length, cancelled: cancelFlag };
  } finally {
    running = false;
  }
}

// ---------- wyszukiwanie ----------

async function search(query, { maxBooks = 200, snippets = 3, context = 70 } = {}) {
  const folded = squash(fold(String(query || '')));
  if (folded.length < 2) return { results: [], scanned: 0, truncated: false };
  const words = folded.split(' ').filter((w) => w.length >= 2);
  const rows = db.all(`SELECT m.book_id AS id, b.title, b.author, b.format FROM fulltext_meta m
                       JOIN books b ON b.id = m.book_id WHERE m.indexed_at > 0`);
  const results = [];
  let scanned = 0;
  for (const row of rows) {
    const p = files(row.id);
    let f;
    try { f = (await gunzip(await fsp.readFile(p.f))).toString('utf8'); } catch { continue; }
    scanned++;
    const positions = [];
    let from = 0;
    let count = 0;
    for (let at = f.indexOf(folded, from); at >= 0; at = f.indexOf(folded, from)) {
      count++;
      if (positions.length < snippets) positions.push({ at, len: folded.length });
      from = at + folded.length;
      if (count > 5000) break;
    }
    let mode = 'phrase';
    if (!count && words.length > 1 && words.every((w) => f.includes(w))) {
      mode = 'words';
      const at = f.indexOf(words[0]);
      positions.push({ at, len: words[0].length });
      count = 1;
    }
    if (!count) continue;
    const t = (await gunzip(await fsp.readFile(p.t))).toString('utf8');
    results.push({
      bookId: row.id, title: row.title, author: row.author, format: row.format, count, mode,
      snippets: positions.map(({ at, len }) => ({
        pre: t.slice(Math.max(0, at - context), at),
        match: t.slice(at, at + len),
        post: t.slice(at + len, at + len + context),
      })),
    });
    if (results.length >= maxBooks) break;
    await new Promise((r) => setImmediate(r));
  }
  results.sort((a, b) => (a.mode === b.mode ? b.count - a.count : a.mode === 'phrase' ? -1 : 1));
  return { results, scanned, truncated: results.length >= maxBooks };
}

module.exports = { mobiHtml, init, status, indexAll, cancel, search, removeIndex, clearAll, fold, palmdoc, htmlToText, extractBookText };
