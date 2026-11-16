// Wyszukiwanie w otwartej książce (foliate view.search) oraz po całej bibliotece (okno narzędzi).
import { $, esc, showModal, hideModal } from './ui.js';

const api = window.api;
let view = null;
let runId = 0;
let pendingQuery = null;
let count = 0;

function setOpen(open) {
  $('#search-panel').classList.toggle('hidden', !open);
  if (open) {
    $('#ann-panel').classList.add('hidden');
    setTimeout(() => { $('#search-input').focus(); $('#search-input').select(); }, 20);
  } else {
    clear();
  }
}

function clear() {
  runId++;
  try { view?.clearSearch(); } catch { /* ignoruj */ }
  $('#search-list').innerHTML = '';
  $('#search-status').textContent = '';
  $('#search-count').textContent = '0';
  count = 0;
}

function addGroup(label, subitems) {
  const list = $('#search-list');
  if (label) {
    const h = document.createElement('div');
    h.className = 'search-group';
    h.textContent = label;
    list.append(h);
  }
  for (const { cfi, excerpt } of subitems) {
    const row = document.createElement('button');
    row.className = 'search-hit';
    row.innerHTML = `${esc(excerpt.pre.slice(-60))}<mark>${esc(excerpt.match)}</mark>${esc(excerpt.post.slice(0, 60))}`;
    row.addEventListener('click', () => view?.goTo(cfi));
    list.append(row);
    count++;
  }
  $('#search-count').textContent = String(count);
}

export async function run(query) {
  query = String(query || '').trim();
  if (!view) return;
  clear();
  if (query.length < 2) return;
  const id = ++runId;
  $('#search-input').value = query;
  $('#search-status').textContent = 'Szukam…';
  try {
    for await (const r of view.search({ query })) {
      if (id !== runId) return; // nowe wyszukiwanie lub zamknięcie panelu
      if (r === 'done') break;
      if (r.subitems) addGroup(r.label, r.subitems);
      else if (r.progress != null) $('#search-status').textContent = `Szukam… ${Math.round(r.progress * 100)}%`;
    }
  } catch (err) {
    console.error(err);
    $('#search-status').textContent = 'Błąd wyszukiwania: ' + err.message;
    return;
  }
  if (id === runId) {
    $('#search-status').textContent = count ? `Znaleziono: ${count}` : 'Brak wyników.';
    const first = $('#search-list .search-hit');
    if (first && pendingQuery === 'jump') first.click();
  }
}

// Wywoływane z czytnika po otwarciu książki.
export function onBookOpened(v) {
  view = v;
  const q = pendingQuery && pendingQuery !== 'jump' ? pendingQuery : null;
  pendingQuery = null;
  $('#reader-search-btn').disabled = false;
  if (q) { setOpen(true); run(q); }
}

export function onBookClosing() {
  clear();
  view = null;
  $('#search-panel').classList.add('hidden');
}

// Po otwarciu książki z wyników biblioteki: od razu wyszukaj frazę.
export function queueQuery(q) { pendingQuery = q; }

export function togglePanel() { if (view) setOpen($('#search-panel').classList.contains('hidden')); }

export function initBookSearch() {
  $('#reader-search-btn').addEventListener('click', togglePanel);
  $('#search-close').addEventListener('click', () => setOpen(false));
  $('#reader-ann-btn').addEventListener('click', () => $('#search-panel').classList.add('hidden'));
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); run($('#search-input').value); });
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && view) { e.preventDefault(); setOpen(true); }
  });
}

// ---------- wyszukiwanie w całej bibliotece ----------

let ftsCtx = null;
let offProgress = null;

async function refreshFtsStatus() {
  const s = await api.ftsStatus();
  const searchable = s.total - s.unsupported;
  $('#fts-status').textContent = s.pending
    ? `Zaindeksowano ${s.indexed} z ${searchable} książek (EPUB/MOBI/AZW3). Do zaindeksowania: ${s.pending}. PDF-y nie są przeszukiwane.`
    : `Zaindeksowano ${s.indexed} książek. PDF-y i pliki bez warstwy tekstowej nie są przeszukiwane.`;
  $('#fts-index-row').classList.toggle('hidden', !s.pending);
  return s;
}

async function ftsSearch() {
  const q = $('#fts-input').value.trim();
  const box = $('#fts-results');
  if (q.length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="hint">Szukam…</p>';
  const { results, scanned } = await api.ftsSearch(q);
  if (!results.length) { box.innerHTML = `<p class="hint">Brak wyników (przeszukano ${scanned} książek).</p>`; return; }
  box.innerHTML = '';
  const head = document.createElement('p');
  head.className = 'hint';
  head.textContent = `Książek z wynikami: ${results.length} (przeszukano ${scanned}).`;
  box.append(head);
  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'fts-book';
    card.innerHTML = `<h4>${esc(r.title || 'Bez tytułu')} <small>${esc(r.author || '')}</small>
        <span class="badge">${r.mode === 'words' ? 'wszystkie słowa' : r.count + '×'}</span></h4>` +
      r.snippets.map((s) => `<div class="fts-snip">…${esc(s.pre)}<mark>${esc(s.match)}</mark>${esc(s.post)}…</div>`).join('');
    const open = document.createElement('button');
    open.textContent = '📖 Otwórz i pokaż w książce';
    open.addEventListener('click', async () => {
      const book = await api.getBook(r.bookId);
      if (!book) return;
      hideModal('#fts-modal');
      queueQuery(r.mode === 'words' ? r.snippets[0]?.match || q : q);
      ftsCtx.openBook(book);
    });
    card.append(open);
    box.append(card);
  }
}

async function build() {
  $('#fts-build').classList.add('hidden');
  $('#fts-cancel').classList.remove('hidden');
  $('#fts-progress').classList.remove('hidden');
  offProgress = api.onFtsProgress((p) => {
    $('#fts-progress').value = p.total ? p.done / p.total : 1;
    if (p.current) $('#fts-status').textContent = `Indeksuję ${p.done + 1}/${p.total}: ${p.current}`;
  });
  try {
    await api.ftsBuild();
  } catch (err) {
    ftsCtx.toast('Indeksowanie nie powiodło się: ' + err.message);
  } finally {
    offProgress?.();
    $('#fts-build').classList.remove('hidden');
    $('#fts-cancel').classList.add('hidden');
    $('#fts-progress').classList.add('hidden');
    await refreshFtsStatus();
  }
}

export function initFulltext(ctx) {
  ftsCtx = ctx;
  $('#btn-fts').addEventListener('click', async () => {
    $('#fts-results').innerHTML = '';
    showModal('#fts-modal');
    const s = await refreshFtsStatus();
    if (s.pending && !s.indexed) build();
    else setTimeout(() => $('#fts-input').focus(), 30);
  });
  $('#fts-close').addEventListener('click', () => hideModal('#fts-modal'));
  $('#fts-build').addEventListener('click', build);
  $('#fts-cancel').addEventListener('click', () => api.ftsCancel());
  $('#fts-form').addEventListener('submit', (e) => { e.preventDefault(); ftsSearch(); });
}
