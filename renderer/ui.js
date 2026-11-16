// Drobne wspólne narzędzia interfejsu.
export const $ = (s) => document.querySelector(s);

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function showModal(sel) { $(sel).classList.remove('hidden'); }
export function hideModal(sel) { $(sel).classList.add('hidden'); }

// Okno z polem tekstowym — zamiennik prompt(), którego Electron nie obsługuje.
// Zwraca wpisany tekst albo null po anulowaniu.
export function askText(title, initial = '', placeholder = '') {
  return new Promise((resolve) => {
    const modal = $('#ask-modal');
    const input = $('#ask-input');
    $('#ask-title').textContent = title;
    input.value = initial;
    input.placeholder = placeholder;
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const done = (value) => {
      modal.classList.add('hidden');
      $('#ask-ok').removeEventListener('click', ok);
      $('#ask-cancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', key);
      resolve(value);
    };
    const ok = () => done(input.value.trim() || null);
    const cancel = () => done(null);
    const key = (e) => { if (e.key === 'Enter') ok(); else if (e.key === 'Escape') cancel(); };
    $('#ask-ok').addEventListener('click', ok);
    $('#ask-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', key);
  });
}

// Motyw "auto" podąża za ustawieniem systemu Windows (jasny/ciemny).
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
export const isDark = (mode) => (mode === 'auto' ? darkQuery.matches : mode !== 'light');
export const onSystemThemeChange = (fn) => darkQuery.addEventListener('change', fn);
export const nextTheme = (mode) => ({ dark: 'light', light: 'auto', auto: 'dark' }[mode] || 'dark');
export const themeLabel = (mode) => ({ dark: 'ciemny', light: 'jasny', auto: 'auto (system)' }[mode] || 'ciemny');
