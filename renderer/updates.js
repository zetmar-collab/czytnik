// Aktualizacje z GitHuba: użytkownik decyduje, czy pobrać i czy zainstalować.
import { $, esc, showModal, hideModal } from './ui.js';

const api = window.api;
let ctx = null;
let info = null;
let off = null;

const show = (id, on) => $(id).classList.toggle('hidden', !on);

function render(i, { downloaded = false } = {}) {
  info = i;
  show('#update-notes', false);
  show('#update-download', false);
  show('#update-install', downloaded);
  show('#update-later', false);
  show('#update-skip', false);
  if (i.managedByStore) {
    $('#update-status').textContent = `Masz wersję ${i.current} ze sklepu Microsoft Store — aktualizuje się ona automatycznie przez sklep.`;
    return;
  }
  if (!i.available) {
    $('#update-status').textContent = i.skipped
      ? `Wersja ${i.version} została wcześniej pominięta. Masz ${i.current}.`
      : `Masz aktualną wersję (${i.current}).`;
    return;
  }
  $('#update-status').textContent = downloaded
    ? `Pobrano wersję ${i.version}. Kliknij „Zainstaluj", aby ją zainstalować.`
    : `Dostępna nowa wersja ${i.version} (masz ${i.current}).` + (i.asset ? '' : ' Dla tego systemu nie ma gotowego pliku — otwórz stronę wydania.');
  if (i.notes) { $('#update-notes').textContent = i.notes; show('#update-notes', true); }
  show('#update-download', !downloaded && !!i.asset);
  show('#update-later', !downloaded);
  show('#update-skip', !downloaded);
}

async function check() {
  $('#update-status').textContent = 'Sprawdzam…';
  try { render(await api.updateCheck()); }
  catch (err) { $('#update-status').textContent = 'Nie udało się sprawdzić aktualizacji: ' + err.message; }
}

async function download() {
  $('#update-download').disabled = true;
  show('#update-progress', true);
  off = api.onUpdateProgress((p) => {
    if (p.total) $('#update-progress').value = p.received / p.total;
    $('#update-status').textContent = `Pobieram… ${(p.received / 1048576).toFixed(0)}${p.total ? ' / ' + (p.total / 1048576).toFixed(0) : ''} MB`;
  });
  try {
    const r = await api.updateDownload();
    render(info, { downloaded: true });
    $('#update-status').textContent += r.verified
      ? ' Suma kontrolna pliku jest zgodna z wydaniem.'
      : ' Uwaga: wydanie nie zawiera sumy kontrolnej, więc pliku nie dało się zweryfikować.';
  } catch (err) {
    $('#update-status').textContent = 'Pobieranie nie powiodło się: ' + err.message;
  } finally {
    off?.();
    $('#update-download').disabled = false;
    show('#update-progress', false);
  }
}

export function initUpdates(context) {
  ctx = context;
  $('#btn-updates').addEventListener('click', async () => {
    show('#update-progress', false);
    showModal('#update-modal');
    const p = await api.updatePrefs();
    $('#update-auto').checked = p.auto;
    $('#update-auto').disabled = p.store;
    if (p.store) render({ managedByStore: true, current: p.current });
    else { $('#update-status').textContent = `Wersja programu: ${p.current}.`; show('#update-download', false); show('#update-install', false); show('#update-notes', false); }
  });
  $('#update-close').addEventListener('click', () => hideModal('#update-modal'));
  $('#update-later').addEventListener('click', () => hideModal('#update-modal'));
  $('#update-check').addEventListener('click', check);
  $('#update-download').addEventListener('click', download);
  $('#update-install').addEventListener('click', async () => {
    try { const r = await api.updateInstall(); if (r.revealed) ctx.toast('Plik pobrano — uruchom go ręcznie z folderu Pobrane'); }
    catch (err) { $('#update-status').textContent = 'Nie udało się uruchomić instalatora: ' + err.message; }
  });
  $('#update-skip').addEventListener('click', async () => {
    if (info?.version) await api.updateSkip(info.version);
    hideModal('#update-modal');
    ctx.toast(`Pominięto wersję ${info?.version}`);
  });
  $('#update-auto').addEventListener('change', (e) => api.updateSetAuto(e.target.checked));
  // powiadomienie z procesu głównego po starcie
  api.onUpdateAvailable((i) => { showModal('#update-modal'); render(i); });
}
