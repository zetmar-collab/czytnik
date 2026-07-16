// Logika biblioteki: siatka książek, szczegóły, edycja, metadane online, skanowanie.
import { openReader } from './reader.js';

const $ = (s) => document.querySelector(s);
const api = window.api;

const state = {
  books: [],
  filters: { search: '', format: '', sort: 'added_desc' },
  currentBook: null,
  metaSource: 'lubimyczytac',
  scanning: false,
  selected: new Set(),
};

// ---------- motyw aplikacji ----------

async function initTheme() {
  const theme = await api.getSetting('appTheme', 'dark');
  applyTheme(theme);
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-name').textContent = theme === 'dark' ? 'ciemny' : 'jasny';
}
$('#btn-theme').addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await api.setSetting('appTheme', next);
});

// ---------- pomocnicze ----------

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

async function coverUrl(book) {
  if (!book.cover) return null;
  return await api.coverUrl(book.cover) + '?v=' + (book.mtime || 0);
}

// ---------- siatka biblioteki ----------

async function loadBooks() {
  state.books = await api.listBooks(state.filters);
  renderGrid();
}

async function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#lib-count').textContent = `${state.books.length} książek`;
  $('#empty-state').classList.toggle('hidden', state.books.length > 0);

  for (const book of state.books) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = book.id;
    if (state.selected.has(book.id)) card.classList.add('selected');
    const pct = Math.round((book.progress_pct || 0) * 100);
    card.innerHTML = `
      <div class="card-cover">
        <div class="placeholder">${esc(book.title || '?')}</div>
        <span class="format-badge">${esc(book.format)}</span>
        <span class="card-check" title="Zaznacz">${state.selected.has(book.id) ? '✔' : ''}</span>
        ${pct > 0 ? `<div class="card-progress"><div style="width:${pct}%"></div></div>` : ''}
      </div>
      <div class="card-title">${esc(book.title || 'Bez tytułu')}</div>
      <div class="card-author">${esc(book.author || '')}</div>`;
    card.querySelector('.card-check').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(book.id);
    });
    card.addEventListener('click', () => {
      if (state.selected.size > 0) toggleSelect(book.id);
      else openDetail(book.id);
    });
    grid.append(card);
    if (book.cover) {
      coverUrl(book).then((url) => {
        if (!url) return;
        const img = new Image();
        img.onload = () => {
          const holder = card.querySelector('.card-cover .placeholder');
          if (holder) holder.replaceWith(img);
        };
        img.src = url;
      });
    }
  }
}

// ---------- zaznaczanie wielu książek ----------

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  updateSelectionUI();
}

function clearSelection() {
  state.selected.clear();
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = state.selected.size;
  $('#select-bar').classList.toggle('hidden', n === 0);
  $('#select-count').textContent = `Zaznaczono: ${n}`;
  document.querySelectorAll('.card').forEach((card) => {
    const id = Number(card.dataset.id);
    const sel = state.selected.has(id);
    card.classList.toggle('selected', sel);
    card.querySelector('.card-check').textContent = sel ? '✔' : '';
  });
  document.body.classList.toggle('selecting', n > 0);
}

$('#btn-select-all').addEventListener('click', () => {
  for (const b of state.books) state.selected.add(b.id);
  updateSelectionUI();
});
$('#btn-select-cancel').addEventListener('click', clearSelection);
$('#btn-delete-selected').addEventListener('click', async () => {
  const n = state.selected.size;
  if (!n) return;
  const ok = confirm(`Usunąć ${n} zaznaczonych książek z biblioteki?\n(Pliki na dysku NIE zostaną usunięte.)`);
  if (!ok) return;
  const removed = await api.removeMany([...state.selected]);
  clearSelection();
  toast(`Usunięto ${removed} książek z biblioteki`);
  loadBooks();
});

// filtry
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.search = e.target.value.trim();
    loadBooks();
  }, 250);
});
$('#sort').addEventListener('change', (e) => {
  state.filters.sort = e.target.value;
  loadBooks();
});
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filters.format = btn.dataset.format;
    loadBooks();
  });
});

// ---------- modale: otwieranie/zamykanie ----------

function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden'));
});
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('mousedown', (e) => {
    if (e.target === m && !state.scanning) m.classList.add('hidden');
  });
});

// ---------- szczegóły książki ----------

const SOURCE_NAMES = {
  plik: 'z pliku', reczne: 'ręcznie', lubimyczytac: 'Lubimyczytać.pl',
  upolujebooka: 'UpolujEbooka.pl', google: 'Google Books',
};

async function openDetail(id) {
  const book = await api.getBook(id);
  if (!book) return;
  state.currentBook = book;

  $('#detail-title').textContent = book.title || 'Bez tytułu';
  $('#detail-author').textContent = book.author || 'Autor nieznany';
  const metaParts = [];
  if (book.publisher) metaParts.push(book.publisher);
  if (book.year) metaParts.push(book.year);
  if (book.isbn) metaParts.push('ISBN ' + book.isbn);
  if (book.series) metaParts.push('Cykl: ' + book.series);
  metaParts.push(book.format.toUpperCase() + ' · ' + formatSize(book.size));
  metaParts.push('dane: ' + (SOURCE_NAMES[book.meta_source] || book.meta_source));
  $('#detail-meta').textContent = metaParts.join('  ·  ');
  $('#detail-rating').textContent = book.rating ? `★ ${book.rating}` : '';
  $('#detail-desc').textContent = book.description || 'Brak opisu. Kliknij „Pobierz metadane”, aby pobrać dane z internetu, albo „Edytuj”, aby dodać je ręcznie.';
  $('#detail-path').textContent = book.path;

  const pct = Math.round((book.progress_pct || 0) * 100);
  $('#detail-progress').textContent = pct > 0 ? `Przeczytano: ${pct}%` : '';

  const coverEl = $('#detail-cover');
  coverEl.innerHTML = '📕';
  const url = await coverUrl(book);
  if (url) coverEl.innerHTML = `<img src="${url}?t=${Date.now()}" alt="">`;

  showModal('#detail-modal');
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

$('#btn-read').addEventListener('click', () => {
  if (!state.currentBook) return;
  hideModal('#detail-modal');
  openReader(state.currentBook, { onClose: loadBooks, toast });
});
$('#btn-folder').addEventListener('click', () => api.showInFolder(state.currentBook.id));
$('#btn-delete').addEventListener('click', async () => {
  if (!state.currentBook) return;
  const ok = confirm(`Usunąć „${state.currentBook.title}” z biblioteki?\n(Plik na dysku NIE zostanie usunięty.)`);
  if (!ok) return;
  await api.removeBook(state.currentBook.id);
  hideModal('#detail-modal');
  toast('Usunięto z biblioteki');
  loadBooks();
});
$('#btn-cover').addEventListener('click', async () => {
  const file = await api.pickCover(state.currentBook.id);
  if (file) {
    toast('Zmieniono okładkę');
    await openDetail(state.currentBook.id);
    loadBooks();
  }
});

// ---------- edycja ręczna ----------

$('#btn-edit').addEventListener('click', () => {
  const b = state.currentBook;
  const f = $('#edit-form');
  f.title.value = b.title || '';
  f.author.value = b.author || '';
  f.publisher.value = b.publisher || '';
  f.year.value = b.year || '';
  f.isbn.value = b.isbn || '';
  f.rating.value = b.rating ?? '';
  f.series.value = b.series || '';
  f.description.value = b.description || '';
  showModal('#edit-modal');
});

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const fields = {
    title: f.title.value.trim() || null,
    author: f.author.value.trim() || null,
    publisher: f.publisher.value.trim() || null,
    year: f.year.value.trim() || null,
    isbn: f.isbn.value.trim() || null,
    rating: f.rating.value !== '' ? parseFloat(f.rating.value) : null,
    series: f.series.value.trim() || null,
    description: f.description.value.trim() || null,
    meta_source: 'reczne',
  };
  await api.updateBook(state.currentBook.id, fields);
  hideModal('#edit-modal');
  toast('Zapisano zmiany');
  await openDetail(state.currentBook.id);
  loadBooks();
});

// ---------- metadane z internetu ----------

$('#btn-fetch-meta').addEventListener('click', () => {
  const b = state.currentBook;
  $('#meta-query').value = [b.title, b.author].filter(Boolean).join(' ');
  $('#meta-results').innerHTML = '';
  $('#meta-status').textContent = '';
  showModal('#meta-modal');
  searchMeta();
});

document.querySelectorAll('.source-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.source-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.metaSource = btn.dataset.source;
    searchMeta();
  });
});
$('#meta-go').addEventListener('click', searchMeta);
$('#meta-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMeta(); });

async function searchMeta() {
  const query = $('#meta-query').value.trim();
  if (!query) return;
  const status = $('#meta-status');
  const results = $('#meta-results');
  results.innerHTML = '';
  status.textContent = 'Szukam…';
  try {
    const candidates = await api.searchMeta(state.metaSource, query);
    status.textContent = candidates.length ? `Znaleziono: ${candidates.length}` : 'Brak wyników. Spróbuj innego źródła lub zmień zapytanie.';
    for (const c of candidates) {
      const item = document.createElement('div');
      item.className = 'meta-item';
      item.innerHTML = `
        ${c.coverUrl ? `<img src="${esc(c.coverUrl)}" alt="">` : '<div class="no-cover">📕</div>'}
        <div class="meta-item-info">
          <h4>${esc(c.title)}</h4>
          <p>${esc(c.author || '—')}${c.year ? ' · ' + esc(c.year) : ''}${c.rating ? ' · ★ ' + esc(String(c.rating)) : ''}</p>
          <div class="desc">${esc(c.description || '')}</div>
        </div>
        <button class="primary">Użyj</button>`;
      item.querySelector('button').addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Pobieram…';
        try {
          await api.applyMeta(state.currentBook.id, c);
          hideModal('#meta-modal');
          toast('Zapisano metadane');
          await openDetail(state.currentBook.id);
          loadBooks();
        } catch (err) {
          toast('Błąd: ' + err.message);
          e.target.disabled = false;
          e.target.textContent = 'Użyj';
        }
      });
      results.append(item);
    }
  } catch (err) {
    status.textContent = 'Błąd pobierania: ' + err.message;
  }
}

// ---------- dodawanie plików i folderu ----------

$('#btn-add-files').addEventListener('click', async () => {
  const result = await api.addFiles();
  if (!result) return;
  toast(`Dodano ${result.added} książek` + (result.skipped ? ` (pominięto ${result.skipped} — duplikaty lub zły format)` : ''));
  loadBooks();
});

$('#btn-quick-folder').addEventListener('click', async () => {
  toastPersistent('Skanuję folder…');
  const result = await api.addFolder();
  if (!result) { $('#toast').classList.add('hidden'); return; }
  toast(`Przejrzano ${result.scanned} plików, dodano ${result.added} nowych książek`);
  loadBooks();
});

function toastPersistent(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
}

// ---------- skanowanie ----------

const scanFolders = new Set();

$('#btn-scan').addEventListener('click', async () => {
  const drives = await api.listDrives();
  const list = $('#drive-list');
  list.innerHTML = '';
  for (const d of drives) {
    const label = document.createElement('label');
    label.className = 'drive-item';
    label.innerHTML = `<input type="checkbox" value="${esc(d)}"> 💾 ${esc(d)}`;
    list.append(label);
  }
  renderFolderChips();
  showModal('#scan-modal');
});

$('#btn-add-folder').addEventListener('click', async () => {
  const folders = await api.pickFolder();
  folders.forEach((f) => scanFolders.add(f));
  renderFolderChips();
});

function renderFolderChips() {
  const box = $('#folder-chips');
  box.innerHTML = '';
  for (const f of scanFolders) {
    const chip = document.createElement('span');
    chip.className = 'folder-chip';
    chip.innerHTML = `📂 ${esc(f)} <button title="Usuń">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      scanFolders.delete(f);
      renderFolderChips();
    });
    box.append(chip);
  }
}

$('#btn-start-scan').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('#drive-list input:checked')].map((i) => i.value);
  const dirs = [...checked, ...scanFolders];
  if (!dirs.length) { toast('Zaznacz dysk lub dodaj folder'); return; }
  const formats = [...document.querySelectorAll('#scan-formats input:checked')].map((i) => i.value);
  if (!formats.length) { toast('Zaznacz przynajmniej jeden format pliku'); return; }

  state.scanning = true;
  $('#scan-progress').classList.remove('hidden');
  $('#btn-start-scan').disabled = true;
  try {
    const result = await api.startScan(dirs, formats);
    toast(result.cancelled
      ? `Przerwano. Dodano ${result.added} nowych książek.`
      : `Gotowe! Przejrzano ${result.scanned} plików, dodano ${result.added} nowych książek.`);
  } catch (err) {
    toast('Błąd skanowania: ' + err.message);
  }
  state.scanning = false;
  $('#scan-progress').classList.add('hidden');
  $('#btn-start-scan').disabled = false;
  hideModal('#scan-modal');
  loadBooks();
});

api.onScanProgress((p) => {
  $('#scan-stats').textContent = `Znaleziono plików: ${p.scanned} · nowych: ${p.added}`;
  $('#scan-current').textContent = p.current || '';
});

$('#btn-cancel-scan').addEventListener('click', () => api.cancelScan());

$('#btn-clear-db').addEventListener('click', async () => {
  const ok = confirm('Wyczyścić całą bazę danych?\n\nWszystkie książki, okładki i postępy czytania zostaną usunięte z biblioteki.\nPliki książek na dysku NIE zostaną usunięte.');
  if (!ok) return;
  const count = await api.clearLibrary();
  toast(`Wyczyszczono bazę — usunięto ${count} wpisów`);
  hideModal('#scan-modal');
  loadBooks();
});

$('#btn-prune').addEventListener('click', async () => {
  const removed = await api.pruneMissing();
  toast(removed ? `Usunięto ${removed} wpisów bez plików` : 'Wszystkie pliki istnieją');
  loadBooks();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected.size && $('#reader').classList.contains('hidden')) {
    clearSelection();
  }
});

// ---------- start ----------

initTheme().then(loadBooks);
