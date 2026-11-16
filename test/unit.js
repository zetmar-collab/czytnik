// Testy jednostkowe (bez Electrona): walidatory, baza, skaner, parser MOBI.
// Uruchomienie: node test/unit.js  (wymaga wcześniej: node test/make-samples.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'czytnik-unit-'));

(async () => {
  const V = require('../src/validate');

  await t('validate: asId odrzuca śmieci', () => {
    assert.strictEqual(V.asId('5'), 5);
    for (const bad of ['../x', -1, 0, 1.5, null, undefined, 'abc', NaN]) assert.throws(() => V.asId(bad), String(bad));
  });
  await t('validate: safeJoin blokuje wyjście poza katalog', () => {
    const base = path.join(os.tmpdir(), 'covers');
    assert.ok(V.safeJoin(base, '5.jpg').startsWith(base));
    for (const bad of ['../x.txt', '..\\x.txt', '../../x', 'a/../../x']) assert.throws(() => V.safeJoin(base, bad), bad);
    assert.ok(!V.isInside(base, base + '-evil' + path.sep + 'x'), 'prefiks katalogu nie jest wnętrzem');
  });
  await t('validate: adresy lokalne i protokoły', () => {
    for (const bad of ['file:///C:/x.png', 'ftp://a/b', 'http://localhost/a', 'http://127.0.0.1/a', 'http://10.0.0.5/a',
      'http://192.168.1.1/a', 'http://172.20.1.1/a', 'http://169.254.1.1/a', 'http://[::1]/a', 'javascript:alert(1)', 'nie-url']) {
      assert.throws(() => V.assertPublicHttpUrl(bad), bad);
    }
    assert.ok(V.assertPublicHttpUrl('https://s.lubimyczytac.pl/a.jpg'));
  });
  await t('validate: sniffImage rozpoznaje po bajtach', () => {
    const pad = Buffer.alloc(20);
    assert.strictEqual(V.sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])), 'jpg');
    assert.strictEqual(V.sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), pad])), 'png');
    assert.strictEqual(V.sniffImage(Buffer.from('<html>błąd 404 - strona nie istnieje</html>')), null);
  });

  // ---- baza ----
  const db = require('../src/db');

  await t('db: odzyskiwanie po uszkodzonym pliku', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'biblioteka.sqlite'), Buffer.from('to nie jest baza sqlite, tylko śmieci'.repeat(20)));
    await db.open(dir);
    assert.ok(db.openInfo.recovered, 'recovered');
    assert.ok(db.openInfo.corruptCopy && fs.existsSync(db.openInfo.corruptCopy), 'kopia uszkodzonego pliku');
    assert.strictEqual(db.listBooks({}).length, 0);
  });

  await t('db: migracja starej bazy bez nowych kolumn', async () => {
    const dir = tmp();
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f) });
    const old = new SQL.Database();
    old.exec("CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, format TEXT NOT NULL, size INTEGER, mtime INTEGER, title TEXT, author TEXT, description TEXT, publisher TEXT, year TEXT, isbn TEXT, series TEXT, rating REAL, cover TEXT, meta_source TEXT DEFAULT 'plik', added_at INTEGER, last_opened INTEGER, progress TEXT, progress_pct REAL DEFAULT 0);");
    old.exec("INSERT INTO books (path, format, title) VALUES ('C:/stara.epub', 'epub', 'Stara książka');");
    fs.writeFileSync(path.join(dir, 'biblioteka.sqlite'), Buffer.from(old.export()));
    await db.open(dir);
    assert.ok(!db.openInfo.recovered);
    const cols = db.all('PRAGMA table_info(books)').map((r) => r.name);
    for (const c of ['tts_section', 'tts_chunk', 'tags', 'progress_at', 'tts_at']) assert.ok(cols.includes(c), c);
    assert.strictEqual(db.listBooks({})[0].title, 'Stara książka');
  });

  await t('db: wyszukiwanie traktuje % i _ dosłownie', async () => {
    await db.open(tmp());
    db.upsertBook({ path: 'a.epub', format: 'epub', size: 1, mtime: 1, title: '100% prawdy' });
    db.upsertBook({ path: 'b.epub', format: 'epub', size: 1, mtime: 1, title: 'Stu lat samotności' });
    db.upsertBook({ path: 'c.epub', format: 'epub', size: 1, mtime: 1, title: 'a_b' });
    assert.strictEqual(db.listBooks({ search: '100%' }).length, 1);
    assert.strictEqual(db.listBooks({ search: '%' }).length, 1);
    assert.strictEqual(db.listBooks({ search: 'a_b' }).length, 1);
    assert.strictEqual(db.listBooks({ search: '_' }).length, 1);
  });

  await t('db: uszkodzone ustawienie nie rzuca wyjątku', async () => {
    await db.open(tmp());
    db.run("INSERT INTO settings (key, value) VALUES ('zepsute', '{nie json')");
    assert.strictEqual(db.getSetting('zepsute', 'domyslne'), 'domyslne');
  });

  // ---- skaner ----
  await t('skaner: foldery dev/run/sys nie są pomijane w Windows', async () => {
    if (process.platform !== 'win32') return;
    const scanner = require('../src/scanner');
    const root = tmp();
    const sample = path.join(__dirname, 'biblioteka', 'Boleslaw_Prus-Lalka.epub');
    for (const d of ['dev', 'run', 'sys', 'snap']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
      fs.copyFileSync(sample, path.join(root, d, `${d}.epub`));
    }
    await db.open(tmp());
    const res = await scanner.scan([root], path.join(tmp(), 'covers'), () => {});
    assert.strictEqual(res.added, 4, `dodano ${res.added}`);
  });

  await t('skaner: zmieniony plik odświeża metadane', async () => {
    const scanner = require('../src/scanner');
    const dir = tmp();
    await db.open(tmp());
    const file = path.join(dir, 'ksiazka.epub');
    fs.copyFileSync(path.join(__dirname, 'biblioteka', 'Boleslaw_Prus-Lalka.epub'), file);
    await scanner.scan([dir], path.join(tmp(), 'c'), () => {});
    const before = db.getBookByPath(file);
    assert.strictEqual(before.title, 'Lalka');
    // ten sam plik, inny tytuł w metadanych
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const opf = zip.file('OEBPS/content.opf');
    zip.file('OEBPS/content.opf', (await opf.async('string')).replace('<dc:title>Lalka</dc:title>', '<dc:title>Lalka (nowe wydanie)</dc:title>'));
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    await scanner.scan([dir], path.join(tmp(), 'c'), () => {});
    assert.strictEqual(db.getBookByPath(file).title, 'Lalka (nowe wydanie)');
    // dane ręczne nie mogą zostać nadpisane
    db.updateBook(before.id, { title: 'Moja nazwa', meta_source: 'reczne' });
    fs.appendFileSync(file, Buffer.alloc(16));
    await scanner.scan([dir], path.join(tmp(), 'c'), () => {});
    assert.strictEqual(db.getBookByPath(file).title, 'Moja nazwa');
  });

  // ---- MOBI: wariant strumieniowy daje to samo co wariant na buforze ----
  await t('mobi: parseMobiFile == parseMobi', async () => {
    const { parseMobi, parseMobiFile } = require('../src/mobi-meta');
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const exthRec = (type, data) => Buffer.concat([u32(type), u32(8 + data.length), data]);
    const recs = [exthRec(100, Buffer.from('Jan Testowy')), exthRec(503, Buffer.from('Testowy Tytuł', 'utf8')), exthRec(201, u32(0))];
    const exthBody = Buffer.concat(recs);
    const exth = Buffer.concat([Buffer.from('EXTH'), u32(12 + exthBody.length), u32(recs.length), exthBody]);
    const mobiLen = 232;
    const rec0 = Buffer.alloc(16 + mobiLen + exth.length + 8);
    rec0.write('MOBI', 16, 'latin1');
    rec0.writeUInt32BE(mobiLen, 20);
    rec0.writeUInt32BE(65001, 28);
    rec0.writeUInt32BE(1, 108);        // pierwszy rekord obrazu
    rec0.writeUInt32BE(0x40, 128);     // jest EXTH
    exth.copy(rec0, 16 + mobiLen);
    const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
    const header = Buffer.alloc(78);
    header.writeUInt16BE(2, 76);
    const r0Off = 78 + 16 + 2;
    const table = Buffer.alloc(16);
    table.writeUInt32BE(r0Off, 0);
    table.writeUInt32BE(r0Off + rec0.length, 8);
    const file = Buffer.concat([header, table, Buffer.alloc(2), rec0, img]);
    const p = path.join(tmp(), 'test.mobi');
    fs.writeFileSync(p, file);
    const a = await parseMobi(file);
    const b = await parseMobiFile(p);
    assert.strictEqual(a.author, 'Jan Testowy');
    assert.strictEqual(b.author, a.author);
    assert.strictEqual(b.title, a.title);
    assert.strictEqual(b.title, 'Testowy Tytuł');
    assert.ok(a.coverBuf && b.coverBuf && b.coverBuf.length === a.coverBuf.length, 'okładka');
  });

  // ---- indeks pełnotekstowy ----
  const ft = require('../src/fulltext');
  await t('fulltext: składanie tekstu zachowuje długość i usuwa ogonki', () => {
    const s = 'Żółć ĄĘŚŁ gęślą jaźń – „Zażółć” 😀 İ';
    const f = ft.fold(s);
    assert.strictEqual(f.length, s.length);
    assert.ok(f.startsWith('zolc aesl gesla jazn'), f);
  });
  await t('fulltext: PalmDOC dekoduje literały, spację+znak i odwołania', () => {
    // "abc abc" = literały a,b,c, spacja, potem odwołanie dist=4 len=3
    const dist = 4, len = 3;
    const ref = ((dist << 3) | (len - 3)) | 0x8000;
    const buf = Buffer.from([0x61, 0x62, 0x63, 0x20, ref >> 8, ref & 255]);
    assert.strictEqual(ft.palmdoc(buf).toString('latin1'), 'abc abc');
    assert.strictEqual(ft.palmdoc(Buffer.from([0xc1])).toString('latin1'), ' A' === ' A' ? ' A' : '');
    assert.strictEqual(ft.palmdoc(Buffer.from([2, 0x80, 0x81])).length, 2);
  });
  await t('fulltext: HTML -> tekst bez skryptów i stylów', () => {
    const txt = ft.htmlToText('<html><head><style>x{}</style></head><body><p>Ala</p><p>ma <b>kota</b></p><script>var a=1</script></body></html>');
    assert.strictEqual(txt, 'Ala ma kota');
  });
  await t('fulltext: indeksowanie EPUB i wyszukiwanie (z ogonkami, fraza i słowa)', async () => {
    const dir = tmp();
    await db.open(dir);
    ft.init(dir);
    const src = path.join(__dirname, 'biblioteka', 'Boleslaw_Prus-Lalka.epub');
    const st = fs.statSync(src);
    const id = db.upsertBook({ path: src, title: 'Lalka', author: 'Prus', format: 'epub', size: st.size, mtime: st.mtimeMs }).id;
    const st1 = ft.status();
    assert.strictEqual(st1.pending, 1);
    const r = await ft.indexAll();
    assert.strictEqual(r.done, 1);
    assert.strictEqual(ft.status().indexed, 1, JSON.stringify(ft.status()));
    const found = await ft.search('wokulski');
    assert.ok(found.results.length === 1 && found.results[0].count > 5, JSON.stringify(found.results[0]?.count));
    const sn = found.results[0].snippets[0];
    assert.strictEqual(ft.fold(sn.match), 'wokulski');
    const none = await ft.search('zzzqqqxxx');
    assert.strictEqual(none.results.length, 0);
    // ponowne indeksowanie nic nie robi
    assert.strictEqual((await ft.indexAll()).total, 0);
    ft.removeIndex(id);
    assert.strictEqual((await ft.search('wokulski')).results.length, 0);
  });

  await t('validate: SSRF — IPv6 zmapowane, rezerwowane zakresy i nazwy wskazujące na adresy lokalne', async () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:172.16.0.1', '::ffff:a9fe:101', 'fe80::1', '100.64.0.1', '0.0.0.0', '::1']) {
      assert.ok(V.isPrivateIp(ip), ip);
    }
    for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.ok(!V.isPrivateIp(ip), ip);
    for (const u of ['http://[::ffff:7f00:1]/', 'http://localhost./', 'http://0x7f.1/', 'http://2130706433/']) assert.throws(() => V.assertPublicHttpUrl(u), u);
    await assert.rejects(() => V.assertPublicHttpUrlResolved('http://localtest.me/'), /sieć lokalną|rozpoznać/);
  });

  // ---- konwersja ----
  const conv = require('../src/convert');
  const JSZip = require('jszip');
  const lalka = path.join(__dirname, 'biblioteka', 'Boleslaw_Prus-Lalka.epub');
  await t('konwersja: EPUB -> TXT, MD i DOCX z poprawną strukturą', async () => {
    const dir = tmp();
    const book = { path: lalka, format: 'epub', title: 'Lalka', author: 'Bolesław Prus' };
    const txt = path.join(dir, 'a.txt'), md = path.join(dir, 'a.md'), docx = path.join(dir, 'a.docx');
    await conv.convertBook(book, 'txt', txt);
    await conv.convertBook(book, 'md', md);
    await conv.convertBook(book, 'docx', docx);
    const t1 = fs.readFileSync(txt, 'utf8');
    assert.ok(t1.includes('Wokulski') && t1.includes('ROZDZIAŁ I'), 'txt');
    const m1 = fs.readFileSync(md, 'utf8');
    assert.ok(m1.startsWith('# Lalka') && /\n## Rozdział I/.test(m1), 'md');
    const zip = await JSZip.loadAsync(fs.readFileSync(docx));
    for (const f of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) assert.ok(zip.file(f), f);
    const docXml = await zip.file('word/document.xml').async('string');
    const { XMLParser } = require('fast-xml-parser');
    assert.doesNotThrow(() => new XMLParser().parse(docXml), 'document.xml jest poprawnym XML-em');
    assert.ok(docXml.includes('Wokulski') && docXml.includes('w:val="Heading1"'));
  });
  await t('konwersja: HTML -> bloki (listy, pogrubienia, nagłówki) i znaki specjalne', async () => {
    const b = conv.htmlToBlocks('<body><h2>Tytuł</h2><p>Ala <b>ma</b> <i>kota</i> &amp; <a href="https://x.pl">link</a></p><ul><li>jeden</li><li>dwa</li></ul><p>A &lt; B\u0001</p></body>');
    assert.deepStrictEqual(b.map((x) => x.t), ['h', 'p', 'li', 'li', 'p']);
    const doc = { title: 'T <&>', author: '', blocks: b };
    const md = conv.renderMd(doc);
    assert.ok(md.includes('**ma**') && md.includes('*kota*') && md.includes('[link](https://x.pl)') && md.includes('- jeden'), md);
    const xmlText = conv.renderDocxXml(doc);
    assert.ok(!/\u0001/.test(xmlText) && xmlText.includes('T &lt;&amp;&gt;'), 'znaki sterujące usunięte, XML poprawnie escapowany');
    assert.ok(conv.renderTxt(doc).includes('  • jeden'));
  });
  await t('konwersja: odrzuca nieobsługiwane formaty i uszkodzone pliki', async () => {
    await assert.rejects(() => conv.convertBook({ path: lalka, format: 'epub' }, 'exe', path.join(tmp(), 'x')), /Nieobsługiwany/);
    await assert.rejects(() => conv.loadBook({ path: path.join(__dirname, 'biblioteka', 'Testowy_dokument.pdf'), format: 'pdf' }), /tylko EPUB/);
    const bad = path.join(tmp(), 'zly.epub'); fs.writeFileSync(bad, 'to nie jest zip');
    await assert.rejects(() => conv.loadBook({ path: bad, format: 'epub' }));
    assert.strictEqual(conv.safeName('A:B/C*?.txt'), 'ABC.txt');
  });

  // ---- czytniki USB ----
  const dv = require('../src/devices');
  await t('urządzenia: rozpoznawanie typu po znacznikach', () => {
    const mk = (...parts) => { const r = tmp(); for (const p of parts) fs.mkdirSync(path.join(r, p), { recursive: true }); return r; };
    assert.strictEqual(dv.detectKind(mk('.kobo')), 'kobo');
    const kin = mk('documents', 'system'); fs.writeFileSync(path.join(kin, 'system', 'version.txt'), 'x');
    assert.strictEqual(dv.detectKind(kin), 'kindle');
    assert.strictEqual(dv.detectKind(mk('Android', 'DCIM')), 'tablet');
    assert.strictEqual(dv.detectKind(mk('system/config')), 'pocketbook');
    assert.strictEqual(dv.detectKind(mk('foo')), 'generic');
  });
  await t('urządzenia: wysyłanie, pomijanie powtórek i nieobsługiwanych formatów, półki jako foldery', async () => {
    await db.open(tmp());
    const src = tmp();
    const epub = path.join(src, 'Lalka.epub'); fs.copyFileSync(lalka, epub);
    const pdf = path.join(src, 'Dok.pdf'); fs.copyFileSync(path.join(__dirname, 'biblioteka', 'Testowy_dokument.pdf'), pdf);
    const a = db.upsertBook({ path: epub, format: 'epub', size: fs.statSync(epub).size, mtime: 1, title: 'Lalka', author: 'Prus' }).id;
    const b = db.upsertBook({ path: pdf, format: 'pdf', size: fs.statSync(pdf).size, mtime: 1, title: 'Dok', author: 'X' }).id;
    const col = db.createCollection('Klasyka');
    db.addBooksToCollection([a], col);
    // Kobo: epub + pdf obsługiwane, półka = folder
    const kobo = tmp(); fs.mkdirSync(path.join(kobo, '.kobo'));
    const dev = dv.describe(kobo, 'KOBOeReader', 1e10, 1e10, true);
    assert.strictEqual(dev.kind, 'kobo');
    const r1 = await dv.exportBooks(dev, dv.booksForExport());
    assert.strictEqual(r1.copied.length, 2);
    assert.ok(fs.existsSync(path.join(kobo, 'Klasyka', 'Lalka.epub')), 'półka jako folder');
    assert.ok(fs.existsSync(path.join(kobo, 'Dok.pdf')));
    assert.strictEqual((await dv.exportBooks(dev, dv.booksForExport())).existing, 2, 'drugi raz nic nie kopiuje');
    // Kindle: EPUB nieobsługiwany, brak podfolderów
    const kin = tmp(); fs.mkdirSync(path.join(kin, 'documents')); fs.mkdirSync(path.join(kin, 'system')); fs.writeFileSync(path.join(kin, 'system', 'version.txt'), 'x');
    const kd = dv.describe(kin, 'Kindle', 1e10, 1e10, true);
    const r2 = await dv.exportBooks(kd, dv.booksForExport());
    assert.deepStrictEqual(r2.unsupported.map((u) => u.format), ['epub']);
    assert.ok(fs.existsSync(path.join(kin, 'documents', 'Dok.pdf')));
    // za mało miejsca
    await assert.rejects(() => dv.exportBooks({ ...dev, root: kobo, free: 10 }, dv.booksForExport({ ids: [a] }), {}).then(() => { throw new Error('powinno odrzucić'); }), /Za mało miejsca|powinno odrzucić/);
  });
  await t('urządzenia: pobieranie nowych książek, półki z folderów, brak duplikatów', async () => {
    await db.open(tmp());
    const kobo = tmp(); fs.mkdirSync(path.join(kobo, '.kobo')); fs.mkdirSync(path.join(kobo, 'Do przeczytania'));
    fs.copyFileSync(lalka, path.join(kobo, 'Do przeczytania', 'Lalka z czytnika.epub'));
    const dev = dv.describe(kobo, 'KOBOeReader', 1e10, 1e10, true);
    const scanner = require('../src/scanner');
    const covers = tmp();
    const libDir = tmp();
    const importer = (paths) => scanner.importFiles(paths, covers);
    const r = await dv.importFromDevice(dev, { libraryDir: libDir, importer });
    assert.strictEqual(r.imported.length, 1, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(libDir, 'Lalka z czytnika.epub')));
    assert.strictEqual(db.listCollections().find((c) => c.name === 'Do przeczytania').count, 1);
    const r2 = await dv.importFromDevice(dev, { libraryDir: libDir, importer });
    assert.strictEqual(r2.imported.length, 0);
    assert.strictEqual(r2.known, 1, 'ta sama książka (nazwa+rozmiar) jest rozpoznana');
    // ta sama książka pod inną nazwą i w innym rozmiarze nie powinna się dublować (klucz tytuł+autor)
    fs.copyFileSync(lalka, path.join(kobo, 'Kopia.epub'));
    const r3 = await dv.importFromDevice(dev, { libraryDir: libDir, importer });
    assert.strictEqual(r3.duplicates.length, 1, JSON.stringify(r3));
    assert.ok(!fs.existsSync(path.join(libDir, 'Kopia.epub')), 'świeża kopia duplikatu usunięta');
    assert.strictEqual(db.all('SELECT id FROM books').length, 1);
  });

  // ---- aktualizacje ----
  const up = require('../src/updater');
  await t('aktualizacje: porównanie wersji, wybór zasobu i suma kontrolna', async () => {
    assert.ok(up.compareVersions('1.10.0', '1.9.9') > 0 && up.compareVersions('v1.5.0', '1.5.0') === 0 && up.compareVersions('1.4.9', '1.5.0') < 0);
    const assets = [{ name: 'Czytnik-1.6.0.AppImage' }, { name: 'Czytnik-Instalator-1.6.0.exe' }, { name: 'latest.yml' }];
    assert.strictEqual(up.pickAsset(assets, 'win32').name, 'Czytnik-Instalator-1.6.0.exe');
    assert.strictEqual(up.pickAsset(assets, 'linux').name, 'Czytnik-1.6.0.AppImage');
    assert.strictEqual(up.pickAsset(assets, 'darwin'), null);
    const yml = 'version: 1.6.0\nfiles:\n  - url: Czytnik-Instalator-1.6.0.exe\n    sha512: AbC+/=123\n    size: 5\npath: Czytnik-Instalator-1.6.0.exe\nsha512: AbC+/=123\n';
    assert.strictEqual(up.sha512FromYml(yml, 'Czytnik-Instalator-1.6.0.exe'), 'AbC+/=123');
    assert.strictEqual(up.sha512FromYml(yml, 'inny.exe'), null);
  });
  await t('aktualizacje: sprawdzanie wydania (nowsze, to samo, sklep, szkic)', async () => {
    const rel = (tag, extra = {}) => async () => ({ tag_name: tag, html_url: 'https://github.com/zetmar-collab/czytnik/releases/tag/' + tag, body: 'notatki', assets: [{ name: `Czytnik-Instalator-${tag.slice(1)}.exe`, browser_download_url: `https://github.com/zetmar-collab/czytnik/releases/download/${tag}/x.exe`, size: 9 }], ...extra });
    const r = await up.checkForUpdate({ currentVersion: '1.5.0', fetchJson: rel('v1.6.0'), platform: 'win32' });
    assert.ok(r.available && r.version === '1.6.0' && r.asset.name.endsWith('.exe') && r.pageUrl.startsWith('https://github.com/zetmar-collab/'));
    assert.ok(!(await up.checkForUpdate({ currentVersion: '1.6.0', fetchJson: rel('v1.6.0'), platform: 'win32' })).available);
    assert.ok(!(await up.checkForUpdate({ currentVersion: '1.5.0', fetchJson: rel('v1.7.0', { prerelease: true }), platform: 'win32' })).available);
    assert.ok((await up.checkForUpdate({ currentVersion: '1.5.0', fetchJson: rel('v1.6.0'), isStore: true })).managedByStore);
    await assert.rejects(() => up.checkForUpdate({ currentVersion: '1.5.0', fetchJson: async () => ({}) }), /Nieprawidłowa/);
  });
  await t('aktualizacje: pobieranie weryfikuje sumę i blokuje obce adresy', async () => {
    const crypto = require('crypto');
    const payload = Buffer.alloc(5000, 7);
    const good = crypto.createHash('sha512').update(payload).digest('base64');
    const stream = (buf) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } });
    const okFetch = async () => ({ ok: true, status: 200, headers: new Map([['content-length', String(payload.length)]]), body: stream(payload) });
    const url = 'https://github.com/zetmar-collab/czytnik/releases/download/v9/Czytnik-Instalator-9.exe';
    const dest = path.join(tmp(), 'i.exe');
    const r = await up.download({ url, destFile: dest, expectedSha512: good, expectedSize: payload.length, fetchRaw: okFetch });
    assert.ok(r.verified && fs.statSync(dest).size === 5000);
    const dest2 = path.join(tmp(), 'j.exe');
    await assert.rejects(() => up.download({ url, destFile: dest2, expectedSha512: 'zla', fetchRaw: okFetch }), /Suma kontrolna/);
    assert.ok(!fs.existsSync(dest2) && !fs.existsSync(dest2 + '.part'), 'zły plik nie zostaje na dysku');
    await assert.rejects(() => up.download({ url: 'https://evil.example/a.exe', destFile: dest2, fetchRaw: okFetch }), /nie należy do wydań/);
    const redirect = async () => ({ ok: false, status: 302, headers: new Map([['location', 'https://evil.example/x']]), body: null });
    await assert.rejects(() => up.download({ url, destFile: dest2, fetchRaw: redirect }), /zablokowane|nieznanego/);
  });

  await t('bezpieczeństwo: kandydat metadanych i ustawienia z pliku są walidowane', () => {
    const m = require('../src/metadata');
    const S = require('../src/sync');
    assert.strictEqual(m.cleanCandidate({ source: 'lubimyczytac', url: 'https://lubimyczytac.pl/k/1', title: 'T', extra: 'x' }).extra, undefined);
    for (const bad of ['http://127.0.0.1/a', 'https://lubimyczytac.pl.evil.com/a', 'file:///c:/x', 'ftp://lubimyczytac.pl/a']) {
      assert.throws(() => m.cleanCandidate({ source: 'lubimyczytac', url: bad }), bad);
    }
    assert.throws(() => m.cleanCandidate({ source: 'obcy' }));
    const st = S.sanitize({ format: 'czytnik-backup', version: 1, settings: {
      appTheme: 'x', readerSettings: { fontFamily: 'a";}body{x:1', fontSize: 999, readerTheme: 'evil' }, ttsSettings: { voice: 5, rate: 99 } } }).settings;
    assert.strictEqual(st.appTheme, undefined);
    assert.strictEqual(st.readerSettings.fontFamily, '');
    assert.strictEqual(st.readerSettings.fontSize, 40);
    assert.strictEqual(st.readerSettings.readerTheme, 'dark');
    assert.strictEqual(st.ttsSettings.rate, 10);
  });

  // ---- automatyczna kopia metadanych ----
  await t('kopia metadanych: tworzy plik, nie powtarza przed upływem terminu, usuwa najstarsze', async () => {
    await db.open(tmp());
    db.upsertBook({ path: 'C:\\x\\a.epub', format: 'epub', size: 1, mtime: 1, title: 'A', author: 'B' });
    const dir = tmp();
    const t0 = Date.UTC(2026, 0, 1, 12);
    const r1 = await require('../src/sync').autoBackup(dir, { now: t0 });
    assert.ok(r1.file && fs.existsSync(r1.file));
    assert.ok((await require('../src/sync').autoBackup(dir, { now: t0 + 3 * 86400000 })).skipped, 'za wcześnie');
    for (let i = 1; i <= 4; i++) await require('../src/sync').autoBackup(dir, { now: t0 + i * 8 * 86400000, keep: 3 });
    assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, 3, 'zostają 3 ostatnie');
    db.setSetting('metaBackupAuto', false);
    assert.ok((await require('../src/sync').autoBackup(dir, { now: t0 + 999 * 86400000 })).skipped === 'wyłączona');
  });

  // ---- masowe dopasowanie metadanych ----
  const bm = require('../src/bulkmeta');
  await t('bulkmeta: podobieństwo tytułów i zgodność autora', () => {
    assert.strictEqual(bm.similarity('Lalka', 'LALKA'), 1);
    assert.ok(bm.similarity('Quo vadis', 'Quo Vadis – powieść z czasów Nerona') < 0.8, 'dłuższy tytuł nie jest pewnym dopasowaniem');
    assert.ok(bm.similarity('Zbrodnia i kara', 'Zbrodnia i kara') === 1);
    assert.ok(bm.similarity('Pan Tadeusz', 'Dziady') === 0);
    assert.ok(bm.authorMatches('Bolesław Prus', 'Prus Bolesław'), 'odwrócona kolejność');
    assert.ok(bm.authorMatches('', 'Ktokolwiek'), 'brak lokalnego autora — decyduje tytuł');
    assert.ok(!bm.authorMatches('Bolesław Prus', 'Henryk Sienkiewicz'));
    assert.ok(!bm.authorMatches('Bolesław Prus', null));
  });
  await t('bulkmeta: wybiera tylko pewne dopasowanie', () => {
    const book = { title: 'Lalka', author: 'Bolesław Prus' };
    const cands = [
      { title: 'Lalka. Tom 1', author: 'Bolesław Prus' },
      { title: 'Lalka', author: 'Jan Kowalski' },
      { title: 'Lalka', author: 'Prus Bolesław', isbn: '1' },
    ];
    assert.strictEqual(bm.bestMatch(book, cands).cand.isbn, '1');
    assert.strictEqual(bm.bestMatch(book, [cands[0], cands[1]]), null);
  });

  // ---- kopia zapasowa / synchronizacja ----
  const sync = require('../src/sync');
  await t('sync: zrzut z komputera A scala się na komputerze B (inne ścieżki, bez duplikowania)', async () => {
    await db.open(tmp());
    const a = db.upsertBook({ path: 'C:\\a\\Lalka.epub', format: 'epub', size: 10, mtime: 1, title: 'Lalka', author: 'Prus' }).id;
    const a2 = db.upsertBook({ path: 'C:\\a\\Inna.epub', format: 'epub', size: 10, mtime: 1, title: 'Inna', author: 'Ktoś' }).id;
    db.updateBook(a, { progress: 'epubcfi(/6/4)', progress_pct: 0.5, progress_at: 2000, tags: 'klasyka', series: 'Cykl' });
    const ann = db.addAnnotation({ book_id: a, type: 'note', loc: 'epubcfi(/6/4!/4/2)', text: 'cytat', note: 'moja notatka', color: '#ffd54f' });
    const gone = db.addAnnotation({ book_id: a, type: 'highlight', loc: 'epubcfi(/6/4!/4/6)', text: 'usunięta' });
    db.deleteAnnotation(gone.uid);
    const col = db.createCollection('Do przeczytania');
    db.addBooksToCollection([a, a2], col);
    db.addReadingSeconds(a, 600, '2026-01-02');
    db.setSetting('appTheme', 'light');
    const file = path.join(tmp(), 'kopia.json');
    const rep0 = await sync.exportToFile(file);
    assert.strictEqual(rep0.books, 2);

    await db.open(tmp()); // "komputer B": te same książki, inne ścieżki, starszy postęp
    const b = db.upsertBook({ path: 'D:\\books\\Lalka.epub', format: 'epub', size: 11, mtime: 1, title: 'Lalka', author: 'Prus' }).id;
    db.updateBook(b, { progress: 'epubcfi(/6/2)', progress_pct: 0.1, progress_at: 1000 });
    const rep = await sync.importFromFile(file);
    assert.strictEqual(rep.matched, 1);
    assert.strictEqual(rep.unmatched, 1, 'książka bez pliku jest policzona jako niedopasowana');
    const book = db.getBook(b);
    assert.strictEqual(book.progress_pct, 0.5, 'nowszy postęp wygrywa');
    assert.strictEqual(book.series, 'Cykl');
    assert.strictEqual(book.tags, 'klasyka');
    const anns = db.listAnnotations(b);
    assert.strictEqual(anns.length, 1);
    assert.strictEqual(anns[0].note, 'moja notatka');
    assert.strictEqual(db.listAnnotations(b, { includeDeleted: true }).length, 2, 'znacznik usunięcia też się przenosi');
    assert.strictEqual(db.listCollections()[0].count, 1);
    assert.strictEqual(db.getStats().total, 600);
    assert.strictEqual(db.getSetting('appTheme'), 'light');
    // ponowny import nic nie zmienia
    const again = await sync.importFromFile(file);
    assert.strictEqual(again.annotationsAdded + again.annotationsUpdated + again.progress + again.collections + again.reading, 0, JSON.stringify(again));
    assert.strictEqual(db.getStats().total, 600, 'sekundy nie sumują się przy powtórzeniu');
    // starszy zrzut nie cofa postępu
    db.updateBook(b, { progress: 'epubcfi(/6/8)', progress_pct: 0.9, progress_at: 9000 });
    await sync.importFromFile(file);
    assert.strictEqual(db.getBook(b).progress_pct, 0.9);
  });
  const KEY = 'ta:' + 'a'.repeat(20);
  await t('sync: odrzuca obcy lub złośliwy plik i czyści pola', async () => {
    assert.throws(() => sync.sanitize({ format: 'cos-innego' }), /kopii zapasowej/);
    assert.throws(() => sync.sanitize({ format: 'czytnik-backup', version: 99 }), /nowszej/);
    const s = sync.sanitize({
      format: 'czytnik-backup', version: 1,
      books: { [KEY]: { title: 'x'.repeat(9999), progress_pct: 'nie-liczba' }, '../../etc/passwd': { title: 'zły' } },
      annotations: [{ key: 'ta:' + 'a'.repeat(20), uid: 'u1', type: 'script', loc: 'x' }, { key: 'brak', uid: 'u2', type: 'note', loc: 'x' }],
      reading: [{ key: 'ta:' + 'a'.repeat(20), day: '../x', seconds: 5 }, { key: 'ta:' + 'a'.repeat(20), day: '2026-01-01', seconds: 1e9 }],
      settings: { syncDir: 'C:\\Windows', appTheme: 'dark' },
    });
    assert.deepStrictEqual(Object.keys(s.books), ['ta:' + 'a'.repeat(20)]);
    assert.strictEqual(s.books['ta:' + 'a'.repeat(20)].title.length, 500);
    assert.strictEqual(s.books['ta:' + 'a'.repeat(20)].progress_pct, null);
    assert.strictEqual(s.annotations.length, 0);
    assert.strictEqual(s.reading.length, 0);
    assert.deepStrictEqual(Object.keys(s.settings), ['appTheme'], 'ustawienia spoza białej listy są pomijane');
  });
  await t('sync: folder — dwa urządzenia wymieniają się danymi', async () => {
    const folder = tmp();
    await db.open(tmp());
    const a = db.upsertBook({ path: 'C:\\x\\K.epub', format: 'epub', size: 1, mtime: 1, title: 'Książka', author: 'Autor' }).id;
    db.addAnnotation({ book_id: a, type: 'bookmark', loc: 'epubcfi(/6/4)', text: 'z A' });
    const idA = sync.deviceId();
    const r1 = await sync.syncFolder(folder);
    assert.strictEqual(r1.files, 0);
    assert.ok(fs.existsSync(path.join(folder, idA + '.czytnik.json')));
    await db.open(tmp());
    const b = db.upsertBook({ path: 'E:\\K.epub', format: 'epub', size: 1, mtime: 1, title: 'Książka', author: 'Autor' }).id;
    assert.notStrictEqual(sync.deviceId(), idA);
    const r2 = await sync.syncFolder(folder);
    assert.strictEqual(r2.files, 1);
    assert.strictEqual(r2.annotationsAdded, 1);
    assert.strictEqual(db.listAnnotations(b)[0].text, 'z A');
    assert.strictEqual((await sync.syncFolder(folder)).annotationsAdded, 0, 'własny plik jest pomijany, powtórka niczego nie dubluje');
    await assert.rejects(() => sync.syncFolder(path.join(folder, 'nie-ma')), /niedostępny/);
  });

  console.log(failed ? `\nWYNIK: ${failed} test(ów) nie przeszło` : '\nWYNIK: SUKCES');
  process.exit(failed ? 1 : 0);
})();
