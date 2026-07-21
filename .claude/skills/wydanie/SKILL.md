---
name: wydanie
description: Publikuje nową wersję aplikacji Czytnik — podbija wersję, uruchamia testy, taguje i wypycha na GitHub, gdzie GitHub Actions buduje instalator i tworzy release. Argument opcjonalny — nowy numer wersji (np. "1.1.0"); bez argumentu podbija wersję patch.
disable-model-invocation: true
---

# Wydanie nowej wersji Czytnika

Wykonaj po kolei. Przerwij i zgłoś problem, jeśli którykolwiek krok zawiedzie.

## Kroki

1. **Sprawdź stan repozytorium** — `git status`. Jeśli są niezacommitowane zmiany związane z funkcjami, zacommituj je najpierw (osobno od commita wydania). Upewnij się, że jesteś na gałęzi `main`.

2. **Ustal nowy numer wersji**:
   - Jeśli użytkownik podał wersję w argumencie — użyj jej.
   - Bez argumentu: podbij wersję patch (np. 1.0.0 → 1.0.1) względem `version` w `package.json`.

3. **Podbij wersję** w `package.json` (pole `version`).

4. **Testy lokalne** (szybkie, headless):
   ```
   node test/make-samples.js
   node test/smoke.js
   ```

5. **Pełny test UI** na wersji deweloperskiej:
   ```powershell
   $env:CZYTNIK_SMOKE = '1'; npx electron . 2>&1 | Select-String "SMOKE"
   ```
   Wszystkie pozycje muszą mieć PASS i wynik „SUKCES". Po teście usuń zmienną: `Remove-Item Env:CZYTNIK_SMOKE`.

6. **Commit i tag**:
   ```
   git add package.json
   git commit -m "Wydanie vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```

7. **GitHub Actions przejmuje resztę** — workflow `.github/workflows/release.yml` zbuduje instalator na maszynie Windows i opublikuje release z plikiem `Czytnik-Instalator-X.Y.Z.exe`. Obserwuj przebieg:
   ```
   gh run watch --repo zetmar-collab/czytnik --exit-status
   ```
   Po zakończeniu zweryfikuj release:
   ```
   gh release view vX.Y.Z --repo zetmar-collab/czytnik --json assets
   ```

8. **Podsumuj** użytkownikowi: numer wersji, link do release, rozmiar instalatora.

## Awaryjnie — budowanie lokalne

Jeśli GitHub Actions zawiedzie i nie da się szybko naprawić, zbuduj lokalnie i wgraj ręcznie:
```
npm run dist
gh release create vX.Y.Z "dist/Czytnik-Instalator-X.Y.Z.exe" --title "Czytnik X.Y.Z" --generate-notes
```
