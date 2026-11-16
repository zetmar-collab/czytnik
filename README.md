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
- **Wyszukiwanie okładek** — osobna wyszukiwarka grafik przeszukująca jednocześnie Empik, Lubimyczytać, UpolujEbooka, Google Books, Open Library, Apple Books i grafikę Bing; wyniki można filtrować po źródle i ustawić okładkę jednym kliknięciem.
- **Czytanie na głos (Windows)** — wbudowany silnik mowy Windows (SAPI / System.Speech) czyta otwartą książkę na głos. Uwzględnia też głosy doinstalowane przez użytkownika (np. IVONA Jacek), pozwala wybrać głos i tempo mowy oraz zapamiętuje, w którym miejscu (rozdział/strona i zdanie) czytanie zostało przerwane — osobno dla każdej książki.
- **Zakładki, zakreślenia i notatki** — zaznacz fragment, wybierz kolor lub dodaj notatkę; zakładka pod Ctrl+B; panel 📑 z listą i eksportem do Markdown.
- **Szukanie w książce** (Ctrl+F) oraz **w treści całej biblioteki** (Narzędzia → „Szukaj w treści książek") — indeks lokalny dla EPUB/MOBI/AZW3, wyniki z fragmentami, otwarcie książki od razu na szukanej frazie. PDF-y nie są indeksowane.
- **Półki, tagi i serie** — własne półki z przypisywaniem pojedynczo lub hurtem, filtry w pasku bocznym.
- **Duplikaty** — wykrywanie tej samej książki (ISBN albo tytuł + autor); usuwa wyłącznie wpisy z biblioteki, nigdy plików.
- **Uzupełnianie metadanych hurtem** — dopasowuje książki znane tylko z pliku i zapisuje wyłącznie pewne dopasowania; reszta trafia do raportu.
- **Statystyki czytania** — czas, seria dni, wykres 14 dni, najczęściej czytane (liczony tylko przy aktywnym czytaniu lub słuchaniu).
- **Kopia zapasowa i synchronizacja** — plik JSON z postępem, notatkami, półkami i statystykami oraz synchronizacja przez wspólny folder (OneDrive/Dropbox); książki są rozpoznawane po ISBN albo tytule i autorze, więc mogą leżeć w różnych miejscach.
- **Lektor** — podświetlanie czytanego zdania, pasek postępu, przeskok o zdanie, zegar uśpienia (minuty lub „do końca rozdziału"), skróty Ctrl+Spacja / Ctrl+←/→ oraz klawisze multimedialne (tylko podczas czytania).
- **Czytniki i tablety przez USB** (Narzędzia → „Czytniki i tablety") — Kindle, Kobo / Tolino, PocketBook, Onyx Boox i inne urządzenia widoczne jako dysk. Wysyłanie pojedynczej książki, półki lub całej biblioteki, pobieranie nowych książek z urządzenia i synchronizacja dwustronna; półka odpowiada folderowi na urządzeniu. Niczego nie usuwa ani nie nadpisuje, sprawdza wolne miejsce i pomija formaty nieobsługiwane przez urządzenie (np. EPUB na Kindle). Tablety w trybie MTP (bez litery dysku) trzeba przełączyć na pamięć masową.
- **Konwersja EPUB / MOBI / AZW3** do DOCX, PDF, Markdown i TXT — pojedyncza książka albo wiele naraz. Pliki z DRM nie są obsługiwane; układ jest uproszczony (nagłówki, akapity, listy, pogrubienia; obrazy tylko w PDF).
- **Licznik książek** — w całej bibliotece oraz w wybranej półce / filtrze (z liczbą wszystkich), a przy każdej półce w pasku bocznym.
- **Aktualizacje z GitHuba** — Czytnik sprawdza wydania (raz na dobę, można wyłączyć) i **tylko informuje**; pobranie i instalację zatwierdza użytkownik. Instalator jest weryfikowany sumą SHA-512 z wydania. Wersja ze Sklepu Microsoft aktualizuje się przez sklep.
- **Automatyczna kopia metadanych** — co tydzień (ostatnie 10) plik JSON w folderze danych, oprócz ręcznej kopii i kopii bazy.
- **Motyw „auto"** — aplikacja i czytnik mogą podążać za jasnym/ciemnym trybem Windows.
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
| `src/covers.js` | wyszukiwanie okładek w 7 źródłach naraz |
| `src/tts.js`, `src/tts-engine.ps1` | czytanie na głos przez silnik mowy Windows (proces PowerShell sterowany JSON) |
| `renderer/tts-controller.js` | ekstrakcja tekstu z książki, kolejkowanie zdań, sterowanie odtwarzaniem |
| `src/validate.js` | walidacja danych z renderera (identyfikatory, ścieżki, adresy, obrazy) |
| `src/ipc-features.js` | IPC: adnotacje, półki, duplikaty, statystyki, indeks treści, kopia i synchronizacja |
| `src/fulltext.js` | indeks pełnotekstowy (skompresowane pliki obok bazy; sql.js nie ma FTS5) |
| `src/sync.js` | kopia zapasowa i synchronizacja folderu — wspólne scalanie danych po kluczu książki |
| `src/convert.js` | konwersja EPUB/MOBI do TXT, MD, DOCX (ręcznie składany OOXML) i PDF (printToPDF) |
| `src/devices.js` | wykrywanie czytników USB, wysyłanie / pobieranie / synchronizacja dwustronna |
| `src/updater.js` | sprawdzanie wydań na GitHubie, pobieranie z weryfikacją sumy SHA-512 |
| `src/ipc-tools.js` | IPC: konwersja, urządzenia, aktualizacje |
| `src/bulkmeta.js` | masowe dopasowanie metadanych z progiem pewności |
| `src/cli.js` | wykrywanie pliku przekazanego w argumentach (dwuklik w Eksploratorze) |
| `renderer/` | interfejs: biblioteka (`app.js`), czytnik (`reader.js`) oraz moduły: `annotations`, `collections`, `duplicates`, `booksearch`, `bulkmeta`, `backup`, `stats` |
| `test/` | generator przykładowych plików + test dymny |

Baza danych i okładki trafiają do katalogu danych aplikacji: `%APPDATA%/czytnik/` na Windows, `~/.config/czytnik/` na Linuksie.

## Testy

```
node test/make-samples.js   # tworzy przykładowy EPUB i PDF w test/biblioteka
node test/smoke.js          # test bazy, skanera i metadanych
node test/unit.js           # testy jednostkowe: walidacja, baza, indeks treści, synchronizacja
npm test                    # wszystko powyżej
```

Pełny test interfejsu (uruchamia prawdziwe okno Electrona, trwa kilka minut):

```
CZYTNIK_SMOKE=1 npx electron .
```
