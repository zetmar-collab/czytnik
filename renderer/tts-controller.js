// Czytanie książki na głos wbudowanym silnikiem mowy Windows (SAPI / System.Speech),
// łącznie z głosami doinstalowanymi przez użytkownika (np. IVONA Jacek).
// Tekst wyciągany jest z aktualnie otwartej książki (foliate-js) i dzielony na zdania,
// które kolejno trafiają do procesu silnika mowy w main procesie (src/tts.js).
// Dla EPUB/MOBI/AZW3 czytane zdanie jest podświetlane, a widok podąża za lektorem.
const $ = (s) => document.querySelector(s);
const api = window.api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUPPORTED = api.platform === 'win32';
const HL_NAME = 'czytnik-tts';

const ttsState = {
  view: null,
  book: null,
  voices: [],
  voicesLoaded: false,
  sectionIndex: 0,
  chunkIndex: 0,
  chunks: [], // { text, range? }
  playing: false,
  paused: false,
  sessionToken: 0,
  spoken: 0,
  skipRequested: false,
  voice: null,
  rate: 0,
  timerMode: '0',
  timerFired: false,
  timerHandle: null,
  hlDoc: null,
  toast: () => {},
};

if (!SUPPORTED) {
  $('#reader-tts-btn')?.classList.add('hidden');
} else {
  $('#reader-tts-btn')?.addEventListener('click', onToggleBar);
}

// ---------- ekstrakcja tekstu ----------

// Przypisy/notatki są w widoku ukryte przez CSS (zob. bookCSS w reader.js) — lektor też ich nie czyta.
const NOTE_TYPES = new Set(['endnote', 'footnote', 'note', 'rearnote']);
function noteType(el) {
  let type = null;
  try { type = el.getAttributeNS('http://www.idpf.org/2007/ops', 'type'); } catch { /* nieobsługiwane */ }
  return type || el.getAttribute('epub:type');
}
const isNoteEl = (el) => { const t = noteType(el); return !!t && t.split(/\s+/).some((x) => NOTE_TYPES.has(x)); };
function inNote(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (isNoteEl(n)) return true;
  return false;
}
function stripNotes(root) {
  for (const el of root.querySelectorAll('*')) if (isNoteEl(el)) el.remove();
  root.querySelectorAll('script, style').forEach((el) => el.remove());
}

const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, dt, figcaption, pre';

// Tylko bloki "liściowe" — kontener (np. blockquote z akapitami) zawiera tekst swoich dzieci,
// więc czytanie go razem z dziećmi dublowałoby wypowiedź.
function leafBlocks(root) {
  return [...root.querySelectorAll(BLOCK_SELECTOR)].filter((el) => !el.querySelector(BLOCK_SELECTOR));
}

// Dzieli tekst na grupy zdań (do ~max znaków) zachowując pozycje w oryginalnym tekście.
function groupSentences(raw, max = 400) {
  let spans;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('pl', { granularity: 'sentence' });
    spans = [...seg.segment(raw)].map((s) => ({ start: s.index, end: s.index + s.segment.length }));
  } else {
    spans = [...raw.matchAll(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  }
  const groups = [];
  let cur = null;
  for (const sp of spans) {
    const t = raw.slice(sp.start, sp.end);
    if (!t.trim()) continue;
    const start = sp.start + (t.length - t.trimStart().length);
    const end = sp.end - (t.length - t.trimEnd().length);
    if (cur && end - cur.start > max) { groups.push(cur); cur = null; }
    if (!cur) cur = { start, end }; else cur.end = end;
  }
  if (cur) groups.push(cur);
  return groups;
}

// Zakres DOM odpowiadający znakom start..end tekstu elementu.
function rangeFromOffsets(el, start, end) {
  const doc = el.ownerDocument;
  const r = doc.createRange();
  const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let pos = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.nodeValue.length;
    if (!started && start < pos + len) { r.setStart(node, start - pos); started = true; }
    if (started && end <= pos + len) { r.setEnd(node, end - pos); return r; }
    pos += len;
  }
  if (!started) return null;
  r.setEndAfter(el.lastChild || el);
  return r;
}

const normalize = (t) => t.replace(/\s+/g, ' ').trim();

// Wyciąga fragmenty z żywego dokumentu sekcji — wraz z zakresami do podświetlania.
function liveChunks(doc) {
  if (!doc?.body) return [];
  let blocks = leafBlocks(doc.body).filter((el) => !inNote(el));
  if (!blocks.length) blocks = [doc.body];
  const out = [];
  for (const el of blocks) {
    const raw = el.textContent || '';
    if (!raw.trim()) continue;
    for (const g of groupSentences(raw)) {
      const text = normalize(raw.slice(g.start, g.end));
      if (text) out.push({ text, range: rangeFromOffsets(el, g.start, g.end) });
    }
  }
  return out;
}

// Wersja tylko tekstowa (dla dokumentów niewyświetlonych): stringi bez zakresów.
export function extractTextFromDoc(doc) {
  if (!doc?.body) return [];
  const clone = doc.body.cloneNode(true);
  stripNotes(clone);
  const blocks = leafBlocks(clone);
  const out = [];
  const push = (t) => {
    const raw = t || '';
    if (!raw.trim()) return;
    for (const g of groupSentences(raw)) { const x = normalize(raw.slice(g.start, g.end)); if (x) out.push(x); }
  };
  if (blocks.length) blocks.forEach((el) => push(el.textContent)); else push(clone.textContent);
  return out;
}

// Zwraca fragmenty tekstu dla danej sekcji/strony książki.
async function extractSection(view, index) {
  const book = view.book;
  if (view.isFixedLayout) {
    try { await view.goTo(index); } catch { return []; }
    // czekamy, aż strona i jej warstwa tekstu zostaną wyrenderowane (do 4 s), zamiast stałej pauzy
    let doc = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      doc = (view.renderer.getContents?.() || [])[0]?.doc || null;
      if (doc?.querySelector?.('.textLayer span')) break;
    }
    return (doc ? extractTextFromDoc(doc) : []).map((text) => ({ text }));
  }
  try { await view.goTo(index); } catch { /* spróbujemy odczytać mimo to */ }
  let doc = null;
  for (let i = 0; i < 30 && !doc; i++) {
    doc = (view.renderer.getContents?.() || []).find((c) => c.index === index)?.doc || null;
    if (!doc) await sleep(100);
  }
  if (doc) return liveChunks(doc);
  const section = book.sections?.[index];
  if (!section?.createDocument) return [];
  try { return extractTextFromDoc(await section.createDocument()).map((text) => ({ text })); } catch { return []; }
}

// ---------- podświetlanie czytanego zdania ----------

function clearHighlight() {
  try { ttsState.hlDoc?.defaultView?.CSS?.highlights?.delete(HL_NAME); } catch { /* ignoruj */ }
  ttsState.hlDoc = null;
}

function showHighlight(range) {
  clearHighlight();
  const doc = range?.startContainer?.ownerDocument;
  const win = doc?.defaultView;
  if (!win || !win.CSS?.highlights || !win.Highlight || !ttsState.view) return;
  const live = (ttsState.view.renderer.getContents?.() || []).some((c) => c.doc === doc);
  if (!live) return; // użytkownik przeszedł do innego rozdziału — dokument jest już nieaktualny
  if (!doc.getElementById('czytnik-tts-style')) {
    const style = doc.createElement('style');
    style.id = 'czytnik-tts-style';
    style.textContent = `::highlight(${HL_NAME}) { background-color: rgba(224,164,88,.5); color: inherit; }`;
    doc.head.append(style);
  }
  win.CSS.highlights.set(HL_NAME, new win.Highlight(range));
  ttsState.hlDoc = doc;
  try { ttsState.view.renderer.scrollToAnchor(range); } catch { /* widok sam nie podąży */ }
}

// ---------- głosy i ustawienia ----------

let voicesPromise = null;
// Jedno wspólne ładowanie listy głosów — równoległe wywołania czekają na ten sam wynik.
function ensureVoices() {
  if (ttsState.voicesLoaded) return Promise.resolve(ttsState.voices);
  if (!voicesPromise) voicesPromise = loadVoices().finally(() => { if (!ttsState.voicesLoaded) voicesPromise = null; });
  return voicesPromise;
}

async function loadVoices() {
  const select = $('#tts-voice');
  select.innerHTML = '<option>Ładowanie głosów…</option>';
  select.disabled = true;
  try {
    const voices = await api.ttsListVoices();
    ttsState.voices = voices;
    ttsState.voicesLoaded = true;
    select.innerHTML = '';
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.culture})`;
      select.append(opt);
    }
    const saved = await api.getSetting('ttsSettings', {});
    ttsState.voice = saved.voice && voices.some((v) => v.name === saved.voice) ? saved.voice : (voices[0]?.name || null);
    if (typeof saved.rate === 'number') ttsState.rate = saved.rate;
    select.value = ttsState.voice || '';
    $('#tts-rate').value = ttsState.rate;
    $('#tts-rate-value').textContent = String(ttsState.rate);
    select.disabled = false;
  } catch (err) {
    select.innerHTML = '<option>Brak dostępnych głosów</option>';
    ttsState.toast('Nie udało się pobrać listy głosów: ' + err.message);
  }
  return ttsState.voices;
}

function saveTtsSettings() {
  api.setSetting('ttsSettings', { voice: ttsState.voice, rate: ttsState.rate });
}

$('#tts-voice')?.addEventListener('change', (e) => { ttsState.voice = e.target.value; saveTtsSettings(); });
$('#tts-rate')?.addEventListener('input', (e) => {
  ttsState.rate = parseInt(e.target.value, 10) || 0;
  $('#tts-rate-value').textContent = String(ttsState.rate);
  saveTtsSettings();
});

// ---------- zegar uśpienia ----------

function setTimer(mode) {
  clearTimeout(ttsState.timerHandle);
  ttsState.timerMode = mode;
  ttsState.timerFired = false;
  if (/^\d+$/.test(mode) && Number(mode) > 0) {
    ttsState.timerHandle = setTimeout(() => { ttsState.timerFired = true; }, Number(mode) * 60000);
  }
}
$('#tts-timer')?.addEventListener('change', (e) => setTimer(e.target.value));

function resetTimerUi() {
  setTimer('0');
  const sel = $('#tts-timer');
  if (sel) sel.value = '0';
}

// ---------- odtwarzanie ----------

function updateButton() {
  const btn = $('#tts-play');
  if (btn) btn.textContent = ttsState.playing && !ttsState.paused ? '⏸️' : '▶️';
}

function updateStatus(text) {
  const el = $('#tts-status');
  if (!el) return;
  if (text !== undefined) { el.textContent = text; return; }
  el.textContent = !ttsState.playing ? 'Zatrzymano' : (ttsState.paused ? 'Wstrzymano' : 'Czyta…');
}

function updateProgress() {
  const el = $('#tts-progress');
  if (!el) return;
  const total = ttsState.chunks.length;
  el.textContent = total ? `${Math.min(ttsState.chunkIndex + 1, total)}/${total}` : '';
}

function persistPosition() {
  if (!ttsState.book) return;
  api.updateBook(ttsState.book.id, { tts_section: ttsState.sectionIndex, tts_chunk: ttsState.chunkIndex })
    .catch((err) => console.error('[tts] nie zapisano pozycji:', err.message));
}

// Informuje proces główny, czy trwa odczyt (od tego zależy przechwytywanie klawiszy multimedialnych).
function notifyActive() {
  try { api.ttsActive?.(ttsState.playing); } catch { /* starsza wersja mostu */ }
}

async function playLoop() {
  const token = ++ttsState.sessionToken;
  ttsState.spoken = 0;
  ttsState.playing = true;
  ttsState.paused = false;
  ttsState.skipRequested = false;
  updateButton();
  updateStatus();
  notifyActive();

  while (ttsState.playing && token === ttsState.sessionToken) {
    if (!ttsState.chunks.length) {
      updateStatus('Wczytuję tekst…');
      const chunks = await extractSection(ttsState.view, ttsState.sectionIndex);
      if (token !== ttsState.sessionToken) return;
      ttsState.chunks = chunks;
      updateStatus();
    }

    if (ttsState.chunkIndex >= ttsState.chunks.length) {
      if (ttsState.timerMode === 'chapter' && ttsState.chunks.length > 0) { // pusta sekcja (np. okładka) nie kończy rozdziału
        stopPlayback();
        resetTimerUi();
        ttsState.toast('Zegar uśpienia: koniec rozdziału.');
        return;
      }
      const nextIndex = ttsState.sectionIndex + 1;
      const total = ttsState.view.book.sections?.length || 0;
      if (nextIndex >= total) {
        const nothing = ttsState.spoken === 0;
        stopPlayback();
        ttsState.toast(nothing
          ? 'Ten dokument nie zawiera tekstu do przeczytania (może to skan — bez warstwy tekstu).'
          : 'Koniec książki.');
        return;
      }
      ttsState.sectionIndex = nextIndex;
      ttsState.chunkIndex = 0;
      ttsState.chunks = [];
      persistPosition();
      continue;
    }

    const chunk = ttsState.chunks[ttsState.chunkIndex];
    updateProgress();
    showHighlight(chunk.range);
    try {
      const result = await api.ttsSpeak(chunk.text, { voice: ttsState.voice, rate: ttsState.rate });
      if (token !== ttsState.sessionToken) return;
      if (result?.cancelled) {
        if (ttsState.skipRequested) { ttsState.skipRequested = false; continue; } // skok do innego zdania
        return; // zatrzymane przez stopPlayback()
      }
    } catch (err) {
      if (token !== ttsState.sessionToken) return;
      ttsState.toast('Błąd czytania na głos: ' + err.message);
      stopPlayback();
      return;
    }
    ttsState.spoken++;
    ttsState.chunkIndex++;
    persistPosition();

    if (ttsState.timerFired) {
      stopPlayback();
      resetTimerUi();
      ttsState.toast('Zegar uśpienia: zatrzymano czytanie.');
      return;
    }
  }
}

function stopPlayback() {
  ttsState.sessionToken++; // unieważnia trwającą pętlę playLoop
  ttsState.playing = false;
  ttsState.paused = false;
  api.ttsStop();
  updateButton();
  updateStatus();
  notifyActive();
}

export async function togglePlay() {
  if (!ttsState.view) return;
  if (ttsState.playing && !ttsState.paused) {
    ttsState.paused = true;
    api.ttsPause();
  } else if (ttsState.playing && ttsState.paused) {
    ttsState.paused = false;
    api.ttsResume();
  } else {
    await ensureVoices();
    if (!ttsState.voice) { ttsState.toast('Brak dostępnych głosów mowy.'); return; }
    playLoop();
    return;
  }
  updateButton();
  updateStatus();
}

export function stopTts() {
  if (ttsState.playing) stopPlayback();
}

// Przeskok o zdanie do przodu (+1) lub do tyłu (-1).
export function skip(delta) {
  if (!ttsState.view || !ttsState.chunks.length) return;
  const target = Math.max(0, ttsState.chunkIndex + delta);
  ttsState.chunkIndex = target;
  persistPosition();
  if (ttsState.playing) {
    ttsState.skipRequested = true;
    ttsState.paused = false;
    updateButton();
    updateStatus();
    api.ttsStop(); // przerywa bieżące zdanie; pętla przejdzie do wskazanego
  } else {
    const chunk = ttsState.chunks[target];
    if (chunk) showHighlight(chunk.range);
    updateProgress();
  }
}

export const isPlaying = () => ttsState.playing;

$('#tts-play')?.addEventListener('click', togglePlay);
$('#tts-stop')?.addEventListener('click', stopTts);
$('#tts-prev')?.addEventListener('click', () => skip(-1));
$('#tts-next')?.addEventListener('click', () => skip(1));

// Klawisze multimedialne (rejestrowane w procesie głównym tylko na czas odczytu).
api.onMediaKey?.((key) => {
  if (key === 'play-pause') togglePlay();
  else if (key === 'stop') stopTts();
  else if (key === 'next') skip(1);
  else if (key === 'prev') skip(-1);
});

function onToggleBar() {
  const bar = $('#tts-bar');
  const hidden = bar.classList.toggle('hidden');
  if (!hidden) ensureVoices();
}

// ---------- integracja z otwieraniem/zamykaniem czytnika ----------

export function onBookOpened(view, book, toast) {
  if (!SUPPORTED) return;
  if (ttsState.playing) stopPlayback();
  clearHighlight();
  ttsState.view = view;
  ttsState.book = book;
  ttsState.sectionIndex = book.tts_section || 0;
  ttsState.chunkIndex = book.tts_chunk || 0;
  ttsState.chunks = [];
  ttsState.playing = false;
  ttsState.paused = false;
  ttsState.toast = toast || (() => {});
  resetTimerUi();
  $('#tts-bar')?.classList.add('hidden');
  updateButton();
  updateStatus('Zatrzymano');
  updateProgress();
}

export function onBookClosing() {
  if (!SUPPORTED) return;
  if (ttsState.playing) stopPlayback();
  clearHighlight();
  resetTimerUi();
  ttsState.view = null;
  ttsState.book = null;
  ttsState.chunks = [];
}
