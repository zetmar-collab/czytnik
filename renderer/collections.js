// Półki (kolekcje), tagi i serie: filtry w pasku bocznym, przypisywanie książek do półek.
import { $, esc, showModal, hideModal, askText } from './ui.js';

const api = window.api;
let ctx = null;
let collections = [];

function setActive(container, matcher) {
  container.querySelectorAll('[data-key]').forEach((el) => el.classList.toggle('active', matcher(el.dataset.key)));
}

export async function refreshSidebar() {
  if (!ctx) return;
  const { state } = ctx;
  const [cols, tags, series] = await Promise.all([api.listCollections(), api.listTags(), api.listSeries()]);
  collections = cols;

  const list = $('#collection-list');
  list.innerHTML = '';
  const all = document.createElement('div');
  all.className = 'side-item';
  all.dataset.key = '';
  all.innerHTML = '<span class="si-name">📚 Wszystkie książki</span>';
  all.addEventListener('click', () => setCollection(null));
  list.append(all);
  for (const c of cols) {
    const row = document.createElement('div');
    row.className = 'side-item';
    row.dataset.key = String(c.id);
    row.innerHTML = `<span class="si-name">🗂️ ${esc(c.name)}</span><span class="si-count">${c.count}</span>
      <span class="si-actions"><button data-act="rename" title="Zmień nazwę">✏️</button><button data-act="del" title="Usuń półkę">🗑️</button></span>`;
    row.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'rename') {
        const name = await askText('Nowa nazwa półki', c.name);
        if (name) { await api.renameCollection(c.id, name); ctx.toast('Zmieniono nazwę półki'); refreshSidebar(); }
        return;
      }
      if (act === 'del') {
        if (confirm(`Usunąć półkę „${c.name}”?\n(Książki zostaną w bibliotece.)`)) {
          await api.deleteCollection(c.id);
          if (state.filters.collection === c.id) state.filters.collection = null;
          ctx.toast('Usunięto półkę');
          await ctx.loadBooks();
        }
        return;
      }
      setCollection(c.id);
    });
    list.append(row);
  }
  setActive(list, (k) => (state.filters.collection ? k === String(state.filters.collection) : k === ''));

  const tagBox = $('#tag-list');
  tagBox.innerHTML = '';
  tagBox.parentElement.classList.toggle('hidden', tags.length === 0);
  for (const t of tags) {
    const chip = document.createElement('button');
    chip.className = 'filter-btn' + (state.filters.tag === t.name ? ' active' : '');
    chip.textContent = `${t.name} (${t.count})`;
    chip.addEventListener('click', () => {
      state.filters.tag = state.filters.tag === t.name ? '' : t.name;
      ctx.loadBooks();
    });
    tagBox.append(chip);
  }

  const sel = $('#series-filter');
  const prev = state.filters.series || '';
  sel.innerHTML = '<option value="">Wszystkie serie</option>' +
    series.map((x) => `<option value="${esc(x.name)}">${esc(x.name)} (${x.count})</option>`).join('');
  sel.value = series.some((x) => x.name === prev) ? prev : '';
  if (sel.value !== prev) state.filters.series = sel.value;
  sel.parentElement.classList.toggle('hidden', series.length === 0);

  const col = cols.find((c) => c.id === state.filters.collection);
  $('#lib-title').textContent = col ? `Półka: ${col.name}` : (state.filters.tag ? `Tag: ${state.filters.tag}` : 'Biblioteka');
}

function setCollection(id) {
  ctx.state.filters.collection = id;
  ctx.loadBooks();
}

// Okno wyboru półek: tryb 'book' (przypisanie jednej książki) lub 'bulk' (dodanie zaznaczonych).
export async function openPicker({ mode, bookId = null, ids = [] }) {
  const cols = await api.listCollections();
  const current = mode === 'book' ? new Set(await api.getBookCollections(bookId)) : new Set();
  const box = $('#col-picker-list');
  const render = (list) => {
    box.innerHTML = '';
    if (!list.length) box.innerHTML = '<p class="hint">Nie masz jeszcze żadnych półek — utwórz pierwszą poniżej.</p>';
    for (const c of list) {
      const label = document.createElement('label');
      label.className = 'drive-item';
      label.innerHTML = `<input type="${mode === 'book' ? 'checkbox' : 'radio'}" name="colpick" value="${c.id}" ${current.has(c.id) ? 'checked' : ''}> 🗂️ ${esc(c.name)}`;
      box.append(label);
    }
  };
  render(cols);
  $('#col-picker-title').textContent = mode === 'book' ? 'Półki tej książki' : `Dodaj ${ids.length} zaznaczonych do półki`;

  await new Promise((resolve) => {
    const finish = async (save) => {
      $('#col-picker-ok').onclick = null;
      $('#col-picker-cancel').onclick = null;
      $('#col-new').onclick = null;
      if (save) {
        const picked = [...box.querySelectorAll('input:checked')].map((i) => Number(i.value));
        if (mode === 'book') {
          await api.setBookCollections(bookId, picked);
          ctx.toast('Zapisano półki');
        } else if (picked.length) {
          await api.addBooksToCollection(ids, picked[0]);
          ctx.toast(`Dodano ${ids.length} książek do półki`);
        }
      }
      hideModal('#col-picker-modal');
      resolve();
    };
    $('#col-picker-ok').onclick = () => finish(true);
    $('#col-picker-cancel').onclick = () => finish(false);
    $('#col-new').onclick = async () => {
      const name = await askText('Nazwa nowej półki', '', 'np. Do przeczytania');
      if (!name) return;
      const id = await api.createCollection(name);
      const fresh = await api.listCollections();
      current.add(id);
      render(fresh);
      box.querySelectorAll('input').forEach((i) => { if (mode !== 'book') i.checked = Number(i.value) === id; });
    };
    showModal('#col-picker-modal');
  });
  await ctx.loadBooks();
}

export function initCollections(context) {
  ctx = context;
  $('#btn-new-collection').addEventListener('click', async () => {
    const name = await askText('Nazwa nowej półki', '', 'np. Do przeczytania');
    if (!name) return;
    await api.createCollection(name);
    ctx.toast('Utworzono półkę');
    refreshSidebar();
  });
  $('#series-filter').addEventListener('change', (e) => {
    ctx.state.filters.series = e.target.value;
    ctx.loadBooks();
  });
  $('#btn-book-collections').addEventListener('click', () => {
    if (ctx.state.currentBook) openPicker({ mode: 'book', bookId: ctx.state.currentBook.id });
  });
  $('#btn-to-collection').addEventListener('click', () => {
    const ids = [...ctx.state.selected];
    if (ids.length) openPicker({ mode: 'bulk', ids });
  });
}
