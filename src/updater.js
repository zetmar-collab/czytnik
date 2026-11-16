// Aktualizacje z wydań na GitHubie. Użytkownik zawsze decyduje: sprawdzanie tylko informuje,
// pobranie rusza po kliknięciu „Pobierz", a instalator uruchamia się dopiero po drugim potwierdzeniu.
// Wersja ze sklepu Microsoft Store aktualizuje się przez sklep — tam mechanizm jest wyłączony.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const V = require('./validate');

const REPO = 'zetmar-collab/czytnik';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const MAX_INSTALLER = 400 * 1024 * 1024;
const HOST_OK = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/i;

// Porównanie wersji x.y.z (bez przyrostków); zwraca >0, gdy a jest nowsza od b.
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Wybiera zasób wydania dla bieżącej platformy.
function pickAsset(assets, platform = process.platform) {
  const re = platform === 'win32' ? /^Czytnik-Instalator-[\d.]+\.exe$/ : platform === 'linux' ? /^Czytnik-[\d.]+\.AppImage$/ : null;
  if (!re) return null;
  return (assets || []).find((a) => re.test(a.name)) || null;
}

// fetchJson(url) — wstrzykiwane (net.fetch z Electrona), żeby dało się testować bez sieci.
async function checkForUpdate({ currentVersion, fetchJson, platform = process.platform, isStore = false }) {
  if (isStore) return { managedByStore: true, available: false, current: currentVersion };
  const rel = await fetchJson(API);
  if (!rel || typeof rel.tag_name !== 'string') throw new Error('Nieprawidłowa odpowiedź GitHuba');
  const version = rel.tag_name.replace(/^v/i, '');
  const available = !rel.draft && !rel.prerelease && compareVersions(version, currentVersion) > 0;
  const asset = pickAsset(rel.assets, platform);
  const yml = (rel.assets || []).find((a) => a.name === 'latest.yml' || a.name === 'latest-linux.yml');
  return {
    available, current: currentVersion, version,
    notes: String(rel.body || '').slice(0, 4000),
    pageUrl: typeof rel.html_url === 'string' && rel.html_url.startsWith(`https://github.com/${REPO}/`) ? rel.html_url : `https://github.com/${REPO}/releases`,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    checksumUrl: yml ? yml.browser_download_url : null,
  };
}

// Wyciąga sha512 (base64) pliku z latest.yml wygenerowanego przez electron-builder.
function sha512FromYml(text, fileName) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-?\s*url:\s*/.test(lines[i]) && lines[i].includes(fileName)) {
      for (let j = i; j < Math.min(i + 4, lines.length); j++) {
        const m = /sha512:\s*([A-Za-z0-9+/=]+)/.exec(lines[j]);
        if (m) return m[1];
      }
    }
  }
  const top = /^sha512:\s*([A-Za-z0-9+/=]+)/m.exec(text);
  const path_ = /^path:\s*(.+)$/m.exec(text);
  return top && path_ && path_[1].trim() === fileName ? top[1] : null;
}

// Adres zasobu musi wskazywać na wydanie tego repozytorium; przekierowania (CDN GitHuba) tylko do domen GitHuba.
function assertReleaseUrl(url) {
  if (!String(url).startsWith(DOWNLOAD_PREFIX)) throw new Error('Adres pobierania nie należy do wydań Czytnika');
}

// fetchRaw(url, {redirect:'manual'}) -> Response; zapisuje do pliku, liczy sha512, raportuje postęp.
async function download({ url, destFile, expectedSha512, expectedSize, fetchRaw, onProgress = () => {} }) {
  assertReleaseUrl(url);
  let current = url;
  let res;
  for (let hop = 0; hop <= 5; hop++) {
    const u = V.assertPublicHttpUrl(current);
    if (u.protocol !== 'https:' || !HOST_OK.test(u.hostname)) throw new Error('Pobieranie z nieznanego serwera zostało zablokowane');
    await V.assertPublicHttpUrlResolved(current);
    res = await fetchRaw(current, { redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) break;
    if (hop === 5) throw new Error('Zbyt wiele przekierowań');
    current = new URL(loc, current).href;
  }
  if (!res.ok) throw new Error(`Pobieranie nie powiodło się (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  if (total > MAX_INSTALLER) throw new Error('Plik instalatora jest zbyt duży');

  const part = destFile + '.part';
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(part);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_INSTALLER) throw new Error('Plik instalatora jest zbyt duży');
      hash.update(value);
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      onProgress({ received, total });
    }
    await new Promise((resolve, reject) => { out.end((e) => (e ? reject(e) : resolve())); });
    if (expectedSize && received !== expectedSize) throw new Error('Pobrany plik ma nieoczekiwany rozmiar');
    const digest = hash.digest('base64');
    if (expectedSha512 && digest !== expectedSha512) throw new Error('Suma kontrolna pobranego pliku się nie zgadza — plik odrzucono');
    await fsp.rename(part, destFile);
    return { file: destFile, verified: !!expectedSha512, bytes: received };
  } catch (err) {
    if (!out.closed) await new Promise((r) => { out.once('close', r); out.destroy(); });
    await fsp.rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { compareVersions, pickAsset, checkForUpdate, sha512FromYml, download, assertReleaseUrl, API, REPO };
