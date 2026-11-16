// Kopia zapasowa i synchronizacja przez folder — okno w menu narzędzi.
import { $, showModal, hideModal } from './ui.js';

const api = window.api;
let ctx = null;

function describe(rep) {
  if (!rep) return '';
  if (rep.error) return 'Błąd: ' + rep.error;
  const parts = [];
  if (rep.matched != null) parts.push(`dopasowano książek: ${rep.matched}`);
  if (rep.unmatched) parts.push(`bez pliku w tej bibliotece: ${rep.unmatched}`);
  if (rep.progress) parts.push(`zaktualizowano pozycji czytania: ${rep.progress}`);
  if (rep.annotationsAdded) parts.push(`nowe zakładki/notatki: ${rep.annotationsAdded}`);
  if (rep.annotationsUpdated) parts.push(`zmienione: ${rep.annotationsUpdated}`);
  if (rep.collections) parts.push(`przypisania do półek: ${rep.collections}`);
  if (rep.reading) parts.push(`dni czytania: ${rep.reading}`);
  return parts.join(' · ') || 'Brak zmian.';
}

async function refresh() {
  const s = await api.syncStatus();
  const on = !!s.dir;
  $('#sync-now').classList.toggle('hidden', !on);
  $('#sync-off').classList.toggle('hidden', !on);
  $('#sync-pick').textContent = on ? '📁 Zmień folder…' : '📁 Wybierz folder…';
  let text = on ? `Folder: ${s.dir}` : 'Synchronizacja jest wyłączona.';
  if (on && s.last) {
    text += s.last.errors?.length
      ? ` — ostatnio ${new Date(s.last.at).toLocaleString('pl-PL')}, problem: ${s.last.errors[0]}`
      : ` — ostatnia synchronizacja: ${new Date(s.last.at).toLocaleString('pl-PL')} (pliki innych urządzeń: ${s.last.files})`;
  }
  $('#sync-state').textContent = text;
}

async function guarded(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { $('#backup-result').textContent = 'Błąd: ' + err.message; } finally { btn.disabled = false; }
}

export function initBackup(context) {
  ctx = context;
  $('#btn-backup').addEventListener('click', async () => {
    $('#backup-result').textContent = '';
    showModal('#backup-modal');
    await refresh();
    const ab = await api.autoBackupStatus();
    $('#autobackup-on').checked = ab.on;
    $('#autobackup-last').textContent = ab.last ? `Ostatnia kopia automatyczna: ${new Date(ab.last).toLocaleString('pl-PL')}.` : 'Jeszcze nie wykonano kopii automatycznej.';
  });
  $('#autobackup-on').addEventListener('change', (e) => api.autoBackupSet(e.target.checked));
  $('#autobackup-open').addEventListener('click', () => api.openBackupFolder());
  $('#backup-close').addEventListener('click', () => hideModal('#backup-modal'));

  $('#backup-export').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
    const r = await api.exportBackup();
    if (r.canceled) return;
    $('#backup-result').textContent = `Zapisano: ${r.book_count ?? r.books} książek, ${r.annotations} zakładek i notatek (${Math.round(r.bytes / 1024)} KB).`;
    ctx.toast('Zapisano kopię zapasową');
  }));

  $('#backup-import').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
    const r = await api.importBackup();
    if (r.canceled) return;
    $('#backup-result').textContent = 'Wczytano kopię — ' + describe(r);
    ctx.toast('Wczytano kopię zapasową');
    await ctx.loadBooks();
  }));

  $('#sync-pick').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
    const r = await api.syncPickFolder();
    if (r.canceled) return;
    $('#backup-result').textContent = 'Synchronizacja włączona — ' + describe(r.report);
    await refresh();
    await ctx.loadBooks();
  }));

  $('#sync-now').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
    const r = await api.syncNow();
    $('#backup-result').textContent = 'Zsynchronizowano — ' + describe(r);
    await refresh();
    await ctx.loadBooks();
  }));

  $('#sync-off').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
    await api.syncDisable();
    $('#backup-result').textContent = 'Synchronizacja wyłączona (pliki w folderze zostały nietknięte).';
    await refresh();
  }));

  // zmiany przyniesione z innego komputera
  api.onDataChanged(() => { ctx.loadBooks(); });
}
