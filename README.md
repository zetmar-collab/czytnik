# 📚 Czytnik

Aplikacja na Windows i Linux do zarządzania biblioteką e-booków i ich czytania.

[![Pobierz z Microsoft Store](https://img.shields.io/badge/Microsoft%20Store-Pobierz-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://apps.microsoft.com/store/detail/9N2JZZGJ1TJP?cid=DevShareMCLPCS)
[![Wydania](https://img.shields.io/github/v/release/zetmar-collab/czytnik?style=for-the-badge&label=Wydanie)](https://github.com/zetmar-collab/czytnik/releases/latest)

## Instalacja

**Windows — najprościej ze sklepu:**
[Czytnik Ebooków w Microsoft Store](https://apps.microsoft.com/store/detail/9N2JZZGJ1TJP?cid=DevShareMCLPCS) — aplikacja jest darmowa i aktualizuje się automatycznie.

Alternatywnie pobierz instalator `.exe` (Windows) albo `.AppImage` (Linux) z [ostatniego wydania](https://github.com/zetmar-collab/czytnik/releases/latest).

## Funkcje

- **Otwieranie dowolnego e-booka z dysku** — przycisk „Otwórz e-booka…" albo zwykły dwuklik na pliku w Eksploratorze (aplikacja rejestruje się jako program obsługujący EPUB, MOBI, AZW3 i PDF). Otwarta książka trafia do biblioteki, więc postęp czytania jest zapamiętywany.
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

## Budowanie

| Polecenie | Wynik |
|---|---|
| `npm run dist:win` | instalator NSIS — `dist/Czytnik-Instalator-<wersja>.exe` |
| `npm run dist:linux` | AppImage — `dist/Czytnik-<wersja>.AppImage` |
| `npm run dist:store` | pakiet MSIX do Microsoft Store — `dist/CzytnikEbookow-Store-<wersja>.msix` |
| `npm run assets` | regeneracja grafik kafelków MSIX z `build/icon.png` |

Gotowe paczki trafiają do `dist/`. Aby dodatkowo budować pakiet `.deb`, trzeba
uzupełnić w `package.json` pola `homepage` i `author.email` (wymagane przez
electron-builder), a następnie dodać `"deb"` do listy `build.linux.target`.

Pakiet MSIX jest celowo **niepodpisany** — podpisuje go Partner Center przy publikacji.
Dane sklepu (tożsamość pakietu, wydawca) siedzą w sekcji `build.appx` w `package.json`.

## Struktura

| Plik | Rola |
|---|---|
| `main.js` | proces główny Electrona, protokół `app://`, IPC |
| `src/db.js` | baza SQLite (sql.js), książki + ustawienia |
| `src/scanner.js` | skanowanie dysków |
| `src/epub-meta.js` | metadane i okładki z EPUB |
| `src/mobi-meta.js` | metadane i okładki z MOBI/AZW3 (EXTH) |
| `src/metadata.js` | Lubimyczytać / UpolujEbooka / Google Books |
| `src/cli.js` | wykrywanie pliku przekazanego w argumentach (dwuklik w Eksploratorze) |
| `renderer/` | interfejs: biblioteka (`app.js`) i czytnik (`reader.js`) |
| `test/` | generator przykładowych plików + test dymny |

Baza danych i okładki trafiają do katalogu danych aplikacji: `%APPDATA%/czytnik/` na Windows, `~/.config/czytnik/` na Linuksie.

## Testy

```
node test/make-samples.js   # tworzy przykładowy EPUB i PDF w test/biblioteka
node test/smoke.js          # test bazy, skanera i metadanych
```
