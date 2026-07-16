// Czytnik oparty o foliate-js (<foliate-view>): EPUB, MOBI, AZW3, PDF.
import '../node_modules/foliate-js/view.js';

const $ = (s) => document.querySelector(s);
const api = window.api;

const FONTS = [
  ['', 'Czcionka książki'],
  ['Georgia', 'Georgia'],
  ['Times New Roman', 'Times New Roman'],
  ['Palatino Linotype', 'Palatino'],
  ['Book Antiqua', 'Book Antiqua'],
  ['Garamond', 'Garamond'],
  ['Cambria', 'Cambria'],
  ['Segoe UI', 'Segoe UI'],
  ['Calibri', 'Calibri'],
  ['Arial', 'Arial'],
  ['Verdana', 'Verdana'],
  ['Trebuchet MS', 'Trebuchet MS'],
];

const state = {
  view: null,
  book: null,
  settings: null,
  isFixed: false,
  zoom: 1,
  onClose: null,
  toast: () => {},
};

const DEFAULT_SETTINGS = {
  fontFamily: '',
  fontSize: 18,
  lineHeight: 1.55,
  justify: true,
  flow: 'paginated',
  readerTheme: 'dark',
};

// ---------- style wstrzykiwane do książki ----------

function bookCSS(s) {
  const dark = s.readerTheme === 'dark';
  const fontRule = s.fontFamily
    ? `html, body, p, li, blockquote, dd, div, span, h1, h2, h3, h4, h5, h6 { font-family: "${s.fontFamily}", serif !important; }`
    : '';
  const darkRules = dark
    ? `body, body * { color: #d8d4cc !important; background-color: transparent !important; }
       a:link, a:visited { color: #8ab4f8 !important; }
       img, svg { background-color: initial !important; }`
    : '';
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${dark ? 'dark' : 'light'}; font-size: ${s.fontSize}px; }
    ${fontRule}
    p, li, blockquote, dd {
      line-height: ${s.lineHeight};
      text-align: ${s.justify ? 'justify' : 'start'};
      -webkit-hyphens: auto; hyphens: auto;
      widows: 2; orphans: 2;
    }
    [align="left"] { text-align: left; } [align="right"] { text-align: right; }
    [align="center"] { text-align: center; } [align="justify"] { text-align: justify; }
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="endnote"], aside[epub|type~="footnote"],
    aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
    ${darkRules}
  `;
}

function applyStyles() {
  const s = state.settings;
  if (state.view?.renderer?.setStyles) state.view.renderer.setStyles(bookCSS(s));
  const readerView = $('#reader-view');
  readerView.style.background = s.readerTheme === 'dark' ? '#201f1e' : '#f7f4ee';
  $('#reader').classList.toggle('dark-book', s.readerTheme === 'dark');
  $('#font-size-label').textContent = s.fontSize + 'px';
  $('#reader-theme').textContent = s.readerTheme === 'dark' ? '🌙' : '☀️';
  $('#reader-flow').textContent = s.flow === 'paginated' ? '📄' : '📜';
  $('#reader-flow').title = s.flow === 'paginated' ? 'Tryb: strony (kliknij, aby przewijać)' : 'Tryb: przewijanie (kliknij, aby stronicować)';
}

async function saveSettings() {
  await api.setSetting('readerSettings', state.settings);
}

// ---------- otwieranie / zamykanie ----------

export async function openReader(book, { onClose, toast }) {
  state.book = book;
  state.onClose = onClose;
  state.toast = toast;
  state.settings = { ...DEFAULT_SETTINGS, ...(await api.getSetting('readerSettings', {})) };

  $('#reader').classList.remove('hidden');
  $('#reader-title').textContent = [book.title, book.author].filter(Boolean).join(' — ');
  $('#reader-toc').classList.add('hidden');
  $('#reader-slider').value = book.progress_pct || 0;
  $('#reader-percent').textContent = Math.round((book.progress_pct || 0) * 100) + '%';

  try {
    const { name, data } = await api.readBook(book.id);
    const file = new File([data], name);

    const view = document.createElement('foliate-view');
    $('#reader-view').append(view);
    state.view = view;

    view.addEventListener('relocate', onRelocate);
    await view.open(file);

    state.isFixed = view.isFixedLayout;
    $('#font-tools').classList.toggle('hidden', state.isFixed);
    $('#zoom-tools').classList.toggle('hidden', !state.isFixed);
    view.classList.toggle('fixed-layout', state.isFixed);

    if (state.isFixed) {
      state.zoom = 1;
      view.renderer.setAttribute('zoom', 'fit-page');
      $('#zoom-mode').value = 'fit-page';
    } else {
      view.renderer.setAttribute('flow', state.settings.flow);
      view.renderer.setAttribute('gap', '6%');
      view.renderer.setAttribute('margin', '44px');
      view.renderer.setAttribute('max-inline-size', '820px');
      view.renderer.setAttribute('max-column-count', '2');
    }
    applyStyles();

    buildTOC(view.book.toc || []);

    // przywróć pozycję albo zacznij od początku
    let opened = false;
    if (book.progress) {
      try {
        await view.init({ lastLocation: book.progress });
        opened = true;
      } catch { /* uszkodzony CFI — od początku */ }
    }
    if (!opened) await view.renderer.next();

    // brak okładki w bazie? spróbuj wyciągnąć z książki
    if (!book.cover && view.book.getCover) {
      view.book.getCover().then(async (blob) => {
        if (!blob) return;
        const buf = await blob.arrayBuffer();
        const ext = blob.type.includes('png') ? 'png' : 'jpg';
        await api.saveCover(book.id, buf, ext);
      }).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    state.toast('Nie udało się otworzyć książki: ' + err.message);
    closeReader();
    return;
  }

  document.addEventListener('keydown', onKey);
}

function closeReader() {
  document.removeEventListener('keydown', onKey);
  try { state.view?.close(); } catch { /* ignoruj */ }
  state.view?.remove();
  state.view = null;
  $('#reader').classList.add('hidden');
  state.onClose?.();
}

$('#reader-back').addEventListener('click', closeReader);

function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') closeReader();
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') state.view?.goLeft();
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') state.view?.goRight();
}

// ---------- postęp ----------

let progressTimer;
function onRelocate(e) {
  const { fraction, cfi } = e.detail;
  if (fraction == null) return;
  $('#reader-slider').value = fraction;
  $('#reader-percent').textContent = Math.round(fraction * 100) + '%';
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    if (state.book) api.saveProgress(state.book.id, cfi || null, fraction);
  }, 800);
}

$('#reader-slider').addEventListener('input', (e) => {
  state.view?.goToFraction?.(parseFloat(e.target.value));
});

$('#page-prev').addEventListener('click', () => state.view?.goLeft());
$('#page-next').addEventListener('click', () => state.view?.goRight());

// ---------- spis treści ----------

function buildTOC(toc) {
  const list = $('#toc-list');
  list.innerHTML = '';
  const add = (items, depth) => {
    for (const item of items || []) {
      const li = document.createElement('li');
      li.textContent = item.label?.trim() || '—';
      if (depth > 0) li.classList.add('sub');
      li.style.paddingLeft = 4 + depth * 16 + 'px';
      if (item.href) {
        li.addEventListener('click', () => {
          state.view?.goTo(item.href);
          $('#reader-toc').classList.add('hidden');
        });
      }
      list.append(li);
      add(item.subitems, depth + 1);
    }
  };
  add(toc, 0);
  if (!list.children.length) {
    const li = document.createElement('li');
    li.textContent = 'Brak spisu treści';
    list.append(li);
  }
}

$('#reader-toc-btn').addEventListener('click', () => {
  $('#reader-toc').classList.toggle('hidden');
});

// ---------- czcionki i motyw ----------

const fontSelect = $('#reader-font');
for (const [value, label] of FONTS) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  fontSelect.append(opt);
}

fontSelect.addEventListener('change', () => {
  state.settings.fontFamily = fontSelect.value;
  applyStyles();
  saveSettings();
});

$('#font-minus').addEventListener('click', () => {
  state.settings.fontSize = Math.max(10, state.settings.fontSize - 1);
  applyStyles();
  saveSettings();
});
$('#font-plus').addEventListener('click', () => {
  state.settings.fontSize = Math.min(40, state.settings.fontSize + 1);
  applyStyles();
  saveSettings();
});

$('#reader-theme').addEventListener('click', () => {
  state.settings.readerTheme = state.settings.readerTheme === 'dark' ? 'light' : 'dark';
  applyStyles();
  saveSettings();
});

$('#reader-flow').addEventListener('click', () => {
  state.settings.flow = state.settings.flow === 'paginated' ? 'scrolled' : 'paginated';
  if (state.view && !state.isFixed) state.view.renderer.setAttribute('flow', state.settings.flow);
  applyStyles();
  saveSettings();
});

// ---------- zoom (PDF / układ stały) ----------

function setZoom(z) {
  state.zoom = Math.min(4, Math.max(0.25, z));
  state.view?.renderer.setAttribute('zoom', String(state.zoom));
}
$('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.2));
$('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.2));
$('#zoom-mode').addEventListener('change', (e) => {
  state.zoom = 1;
  state.view?.renderer.setAttribute('zoom', e.target.value);
});

// inicjalizacja selecta czcionek przy starcie modułu
api.getSetting('readerSettings', {}).then((s) => {
  fontSelect.value = s.fontFamily ?? '';
});
