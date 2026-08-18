# RA-001 — Audit 05

## Metadata

- Task: `RA-001`
- Audytowany handoff: `docs/handoffs/RA-001/HANDOFF-05.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-18
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Finding HIGH z AUDIT-04 został zamknięty dla nazw z numerycznym sufiksem:
`AUDIT-01`/`AUDIT-001` oraz analogiczny konflikt handoffów failują, `00` i
nadmiarowe zera są odrzucane, a `10` deterministycznie wygrywa z `09`. Commit
`975b70c` przechodzi pełny clean-archive gate na dokładnym Node `24.19.0` i pnpm
`10.26.1`: 43/43 testy i 20/20 buildów bez cache. Nie można jednak wydać `PASS`,
ponieważ skaner nadal cicho ignoruje nazwy artefaktopodobne, które nie pasują do
`^PREFIX-(\d+)\.md$`. W efekcie błędnie nazwany nowszy audyt może pozostawić
historyczny `PASS` jako obowiązujący i przepuścić `AUDIT_PASSED`.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, Master Plan, RA-001, protokół workflow,
  checklist audytora, AUDIT-01…04 oraz HANDOFF-05.
- Sprawdzony diff/commity: `0f9bb95..975b70c`, w szczególności commit poprawki
  `10b67d8` i follow-up docs `975b70c`.
- Uruchomione kontrole: 41 testów validatora, adwersarialne fixture'y nazw,
  clean `git archive HEAD`, frozen install i full gate na Node `24.19.0`, skan
  137 śledzonych blobów/nazw, Docker Compose i Git integrity.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Clean checkout instaluje się jednym poleceniem | PASS | `git archive 975b70c`; Node `v24.19.0`, pnpm `10.26.1`; frozen install exit 0. |
| 2. Root lint/typecheck/test/build są deterministyczne | PASS | Clean archive `pnpm run check` exit 0; 43/43 testy, 20/20 typecheck i build, 0 cache. |
| 3. Wszystkie app/package manifests są w workspace | PASS | 21 projektów pozostaje poprawnie wykrywanych. |
| 4. CI używa lockfile i nie wymaga sekretów | PASS | Przypięty obraz i pnpm, frozen install, brak credential variables. |
| 5. Strict TS i dependency boundaries mają failing fixtures | PASS | Oba guardraile przechodzą w clean archive. |
| 6. Brak credentiali i danych lokalnych w Git | PASS | Skan 137 blobów: 0 plików z wzorcami sekretów, 0 podejrzanych nazw, 0 tracked-ignored. |
| 7. Validator odrzuca niejednoznaczne artefakty i stany | FAIL | `AUDIT-01.md: PASS` plus artefaktopodobny `AUDIT-02-final.md: CHANGES_REQUIRED` przy `AUDIT_PASSED` zwraca `ok: true`; trzy dalsze malformed warianty również są ignorowane. |

## Findingi

### HIGH — Malformed artefakt jest ignorowany, więc historyczny werdykt może zostać uznany za najnowszy

- Lokalizacja: `scripts/workflow/validate.ts` (`scanArtifacts`, warunek
  `if (!m) continue`), brak wymaganego malformed fixture w
  `test/workflow/validate.test.ts`.
- Dowód: niezależny fixture z kanonicznym `AUDIT-01.md` zawierającym `PASS` oraz
  `AUDIT-02-final.md` zawierającym `CHANGES_REQUIRED`, przy statusie
  `AUDIT_PASSED`, zwrócił `{ ok: true, errors: [] }`. Tak samo zostały
  zaakceptowane warianty `AUDIT-final-02.md`, `AUDIT-02.txt` oraz
  `AUDITT-02.md`. Nowy zestaw testów obejmuje `00`, brak paddingu, duplikaty i
  `09/10`, ale nie zawiera wymaganego przez AUDIT-04 przypadku malformed prefix.
- Wpływ: literówka albo dodatkowy sufiks w najnowszym dokumencie audytora może
  zostać pominięty bez sygnału, a starszy `PASS` odblokuje zależne taski mimo
  późniejszego `CHANGES_REQUIRED`. Bramka ponownie failuje otwarcie w przypadku
  niepoprawnej nazwy spoza wąskiego regexu.
- Wymagana zmiana: taskowe katalogi `docs/audits/<TASK_ID>/` i
  `docs/handoffs/<TASK_ID>/` muszą mieć jawny, udokumentowany kontrakt dozwolonych
  wpisów. Plik lub katalog wyglądający jak artefakt, ale niepasujący dokładnie do
  kanonicznego `<PREFIX>-<REV>.md`, ma generować błąd zamiast `continue`; jeśli
  katalog dopuszcza pliki pomocnicze, wymagany jest zamknięty allowlist, nie
  ciche ignorowanie. Dodać testy co najmniej dla błędnego sufiksu/rozszerzenia,
  malformed prefix i przypadku ze starszym kanonicznym `PASS`, aby wykazać brak
  wyboru stale verdict. Zachować wszystkie testy duplikatów, verdict i
  provenance `BLOCKED`.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `git archive HEAD` do pustego katalogu | 0 | 137 plików z commita `975b70c`. |
| Exact runtime frozen install + `pnpm run check` w archiwum | 0 | Node `v24.19.0`, pnpm `10.26.1`; 43/43 testy, 20/20 buildów, 0 cache; workflow OK. |
| Fixture `AUDIT-01: PASS` + `AUDIT-02-final: CHANGES_REQUIRED` | 0 procesu | Validator błędnie zwrócił `ok: true`, bez errors. |
| Warianty `AUDIT-final-02`, `AUDIT-02.txt`, `AUDITT-02` | 0 procesu | Wszystkie błędnie zwróciły `ok: true`, bez errors. |
| Skan wzorców sekretów na tracked tree | 0 | 137 blobów; 0 content findings, 0 suspicious filenames, 0 tracked-ignored. |
| `docker compose config --quiet`; `git fsck --full` | 0 | Compose poprawny; repo integralne, branch `main`, brak remote. |

## Ryzyka przekrojowe

- Security/privacy: śledzone drzewo jest czyste; finding dotyczy logicznego
  obejścia bramki, nie credentiali.
- Idempotencja/recovery: install i build są odtwarzalne; interpretacja
  malformed artefaktu nie jest bezpiecznie recoverable, bo błąd pozostaje
  niewidoczny.
- Współbieżność i observability: bez zmian produktowych w zakresie RA-001;
  komunikat walidatora powinien wskazywać dokładną niedozwoloną nazwę.
- Kompatybilność: istniejące taskowe katalogi zawierają wyłącznie kanoniczne
  artefakty, więc zamknięcie kontraktu nie wymaga migracji.

## Wymagane działania po `continue`

1. Zastąpić ciche ignorowanie malformed wpisów w taskowych katalogach jawnie
   walidowanym kontraktem nazw/typów wpisów.
2. Dodać regresje dla malformed prefix, sufiksu i rozszerzenia, w tym wariant ze
   starszym kanonicznym `PASS` oraz nowszym błędnie nazwanym
   `CHANGES_REQUIRED`.
3. Zachować deterministyczne `09/10`, duplikaty liczbowe, parser verdict i
   provenance `BLOCKED`.
4. Uruchomić full clean-archive gate na Node `24.19.0`, skan tracked tree,
   zapisać poprawkę i utworzyć `HANDOFF-06` bez rozpoczynania RA-002.

## Uzasadnienie werdyktu

Główna niejednoznaczność numeryczna została naprawiona i fundament jest
reprodukowalny, ale nieukończony malformed case nadal pozwala cicho pominąć
nowszy dokument odrzucający. Jest to reprodukowalny finding HIGH w centralnej
bramce workflow, dlatego werdykt to `CHANGES_REQUIRED`.
