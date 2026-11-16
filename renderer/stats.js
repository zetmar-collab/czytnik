// Statystyki czytania: licznik aktywnego czasu w czytniku + okno z podsumowaniem.
import { $, esc, showModal, hideModal } from './ui.js';
import { isPlaying } from './tts-controller.js';

const api = window.api;
const IDLE_MS = 90 * 1000;   // po tylu ms bez aktywności czas przestaje być liczony
const TICK_MS = 5 * 1000;
const FLUSH_S = 60;

let bookId = null;
let lastActivity = 0;
let pending = 0;
let timer = null;

export function touch() { lastActivity = Date.now(); }

function tick() {
  if (!bookId) return;
  const active = document.visibilityState === 'visible' && document.hasFocus() &&
    (Date.now() - lastActivity < IDLE_MS || isPlaying());
  if (active) pending += TICK_MS / 1000;
  if (pending >= FLUSH_S) flush();
}

function flush() {
  const sec = Math.round(pending);
  if (bookId && sec > 0) { pending = 0; api.addReadingSeconds(bookId, sec).catch(() => {}); }
}

export function onBookOpened(book) {
  onBookClosing();
  bookId = book.id;
  pending = 0;
  touch();
  timer = setInterval(tick, TICK_MS);
}

export function onBookClosing() {
  clearInterval(timer);
  timer = null;
  flush();
  bookId = null;
}

// ---------- okno statystyk ----------

const fmtDur = (s) => {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function streak(map) {
  const d = new Date();
  if (!map.get(dayStr(d))) d.setDate(d.getDate() - 1); // dziś jeszcze można przeczytać
  let n = 0;
  while (map.get(dayStr(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

async function open() {
  flush();
  const s = await api.getStats();
  const map = new Map(s.days.map((d) => [d.day, d.seconds]));
  const today = map.get(dayStr(new Date())) || 0;
  const last = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last.push({ day: dayStr(d), label: d.toLocaleDateString('pl-PL', { weekday: 'short' }), seconds: map.get(dayStr(d)) || 0 });
  }
  const week = last.slice(-7).reduce((a, d) => a + d.seconds, 0);
  const max = Math.max(60, ...last.map((d) => d.seconds));

  $('#stats-cards').innerHTML = [
    ['Dziś', fmtDur(today)], ['7 dni', fmtDur(week)], ['Łącznie', fmtDur(s.total)],
    ['Seria dni', `${streak(map)} 🔥`], ['Przeczytane', s.finished], ['W trakcie', s.inProgress],
  ].map(([k, v]) => `<div class="stat-card"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');

  $('#stats-chart').innerHTML = last.map((d) =>
    `<div class="bar" title="${esc(d.day)}: ${esc(fmtDur(d.seconds))}"><i style="height:${Math.round((d.seconds / max) * 100)}%"></i><span>${esc(d.label)}</span></div>`).join('');

  $('#stats-top').innerHTML = s.perBook.length
    ? s.perBook.map((b) => `<li>${esc(b.title || 'Bez tytułu')} <span class="hint">${esc(b.author || '')} — ${esc(fmtDur(b.seconds))}</span></li>`).join('')
    : '<li class="hint">Brak danych — czas liczy się, gdy czytasz w oknie Czytnika (lub słuchasz lektora).</li>';
  showModal('#stats-modal');
}

export function initStats() {
  $('#btn-stats').addEventListener('click', open);
  $('#stats-close').addEventListener('click', () => hideModal('#stats-modal'));
  ['keydown', 'mousemove', 'wheel', 'click', 'touchstart'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  window.addEventListener('beforeunload', flush);
}
