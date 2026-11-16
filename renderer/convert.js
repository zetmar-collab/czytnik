// Konwersja książek (EPUB/MOBI/AZW3 -> DOCX, PDF, MD, TXT): okno wspólne dla jednej i wielu książek.
import { $, esc, showModal, hideModal } from './ui.js';

const api = window.api;
let ctx = null;
let ids = [];
let off = null;

const CONVERTIBLE = new Set(['epub', 'mobi', 'azw3']);

export async function openConvert(bookIds) {
  const books = (await Promise.all(bookIds.map((id) => api.getBook(id)))).filter(Boolean);
  ids = books.filter((b) => CONVERTIBLE.has(b.format)).map((b) => b.id);
  const skipped = books.length - ids.length;
  if (!ids.length) { ctx.toast('Konwersja obsługuje tylko książki EPUB, MOBI i AZW3'); return; }
  $('#convert-info').textContent = ids.length === 1
    ? `Książka: ${books.find((b) => b.id === ids[0]).title || 'bez tytułu'}`
    : `Książek do konwersji: ${ids.length}${skipped ? ` (pominięto ${skipped} w innych formatach, np. PDF)` : ''}. Zostaniesz poproszony o folder docelowy.`;
  $('#convert-report').innerHTML = '';
  showModal('#convert-modal');
}

function report(r) {
  const parts = [`<p><b>Skonwertowano: ${r.ok.length}</b>${r.failed.length ? `, błędy: ${r.failed.length}` : ''}.</p>`];
  if (r.failed.length) parts.push('<ul class="bulk-list">' + r.failed.map((f) => `<li>${esc(f.title)} <span class="hint">— ${esc(f.error)}</span></li>`).join('') + '</ul>');
  $('#convert-report').innerHTML = parts.join('');
}

async function start() {
  const format = document.querySelector('input[name="convfmt"]:checked').value;
  const btn = $('#convert-start');
  btn.disabled = true;
  $('#convert-progress').classList.remove('hidden');
  $('#convert-report').innerHTML = '';
  off = api.onConvertProgress((p) => {
    $('#convert-progress').value = p.total ? p.done / p.total : 1;
    if (p.current) $('#convert-info').textContent = `Konwertuję ${p.done + 1} z ${p.total}: ${p.current}`;
  });
  try {
    if (ids.length === 1) {
      $('#convert-progress').removeAttribute('value'); // postęp nieokreślony
      const r = await api.convertBook(ids[0], format);
      if (!r.canceled) { report({ ok: [r], failed: [] }); ctx.toast('Zapisano plik: ' + r.file); }
    } else {
      const r = await api.convertMany(ids, format);
      if (!r.canceled) { report(r); ctx.toast(`Skonwertowano ${r.ok.length} książek`); }
    }
  } catch (err) {
    $('#convert-report').innerHTML = `<p class="hint">Błąd: ${esc(err.message)}</p>`;
  } finally {
    off?.();
    btn.disabled = false;
    $('#convert-progress').classList.add('hidden');
    $('#convert-progress').value = 0;
  }
}

export function initConvert(context) {
  ctx = context;
  $('#convert-close').addEventListener('click', () => hideModal('#convert-modal'));
  $('#convert-start').addEventListener('click', start);
  $('#btn-convert-selected').addEventListener('click', () => openConvert([...ctx.state.selected]));
  $('#btn-convert-book').addEventListener('click', () => { if (ctx.state.currentBook) openConvert([ctx.state.currentBook.id]); });
  $('#btn-convert-tool').addEventListener('click', () => {
    const sel = [...ctx.state.selected];
    if (sel.length) openConvert(sel);
    else ctx.toast('Zaznacz książki w bibliotece (przytrzymaj Ctrl lub kliknij pole wyboru), a potem „Konwertuj…"');
  });
}
