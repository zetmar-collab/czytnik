// Masowe uzupełnianie metadanych: dla książek znanych tylko z pliku szuka pewnych dopasowań w sieci.
// Zastosowane zostają wyłącznie dopasowania o wysokiej zgodności tytułu (i autora, jeśli go znamy) —
// reszta trafia do raportu, żeby użytkownik mógł dopasować je ręcznie.
const fsp = require('fs/promises');
const db = require('./db');
const metadata = require('./metadata');
const V = require('./validate');

const SOURCES = ['lubimyczytac', 'google'];
const DELAY_MS = 700;
const MIN_TITLE = 0.8;

const tokens = (s) => db.normalizeText(s).split(' ').filter((w) => w.length > 1);

// Współczynnik Dice'a na zbiorach słów (0..1); 1 = te same słowa, niezależnie od kolejności.
function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

// Czy autor z kandydata pasuje do lokalnego? (nazwiska bywają zapisane w odwrotnej kolejności)
function authorMatches(local, remote) {
  if (!local) return true; // nie mamy autora — decyduje sam tytuł
  if (!remote) return false;
  const L = new Set(tokens(local));
  const R = tokens(remote);
  if (!L.size || !R.length) return false;
  return R.filter((w) => L.has(w)).length >= Math.min(L.size, 2) || similarity(local, remote) >= 0.5;
}

function bestMatch(book, candidates) {
  let best = null;
  for (const c of candidates) {
    const ts = similarity(book.title, c.title);
    if (ts < MIN_TITLE || !authorMatches(book.author, c.author)) continue;
    if (!best || ts > best.score) best = { cand: c, score: ts };
  }
  return best;
}

// Zapisuje kandydata w bazie (wspólne dla pojedynczego i masowego dopasowania).
async function applyCandidate(id, candidate, coversDir, { keepCover = false } = {}) {
  const full = await metadata.details(metadata.cleanCandidate(candidate));
  const fields = { meta_source: full.source };
  for (const f of ['title', 'author', 'description', 'publisher', 'year', 'isbn']) if (full[f]) fields[f] = full[f];
  if (full.rating != null) fields.rating = full.rating;
  const had = db.getBook(id);
  if (full.coverUrl && !(keepCover && had?.cover)) {
    try {
      const { buf, ext } = await metadata.downloadCover(full.coverUrl);
      const file = V.safeJoin(coversDir, `${id}.${ext}`);
      await fsp.writeFile(file, buf);
      fields.cover = file;
    } catch { /* okładka opcjonalna */ }
  }
  db.updateBook(id, fields);
  return db.getBook(id);
}

let running = false;
let cancelFlag = false;
const cancel = () => { cancelFlag = true; };

function pending() {
  return db.all("SELECT id, title, author FROM books WHERE meta_source = 'plik' AND title IS NOT NULL AND title <> '' ORDER BY title COLLATE NOCASE");
}

async function run(coversDir, { ids = null, onProgress = () => {}, delay = DELAY_MS } = {}) {
  if (running) throw new Error('Dopasowywanie już trwa');
  running = true;
  cancelFlag = false;
  const report = { applied: [], skipped: [], errors: [], total: 0, cancelled: false };
  try {
    let todo = pending();
    if (ids) { const set = new Set(ids); todo = todo.filter((b) => set.has(b.id)); }
    report.total = todo.length;
    for (let i = 0; i < todo.length; i++) {
      if (cancelFlag) { report.cancelled = true; break; }
      const book = todo[i];
      onProgress({ done: i, total: todo.length, current: book.title });
      const query = [book.title, book.author].filter(Boolean).join(' ');
      let match = null;
      let failures = 0;
      for (const source of SOURCES) {
        try {
          match = bestMatch(book, await metadata.search(source, query));
          if (match) { match.source = source; break; }
        } catch (err) {
          failures++;
          if (failures === SOURCES.length) report.errors.push(`${book.title}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, delay));
      }
      if (match) {
        try {
          await applyCandidate(book.id, match.cand, coversDir, { keepCover: true });
          report.applied.push({ id: book.id, title: book.title, matched: match.cand.title, source: match.source });
        } catch (err) {
          report.errors.push(`${book.title}: ${err.message}`);
        }
      } else if (failures < SOURCES.length) {
        report.skipped.push({ id: book.id, title: book.title, author: book.author || '' });
      }
      await new Promise((r) => setTimeout(r, delay));
    }
    onProgress({ done: report.total, total: report.total, current: null, finished: true });
    return report;
  } finally {
    running = false;
  }
}

module.exports = { run, cancel, pending, applyCandidate, similarity, authorMatches, bestMatch };
