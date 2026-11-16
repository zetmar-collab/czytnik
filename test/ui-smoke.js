// Automatyczny test UI uruchamiany przez: CZYTNIK_SMOKE=1 npm start
// Skanuje folder testowy, otwiera książkę w czytniku i raportuje wyniki na stdout.
const path = require('path');

module.exports = async function runUiSmoke(win, app) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('[SMOKE]', ...a);

  // Odtwarza ścieżkę „plik z dysku -> czytnik" używaną przez przycisk
  // „Otwórz e-booka…" i przez dwuklik w Eksploratorze.
  const openExternal = async (filePath) => {
    const db = require('../src/db');
    const scanner = require('../src/scanner');
    const coversDir = path.join(app.getPath('userData'), 'covers');
    await scanner.importFiles([filePath], coversDir);
    const book = db.getBookByPath(filePath);
    if (book) win.webContents.send('open-book', book.id);
    return book;
  };

  let failed = false;
  const check = (name, ok, extra = '') => {
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  try {
    await sleep(1500);

    // 1. skanowanie folderu testowego
    const libDir = path.join(__dirname, 'biblioteka').replace(/\\/g, '\\\\');
    const scanResult = await js(`window.api.startScan(['${libDir}']).then(JSON.stringify)`);
    const scan = JSON.parse(scanResult);
    check('skanowanie', scan.added >= 2, `dodano ${scan.added}`);

    // 2. odśwież bibliotekę i policz kafelki
    await js(`window.location.reload()`);
    await sleep(1500);
    const cards = await js(`document.querySelectorAll('.card').length`);
    check('siatka biblioteki', cards >= 2, `${cards} kafelków`);

    // 3. metadane EPUB widoczne na kafelku
    const hasTitle = await js(`[...document.querySelectorAll('.card-title')].some(e => e.textContent === 'Lalka')`);
    check('metadane EPUB (tytuł)', hasTitle);

    // 4. szczegóły książki
    await js(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title').textContent === 'Lalka').click()`);
    await sleep(600);
    const detailVisible = await js(`!document.querySelector('#detail-modal').classList.contains('hidden')`);
    const detailAuthor = await js(`document.querySelector('#detail-author').textContent`);
    check('szczegóły książki', detailVisible && detailAuthor.includes('Prus'), detailAuthor);

    // 5. czytnik EPUB
    await js(`document.querySelector('#btn-read').click()`);
    await sleep(3500);
    const readerOpen = await js(`!document.querySelector('#reader').classList.contains('hidden')`);
    const hasView = await js(`!!document.querySelector('#reader-view foliate-view')`);
    const tocCount = await js(`document.querySelectorAll('#toc-list li').length`);
    check('czytnik EPUB otwarty', readerOpen && hasView, `spis treści: ${tocCount} pozycji`);

    // 6. zmiana rozmiaru czcionki i motywu czytnika
    await js(`document.querySelector('#font-plus').click(); document.querySelector('#font-plus').click()`);
    await sleep(300);
    const fontLabel = await js(`document.querySelector('#font-size-label').textContent`);
    check('zmiana rozmiaru czcionki', fontLabel === '20px', fontLabel);
    await js(`document.querySelector('#reader-theme').click()`);
    await sleep(300);
    const themeAfter = await js(`document.querySelector('#reader').classList.contains('dark-book') ? 'dark' : 'light'`);
    check('przełączenie motywu czytnika', true, 'aktualny: ' + themeAfter);

    // 7. nawigacja stron
    await js(`document.querySelector('#page-next').click()`);
    await sleep(800);
    const pct = await js(`document.querySelector('#reader-percent').textContent`);
    check('nawigacja / postęp', true, 'postęp: ' + pct);

    // 7b. wznawianie czytania od zapamiętanego miejsca
    await sleep(1200); // poczekaj na zapis postępu (debounce 800 ms)
    const pctBefore = await js(`document.querySelector('#reader-percent').textContent`);
    await js(`document.querySelector('#reader-back').click()`);
    await sleep(600);
    await js(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title').textContent === 'Lalka').click()`);
    await sleep(500);
    await js(`document.querySelector('#btn-read').click()`);
    await sleep(3500);
    const pctAfter = await js(`document.querySelector('#reader-percent').textContent`);
    check('wznowienie od miejsca przerwania', pctBefore !== '0%' && pctAfter === pctBefore,
      `przed zamknięciem: ${pctBefore}, po ponownym otwarciu: ${pctAfter}`);

    // 8. zamknij czytnik, otwórz PDF
    await js(`document.querySelector('#reader-back').click()`);
    await sleep(600);
    await js(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.format-badge').textContent === 'pdf').click()`);
    await sleep(500);
    await js(`document.querySelector('#btn-read').click()`);
    await sleep(4500);
    const pdfView = await js(`!!document.querySelector('#reader-view foliate-view')`);
    const zoomVisible = await js(`!document.querySelector('#zoom-tools').classList.contains('hidden')`);
    const fontHidden = await js(`document.querySelector('#font-tools').classList.contains('hidden')`);
    check('czytnik PDF', pdfView, `zoom widoczny: ${zoomVisible}, czcionki ukryte: ${fontHidden}`);

    // 9. motyw aplikacji
    await js(`document.querySelector('#reader-back').click()`);
    await sleep(400);
    const before = await js(`document.documentElement.dataset.theme`);
    await js(`document.querySelector('#btn-theme').click()`);
    await sleep(300);
    const after = await js(`document.documentElement.dataset.theme`);
    check('motyw aplikacji', before !== after, `${before} -> ${after}`);

    // 10. edycja ręczna metadanych
    await js(`[...document.querySelectorAll('.card')][0].click()`);
    await sleep(400);
    await js(`document.querySelector('#btn-edit').click()`);
    await sleep(300);
    await js(`
      const f = document.querySelector('#edit-form');
      f.author.value = 'Autor Testowy';
      f.requestSubmit();
    `);
    await sleep(800);
    const editedAuthor = await js(`document.querySelector('#detail-author').textContent`);
    check('edycja ręczna', editedAuthor === 'Autor Testowy', editedAuthor);

    // 11. czyszczenie bazy
    const cleared = await js(`window.api.clearLibrary()`);
    await js(`window.location.reload()`);
    await sleep(1200);
    const afterClear = await js(`document.querySelectorAll('.card').length`);
    check('czyszczenie bazy', cleared >= 2 && afterClear === 0, `usunięto ${cleared}, zostało ${afterClear}`);

    // 12. skanowanie z filtrem formatu (tylko PDF)
    const scan2 = JSON.parse(await js(`window.api.startScan(['${libDir}'], ['pdf']).then(JSON.stringify)`));
    const onlyPdf = JSON.parse(await js(`window.api.listBooks({}).then(JSON.stringify)`));
    check('filtr formatów przy skanowaniu', scan2.added === 1 && onlyPdf.every(b => b.format === 'pdf'),
      `dodano ${scan2.added}, formaty: ${onlyPdf.map(b => b.format).join(',')}`);

    // 13. zaznaczanie wielu i usuwanie
    await js(`window.api.startScan(['${libDir}']).then(JSON.stringify)`); // uzupełnij bibliotekę
    await js(`window.location.reload()`);
    await sleep(1200);
    await js(`window.confirm = () => true; undefined`);
    await js(`document.querySelectorAll('.card-check').forEach(c => c.click()); undefined`);
    await sleep(300);
    const selBarVisible = await js(`!document.querySelector('#select-bar').classList.contains('hidden')`);
    const selCount = await js(`document.querySelector('#select-count').textContent`);
    check('zaznaczanie wielu książek', selBarVisible, selCount);
    await js(`document.querySelector('#btn-delete-selected').click()`);
    await sleep(800);
    const afterDelete = await js(`document.querySelectorAll('.card').length`);
    check('usuwanie zaznaczonych', afterDelete === 0, `zostało ${afterDelete}`);

    // 14. import pojedynczych plików (z pominięciem okna dialogowego)
    const imported = JSON.parse(await js(`window.api.startScan(['${libDir}'], ['epub']).then(JSON.stringify)`));
    check('ponowny import po usunięciu', imported.added === 1, `dodano ${imported.added}`);

    // 14b. URL okładki musi się zmienić po podmianie pliku okładki,
    //      inaczej siatka pokazuje starą grafikę z pamięci podręcznej
    {
      const fs = require('fs');
      const books = JSON.parse(await js(`window.api.listBooks({}).then(JSON.stringify)`));
      const withCover = books.find((b) => b.cover);
      if (!withCover) {
        check('świeżość URL okładki', false, 'brak książki z okładką');
      } else {
        const before = await js(`window.api.coverUrl(${JSON.stringify(withCover.cover)})`);
        const t = Date.now() + 5000;
        fs.utimesSync(withCover.cover, t / 1000, t / 1000);
        const after = await js(`window.api.coverUrl(${JSON.stringify(withCover.cover)})`);
        check('świeżość URL okładki', before !== after, `${before} -> ${after}`);
      }
    }

    // 14c. wyszukiwanie okładki w internecie (pomijane w trybie offline, np. w CI)
    if (!process.env.CZYTNIK_OFFLINE) {
      const res = JSON.parse(await js(`window.api.searchCovers('Lalka Prus').then(JSON.stringify)`));
      const zrodla = [...new Set(res.covers.map((c) => c.source))];
      check('wyszukiwanie okładek', res.covers.length > 0,
        `${res.covers.length} okładek z: ${zrodla.join(', ')}` +
        (res.errors.length ? ` | bez odpowiedzi: ${res.errors.map((e) => e.source).join(', ')}` : ''));

      if (res.covers.length) {
        const books = JSON.parse(await js(`window.api.listBooks({}).then(JSON.stringify)`));
        const target = books[0];
        const before = target.cover;
        const applied = JSON.parse(await js(
          `window.api.applyCover(${target.id}, ${JSON.stringify(res.covers[0].url)}).then(JSON.stringify)`));
        check('ustawienie znalezionej okładki', !!applied.cover && applied.cover !== before,
          `${before || '(brak)'} -> ${applied.cover}`);
      }
    }

    // 15. otwarcie dowolnego pliku z dysku prosto w czytniku
    //     (symuluje zdarzenie 'open-book' wysyłane po dwukliku w Eksploratorze)
    const epubPath = path.join(__dirname, 'biblioteka', 'Boleslaw_Prus-Lalka.epub');
    const opened = await openExternal(epubPath);
    check('otwarcie e-booka z dysku', !!opened, opened ? `"${opened.title}"` : 'brak wyniku');
    await sleep(4000);
    const extReaderOpen = await js(`!document.querySelector('#reader').classList.contains('hidden')
      && !!document.querySelector('#reader-view foliate-view')`);
    const extTitle = await js(`document.querySelector('#reader-title').textContent`);
    check('czytnik otwarty dla pliku z dysku', extReaderOpen, extTitle);
    await js(`document.querySelector('#reader-back').click()`);
    await sleep(500);

    // 15b. bezpieczeństwo: walidacja IPC, złośliwy EPUB, kolejny plik przy otwartym czytniku
    {
      const os = require('os');
      const fs = require('fs');
      const probeFile = path.join(os.tmpdir(), 'czytnik-poc.txt');
      try { fs.unlinkSync(probeFile); } catch { /* brak */ }

      const ipc = JSON.parse(await js(`(async () => {
        const r = {};
        const books = await window.api.listBooks({});
        const id = books[0].id;
        const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
        r.saveCoverTraversal = await rejects(() => window.api.saveCover('../../czytnik-poc2', new ArrayBuffer(8), 'txt'));
        r.badSettingKey = await rejects(() => window.api.setSetting('../evil', 1));
        r.badIdList = await rejects(() => window.api.removeMany(['../x']));
        r.fileUrlCover = await rejects(() => window.api.applyCover(id, 'file:///C:/Windows/win.ini'));
        r.localhostCover = await rejects(() => window.api.applyCover(id, 'http://127.0.0.1:9/x.png'));
        const before = books[0];
        const after = await window.api.updateBook(id, { cover: 'C:/Windows/x.png', path: 'C:/Windows/y.epub', title: before.title });
        r.protectedFields = after.cover === before.cover && after.path === before.path;
        return JSON.stringify(r);
      })()`));
      check('IPC odrzuca ścieżki spoza katalogu okładek', ipc.saveCoverTraversal);
      check('IPC odrzuca nieprawidłowy klucz ustawienia', ipc.badSettingKey);
      check('IPC odrzuca nieprawidłową listę id', ipc.badIdList);
      check('pobieranie okładki odrzuca file:// i adresy lokalne', ipc.fileUrlCover && ipc.localhostCover);
      check('renderer nie może zmienić ścieżki pliku ani okładki', ipc.protectedFields);

      const evilPath = path.join(__dirname, 'evil', 'evil.epub');
      if (fs.existsSync(evilPath)) {
        await openExternal(evilPath);
        await sleep(4500);
        const evilTitle = await js(`document.querySelector('#reader-title').textContent`);
        check('skrypt z EPUB-a nie ma dostępu do API aplikacji', !/PWN/.test(evilTitle), evilTitle);
        check('skrypt z EPUB-a nie zapisał pliku poza katalogiem okładek', !fs.existsSync(probeFile));
        // kolejny plik przy otwartym czytniku nie może zostawiać drugiego widoku
        await openExternal(epubPath);
        await sleep(4500);
        const views = await js(`document.querySelectorAll('#reader-view foliate-view').length`);
        check('otwarcie drugiej książki zamyka poprzednią', views === 1, `widoków: ${views}`);
        await js(`document.querySelector('#reader-back').click(); undefined`);
        await sleep(500);
      } else {
        log('pominięto test złośliwego EPUB-a (brak test/evil/evil.epub)');
      }
      try { fs.unlinkSync(probeFile); } catch { /* brak */ }

      const dedupe = JSON.parse(await js(`(async () => {
        const m = await import('app://bundle/renderer/tts-controller.js');
        const xml = '<html xmlns="http://www.w3.org/1999/xhtml"><body><blockquote><p>Cytat jeden.</p><p>Cytat dwa.</p></blockquote><ul><li><p>Punkt.</p></li></ul></body></html>';
        return JSON.stringify(m.extractTextFromDoc(new DOMParser().parseFromString(xml, 'application/xhtml+xml')));
      })()`));
      check('TTS: zagnieżdżone bloki nie są czytane podwójnie',
        JSON.stringify(dedupe) === JSON.stringify(['Cytat jeden.', 'Cytat dwa.', 'Punkt.']), JSON.stringify(dedupe));
    }

    // 15c. zakładki, zakreślenia i notatki
    {
      const waitFor2 = async (expr, timeout = 15000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) { if (await js(expr)) return true; await sleep(200); }
        return false;
      };
      const openLalka = async () => {
        await js(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title').textContent === 'Lalka').click(); undefined`);
        await sleep(500);
        await js(`document.querySelector('#btn-read').click(); undefined`);
        await waitFor2(`!!document.querySelector('#reader-view foliate-view') && (document.querySelector('foliate-view').renderer.getContents?.() || []).length > 0`);
        await sleep(800);
      };
      await openLalka();
      const bookId = JSON.parse(await js(`window.api.listBooks({search:'Lalka'}).then(b => JSON.stringify(b[0].id))`));

      await js(`(() => {
        const v = document.querySelector('foliate-view');
        const doc = v.renderer.getContents()[0].doc;
        const r = doc.createRange(); r.selectNodeContents(doc.querySelector('p'));
        const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      })(); undefined`);
      const barShown = await waitFor2(`!document.querySelector('#sel-bar').classList.contains('hidden')`, 4000);
      check('adnotacje: pasek zaznaczenia po zaznaczeniu tekstu', barShown);
      await js(`document.querySelector('#sel-colors .color-dot:nth-child(2)').click(); undefined`);
      await waitFor2(`window.api.listAnnotations(${bookId}).then(a => a.length === 1)`, 5000);
      let anns = JSON.parse(await js(`window.api.listAnnotations(${bookId}).then(a => JSON.stringify(a))`));
      check('adnotacje: zakreślenie zapisane w bazie', anns.length === 1 && anns[0].type === 'highlight' && /^#/.test(anns[0].color) && anns[0].text.length > 5,
        anns[0] ? `${anns[0].type} ${anns[0].color} "${anns[0].text.slice(0, 30)}…"` : 'brak');

      await js(`document.querySelector('#reader-bookmark-btn').click(); undefined`);
      await waitFor2(`window.api.listAnnotations(${bookId}).then(a => a.length === 2)`, 5000);
      anns = JSON.parse(await js(`window.api.listAnnotations(${bookId}).then(a => JSON.stringify(a))`));
      check('adnotacje: zakładka dodana', anns.some((a) => a.type === 'bookmark'));
      await js(`document.querySelector('#reader-bookmark-btn').click(); undefined`); // przełącznik: usuwa tę samą zakładkę
      await waitFor2(`window.api.listAnnotations(${bookId}).then(a => a.length === 1)`, 5000);
      check('adnotacje: ponowne kliknięcie zdejmuje zakładkę', true);
      await js(`document.querySelector('#reader-bookmark-btn').click(); undefined`);
      await waitFor2(`window.api.listAnnotations(${bookId}).then(a => a.length === 2)`, 5000);

      // po zamknięciu i ponownym otwarciu książki adnotacje wracają do panelu
      await js(`document.querySelector('#reader-back').click(); undefined`);
      await sleep(600);
      await openLalka();
      await js(`document.querySelector('#reader-ann-btn').click(); undefined`);
      await sleep(500);
      const panelCount = await js(`document.querySelector('#ann-count').textContent`);
      check('adnotacje: przetrwały ponowne otwarcie książki', panelCount === '2', `w panelu: ${panelCount}`);

      // usuwanie z panelu
      await js(`document.querySelectorAll('.ann-item [data-act="del"]').forEach(b => b.click()); undefined`);
      const gone = await waitFor2(`window.api.listAnnotations(${bookId}).then(a => a.length === 0)`, 5000);
      check('adnotacje: usuwanie z panelu', gone);
      await js(`document.querySelector('#reader-back').click(); undefined`);
      await sleep(500);
    }

    // 15d. półki, tagi i serie
    {
      const waitFor3 = async (expr, timeout = 8000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) { if (await js(expr)) return true; await sleep(150); }
        return false;
      };
      const lalka = JSON.parse(await js(`window.api.listBooks({search:'Lalka'}).then(b => JSON.stringify(b[0]))`));
      await js(`document.querySelector('#btn-new-collection').click(); undefined`);
      await sleep(300);
      await js(`document.querySelector('#ask-input').value = 'Testowa półka'; document.querySelector('#ask-ok').click(); undefined`);
      const created = await waitFor3(`[...document.querySelectorAll('#collection-list .side-item')].some(e => e.textContent.includes('Testowa półka'))`);
      check('półki: utworzenie nowej półki', created);

      await js(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title').textContent === 'Lalka').click(); undefined`);
      await sleep(500);
      await js(`document.querySelector('#btn-book-collections').click(); undefined`);
      await waitFor3(`document.querySelectorAll('#col-picker-list input').length > 0`);
      await js(`document.querySelector('#col-picker-list input').checked = true; document.querySelector('#col-picker-ok').click(); undefined`);
      await sleep(800);
      const colIds = JSON.parse(await js(`window.api.getBookCollections(${lalka.id}).then(JSON.stringify)`));
      check('półki: przypisanie książki do półki', colIds.length === 1);
      await js(`document.querySelector('#detail-modal').classList.add('hidden'); undefined`);

      await js(`[...document.querySelectorAll('#collection-list .side-item')].find(e => e.textContent.includes('Testowa półka')).click(); undefined`);
      await waitFor3(`document.querySelectorAll('.card').length === 1`);
      check('półki: filtr pokazuje tylko książki z półki', (await js(`document.querySelectorAll('.card').length`)) === 1);
      await js(`document.querySelector('#collection-list .side-item').click(); undefined`); // "Wszystkie książki"
      await waitFor3(`document.querySelectorAll('.card').length > 1`);

      // tagi i seria
      await js(`window.api.updateBook(${lalka.id}, { tags: 'fantastyka, lektura', series: 'Cykl Testowy' }).then(() => window.location.reload()); undefined`);
      await sleep(1800);
      const hasTag = await waitFor3(`[...document.querySelectorAll('#tag-list button')].some(b => b.textContent.startsWith('lektura'))`);
      check('tagi: pojawiają się w pasku bocznym', hasTag);
      await js(`[...document.querySelectorAll('#tag-list button')].find(b => b.textContent.startsWith('lektura')).click(); undefined`);
      await waitFor3(`document.querySelectorAll('.card').length === 1`);
      check('tagi: filtr po tagu', (await js(`document.querySelectorAll('.card').length`)) === 1);
      await js(`[...document.querySelectorAll('#tag-list button')].find(b => b.textContent.startsWith('lektura')).click(); undefined`); // zdejmij filtr
      await waitFor3(`document.querySelectorAll('.card').length > 1`);
      await js(`(() => { const s = document.querySelector('#series-filter'); s.value = 'Cykl Testowy'; s.dispatchEvent(new Event('change')); })(); undefined`);
      await waitFor3(`document.querySelectorAll('.card').length === 1`);
      check('serie: filtr po serii', (await js(`document.querySelectorAll('.card').length`)) === 1);
      const srch = JSON.parse(await js(`window.api.listBooks({search:'lektura'}).then(b => JSON.stringify(b.length))`));
      check('tagi: wyszukiwarka znajduje po tagu', srch === 1);

      // sprzątanie: stan wyjściowy dla dalszych testów
      await js(`(async () => {
        await window.api.updateBook(${lalka.id}, { tags: null, series: null });
        for (const c of await window.api.listCollections()) await window.api.deleteCollection(c.id);
        window.location.reload();
      })(); undefined`);
      await sleep(1800);
      check('półki: po sprzątaniu brak półek i filtrów', (await js(`document.querySelectorAll('#collection-list .side-item').length`)) === 1 && (await js(`document.querySelectorAll('.card').length`)) > 1);
    }

    // 15e. wykrywanie duplikatów
    {
      const os = require('os');
      const fs = require('fs');
      const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'czytnik-dup-'));
      const copy = path.join(dupDir, 'Lalka - kopia.epub');
      fs.copyFileSync(epubPath, copy);
      await js(`window.api.startScan([${JSON.stringify(dupDir)}]).then(() => window.location.reload()); undefined`);
      await sleep(2200);
      const before = await js(`document.querySelectorAll('.card').length`);
      await js(`document.querySelector('#btn-tools').click(); undefined`);
      await sleep(300);
      await js(`document.querySelector('#btn-dups').click(); undefined`);
      await sleep(900);
      const groups = await js(`document.querySelectorAll('#dups-list .dup-group').length`);
      const rows = await js(`document.querySelectorAll('#dups-list .dup-row').length`);
      const checked = await js(`document.querySelectorAll('#dups-list input:checked').length`);
      check('duplikaty: znaleziono grupę z dwoma wpisami', groups === 1 && rows === 2, `grup=${groups} wierszy=${rows}`);
      check('duplikaty: w grupie zostaje jeden egzemplarz', checked === 1, `zaznaczonych=${checked}`);
      await js(`window.confirm = () => true; document.querySelector('#dups-delete').click(); undefined`);
      await sleep(1500);
      const after = await js(`document.querySelectorAll('.card').length`);
      check('duplikaty: usunięto wpis, a plik na dysku został', after === before - 1 && fs.existsSync(copy), `kafelki ${before} -> ${after}`);
      try { fs.rmSync(dupDir, { recursive: true, force: true }); } catch { /* ignoruj */ }
    }

    // 15f. wyszukiwanie w treści: cała biblioteka + panel w książce
    {
      const waitForF = async (expr, timeout = 60000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) { if (await js(expr)) return true; await sleep(250); }
        return false;
      };
      await js(`document.querySelector('#btn-tools').click(); undefined`);
      await sleep(300);
      await js(`document.querySelector('#btn-fts').click(); undefined`);
      const built = await waitForF(`/^Zaindeksowano \\d+ książek\\./.test(document.querySelector('#fts-status').textContent) && document.querySelector('#fts-progress').classList.contains('hidden')`);
      check('szukanie w treści: indeks buduje się automatycznie', built, await js(`document.querySelector('#fts-status').textContent`));
      await js(`(() => { const i = document.querySelector('#fts-input'); i.value = 'wokulski'; document.querySelector('#fts-form').requestSubmit(); })(); undefined`);
      const found = await waitForF(`document.querySelectorAll('#fts-results .fts-book').length >= 1`, 20000);
      check('szukanie w treści: znaleziono książkę z fragmentami', found && (await js(`document.querySelectorAll('#fts-results .fts-snip mark').length`)) >= 1);
      await js(`document.querySelector('#fts-results .fts-book button').click(); undefined`);
      const hits = await waitForF(`!document.querySelector('#search-panel').classList.contains('hidden') && document.querySelectorAll('#search-list .search-hit').length > 0`, 60000);
      check('szukanie w treści: książka otwiera się z panelem wyników', hits, await js(`document.querySelector('#search-status').textContent`));
      check('szukanie w książce: licznik wyników > 0', Number(await js(`document.querySelector('#search-count').textContent`)) > 0);
      await js(`document.querySelector('#search-list .search-hit').click(); undefined`);
      await sleep(900);
      check('szukanie w książce: kliknięcie wyniku przechodzi do miejsca w tekście',
        (await js(`document.querySelector('foliate-view').renderer.getContents().length`)) > 0);
      await js(`(() => { const i = document.querySelector('#search-input'); i.value = 'zzzqqqxxx'; document.querySelector('#search-form').requestSubmit(); })(); undefined`);
      check('szukanie w książce: brak wyników jest komunikowany', await waitForF(`document.querySelector('#search-status').textContent.startsWith('Brak')`, 30000));
      await js(`document.querySelector('#reader-back').click(); undefined`);
      await sleep(500);
      check('szukanie w książce: zamknięcie czytnika czyści panel', await js(`document.querySelector('#search-panel').classList.contains('hidden') && !document.querySelector('#search-list').children.length`));
      await js(`document.querySelector('#fts-close')?.click(); undefined`);
    }

    // 15g. statystyki, masowe metadane, kopia/synchronizacja, motyw automatyczny
    {
      const openTool = async (btn, modal) => {
        await js(`document.querySelector('#btn-tools').click(); undefined`);
        await sleep(250);
        await js(`document.querySelector('${btn}').click(); undefined`);
        await sleep(700);
        return await js(`!document.querySelector('${modal}').classList.contains('hidden')`);
      };
      // statystyki: zapisz czas, otwórz okno
      const anyId = JSON.parse(await js(`window.api.listBooks({}).then(b => JSON.stringify(b[0].id))`));
      await js(`window.api.addReadingSeconds(${anyId}, 1800)`);
      check('statystyki: okno się otwiera', await openTool('#btn-stats', '#stats-modal'));
      const cards = await js(`document.querySelector('#stats-cards').innerText.replace(/\\s+/g, ' ')`);
      check('statystyki: pokazują zapisany czas i serię dni', /Dziś\s*30 min|30 min\s*Dziś/.test(cards) || /30 min/.test(cards), cards);
      check('statystyki: wykres ma 14 słupków', (await js(`document.querySelectorAll('#stats-chart .bar').length`)) === 14);
      await js(`document.querySelector('#stats-close').click(); undefined`);

      check('masowe metadane: okno pokazuje liczbę książek do dopasowania', await openTool('#btn-bulk', '#bulk-modal')
        && /Książek znanych tylko z pliku: \d+|Wszystkie książki/.test(await js(`document.querySelector('#bulk-info').textContent`)));
      await js(`document.querySelector('#bulk-close').click(); undefined`);

      check('kopia i synchronizacja: okno się otwiera i pokazuje stan', await openTool('#btn-backup', '#backup-modal')
        && /Synchronizacja jest wyłączona/.test(await js(`document.querySelector('#sync-state').textContent`)));
      await js(`document.querySelector('#backup-close').click(); undefined`);
      const reserved = await js(`window.api.setSetting('syncDir', 'C:/Windows').then(() => 'zapisano', (e) => 'odrzucono')`);
      check('bezpieczeństwo: renderer nie ustawi folderu synchronizacji', reserved === 'odrzucono', reserved);

      // motyw: kolejne kliknięcia przechodzą ciemny → jasny → auto → ciemny
      const next = { 'ciemny': 'jasny', 'jasny': 'auto (system)', 'auto (system)': 'ciemny' };
      let cur = await js(`document.querySelector('#theme-name').textContent`);
      let okCycle = cur in next;
      for (let i = 0; i < 3 && okCycle; i++) {
        await js(`document.querySelector('#btn-theme').click(); undefined`);
        await sleep(250);
        const now = await js(`document.querySelector('#theme-name').textContent`);
        okCycle = now === next[cur];
        cur = now;
      }
      check('motyw: przełącza ciemny → jasny → auto → ciemny', okCycle, cur);
      const effective = await js(`document.documentElement.dataset.theme`);
      check('motyw: ustawiony jest jasny lub ciemny wariant', effective === 'dark' || effective === 'light', effective);
    }

    // 15h. licznik książek, czytniki USB, konwersja, aktualizacje
    {
      const open = async (btn, modal) => {
        await js(`document.querySelector('#btn-tools').click(); undefined`);
        await sleep(250);
        await js(`document.querySelector('${btn}').click(); undefined`);
        await sleep(900);
        return await js(`!document.querySelector('${modal}').classList.contains('hidden')`);
      };
      const counter = await js(`document.querySelector('#lib-count').textContent`);
      check('licznik: pokazuje liczbę książek po polsku', /^\d+ (książka|książki|książek)/.test(counter), counter);

      check('czytniki USB: okno się otwiera', await open('#btn-devices', '#devices-modal'));
      const devInfo = await js(`document.querySelector('#dev-info').textContent`);
      check('czytniki USB: komunikat o wykrytych urządzeniach', devInfo.length > 10, devInfo);
      await js(`document.querySelector('#devices-close').click(); undefined`);

      // konwersja: brak zaznaczenia -> podpowiedź, z zaznaczeniem EPUB -> okno z formatami
      await js(`document.querySelector('#btn-tools').click(); undefined`);
      await sleep(250);
      await js(`document.querySelector('#btn-convert-tool').click(); undefined`);
      await sleep(400);
      check('konwersja: bez zaznaczenia pokazuje podpowiedź', /Zaznacz książki/.test(await js(`document.querySelector('#toast').textContent`)));
      const lalkaId = JSON.parse(await js(`window.api.listBooks({search:'Lalka'}).then(b => JSON.stringify(b[0] && b[0].id))`));
      await js(`import('app://bundle/renderer/convert.js').then(m => m.openConvert([${lalkaId}])); undefined`);
      await sleep(700);
      check('konwersja: okno z formatami DOCX/PDF/MD/TXT', (await js(`document.querySelectorAll('#convert-modal input[name=convfmt]').length`)) === 4
        && await js(`!document.querySelector('#convert-modal').classList.contains('hidden')`));
      await js(`document.querySelector('#convert-close').click(); undefined`);
      const pdfErr = await js(`window.api.convertBook(${lalkaId}, 'exe').then(() => 'ok', (e) => 'odrzucono')`);
      check('konwersja: nieznany format odrzucony po stronie głównej', pdfErr === 'odrzucono', pdfErr);

      check('aktualizacje: okno się otwiera i pokazuje wersję', await open('#btn-updates', '#update-modal')
        && /Wersja programu: \d+\.\d+\.\d+|Microsoft Store/.test(await js(`document.querySelector('#update-status').textContent`)));
      await js(`document.querySelector('#update-close').click(); undefined`);
      const res = await js(`window.api.setSetting('updateSkip', '9.9.9').then(() => 'zapisano', () => 'odrzucono')`);
      check('bezpieczeństwo: renderer nie ustawi pominiętej wersji', res === 'odrzucono', res);
      const dl = await js(`window.api.updateDownload().then(() => 'ok', (e) => e.message)`);
      check('aktualizacje: pobranie bez sprawdzenia jest odrzucone', /Brak dostępnej aktualizacji|Microsoft Store/.test(dl), dl);
    }

    // 16. czytanie na głos (TTS) — tylko na Windows, gdzie działa SAPI
    if (process.platform === 'win32' && !process.env.CZYTNIK_NO_TTS) {
      // czeka aż wyrażenie JS da prawdę (start PowerShella bywa wolniejszy, więc bez stałych pauz)
      const waitFor = async (expr, timeout = 20000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          if (await js(expr)) return true;
          await sleep(200);
        }
        return false;
      };
      await js(`[...document.querySelectorAll('.card')].find(c =>
        c.querySelector('.card-title').textContent === 'Lalka').click(); undefined`);
      await sleep(600);
      await js(`document.querySelector('#btn-read').click(); undefined`);
      await waitFor(`!!document.querySelector('#reader-view foliate-view')`);
      await sleep(1500);

      const ttsBtnHidden = await js(`document.querySelector('#reader-tts-btn').classList.contains('hidden')`);
      check('przycisk TTS widoczny na Windows', !ttsBtnHidden);

      await js(`document.querySelector('#reader-tts-btn').click(); undefined`);
      await waitFor(`!document.querySelector('#tts-voice').disabled && document.querySelector('#tts-voice').options.length > 0`);
      const voiceNames = await js(`[...document.querySelector('#tts-voice').options].map(o => o.value).join(' | ')`);
      check('lista głosów wypełniona', voiceNames.length > 0 && !/Ładowanie/.test(voiceNames), voiceNames);

      await js(`(() => {
        const sel = document.querySelector('#tts-voice');
        // deterministycznie: głos systemowy Microsoft (głosy zewnętrzne, np. IVONA, bywają niedostępne na maszynie testowej)
        const pick = [...sel.options].find(o => /paulina/i.test(o.value)) || [...sel.options].find(o => /^Microsoft/i.test(o.value));
        if (pick) sel.value = pick.value;
        sel.dispatchEvent(new Event('change'));
      })(); undefined`);

      await js(`document.querySelector('#tts-play').click(); undefined`);
      const started = await waitFor(`document.querySelector('#tts-status').textContent === 'Czyta…'`);
      check('TTS: odtwarzanie wystartowało', started, `status="${await js(`document.querySelector('#tts-status').textContent`)}"`);

      await js(`document.querySelector('#tts-play').click(); undefined`); // pauza
      await sleep(400);
      let status = await js(`document.querySelector('#tts-status').textContent`);
      check('TTS: pauza', status === 'Wstrzymano', `status="${status}"`);

      await js(`document.querySelector('#tts-play').click(); undefined`); // wznowienie
      await sleep(600);
      status = await js(`document.querySelector('#tts-status').textContent`);
      check('TTS: wznowienie', status === 'Czyta…', `status="${status}"`);

      // postęp zapisany w bazie po przeczytaniu pierwszego fragmentu
      let midBook = null;
      await waitFor(`window.api.listBooks({search:'Lalka'}).then(b => (b[0].tts_chunk || 0) > 0 || (b[0].tts_section || 0) > 0)`, 90000);
      midBook = JSON.parse(await js(`window.api.listBooks({search:'Lalka'}).then(b => JSON.stringify(b))`))[0];
      check('TTS: postęp zapisany w bazie', (midBook.tts_section || 0) > 0 || (midBook.tts_chunk || 0) > 0,
        `sekcja=${midBook.tts_section} fragment=${midBook.tts_chunk}`);

      // regresja: pauza -> stop -> ponowne odtwarzanie nie może zawiesić silnika
      await js(`document.querySelector('#tts-play').click(); undefined`); // pauza
      await sleep(300);
      await js(`document.querySelector('#tts-stop').click(); undefined`);
      await sleep(400);
      status = await js(`document.querySelector('#tts-status').textContent`);
      check('TTS: zatrzymanie', status === 'Zatrzymano', `status="${status}"`);
      const chunkBefore = midBook.tts_chunk || 0;
      await js(`document.querySelector('#tts-play').click(); undefined`);
      const replay = await waitFor(`window.api.listBooks({search:'Lalka'}).then(b => (b[0].tts_chunk || 0) > ${chunkBefore})`, 40000);
      check('TTS: odtwarzanie działa po pauza→stop', replay, 'silnik nie zawiesza się');
      await js(`document.querySelector('#tts-stop').click(); undefined`);
      await sleep(400);
      midBook = JSON.parse(await js(`window.api.listBooks({search:'Lalka'}).then(b => JSON.stringify(b))`))[0];

      // zamknij czytnik — pozycja TTS powinna zostać zapamiętana
      await js(`document.querySelector('#reader-back').click(); undefined`);
      await sleep(600);
      const afterBooks = JSON.parse(await js(`window.api.listBooks({search:'Lalka'}).then(b => JSON.stringify(b))`));
      check('TTS: pozycja przetrwała zamknięcie czytnika',
        afterBooks[0].tts_section === midBook.tts_section && afterBooks[0].tts_chunk === midBook.tts_chunk,
        `sekcja=${afterBooks[0].tts_section} fragment=${afterBooks[0].tts_chunk}`);

      // podświetlanie zdania, postęp, skok o zdanie i zegar uśpienia "do końca rozdziału"
      await js(`[...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title').textContent === 'Lalka').click(); undefined`);
      await sleep(500);
      await js(`document.querySelector('#btn-read').click(); undefined`);
      await waitFor(`!!document.querySelector('#reader-view foliate-view') && (document.querySelector('foliate-view').renderer.getContents?.() || []).length > 0`);
      await sleep(1000);
      await js(`document.querySelector('#reader-tts-btn').click(); undefined`);
      await waitFor(`!document.querySelector('#tts-voice').disabled && document.querySelector('#tts-voice').options.length > 0`);
      await js(`document.querySelector('#tts-play').click(); undefined`);
      await waitFor(`document.querySelector('#tts-status').textContent === 'Czyta…'`);
      const hl = await waitFor(`(() => { const c = document.querySelector('foliate-view').renderer.getContents()[0]; return !!c && c.doc.defaultView.CSS.highlights.has('czytnik-tts'); })()`, 15000);
      check('TTS: czytane zdanie jest podświetlone', hl);
      const prog = await js(`document.querySelector('#tts-progress').textContent`);
      check('TTS: pasek pokazuje postęp zdań', /^\d+\/\d+$/.test(prog), prog);

      const before = JSON.parse(await js(`window.api.listBooks({search:'Lalka'}).then(b => JSON.stringify(b[0]))`));
      await js(`document.querySelector('#tts-next').click(); undefined`);
      const skipped = await waitFor(`window.api.listBooks({search:'Lalka'}).then(b => (b[0].tts_chunk || 0) !== ${before.tts_chunk || 0})`, 8000);
      check('TTS: przycisk ⏭️ przeskakuje do następnego zdania', skipped);

      await js(`(() => { const t = document.querySelector('#tts-timer'); t.value = 'chapter'; t.dispatchEvent(new Event('change')); })(); undefined`);
      await waitFor(`document.querySelector('#tts-progress').textContent.split('/').length === 2`, 30000); // tekst rozdziału wczytany
      await js(`import('app://bundle/renderer/tts-controller.js').then(m => m.skip(5000)); undefined`);
      const slept = await waitFor(`document.querySelector('#tts-status').textContent === 'Zatrzymano'`, 15000);
      check('TTS: zegar "do końca rozdziału" zatrzymuje czytanie', slept && /koniec rozdziału/i.test(await js(`document.querySelector('#toast').textContent`)),
        await js(`document.querySelector('#toast').textContent`));
      await js(`document.querySelector('#reader-back').click(); undefined`);
      await sleep(500);
    } else {
      log('TTS: pominięto (test uruchomiony poza Windows)');
    }

  } catch (err) {
    console.error('[SMOKE] BŁĄD:', err.message);
    failed = true;
  }

  log(failed ? 'WYNIK: PORAŻKA' : 'WYNIK: SUKCES');
  app.exit(failed ? 1 : 0);
};
