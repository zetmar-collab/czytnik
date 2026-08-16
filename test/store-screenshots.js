// Generuje zrzuty ekranu do listingu w Microsoft Store (1366x768 PNG).
// Uruchomienie: CZYTNIK_SHOTS=1 npx electron .
const path = require('path');
const fs = require('fs');

module.exports = async function makeShots(win, app) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const outDir = path.join(__dirname, '..', 'dist', 'store-screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;

  // capturePage bywa nieprzygotowany zaraz po przeładowaniu strony — ponawiamy
  const shot = async (name, expect) => {
    await sleep(1200);
    if (expect) {
      // upewnij się, że widok naprawdę jest w oczekiwanym stanie
      const readerOpen = await js(`!document.querySelector('#reader').classList.contains('hidden')`);
      const want = expect === 'reader';
      if (readerOpen !== want) {
        throw new Error(`zrzut "${name}": oczekiwano ${expect}, a czytnik jest ${readerOpen ? 'otwarty' : 'zamknięty'}`);
      }
    }
    // Okno bywa zasłonięte i Chromium wstrzymuje przemalowanie — wymuś je,
    // inaczej capturePage zwraca starą klatkę (np. czytnik zamiast biblioteki).
    const repaint = async () => {
      win.showInactive();
      win.setContentSize(1366, 769);
      await sleep(250);
      win.setContentSize(1366, 768);
      win.webContents.invalidate();
      await sleep(900);
    };

    let img = null, lastErr = null;
    for (let i = 0; i < 5; i++) {
      try {
        await repaint();
        img = await win.webContents.capturePage();
        if (img && !img.isEmpty()) break;
      } catch (e) {
        lastErr = e;
      }
      await sleep(1200);
    }
    if (!img || img.isEmpty()) throw new Error(`nie udało się zrobić zrzutu "${name}": ${lastErr?.message || 'pusty obraz'}`);
    const file = path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(`[SHOT] ${path.basename(file)}`);
  };

  try {
    win.setContentSize(1366, 768);
    await sleep(1200);

    // wypełnij bibliotekę przykładowymi książkami
    const libDir = (process.env.CZYTNIK_SHOTS_LIB || path.join(__dirname, 'biblioteka'))
      .replace(/\\/g, '\\\\');
    await js(`window.api.startScan(['${libDir}']).then(()=>1)`);
    await js(`window.location.reload(); undefined`);
    await sleep(2500);

    // dociągnij prawdziwy opis i ocenę dla książki pokazywanej w szczegółach
    try {
      const applied = await js(`(async () => {
        const books = await window.api.listBooks({ search: 'Lalka' });
        if (!books.length) return 'brak książki';
        const found = await window.api.searchMeta('lubimyczytac', 'Lalka Prus');
        // dokładnie powieść Prusa — nie streszczenia ani opracowania
        const match = found.find(c =>
          c.title.trim().toLowerCase() === 'lalka' &&
          (c.author || '').toLowerCase().includes('prus'));
        if (!match) return 'brak trafnego dopasowania: ' + found.map(c => c.title).join(' | ');
        await window.api.applyMeta(books[0].id, match);
        return 'dopasowano: ' + match.title + ' — ' + match.author;
      })()`);
      console.log('[SHOT] metadane online:', applied);
      await js(`window.location.reload(); undefined`);
      await sleep(2500);
    } catch (e) {
      console.log('[SHOT] metadane online pominięte:', e.message);
    }

    // 1. biblioteka — motyw ciemny
    await shot('biblioteka-ciemna', 'library');

    // zamyka czytnik i czeka, aż faktycznie zniknie (dla PDF-a bywa wolniejsze)
    const closeReader = async () => {
      for (let i = 0; i < 6; i++) {
        const hidden = await js(`(() => {
          const reader = document.querySelector('#reader');
          if (reader.classList.contains('hidden')) return true;
          document.querySelector('#reader-back').click();
          return false;
        })()`);
        if (hidden) return;
        await sleep(1200);
      }
      throw new Error('nie udało się zamknąć czytnika');
    };

    // 2. szczegóły książki
    const clickCard = async (needle) => {
      const ok = await js(`(() => {
        const card = [...document.querySelectorAll('.card')].find(c =>
          (c.querySelector('.card-title')?.textContent || '').includes(${JSON.stringify(needle)}));
        if (!card) return false;
        card.click();
        return true;
      })()`);
      if (!ok) throw new Error(`nie znaleziono kafelka: ${needle}`);
    };
    await clickCard('Lalka');
    await sleep(900);
    await shot('szczegoly-ksiazki', 'library');

    // 3. czytnik — motyw ciemny
    await js(`document.querySelector('#btn-read').click(); undefined`);
    await sleep(4000);
    await shot('czytnik-ciemny', 'reader');

    // 4. czytnik — motyw jasny + większa czcionka
    await js(`document.querySelector('#reader-theme').click();
              document.querySelector('#font-plus').click();
              document.querySelector('#font-plus').click(); undefined`);
    await sleep(1200);
    await shot('czytnik-jasny', 'reader');

    // 5. spis treści
    await js(`document.querySelector('#reader-toc-btn').click(); undefined`);
    await sleep(700);
    await shot('spis-tresci', 'reader');

    // 6. czytnik PDF
    await js(`document.querySelector('#reader-toc-btn').click(); undefined`);
    await sleep(500);
    await closeReader();
    await js(`[...document.querySelectorAll('.card')].find(c =>
      c.querySelector('.format-badge').textContent === 'pdf').click(); undefined`);
    await sleep(900);
    await js(`document.querySelector('#btn-read').click(); undefined`);
    await sleep(6000);
    // przejdź dalej, żeby zamiast samej okładki widać było pełną rozkładówkę
    await js(`document.querySelector('#page-next').click(); undefined`);
    await sleep(3000);
    await shot('czytnik-pdf', 'reader');

    // 7. biblioteka — motyw jasny
    await closeReader();
    await js(`document.querySelector('#btn-theme').click(); undefined`);
    await sleep(1200);
    await shot('biblioteka-jasna', 'library');

    console.log(`[SHOT] Gotowe: ${n} zrzutów w ${outDir}`);
  } catch (err) {
    console.error('[SHOT] BŁĄD:', err.message);
  }
  app.exit(0);
};
