# 📚 Czytnik

Aplikacja na Windows do zarządzania biblioteką e-booków i ich czytania.

## Funkcje

- **Skanowanie dysków** — wyszukuje pliki `EPUB`, `MOBI`, `AZW3` i `PDF` na wybranych dyskach lub w folderach (foldery systemowe są pomijane) i dodaje je do bazy danych SQLite.
- **Metadane z plików** — tytuł, autor, opis, wydawca, rok, ISBN oraz okładka wyciągane automatycznie z EPUB i MOBI/AZW3.
- **Metadane z internetu** — pobieranie danych książki (opis, okładka, ocena, ISBN) z:
  - Lubimyczytać.pl
  - UpolujEbooka.pl
  - Google Books
- **Edycja ręczna** — gdy danych nie ma w serwisach, wszystkie pola można uzupełnić samodzielnie; można też wskazać własny plik okładki.
- **Czytnik** wszystkich czterech formatów (oparty o foliate-js + pdf.js):
  - wybór czcionki i rozmiaru czcionki,
  - tryb stron / przewijania,
  - motyw jasny i ciemny — osobno dla aplikacji i osobno dla otwartej książki (PDF w trybie ciemnym jest odwracany),
  - spis treści, pasek postępu, zapamiętywanie miejsca czytania,
  - powiększenie dla PDF.
- **Biblioteka** — wyszukiwarka, filtry formatu, sortowanie, pasek postępu czytania na okładkach.

## Uruchamianie

```
npm install
npm start
```

## Struktura

| Plik | Rola |
|---|---|
| `main.js` | proces główny Electrona, protokół `app://`, IPC |
| `src/db.js` | baza SQLite (sql.js), książki + ustawienia |
| `src/scanner.js` | skanowanie dysków |
| `src/epub-meta.js` | metadane i okładki z EPUB |
| `src/mobi-meta.js` | metadane i okładki z MOBI/AZW3 (EXTH) |
| `src/metadata.js` | Lubimyczytać / UpolujEbooka / Google Books |
| `renderer/` | interfejs: biblioteka (`app.js`) i czytnik (`reader.js`) |
| `test/` | generator przykładowych plików + test dymny |

Baza danych i okładki trafiają do `%APPDATA%/czytnik/`.

## Testy

```
node test/make-samples.js   # tworzy przykładowy EPUB i PDF w test/biblioteka
node test/smoke.js          # test bazy, skanera i metadanych
```
