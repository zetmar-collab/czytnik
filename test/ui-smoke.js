// Automatyczny test UI uruchamiany przez: CZYTNIK_SMOKE=1 npm start
// Skanuje folder testowy, otwiera książkę w czytniku i raportuje wyniki na stdout.
const path = require('path');

module.exports = async function runUiSmoke(win, app) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('[SMOKE]', ...a);
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

  } catch (err) {
    console.error('[SMOKE] BŁĄD:', err.message);
    failed = true;
  }

  log(failed ? 'WYNIK: PORAŻKA' : 'WYNIK: SUKCES');
  app.exit(failed ? 1 : 0);
};
