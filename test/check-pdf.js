// Sprawdza, czy wskazany plik otwiera się w czytniku.
// Uruchomienie: CZYTNIK_CHECK="<ścieżka>" npx electron .
const path = require('path');
const fs = require('fs');

module.exports = async function checkFile(win, app) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const filePath = process.env.CZYTNIK_CHECK;
  let failed = false;

  try {
    const db = require('../src/db');
    const scanner = require('../src/scanner');
    const coversDir = path.join(app.getPath('userData'), 'covers');

    const res = await scanner.importFiles([filePath], coversDir);
    const book = db.getBookByPath(filePath);
    console.log(`[CHECK] import: dodano=${res.added} | tytuł="${book?.title}" | format=${book?.format}`);
    if (!book) throw new Error('nie udało się dodać pliku do bazy');

    win.webContents.send('open-book', book.id);
    await sleep(9000);

    const state = JSON.parse(await js(`JSON.stringify({
      readerOpen: !document.querySelector('#reader').classList.contains('hidden'),
      hasView: !!document.querySelector('#reader-view foliate-view'),
      title: document.querySelector('#reader-title').textContent,
      percent: document.querySelector('#reader-percent').textContent,
      zoomVisible: !document.querySelector('#zoom-tools').classList.contains('hidden'),
      canvases: document.querySelectorAll('#reader-view foliate-view').length
    })`));
    console.log('[CHECK] czytnik:', JSON.stringify(state));
    if (!state.readerOpen || !state.hasView) throw new Error('czytnik się nie otworzył');

    // przewiń kilka stron, żeby sprawdzić renderowanie kolejnych kartek
    for (let i = 0; i < 3; i++) {
      await js(`document.querySelector('#page-next').click(); undefined`);
      await sleep(2500);
    }
    const after = await js(`document.querySelector('#reader-percent').textContent`);
    console.log(`[CHECK] po przewinięciu 3 stron: ${after}`);

    const shotDir = path.join(__dirname, '..', 'dist');
    fs.mkdirSync(shotDir, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shotDir, 'podglad-pdf-uzytkownika.png'), img.toPNG());
    console.log('[CHECK] zapisano podgląd: dist/podglad-pdf-uzytkownika.png');
    console.log('[CHECK] WYNIK: OK');
  } catch (err) {
    console.error('[CHECK] BŁĄD:', err.message);
    failed = true;
  }
  app.exit(failed ? 1 : 0);
};
