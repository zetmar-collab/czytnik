// Wyszukiwanie okładek książek po tytule w wielu źródłach naraz:
//  - polskie księgarnie i serwisy: Empik, Lubimyczytać, UpolujEbooka
//  - katalogi zagraniczne: Google Books, Open Library, Apple Books
//  - wyszukiwarka grafiki: Bing
const { net } = require('electron');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 15000;
// ile okładek bierzemy z jednego źródła — żeby jedna księgarnia nie zdominowała siatki
const PER_SOURCE_LIMIT = 24;

async function fetchRaw(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    return await net.fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8', ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options) {
  const res = await fetchRaw(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchJson(url, options) {
  const res = await fetchRaw(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ---------- źródła polskie ----------

// Empik — największa polska księgarnia. Okładki siedzą w atrybucie lazy-img,
// przy czym wariant "-p-" to miniatura, a "-b-" to pełny rozmiar.
async function fromEmpik(query) {
  const url = `https://www.empik.com/szukaj/produkt?q=${encodeURIComponent(query)}&productTypeFacet=ksiazki`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const out = [];
  $('img[lazy-img]').each((_, el) => {
    const src = $(el).attr('lazy-img');
    const title = ($(el).attr('alt') || '').trim();
    if (!src || !src.includes('ecsmedia.pl')) return;
    out.push({
      source: 'Empik',
      url: src.replace('-p-iext', '-b-iext'),
      title: title || null,
    });
  });
  return out;
}

async function fromLubimyczytac(query) {
  const url = `https://lubimyczytac.pl/searcher/getsuggestions?phrase=${encodeURIComponent(query)}`;
  const json = await fetchJson(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  const results = json?.items?.books?.results || [];
  return results
    .filter((r) => r.cover)
    .map((r) => ({
      source: 'Lubimyczytać',
      url: r.cover,
      title: r.title || null,
      author: r.author?.fullname || null,
    }));
}

async function fromUpolujebooka(query) {
  const homeRes = await fetchRaw('https://upolujebooka.pl/');
  if (!homeRes.ok) throw new Error(`HTTP ${homeRes.status}`);
  const cookies = (homeRes.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const home = await homeRes.text();
  const token = home.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!token) throw new Error('brak tokenu CSRF');

  const html = await fetchText('https://upolujebooka.pl/szukaj.html', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://upolujebooka.pl/',
      Cookie: cookies,
    },
    body: new URLSearchParams({ keyword: query, csrf_token: token[1] }).toString(),
  });

  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href^="/oferta,"]').each((_, el) => {
    const $a = $(el);
    const $img = $a.find('img').first();
    const src = $img.attr('src');
    const title = $a.find('h4').first().text().trim() || ($img.attr('alt') || '').trim();
    if (!src || seen.has(src)) return;
    seen.add(src);
    out.push({ source: 'UpolujEbooka', url: src, title: title || null });
  });
  return out;
}

// ---------- katalogi zagraniczne ----------

async function fromGoogleBooks(query) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20`;
  const res = await fetchRaw(url);
  if (res.status === 429) throw new Error('przekroczony dzienny limit zapytań');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.items || [])
    .map((item) => {
      const v = item.volumeInfo || {};
      const raw = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail;
      if (!raw) return null;
      // zoom=1 bez "edge=curl" daje czysty, większy obrazek
      const big = raw
        .replace(/^http:/, 'https:')
        .replace(/&edge=curl/, '')
        .replace(/&zoom=\d/, '&zoom=1');
      return {
        source: 'Google Books',
        url: big,
        title: v.title || null,
        author: (v.authors || []).join(', ') || null,
      };
    })
    .filter(Boolean);
}

async function fromOpenLibrary(query) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=20&fields=title,author_name,cover_i`;
  const json = await fetchJson(url);
  return (json.docs || [])
    .filter((d) => d.cover_i)
    .map((d) => ({
      source: 'Open Library',
      url: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
      title: d.title || null,
      author: (d.author_name || []).join(', ') || null,
    }));
}

async function fromAppleBooks(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=ebook&limit=20`;
  const json = await fetchJson(url);
  return (json.results || [])
    .filter((r) => r.artworkUrl100)
    .map((r) => ({
      source: 'Apple Books',
      // miniatura ma ten sam adres co pełny rozmiar — wystarczy podmienić wymiar
      url: r.artworkUrl100.replace(/\/\d+x\d+bb\.jpg$/, '/600x600bb.jpg'),
      title: r.trackName || null,
      author: r.artistName || null,
    }));
}

// ---------- wyszukiwarka grafiki ----------

// Bing osadza adresy obrazów w atrybucie "m" jako zakodowany JSON (pole murl).
async function fromBingImages(query) {
  const phrase = `${query} okładka książki`;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(phrase)}&form=HDRSC2&first=1`;
  const html = await fetchText(url);
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)) {
    const link = m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    if (!link.startsWith('http') || seen.has(link)) continue;
    seen.add(link);
    out.push({ source: 'Bing', url: link, title: null });
    if (out.length >= 30) break;
  }
  return out;
}

// ---------- interfejs wspólny ----------

const SOURCES = [
  ['Empik', fromEmpik],
  ['Lubimyczytać', fromLubimyczytac],
  ['UpolujEbooka', fromUpolujebooka],
  ['Google Books', fromGoogleBooks],
  ['Open Library', fromOpenLibrary],
  ['Apple Books', fromAppleBooks],
  ['Bing', fromBingImages],
];

// Przeszukuje wszystkie źródła równolegle. Awaria jednego nie przerywa reszty.
async function searchCovers(query) {
  const q = (query || '').trim();
  if (!q) return { covers: [], errors: [] };

  const settled = await Promise.allSettled(SOURCES.map(([, fn]) => fn(q)));
  const covers = [];
  const errors = [];
  const seen = new Set();

  settled.forEach((res, i) => {
    const name = SOURCES[i][0];
    if (res.status === 'rejected') {
      errors.push({ source: name, message: String(res.reason?.message || res.reason) });
      return;
    }
    let taken = 0;
    for (const item of res.value || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      if (taken >= PER_SOURCE_LIMIT) break;
      seen.add(item.url);
      covers.push(item);
      taken++;
    }
  });

  return { covers, errors };
}

// Pobiera wskazaną okładkę; zwraca bufor i rozszerzenie pliku.
async function download(url) {
  const res = await fetchRaw(url, { timeout: 25000 });
  if (!res.ok) throw new Error(`nie udało się pobrać (HTTP ${res.status})`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('adres nie wskazuje na obrazek');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('obrazek jest zbyt mały');
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
  return { buf, ext };
}

module.exports = { searchCovers, download, SOURCES };
