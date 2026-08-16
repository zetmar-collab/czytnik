// Wykrywanie pliku e-booka przekazanego w argumentach wiersza poleceń
// (dwuklik w Eksploratorze, „Otwórz za pomocą", skojarzenia plików).
const fs = require('fs');
const path = require('path');

const READABLE = ['.epub', '.mobi', '.azw3', '.pdf'];

function bookPathFromArgv(argv) {
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue;
    if (!READABLE.includes(path.extname(arg).toLowerCase())) continue;
    try {
      if (fs.statSync(arg).isFile()) return path.resolve(arg);
    } catch { /* nie istnieje albo nie jest plikiem */ }
  }
  return null;
}

module.exports = { READABLE, bookPathFromArgv };
