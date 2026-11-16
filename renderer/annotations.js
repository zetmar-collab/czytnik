// Zakładki, zakreślenia i notatki w czytniku (EPUB/MOBI/AZW3: zakreślenia i notatki przez CFI;
// PDF: zakładki stron). Dane trzymane w bazie (tabela annotations), rysowane nakładką foliate-js.
import { Overlayer } from '../node_modules/foliate-js/overlayer.js';

const $ = (s) => document.querySelector(s);
const api = window.api;

export const COLORS = ['#ffd54a', '#7bd88f', '#6cb6ff', '#ff8a80'];

const st = { view: null, book: null, list: [], toast: () => {}, pending: null, editing: null, noteColor: COLORS[0], offs: [] };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parseLoc = (a) => { try { return JSON.parse(a.loc); } catch { return {}; } };

// ---------- rysowanie ----------

function drawAll() {
  if (!st.view || st.view.isFixedLayout) return;
  for (const a of st.list) {
    if (a.type === 'bookmark') continue;
    const cfi = parseLoc(a).cfi;
    if (cfi) Promise.resolve(st.view.addAnnotation({ value: cfi, color: a.color || COLORS[0] })).catch(() => {});
  }
}

// ---------- pasek po zaznaczeniu tekstu ----------

function showBar(text) {
  $('#sel-text').textContent = text.length > 60 ? text.slice(0, 60) + '…' : text;
  $('#sel-bar').classList.remove('hidden');
}
function hideBar() {
  st.pending = null;
  $('#sel-bar').classList.add('hidden');
}

function attachSelection(doc, index) {
  if (st.view?.isFixedLayout) return; // PDF: bez zakreśleń (brak stabilnych zakresów w warstwie tekstu)
  const check = () => {
    const sel = doc.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    if (!text || !sel.rangeCount) { hideBar(); return; }
    st.pending = { index, range: sel.getRangeAt(0).cloneRange(), text, doc };
    showBar(text);
  };
  doc.addEventListener('mouseup', () => setTimeout(check, 10));
  doc.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Shift') check(); });
  doc.addEventListener('mousedown', () => setTimeout(() => {
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed) hideBar();
  }, 0));
}

async function createFromSelection(color, note) {
  const p = st.pending;
  if (!p || !st.book) return;
  const view = st.view;
  const cfi = view.getCFI(p.index, p.range);
  const loc = JSON.stringify({
    cfi, index: p.index,
    fraction: view.lastLocation?.fraction ?? null,
    label: view.lastLocation?.tocItem?.label || '',
  });
  const row = await api.addAnnotation({
    book_id: st.book.id, type: note ? 'note' : 'highlight', loc,
    text: p.text.slice(0, 1000), note: note || null, color,
  });
  st.list.push(row);
  Promise.resolve(view.addAnnotation({ value: cfi, color })).catch(() => {});
  try { p.doc.getSelection().removeAllRanges(); } catch { /* ignoruj */ }
  hideBar();
  renderPanel();
  st.toast(note ? 'Zapisano notatkę' : 'Dodano zakreślenie');
}

// ---------- zakładki ----------

function currentCfi() {
  return st.view?.lastLocation?.cfi || null;
}

function bookmarkAt(cfi) {
  return st.list.find((a) => a.type === 'bookmark' && parseLoc(a).cfi === cfi);
}

export async function toggleBookmark() {
  const view = st.view;
  const cfi = currentCfi();
  if (!view || !cfi || !st.book) return;
  const existing = bookmarkAt(cfi);
  if (existing) {
    await api.deleteAnnotation(existing.uid);
    st.list = st.list.filter((a) => a.uid !== existing.uid);
    st.toast('Usunięto zakładkę');
  } else {
    const loc = view.lastLocation;
    const label = loc?.tocItem?.label?.trim() || `Strona ${loc?.pageItem?.label || ''}`.trim() || 'Zakładka';
    const row = await api.addAnnotation({
      book_id: st.book.id, type: 'bookmark', text: label,
      loc: JSON.stringify({ cfi, index: view.renderer?.index ?? null, fraction: loc.fraction ?? null, label }),
    });
    st.list.push(row);
    st.toast('Dodano zakładkę');
  }
  updateBookmarkButton();
  renderPanel();
}

function updateBookmarkButton() {
  const btn = $('#reader-bookmark-btn');
  if (!btn) return;
  const on = !!bookmarkAt(currentCfi());
  btn.classList.toggle('active', on);
  btn.textContent = on ? '🔖' : '🏷️';
}

// ---------- panel ----------

const ICON = { bookmark: '🔖', highlight: '🖍️', note: '📝' };

function renderPanel() {
  const box = $('#ann-list');
  if (!box) return;
  const items = [...st.list].sort((a, b) => (parseLoc(a).fraction ?? 2) - (parseLoc(b).fraction ?? 2) || a.created_at - b.created_at);
  $('#ann-count').textContent = String(items.length);
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<p class="hint">Brak zakładek i notatek. Zaznacz fragment tekstu, aby go zakreślić, albo kliknij 🏷️ w pasku, aby dodać zakładkę.</p>';
    return;
  }
  for (const a of items) {
    const loc = parseLoc(a);
    const row = document.createElement('div');
    row.className = 'ann-item';
    row.dataset.uid = a.uid;
    row.innerHTML = `
      <div class="ann-head"><span class="ann-ico" style="${a.color ? `color:${esc(a.color)}` : ''}">${ICON[a.type] || '•'}</span>
        <span class="ann-label">${esc(loc.label || '')}</span>
        <span class="ann-actions">
          ${a.type !== 'bookmark' ? '<button data-act="edit" title="Edytuj notatkę">✏️</button>' : ''}
          <button data-act="del" title="Usuń">🗑️</button>
        </span></div>
      ${a.text ? `<div class="ann-text" style="${a.color ? `border-left-color:${esc(a.color)}` : ''}">${esc(a.text)}</div>` : ''}
      ${a.note ? `<div class="ann-note">${esc(a.note)}</div>` : ''}`;
    row.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'del') {
        await api.deleteAnnotation(a.uid);
        st.list = st.list.filter((x) => x.uid !== a.uid);
        if (a.type !== 'bookmark' && loc.cfi) st.view?.deleteAnnotation({ value: loc.cfi });
        updateBookmarkButton();
        renderPanel();
        return;
      }
      if (act === 'edit') { openNoteModal(a); return; }
      try { await st.view.goTo(loc.cfi); } catch { st.toast('Nie można przejść do tego miejsca'); }
    });
    box.append(row);
  }
}

function toMarkdown() {
  const title = st.book?.title || 'Książka';
  const lines = [`# ${title}`, ''];
  const items = [...st.list].sort((a, b) => (parseLoc(a).fraction ?? 2) - (parseLoc(b).fraction ?? 2));
  for (const a of items) {
    const label = parseLoc(a).label;
    if (a.type === 'bookmark') lines.push(`- 🔖 ${label || a.text || 'Zakładka'}`);
    else {
      lines.push(`> ${String(a.text || '').replace(/\n/g, '\n> ')}`);
      if (a.note) lines.push('', a.note);
      if (label) lines.push('', `*${label}*`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- okno notatki ----------

function openNoteModal(annotation = null) {
  st.editing = annotation;
  st.noteColor = annotation?.color || COLORS[0];
  $('#note-quote').textContent = annotation?.text || st.pending?.text || '';
  $('#note-text').value = annotation?.note || '';
  buildNoteColors();
  $('#note-modal').classList.remove('hidden');
  setTimeout(() => $('#note-text').focus(), 30);
}

function buildNoteColors() {
  const box = $('#note-colors');
  box.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'color-dot' + (c === st.noteColor ? ' active' : '');
    b.style.background = c;
    b.title = 'Kolor';
    b.addEventListener('click', () => { st.noteColor = c; buildNoteColors(); });
    box.append(b);
  }
}

async function saveNote() {
  const note = $('#note-text').value.trim();
  if (st.editing) {
    const row = await api.updateAnnotation(st.editing.uid, { note, color: st.noteColor });
    const i = st.list.findIndex((a) => a.uid === row.uid);
    if (i >= 0) st.list[i] = row;
    const cfi = parseLoc(row).cfi;
    if (cfi) Promise.resolve(st.view.addAnnotation({ value: cfi, color: row.color || COLORS[0] })).catch(() => {});
    renderPanel();
  } else {
    await createFromSelection(st.noteColor, note || null);
  }
  $('#note-modal').classList.add('hidden');
  st.editing = null;
}

// ---------- podpięcie do czytnika ----------

let wired = false;
function wireUiOnce() {
  if (wired) return;
  wired = true;
  $('#reader-bookmark-btn').addEventListener('click', toggleBookmark);
  $('#reader-ann-btn').addEventListener('click', () => {
    $('#ann-panel').classList.toggle('hidden');
    renderPanel();
  });
  $('#ann-close').addEventListener('click', () => $('#ann-panel').classList.add('hidden'));
  $('#ann-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toMarkdown()); st.toast('Skopiowano notatki jako Markdown'); }
    catch { st.toast('Nie udało się skopiować do schowka'); }
  });
  // przyciski paska zaznaczenia nie mogą zabierać zaznaczenia z dokumentu książki
  $('#sel-bar').addEventListener('mousedown', (e) => e.preventDefault());
  document.querySelectorAll('#sel-colors .color-dot').forEach((b, i) => {
    b.style.background = COLORS[i];
    b.addEventListener('click', () => createFromSelection(COLORS[i], null));
  });
  $('#sel-note').addEventListener('click', () => openNoteModal(null));
  $('#sel-close').addEventListener('click', hideBar);
  $('#note-save').addEventListener('click', saveNote);
  $('#note-cancel').addEventListener('click', () => { $('#note-modal').classList.add('hidden'); st.editing = null; });
  $('#note-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote(); });
}

export async function onBookOpened(view, book, toast) {
  wireUiOnce();
  st.view = view;
  st.book = book;
  st.toast = toast || (() => {});
  st.list = [];
  hideBar();
  $('#ann-panel').classList.add('hidden');
  const onDraw = (e) => e.detail.draw(Overlayer.highlight, { color: e.detail.annotation.color || COLORS[0] });
  const onLoad = (e) => attachSelection(e.detail.doc, e.detail.index);
  const onShow = (e) => {
    const a = st.list.find((x) => parseLoc(x).cfi === e.detail.value);
    if (!a) return;
    $('#ann-panel').classList.remove('hidden');
    renderPanel();
    document.querySelector(`.ann-item[data-uid="${a.uid}"]`)?.classList.add('flash');
  };
  view.addEventListener('draw-annotation', onDraw);
  view.addEventListener('load', onLoad);
  view.addEventListener('create-overlay', drawAll);
  view.addEventListener('show-annotation', onShow);
  view.addEventListener('relocate', updateBookmarkButton);
  st.offs = [
    () => view.removeEventListener('draw-annotation', onDraw),
    () => view.removeEventListener('load', onLoad),
    () => view.removeEventListener('create-overlay', drawAll),
    () => view.removeEventListener('show-annotation', onShow),
    () => view.removeEventListener('relocate', updateBookmarkButton),
  ];
  try { st.list = await api.listAnnotations(book.id); } catch { st.list = []; }
  drawAll();
  renderPanel();
  updateBookmarkButton();
}

export function onBookClosing() {
  for (const off of st.offs) off();
  st.offs = [];
  hideBar();
  st.view = null;
  st.book = null;
  st.list = [];
}

// do testów i skrótów klawiszowych
export const _state = st;
