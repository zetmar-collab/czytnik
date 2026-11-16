// Walidacja danych przychodzących z renderera (IPC) oraz adresów pobieranych z sieci.
// Renderer wyświetla cudzą treść (EPUB-y), więc traktujemy go jako niezaufany.
const path = require('path');
const net = require('net');

const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function asId(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Nieprawidłowy identyfikator');
  return n;
}

function asIdList(list) {
  if (!Array.isArray(list) || list.length > 100000) throw new Error('Nieprawidłowa lista identyfikatorów');
  return list.map(asId);
}

function asImageExt(ext, fallback = 'jpg') {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  return IMG_EXT.has(e) ? e : fallback;
}

function asString(v, max = 10000) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Składa ścieżkę wewnątrz katalogu bazowego; wyrzuca błąd, gdy wychodzi poza niego.
function safeJoin(base, ...parts) {
  const full = path.resolve(base, ...parts);
  const rel = path.relative(path.resolve(base), full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Ścieżka poza dozwolonym katalogiem');
  return full;
}

function isInside(base, file) {
  const rel = path.relative(path.resolve(base), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Adres IPv6 zmapowany na IPv4 (::ffff:a.b.c.d albo ::ffff:hhhh:hhhh) -> zwykły IPv4, inaczej null.
function mappedV4(h) {
  let m = /^(?:0{0,4}:){2,5}ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (m) return m[1];
  m = /^(?:0{0,4}:){2,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

const BLOCKED = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  BLOCKED.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) {
  BLOCKED.addSubnet(addr, bits, 'ipv6');
}

// Czy adres IP (v4/v6) jest lokalny, prywatny lub zarezerwowany.
function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const kind = net.isIP(h);
  if (!kind) return true; // nie umiemy ocenić — traktujemy jak niebezpieczny
  if (kind === 6) {
    const v4 = mappedV4(h);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(h, 'ipv6');
  }
  return BLOCKED.check(h, 'ipv4');
}

// Czy host wskazuje na sieć lokalną / pętlę zwrotną (ochrona przed SSRF) — bez zapytania DNS.
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return net.isIP(h) ? isPrivateIp(h) : false;
}

// Zwraca obiekt URL tylko dla publicznych adresów http(s); w przeciwnym razie błąd.
function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('Nieprawidłowy adres URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Dozwolone są tylko adresy http(s)');
  if (isPrivateHost(u.hostname)) throw new Error('Adres wskazuje na sieć lokalną');
  return u;
}

// Jak wyżej, ale dodatkowo rozwiązuje nazwę przez DNS i odrzuca ją, gdy KTÓRYKOLWIEK wynik jest prywatny
// (ochrona przed nazwami wskazującymi na adresy lokalne). Nie chroni w pełni przed DNS rebindingiem
// między sprawdzeniem a połączeniem — dlatego pobrany plik i tak musi być obrazem (sniffImage).
async function assertPublicHttpUrlResolved(raw) {
  const u = assertPublicHttpUrl(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return u;
  let addrs;
  try { addrs = await require('dns').promises.lookup(host, { all: true, verbatim: true }); } catch { throw new Error('Nie udało się rozpoznać adresu serwera'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Adres wskazuje na sieć lokalną');
  return u;
}

// Rozpoznaje typ obrazu po bajtach, a nie po nagłówku serwera.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Zamienia frazę użytkownika na bezpieczny wzorzec LIKE (z ESCAPE '\').
function likePattern(s) {
  return '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

module.exports = {
  IMG_EXT, asId, asIdList, asImageExt, asString, safeJoin, isInside,
  isPrivateHost, isPrivateIp, assertPublicHttpUrl, assertPublicHttpUrlResolved, sniffImage, likePattern,
};
