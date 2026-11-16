// Masowe dopasowanie metadanych z raportem (okno w menu narzędzi).
import { $, esc, showModal, hideModal } from './ui.js';

const api = window.api;
let ctx = null;
let off = null;

async function refresh() {
  const n = await api.bulkPending();
  $('#bulk-info').textContent = n
    ? `Książek znanych tylko z pliku: ${n}. Czytnik poszuka ich w serwisach (lubimyczytac.pl, Google Books) i zapisze tylko dopasowania o bardzo wysokiej zgodności tytułu i autora. Pozostałe pokaże w raporcie.`
    : 'Wszystkie książki mają już metadane z sieci lub zostały dopasowane. 🎉';
  $('#bulk-start').classList.toggle('hidden', !n);
}

function renderReport(r) {
  const box = $('#bulk-report');
  const parts = [`<p><b>Dopasowano: ${r.applied.length}</b> z ${r.total}${r.cancelled ? ' (przerwano)' : ''}. Bez pewnego wyniku: ${r.skipped.length}. Błędy: ${r.errors.length}.</p>`];
  if (r.applied.length) {
    parts.push('<details open><summary>Dopasowane</summary><ul class="bulk-list">' +
      r.applied.map((a) => `<li>${esc(a.title)} <span class="hint">→ ${esc(a.matched)} (${esc(a.source)})</span></li>`).join('') + '</ul></details>');
  }
  if (r.skipped.length) {
    parts.push('<details><summary>Bez pewnego dopasowania — kliknij, aby poprawić ręcznie</summary><ul class="bulk-list">' +
      r.skipped.map((s) => `<li><a href="#" data-id="${s.id}">${esc(s.title)}</a> <span class="hint">${esc(s.author)}</span></li>`).join('') + '</ul></details>');
  }
  if (r.errors.length) {
    parts.push('<details><summary>Błędy</summary><ul class="bulk-list">' + r.errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul></details>');
  }
  box.innerHTML = parts.join('');
  box.querySelectorAll('a[data-id]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    hideModal('#bulk-modal');
    ctx.openDetail(Number(a.dataset.id));
  }));
}

async function start() {
  $('#bulk-start').classList.add('hidden');
  $('#bulk-cancel').classList.remove('hidden');
  $('#bulk-progress').classList.remove('hidden');
  $('#bulk-report').innerHTML = '';
  off = api.onBulkProgress((p) => {
    $('#bulk-progress').value = p.total ? p.done / p.total : 1;
    if (p.current) $('#bulk-info').textContent = `Dopasowuję ${p.done + 1} z ${p.total}: ${p.current}`;
  });
  try {
    const report = await api.bulkRun();
    renderReport(report);
    if (report.applied.length) await ctx.loadBooks();
  } catch (err) {
    ctx.toast('Dopasowanie nie powiodło się: ' + err.message);
  } finally {
    off?.();
    $('#bulk-cancel').classList.add('hidden');
    $('#bulk-progress').classList.add('hidden');
    await refresh();
  }
}

export function initBulkMeta(context) {
  ctx = context;
  $('#btn-bulk').addEventListener('click', async () => {
    $('#bulk-report').innerHTML = '';
    showModal('#bulk-modal');
    await refresh();
  });
  $('#bulk-close').addEventListener('click', () => hideModal('#bulk-modal'));
  $('#bulk-start').addEventListener('click', start);
  $('#bulk-cancel').addEventListener('click', () => api.bulkCancel());
}
