// Wykrywanie duplikatów: grupy książek o tym samym ISBN albo tytule i autorze.
// Usuwa wyłącznie wpisy z biblioteki — pliki na dysku zostają nietknięte.
import { $, esc, showModal, hideModal } from './ui.js';

const api = window.api;
let ctx = null;

// Najlepszy egzemplarz do zachowania: z okładką, opisem, największym postępem, większy plik.
function score(b) {
  return (b.cover ? 4 : 0) + (b.description ? 2 : 0) + (b.meta_source && b.meta_source !== 'plik' ? 2 : 0) +
    (b.progress_pct > 0 ? 3 : 0) + (b.size || 0) / 1e9;
}

function fmtSize(n) {
  if (!n) return '';
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

async function open() {
  const groups = await api.findDuplicates();
  const box = $('#dups-list');
  box.innerHTML = '';
  $('#dups-summary').textContent = groups.length
    ? `Znaleziono ${groups.length} grup powtarzających się książek. Zaznaczone wpisy zostaną usunięte z biblioteki (pliki na dysku zostają).`
    : 'Nie znaleziono duplikatów. 🎉';
  $('#dups-delete').classList.toggle('hidden', !groups.length);

  for (const g of groups) {
    const best = g.reduce((a, b) => (score(b) > score(a) ? b : a));
    const card = document.createElement('div');
    card.className = 'dup-group';
    card.innerHTML = `<h4>${esc(best.title || 'Bez tytułu')} <small>${esc(best.author || '')}</small></h4>` +
      g.map((b) => `<label class="dup-row">
        <input type="checkbox" value="${b.id}" ${b.id === best.id ? '' : 'checked'}>
        <span class="dup-fmt">${esc(String(b.format).toUpperCase())}</span>
        <span class="dup-path" title="${esc(b.path)}">${esc(b.path)}</span>
        <span class="dup-size">${esc(fmtSize(b.size))}</span>
        ${b.id === best.id ? '<span class="dup-keep">zachowaj</span>' : ''}
      </label>`).join('');
    // w grupie nie wolno zaznaczyć wszystkich — zawsze zostaje jeden egzemplarz
    card.addEventListener('change', () => {
      const boxes = [...card.querySelectorAll('input')];
      if (boxes.every((i) => i.checked)) boxes.find((i) => Number(i.value) === best.id).checked = false;
    });
    box.append(card);
  }
  showModal('#dups-modal');
}

export function initDuplicates(context) {
  ctx = context;
  $('#btn-dups').addEventListener('click', open);
  $('#dups-close').addEventListener('click', () => hideModal('#dups-modal'));
  $('#dups-delete').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('#dups-list input:checked')].map((i) => Number(i.value));
    if (!ids.length) { ctx.toast('Nic nie zaznaczono'); return; }
    if (!confirm(`Usunąć ${ids.length} wpisów z biblioteki?\n(Pliki na dysku NIE zostaną usunięte.)`)) return;
    const removed = await api.removeMany(ids);
    ctx.toast(`Usunięto ${removed} duplikatów z biblioteki`);
    hideModal('#dups-modal');
    await ctx.loadBooks();
  });
}
