const path = require('path');
module.exports = async function checkTtsPdf(win, app) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('[TTSPDF]', ...a);
  let failed = false;
  const check = (name, ok, extra = '') => { log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed = true; };

  try {
    const libDir = path.join(__dirname, 'biblioteka').split(path.sep).join('\\\\');
    await js(`window.api.startScan(['${libDir}']).then(()=>1)`);
    await js(`window.location.reload(); undefined`);
    await sleep(1500);

    await js(`[...document.querySelectorAll('.card')].find(c =>
      c.querySelector('.format-badge').textContent === 'pdf').click(); undefined`);
    await sleep(600);
    await js(`document.querySelector('#btn-read').click(); undefined`);
    await sleep(5000);

    await js(`document.querySelector('#reader-tts-btn').click(); undefined`);
    await sleep(2500);
    const voiceCount = await js(`document.querySelector('#tts-voice').options.length`);
    check('glosy zaladowane dla PDF', voiceCount > 0, String(voiceCount));

    await js(`document.querySelector('#tts-play').click(); undefined`);
    await sleep(2500);
    const status1 = await js(`document.querySelector('#tts-status').textContent`);
    check('PDF TTS: rozpoczeto odtwarzanie', status1 === 'Czyta…' || status1 === 'Wczytuję tekst…', status1);

    await sleep(3000);
    const books = JSON.parse(await js(`window.api.listBooks({}).then(JSON.stringify)`));
    const pdfBook = books.find((b) => b.format === 'pdf');
    check('PDF TTS: postep zapisany', (pdfBook.tts_section || 0) > 0 || (pdfBook.tts_chunk || 0) > 0,
      `sekcja=${pdfBook.tts_section} fragment=${pdfBook.tts_chunk}`);

    await js(`document.querySelector('#tts-stop').click(); undefined`);
    await sleep(400);
  } catch (err) {
    log('BŁĄD:', err.message);
    failed = true;
  }
  log(failed ? 'WYNIK: PORAZKA' : 'WYNIK: SUKCES');
  app.exit(failed ? 1 : 0);
};
