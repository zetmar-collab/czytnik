// Test dymny bez Electrona: baza + ekstrakcja metadanych + skaner.
const fs = require('fs');
const path = require('path');
const os = require('os');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'czytnik-test-'));
  const db = require('../src/db');
  await db.open(tmp);

  const scanner = require('../src/scanner');
  const coversDir = path.join(tmp, 'covers');
  const libDir = path.join(__dirname, 'biblioteka');

  const result = await scanner.scan([libDir], coversDir, () => {});
  console.log('Wynik skanowania:', result);

  const books = db.listBooks({});
  for (const b of books) {
    console.log(`- [${b.format}] "${b.title}" — ${b.author || 'brak autora'} | wyd. ${b.publisher || '—'} ${b.year || ''} | ISBN ${b.isbn || '—'} | okładka: ${b.cover ? 'TAK' : 'nie'}`);
  }

  // edycja ręczna
  db.updateBook(books[0].id, { title: 'Zmieniony tytuł', meta_source: 'reczne' });
  const edited = db.getBook(books[0].id);
  console.log('Po edycji:', edited.title, '/', edited.meta_source);

  // wyszukiwanie
  const found = db.listBooks({ search: 'test' });
  console.log('Wyszukiwanie "test":', found.length, 'wyników');

  // import pojedynczych plików
  db.clearBooks();
  const files = fs.readdirSync(libDir).map((f) => path.join(libDir, f));
  const imported = await scanner.importFiles([...files, path.join(libDir, 'nieistnieje.txt')], coversDir);
  console.log('Import plików:', imported);
  if (imported.added !== files.length) throw new Error('importFiles: zła liczba dodanych');

  db.persist();
  console.log('OK — test dymny zaliczony');
}

main().catch((e) => { console.error(e); process.exit(1); });
