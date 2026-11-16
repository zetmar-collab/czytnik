// Czytniki i tablety przez USB: wysyłanie, pobieranie i synchronizacja dwustronna.
import { $, esc, showModal, hideModal } from './ui.js';

const api = window.api;
let ctx = null;
let devices = [];
let off = null;

const fmtMB = (n) => (n ? (n > 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB') : '?');

function current() { return devices.find((d) => d.root === $('#dev-select').value) || null; }

async function refresh() {
  $('#dev-info').textContent = 'Szukam urządzeń…';
  devices = await api.devList();
  const sel = $('#dev-select');
  sel.innerHTML = devices.map((d) => `<option value="${esc(d.root)}">${esc(d.root)} — ${esc(d.name)}${d.label ? ' „' + esc(d.label) + '”' : ''}</option>`).join('');
  const none = !devices.length;
  ['#dev-send', '#dev-receive', '#dev-sync'].forEach((s) => { $(s).disabled = none; });
  $('#dev-info').textContent = none
    ? 'Nie wykryto żadnego czytnika ani tabletu. Podłącz urządzenie, włącz tryb pamięci masowej USB i kliknij „Odśwież".'
    : '';
  await showDeviceInfo();
  $('#dev-shelf').innerHTML = (await api.listCollections()).map((c) => `<option value="${c.id}">${esc(c.name)} (${c.count})</option>`).join('');
  $('#dev-importdir').textContent = await api.devImportDir();
}

async function showDeviceInfo() {
  const d = current();
  if (!d) return;
  let n = '…';
  try { n = await api.devCount(d.root); } catch { n = '?'; }
  const fmts = d.formats.map((f) => f.toUpperCase()).join(', ');
  $('#dev-info').textContent = `${d.name}: wolne ${fmtMB(d.free)} z ${fmtMB(d.total)}, książek na urządzeniu: ${n}. Obsługiwane formaty: ${fmts}.` +
    (d.folders ? '' : ' To urządzenie nie pokazuje folderów, więc książki trafiają do jednego katalogu.');
  $('#dev-folders').disabled = !d.folders;
}

function scopeOpts() {
  const scope = $('#dev-scope').value;
  const opts = { scope, folderPerShelf: $('#dev-folders').checked };
  if (scope === 'shelf') opts.collectionId = Number($('#dev-shelf').value);
  if (scope === 'selected') opts.ids = [...ctx.state.selected];
  return opts;
}

function renderReport({ sent, received }) {
  const p = [];
  if (sent) {
    p.push(`<p><b>Wysłano: ${sent.copied.length}</b> (${(sent.bytes / 1048576).toFixed(1)} MB), już były: ${sent.existing}` +
      (sent.unsupported.length ? `, nieobsługiwany format: ${sent.unsupported.length}` : '') +
      (sent.missing.length ? `, brak pliku: ${sent.missing.length}` : '') + '.</p>');
    if (sent.unsupported.length) {
      p.push('<details><summary>Pominięte — format nieobsługiwany przez urządzenie</summary><ul class="bulk-list">' +
        sent.unsupported.map((u) => `<li>${esc(u.title)} <span class="hint">(${esc(u.format.toUpperCase())})</span></li>`).join('') + '</ul></details>');
    }
    if (sent.errors.length) p.push('<details open><summary>Błędy wysyłania</summary><ul class="bulk-list">' + sent.errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul></details>');
  }
  if (received) {
    p.push(`<p><b>Pobrano nowych: ${received.imported.length}</b>, znanych: ${received.known}` +
      (received.duplicates.length ? `, duplikatów pominięto: ${received.duplicates.length}` : '') +
      (received.shelvesAssigned ? `, przypisań do półek: ${received.shelvesAssigned}` : '') + '.</p>');
    if (received.imported.length) p.push('<details><summary>Nowe w bibliotece</summary><ul class="bulk-list">' + received.imported.map((b) => `<li>${esc(b.title)}</li>`).join('') + '</ul></details>');
    if (received.errors.length) p.push('<details open><summary>Błędy pobierania</summary><ul class="bulk-list">' + received.errors.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul></details>');
  }
  $('#dev-report').innerHTML = p.join('');
}

async function run(kind) {
  const d = current();
  if (!d) return;
  const opts = scopeOpts();
  if (opts.scope === 'selected' && !opts.ids.length && kind !== 'receive') { ctx.toast('Nie zaznaczono żadnych książek'); return; }
  ['#dev-send', '#dev-receive', '#dev-sync'].forEach((s) => { $(s).disabled = true; });
  $('#dev-progress').classList.remove('hidden');
  $('#dev-report').innerHTML = '';
  off = api.onDevProgress((p) => {
    $('#dev-progress').value = p.total ? p.done / p.total : 1;
    if (p.current) $('#dev-info').textContent = `${p.phase === 'send' ? 'Wysyłam' : 'Pobieram'} ${p.done + 1} z ${p.total}: ${p.current}`;
  });
  try {
    if (kind === 'send') renderReport({ sent: await api.devSend(d.root, opts) });
    else if (kind === 'receive') renderReport({ received: await api.devReceive(d.root) });
    else renderReport(await api.devSync(d.root, opts));
    await ctx.loadBooks();
  } catch (err) {
    $('#dev-report').innerHTML = `<p class="hint">Błąd: ${esc(err.message)}</p>`;
  } finally {
    off?.();
    $('#dev-progress').classList.add('hidden');
    ['#dev-send', '#dev-receive', '#dev-sync'].forEach((s) => { $(s).disabled = false; });
    await showDeviceInfo();
  }
}

export async function openDevices({ scope = 'all' } = {}) {
  $('#dev-report').innerHTML = '';
  showModal('#devices-modal');
  await refresh();
  $('#dev-scope').value = scope;
  $('#dev-shelf').classList.toggle('hidden', scope !== 'shelf');
}

export function initDevices(context) {
  ctx = context;
  $('#btn-devices').addEventListener('click', () => openDevices());
  $('#devices-close').addEventListener('click', () => hideModal('#devices-modal'));
  $('#dev-refresh').addEventListener('click', refresh);
  $('#dev-select').addEventListener('change', showDeviceInfo);
  $('#dev-scope').addEventListener('change', () => $('#dev-shelf').classList.toggle('hidden', $('#dev-scope').value !== 'shelf'));
  $('#dev-send').addEventListener('click', () => run('send'));
  $('#dev-receive').addEventListener('click', () => run('receive'));
  $('#dev-sync').addEventListener('click', () => run('sync'));
  $('#dev-pickdir').addEventListener('click', async () => {
    const r = await api.devPickImportDir();
    if (!r.canceled) $('#dev-importdir').textContent = r.dir;
  });
  $('#btn-device-selected').addEventListener('click', () => openDevices({ scope: 'selected' }));
  $('#btn-device-book').addEventListener('click', () => {
    if (!ctx.state.currentBook) return;
    ctx.state.selected.clear();
    ctx.state.selected.add(ctx.state.currentBook.id);
    openDevices({ scope: 'selected' });
  });
}
