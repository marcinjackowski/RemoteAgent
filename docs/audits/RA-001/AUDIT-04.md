# RA-001 — Audit 04

## Metadata

- Task: `RA-001`
- Audytowany handoff: `docs/handoffs/RA-001/HANDOFF-04.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-18
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Finding z AUDIT-03 został funkcjonalnie zamknięty dla kanonicznie nazwanych
artefaktów: proceduralny Decision Request po wcześniejszym `CHANGES_REQUIRED`
jest legalny, a brak markera i konflikt z audytem failują zamknięcie. Commit
`0f9bb95` przechodzi clean-archive gate na Node `24.19.0` z 36/36 testami i
20/20 buildami bez cache. Pozostał jednak finding HIGH w samym fundamencie
rewizji: różne nazwy reprezentujące ten sam numer (`AUDIT-01.md` i
`AUDIT-001.md`) są akceptowane, a jeden z konfliktowych dokumentów jest wybierany
zależnie od kolejności `readdirSync`.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, Master Plan, RA-001, protokół workflow,
  checklist audytora, AUDIT-01/02/03 i HANDOFF-01/02/03/04.
- Sprawdzony diff/commity: `161bb31..0f9bb95`, commit implementacji `64ab1a7` i
  follow-up docs/status `0f9bb95`.
- Uruchomione kontrole: 34 testy validatora, niezależna macierz provenance,
  fixture'y duplikatów numerycznych, clean `git archive HEAD`, frozen install i
  full gate na Node `24.19.0`, skan 135 blobów, Docker Compose i Git integrity.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Clean checkout instaluje się jednym poleceniem | PASS | `git archive 0f9bb95`; Node `v24.19.0`, pnpm `10.26.1`; frozen install exit 0. |
| 2. Root lint/typecheck/test/build są deterministyczne | PASS | Clean archive `pnpm run check` exit 0; 36/36 testów, 20/20 buildów i typechecków, 0 cache. |
| 3. Wszystkie app/package manifests są w workspace | PASS | 21 projektów pozostaje widocznych. |
| 4. CI używa lockfile i nie wymaga sekretów | PASS | Bez regresji; wersje i frozen install przypięte. |
| 5. Strict TS i dependency boundaries mają failing fixtures | PASS | 2/2 guardraile zielone. |
| 6. Brak credentiali i danych lokalnych w Git | PASS | Skan 135 blobów: 0 content findings, 0 podejrzanych nazw, 0 tracked artefaktów lokalnych. |
| 7. Validator odrzuca niejednoznaczne artefakty i stany | FAIL | Konfliktowe `AUDIT-001: PASS` + `AUDIT-01: CHANGES_REQUIRED` dla `AUDIT_PASSED` zwraca `ok: true`; analogiczny duplikat handoffu również jest akceptowany. |

## Findingi

### HIGH — Niejednoznaczne numery rewizji pozwalają arbitralnie wybrać werdykt

- Lokalizacja: `scripts/workflow/validate.ts:142`,
  `scripts/workflow/validate.ts:155`, `scripts/workflow/validate.ts:164`,
  `scripts/workflow/validate.ts:175`; brak testów w
  `test/workflow/validate.test.ts`.
- Dowód: regex `^PREFIX-\d{2,}\.md$` dopuszcza jednocześnie `AUDIT-01.md` i
  `AUDIT-001.md`; `artifactRevision` mapuje oba do liczby `1`, a
  `latestArtifactPath` aktualizuje wynik tylko dla `>`, więc remis zachowuje
  pierwszy element zwrócony przez `readdirSync`. Fixture z `AUDIT-001.md`
  zawierającym `PASS` i `AUDIT-01.md` zawierającym `CHANGES_REQUIRED` został
  zaakceptowany przy statusie `AUDIT_PASSED` (`ok: true`). Fixture z
  `HANDOFF-001.md` zawierającym Decision Request i zwykłym `HANDOFF-01.md` także
  zwrócił `ok: true`. Osobny test potwierdził, że `10` poprawnie wygrywa z `09`.
- Wpływ: sprzeczny lub przypadkowo źle wyzerowany plik może sprawić, że odrzucona
  implementacja zostanie uznana za zaakceptowaną i odblokuje zależne taski.
  Wynik zależy od kolejności katalogu, więc ten sam commit może być interpretowany
  inaczej między filesystemami.
- Wymagana zmiana: zdefiniować i egzekwować jedną kanoniczną reprezentację każdej
  dodatniej rewizji (`01`…`09`, następnie `10`, `11`, …, `100`; bez `00` i bez
  nadmiarowych zer). Validator musi jawnie odrzucać pliki artefaktów z
  niekanoniczną nazwą oraz duplikaty tego samego numeru przed wyborem latest;
  nie może ich cicho ignorować. Wybór latest musi być deterministyczny i nie
  zależeć od `readdirSync`. Dodać testy konfliktowych `AUDIT-01`/`AUDIT-001` i
  `HANDOFF-01`/`HANDOFF-001`, rewizji `00`, malformed prefix oraz rzeczywistego
  porównania `09`/`10`.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run test/workflow/validate.test.ts` | 0 | 34/34 istniejące testy. |
| Macierz provenance `BLOCKED` | 0 | Legalny Decision Request po starym audycie przechodzi; brak markera, zły verdict i konflikty failują. |
| Adwersarialne duplikaty rewizji | 0 | `duplicate_numeric_audit_revision` i `duplicate_numeric_handoff_revision` zwróciły `ok: true` — finding potwierdzony. |
| Test `HANDOFF-10` kontra `AUDIT-09` | 0 | Rewizja `10` poprawnie uznana za nowszą. |
| `git archive HEAD` do pustego katalogu | 0 | 135 plików z commita `0f9bb95`. |
| Exact Node/pnpm frozen install + `pnpm run check` w archiwum | 0 | Node `v24.19.0`, pnpm `10.26.1`; 36/36 testów, 20/20 buildów, 0 cache; workflow OK. |
| Skan wzorców sekretów na `git ls-tree -r HEAD` | 0 | 135 blobów; 0 content findings i 0 suspicious filenames. |
| `docker compose config --quiet`; `git fsck --full` | 0 | Compose poprawny, repo integralne, brak remote. |

## Ryzyka przekrojowe

- Security/privacy: commit jest czysty, ale niejednoznaczna rewizja może obejść
  logiczną bramkę akceptacji.
- Idempotencja/recovery: kod i lockfile są odtwarzalne; interpretacja duplikatów
  rewizji nie jest obecnie deterministyczna między filesystemami.
- Współbieżność: bez zmian w tym zakresie.
- Observability: poza zakresem RA-001.
- Kompatybilność: wszystkie istniejące artefakty używają kanonicznych nazw
  dwucyfrowych, więc zaostrzenie walidacji nie wymaga migracji bieżącego repo.

## Wymagane działania po `continue`

1. Wprowadzić kanoniczny parser nazw/rewizji HANDOFF i AUDIT oraz jawne błędy dla
   niekanonicznych i zduplikowanych rewizji.
2. Uczynić wybór latest deterministycznym; zachować numeryczne `10 > 09`.
3. Dodać wszystkie fixture'y wskazane w findingu, nie osłabiając testów verdict i
   provenance `BLOCKED` z wcześniejszych audytów.
4. Uruchomić pełny gate na Node `24.19.0`, przeskanować staged/tracked content,
   zapisać poprawkę w lokalnym Git i sprawdzić clean archive finalnego commita.
5. Utworzyć `HANDOFF-05`, ustawić RA-001 na `AWAITING_AUDIT` i zatrzymać się bez
   rozpoczynania RA-002.

## Uzasadnienie werdyktu

Normalny przebieg i finding AUDIT-03 są naprawione, a projekt przechodzi pełną
bramkę na przypiętym runtime. Jednak konfliktowe nazwy tej samej rewizji mogą
przywrócić fail-open `AUDIT_PASSED` i odblokować zależności. Jest to
reprodukowalny finding HIGH w centralnej bramce workflow, dlatego zgodnie z
AGENTS.md werdykt to `CHANGES_REQUIRED`.
