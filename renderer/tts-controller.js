// Czytanie książki na głos wbudowanym silnikiem mowy Windows (SAPI / System.Speech),
// łącznie z głosami doinstalowanymi przez użytkownika (np. IVONA Jacek).
// Tekst wyciągany jest z aktualnie otwartej książki (foliate-js) i dzielony na zdania,
// które kolejno trafiają do procesu silnika mowy w main procesie (src/tts.js).
const $ = (s) => document.querySelector(s);
const api = window.api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUPPORTED = api.platform === 'win32';

const ttsState = {
  view: null,
  book: null,
  voices: [],
  voicesLoaded: false,
  sectionIndex: 0,
  chunkIndex: 0,
  chunks: [],
  playing: false,
  paused: false,
  sessionToken: 0,
  voice: null,
  rate: 0,
  toast: () => {},
};

if (!SUPPORTED) {
  $('#reader-tts-btn')?.classList.add('hidden');
} else {
  $('#reader-tts-btn')?.addEventListener('click', onToggleBar);
}

// ---------- ekstrakcja tekstu z sekcji książki ----------

// Usuwa z klonu treści przypisy/notatki, które w widoku i tak są ukryte przez CSS
// (zob. bookCSS w reader.js) — żeby lektor ich nie wyczytywał w środku zdania.
const NOTE_TYPES = new Set(['endnote', 'footnote', 'note', 'rearnote']);
function stripNotes(root) {
  const all = root.querySelectorAll('*');
  for (const el of all) {
    let type = null;
    try { type = el.getAttributeNS('http://www.idpf.org/2007/ops', 'type'); } catch { /* nieobsługiwane */ }
    if (!type) type = el.getAttribute('epub:type');
    if (type && type.split(/\s+/).some((t) => NOTE_TYPES.has(t))) el.remove();
  }
  root.querySelectorAll('script, style').forEach((el) => el.remove());
}

function splitLong(text, max = 400) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  let sentences;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('pl', { granularity: 'sentence' });
    sentences = [...seg.segment(clean)].map((s) => s.segment.trim()).filter(Boolean);
  } else {
    sentences = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || [clean];
  }
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur.length + s.length + 1) > max) { out.push(cur); cur = s; }
    else cur = cur ? cur + ' ' + s : s;
  }
  if (cur) out.push(cur);
  return out;
}

function extractTextFromDoc(doc) {
  if (!doc?.body) return [];
  const clone = doc.body.cloneNode(true);
  stripNotes(clone);
  const blocks = clone.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, dt, figcaption, pre');
  const chunks = [];
  if (blocks.length) {
    for (const el of blocks) {
      const t = (el.textContent || '').trim();
      if (t) chunks.push(...splitLong(t));
    }
  } else {
    const t = (clone.textContent || '').trim();
    if (t) chunks.push(...splitLong(t));
  }
  return chunks;
}

// Zwraca listę fragmentów tekstu (zdania/akapity) dla danej sekcji/strony książki.
// Dla EPUB/MOBI/AZW3 czyta cały (niewidoczny) dokument sekcji przez createDocument().
// Dla PDF (układ stały) nie ma createDocument — nawigujemy tam widok i czytamy
// wyrenderowaną warstwę tekstu strony.
async function extractSectionText(view, index) {
  const book = view.book;
  if (view.isFixedLayout) {
    try { await view.goTo(index); } catch { return []; }
    await sleep(220); // czas na wyrenderowanie strony/warstwy tekstu w iframe
    const contents = view.renderer.getContents?.() || [];
    const doc = contents[0]?.doc;
    return doc ? extractTextFromDoc(doc) : [];
  }
  const section = book.sections?.[index];
  if (!section?.createDocument) return [];
  try {
    const doc = await section.createDocument();
    view.goTo(index).catch(() => { /* podążanie wizualne jest tylko dodatkiem */ });
    return extractTextFromDoc(doc);
  } catch {
    return [];
  }
}

// ---------- głosy i ustawienia ----------

async function ensureVoices() {
  if (ttsState.voicesLoaded) return ttsState.voices;
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
    if (saved.voice && voices.some((v) => v.name === saved.voice)) {
      ttsState.voice = saved.voice;
    } else {
      ttsState.voice = voices[0]?.name || null;
    }
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

$('#tts-voice')?.addEventListener('change', (e) => {
  ttsState.voice = e.target.value;
  saveTtsSettings();
});
$('#tts-rate')?.addEventListener('input', (e) => {
  ttsState.rate = parseInt(e.target.value, 10) || 0;
  $('#tts-rate-value').textContent = String(ttsState.rate);
  saveTtsSettings();
});

// ---------- odtwarzanie ----------

function updateButton() {
  const btn = $('#tts-play');
  if (!btn) return;
  btn.textContent = ttsState.playing && !ttsState.paused ? '⏸️' : '▶️';
}

function updateStatus(text) {
  const el = $('#tts-status');
  if (!el) return;
  if (text !== undefined) { el.textContent = text; return; }
  el.textContent = !ttsState.playing ? 'Zatrzymano' : (ttsState.paused ? 'Wstrzymano' : 'Czyta…');
}

function persistPosition() {
  if (!ttsState.book) return;
  api.updateBook(ttsState.book.id, { tts_section: ttsState.sectionIndex, tts_chunk: ttsState.chunkIndex });
}

async function playLoop() {
  const token = ++ttsState.sessionToken;
  ttsState.playing = true;
  ttsState.paused = false;
  updateButton();
  updateStatus();

  while (ttsState.playing && token === ttsState.sessionToken) {
    if (!ttsState.chunks.length) {
      updateStatus('Wczytuję tekst…');
      const chunks = await extractSectionText(ttsState.view, ttsState.sectionIndex);
      if (token !== ttsState.sessionToken) return;
      ttsState.chunks = chunks;
      updateStatus();
    }

    if (ttsState.chunkIndex >= ttsState.chunks.length) {
      const nextIndex = ttsState.sectionIndex + 1;
      const total = ttsState.view.book.sections?.length || 0;
      if (nextIndex >= total) {
        stopPlayback();
        ttsState.toast('Koniec książki.');
        return;
      }
      ttsState.sectionIndex = nextIndex;
      ttsState.chunkIndex = 0;
      ttsState.chunks = [];
      persistPosition();
      continue;
    }

    const text = ttsState.chunks[ttsState.chunkIndex];
    try {
      const result = await api.ttsSpeak(text, { voice: ttsState.voice, rate: ttsState.rate });
      if (token !== ttsState.sessionToken) return;
      if (result?.cancelled) return; // zatrzymane przez stopPlayback()
    } catch (err) {
      if (token !== ttsState.sessionToken) return;
      ttsState.toast('Błąd czytania na głos: ' + err.message);
      stopPlayback();
      return;
    }
    ttsState.chunkIndex++;
    persistPosition();
  }
}

function stopPlayback() {
  ttsState.sessionToken++; // unieważnia trwającą pętlę playLoop
  ttsState.playing = false;
  ttsState.paused = false;
  api.ttsStop();
  updateButton();
  updateStatus();
}

$('#tts-play')?.addEventListener('click', async () => {
  if (!ttsState.view) return;
  if (ttsState.playing && !ttsState.paused) {
    ttsState.paused = true;
    api.ttsPause();
    updateButton();
    updateStatus();
    return;
  }
  if (ttsState.playing && ttsState.paused) {
    ttsState.paused = false;
    api.ttsResume();
    updateButton();
    updateStatus();
    return;
  }
  await ensureVoices();
  if (!ttsState.voice) { ttsState.toast('Brak dostępnych głosów mowy.'); return; }
  playLoop();
});

$('#tts-stop')?.addEventListener('click', () => {
  if (ttsState.playing) stopPlayback();
});

function onToggleBar() {
  const bar = $('#tts-bar');
  const hidden = bar.classList.toggle('hidden');
  if (!hidden) ensureVoices();
}

// ---------- integracja z otwieraniem/zamykaniem czytnika ----------

export function onBookOpened(view, book, toast) {
  if (!SUPPORTED) return;
  ttsState.view = view;
  ttsState.book = book;
  ttsState.sectionIndex = book.tts_section || 0;
  ttsState.chunkIndex = book.tts_chunk || 0;
  ttsState.chunks = [];
  ttsState.playing = false;
  ttsState.paused = false;
  ttsState.toast = toast || (() => {});
  $('#tts-bar')?.classList.add('hidden');
  updateButton();
  updateStatus('Zatrzymano');
}

export function onBookClosing() {
  if (!SUPPORTED) return;
  if (ttsState.playing) stopPlayback();
  ttsState.view = null;
  ttsState.book = null;
  ttsState.chunks = [];
}
