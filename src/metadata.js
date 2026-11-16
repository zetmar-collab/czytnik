// Pobieranie metadanych książek z internetu:
//  - lubimyczytac.pl  (endpoint JSON wyszukiwarki + opis ze strony książki)
//  - upolujebooka.pl  (wyszukiwarka z tokenem CSRF + strona oferty)
//  - Google Books API
const { net } = require('electron');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIMEOUT = 15000;

// Każde zapytanie ma limit czasu — inaczej zawieszony serwer blokuje interfejs w nieskończoność.
async function fetchRaw(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    return await net.fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'pl-PL,pl;q=0.9', ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Niektóre serwisy podwójnie kodują encje HTML w opisach.
function decodeEntities(s) {
  if (!s) return s;
  for (let i = 0; i < 4 && /&[a-z#0-9]+;/i.test(s); i++) {
    s = cheerio.load('<div>' + s + '</div>')('div').text();
  }
  return s.replace(/\s+/g, ' ').trim();
}

async function fetchText(url, options) {
  const res = await fetchRaw(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return await res.text();
}

// ---------- Google Books ----------

async function searchGoogle(query) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10`;
  const res = await fetchRaw(url);
  if (res.status === 429) throw new Error('Google Books: przekroczony dzienny limit zapytań — spróbuj ponownie później albo użyj innego źródła');
  if (!res.ok) throw new Error(`Google Books: HTTP ${res.status}`);
  const json = await res.json();
  return (json.items || []).map((item) => {
    const v = item.volumeInfo || {};
    const isbn = (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13')?.identifier
      || (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_10')?.identifier || null;
    return {
      source: 'google',
      title: v.title || null,
      author: (v.authors || []).join(', ') || null,
      description: v.description || null,
      publisher: v.publisher || null,
      year: (v.publishedDate || '').slice(0, 4) || null,
      isbn,
      rating: v.averageRating || null,
      coverUrl: (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:') || null,
      url: v.infoLink || null,
    };
  }).filter((c) => c.title);
}

// ---------- lubimyczytac.pl ----------

async function searchLubimyczytac(query) {
  const url = `https://lubimyczytac.pl/searcher/getsuggestions?phrase=${encodeURIComponent(query)}`;
  const res = await fetchRaw(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (!res.ok) throw new Error(`lubimyczytac.pl: HTTP ${res.status}`);
  const json = await res.json();
  const results = json?.items?.books?.results || [];
  return results
    .filter((r) => r.bookFormat === 'ksiazka' || r.bookFormat === 'ebook')
    .map((r) => ({
      source: 'lubimyczytac',
      title: r.title || null,
      author: r.author?.fullname || null,
      isbn: r.isbn || null,
      rating: r.rating ? parseFloat(String(r.rating).replace(',', '.')) : null,
      coverUrl: r.cover || null,
      url: r.url || null,
      description: null,
      needsDetails: true,
    }));
}

async function detailsLubimyczytac(candidate) {
  if (!candidate.url) return candidate;
  try {
    const html = await fetchText(candidate.url);
    const $ = cheerio.load(html);
    const desc = $('#book-description .collapse-content').text().trim()
      || $('meta[property="og:description"]').attr('content') || null;
    if (desc) candidate.description = decodeEntities(desc);
    const pubLink = $('a[href*="/wydawnictwo/"]').first().text().trim();
    if (pubLink) candidate.publisher = pubLink;
    const details = $('#book-details').text();
    const yearMatch = details.match(/Data\s+wydania:\s*(\d{4})/) || html.match(/dc\.date[^>]*content="(\d{4})/);
    if (yearMatch) candidate.year = yearMatch[1];
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage && !candidate.coverUrl) candidate.coverUrl = ogImage;
  } catch { /* zostają dane z wyszukiwarki */ }
  return candidate;
}

// ---------- upolujebooka.pl ----------

async function searchUpolujebooka(query) {
  // strona główna: ciasteczka + token CSRF
  const homeRes = await fetchRaw('https://upolujebooka.pl/');
  if (!homeRes.ok) throw new Error(`upolujebooka.pl: HTTP ${homeRes.status}`);
  const cookies = (homeRes.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0]).join('; ');
  const home = await homeRes.text();
  const tokenMatch = home.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('upolujebooka.pl: brak tokenu CSRF');

  const body = new URLSearchParams({ keyword: query, csrf_token: tokenMatch[1] }).toString();
  const html = await fetchText('https://upolujebooka.pl/szukaj.html', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://upolujebooka.pl/',
      'Cookie': cookies,
    },
    body,
  });

  const $ = cheerio.load(html);
  const seen = new Set();
  const candidates = [];
  $('a[href^="/oferta,"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    const title = $a.find('h4').first().text().trim();
    if (!title || seen.has(href)) return;
    seen.add(href);
    // okładka i autor są w sąsiednich elementach karty — szukaj w górę drzewa
    let cover = null, author = null;
    let $node = $a;
    for (let i = 0; i < 5 && (!cover || !author); i++) {
      $node = $node.parent();
      if (!$node.length) break;
      if (!cover) {
        const img = $node.find(`a[href="${href}"] img`).first().attr('src')
          || $node.find('img').first().attr('src');
        if (img) cover = img;
      }
      if (!author) {
        const a = $node.find('a[href^="/autor"]').first().text().trim();
        if (a) author = a;
      }
    }
    candidates.push({
      source: 'upolujebooka',
      title,
      author,
      coverUrl: cover,
      url: 'https://upolujebooka.pl' + href,
      description: null,
      needsDetails: true,
    });
  });
  return candidates;
}

async function detailsUpolujebooka(candidate) {
  if (!candidate.url) return candidate;
  try {
    const html = await fetchText(candidate.url);
    const $ = cheerio.load(html);
    const desc = $('meta[name="description"]').attr('content')
      || $('meta[property="og:description"]').attr('content') || null;
    if (desc) candidate.description = decodeEntities(desc);
    const author = $('[itemprop="author"]').first().text().trim();
    if (author && !candidate.author) candidate.author = author;
    const h1 = $('h1').first().text().replace(/\s*-\s*(ebook|audiobook).*$/i, '').trim();
    if (h1) candidate.title = h1;
    const isbn = html.match(/ISBN[:\s]*([0-9-]{10,17})/i);
    if (isbn) candidate.isbn = isbn[1];
    const year = html.match(/Rok\s+wydania[:\s<>/a-z"=]*?(\d{4})/i);
    if (year) candidate.year = year[1];
  } catch { /* zostają dane z wyszukiwarki */ }
  return candidate;
}

// ---------- interfejs wspólny ----------

async function search(source, query) {
  if (source === 'google') return await searchGoogle(query);
  if (source === 'lubimyczytac') return await searchLubimyczytac(query);
  if (source === 'upolujebooka') return await searchUpolujebooka(query);
  throw new Error('Nieznane źródło: ' + source);
}

// Adres strony szczegółów musi należeć do serwisu, z którego pochodzi kandydat (renderer jest niezaufany).
const DETAIL_HOSTS = { lubimyczytac: /(^|\.)lubimyczytac\.pl$/i, upolujebooka: /(^|\.)upolujebooka\.pl$/i };

// Odbudowuje kandydata z dozwolonych pól — nie ufamy obiektowi przysłanemu z renderera.
function cleanCandidate(c) {
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  if (!c || !['google', 'lubimyczytac', 'upolujebooka'].includes(c.source)) throw new Error('Nieznane źródło kandydata');
  const out = {
    source: c.source, title: str(c.title, 500), author: str(c.author, 500), description: str(c.description, 20000),
    publisher: str(c.publisher, 300), year: str(c.year, 20), isbn: str(c.isbn, 40),
    rating: typeof c.rating === 'number' && Number.isFinite(c.rating) ? c.rating : null,
    coverUrl: str(c.coverUrl, 2000), url: str(c.url, 2000), needsDetails: !!c.needsDetails,
  };
  if (out.url && DETAIL_HOSTS[out.source]) {
    let u;
    try { u = new URL(out.url); } catch { throw new Error('Nieprawidłowy adres kandydata'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Nieprawidłowy adres kandydata');
    if (!DETAIL_HOSTS[out.source].test(u.hostname)) throw new Error('Adres kandydata nie należy do serwisu źródłowego');
  } else if (out.url && out.source === 'google') {
    out.url = null; // dla Google Books strona szczegółów nie jest pobierana
  }
  return out;
}

async function details(candidate) {
  if (!candidate.needsDetails) return candidate;
  if (candidate.source === 'lubimyczytac') return await detailsLubimyczytac(candidate);
  if (candidate.source === 'upolujebooka') return await detailsUpolujebooka(candidate);
  return candidate;
}

// Pobieranie okładki z adresu podanego przez serwis — ta sama walidacja co w covers.js.
async function downloadCover(url) {
  return await require('./covers').download(url);
}

module.exports = { search, details, downloadCover, cleanCandidate };
