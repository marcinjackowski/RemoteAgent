# RA-001 — Audit 06

## Metadata

- Task: `RA-001`
- Audytowany handoff: `docs/handoffs/RA-001/HANDOFF-06.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-18
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Finding z AUDIT-05 został zamknięty: taskowe katalogi artefaktów mają zamknięty
kontrakt, więc malformed prefix/sufiks/rozszerzenie i pliki pomocnicze są teraz
twardym błędem. Commit `c53e349` przechodzi clean-archive gate na dokładnym Node
`24.19.0` i pnpm `10.26.1` z 48/48 testami oraz 20/20 buildami bez cache.
Pełniejsza macierz przejść ujawniła jednak trzy nadal otwarte obszary
deklarowanego zakresu validatora: brak związania statusu z kolejnością
handoff/audit, brak egzekwowania ukończenia zależności oraz fail-open parser
wierszy/kolejności kolejki.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, Master Plan, RA-001, protokół workflow,
  checklist audytora, AUDIT-01…05 oraz HANDOFF-06.
- Sprawdzony diff/commity: `975b70c..c53e349`, commit poprawki `f8c9361` i
  follow-up docs `c53e349`.
- Uruchomione kontrole: 46 testów validatora, niezależna macierz dziesięciu
  adwersarialnych stanów, clean `git archive HEAD`, frozen install i pełny gate
  na Node `24.19.0`, skan 139 blobów/nazw, Docker Compose i Git integrity.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Clean checkout instaluje się jednym poleceniem | PASS | `git archive c53e349`; Node `v24.19.0`, pnpm `10.26.1`; frozen install exit 0. |
| 2. Root lint/typecheck/test/build są deterministyczne | PASS | Clean archive `pnpm run check` exit 0; 48/48 testów, 20/20 typecheck i build, 0 cache. |
| 3. Wszystkie app/package manifests są w workspace | PASS | 21 projektów pozostaje poprawnie wykrywanych. |
| 4. CI używa lockfile i nie wymaga sekretów | PASS | Dokładne wersje, frozen install i brak credential variables. |
| 5. Strict TS i dependency boundaries mają failing fixtures | PASS | Oba guardraile przechodzą w clean archive. |
| 6. Brak credentiali i danych lokalnych w Git | PASS | 139 blobów; 0 wzorców sekretów, 0 podejrzanych nazw i 0 tracked-ignored. |
| 7. Validator odrzuca niepoprawne statusy, zależności i przejścia | FAIL | Dziesięć fixture'ów nielegalnych stanów zwróciło `ok: true`, m.in. stale `PASS` po nowszym handoffie, aktywny task z niedokończoną zależnością i niedeterministyczna/malformed kolejka. |

## Findingi

### HIGH — Nowszy handoff może zostać zatwierdzony przez starszy `PASS`

- Lokalizacja: `scripts/workflow/validate.ts` — sprawdzanie
  `STATUS_TO_REQUIRED_VERDICT` używa najnowszego audytu, ale nie porównuje jego
  rewizji z najnowszym handoffem; `AWAITING_AUDIT` sprawdza tylko, czy istnieje
  jakikolwiek handoff.
- Dowód: `HANDOFF-01`, `AUDIT-01: PASS`, następnie `HANDOFF-02` przy statusie
  `AUDIT_PASSED` zwraca `{ ok: true, errors: [] }`. Również
  `AWAITING_AUDIT` z `HANDOFF-01` i nowszym `AUDIT-02: CHANGES_REQUIRED` oraz
  `CHANGES_REQUESTED` z nowszym `HANDOFF-02` i starym `AUDIT-01` przechodzą.
- Wpływ: nowa, niezaudytowana implementacja może odziedziczyć historyczny
  `PASS`, dostać `DONE` i odblokować następne taski. Jest to analogiczny
  fail-open do naprawionego malformed artefaktu, ale z poprawnie nazwanymi
  plikami.
- Wymagana zmiana: udokumentować i egzekwować causality rewizji dla wszystkich
  statusów artefaktowych, nie tylko `BLOCKED`. Co najmniej
  `AWAITING_AUDIT` wymaga najnowszego handoffu nowszego od audytu, a
  `CHANGES_REQUESTED`, `AUDIT_PASSED` i `DONE` wymagają audytu nie starszego niż
  najnowszy handoff. Dodać pozytywne i negatywne testy, w tym stale `PASS` po
  nowym handoffie i poprawny aktualny układ `HANDOFF-06`/`AUDIT-05` dla
  `AWAITING_AUDIT`.

### HIGH — Statusy robocze nie respektują zależności tasków

- Lokalizacja: `scripts/workflow/validate.ts` — po walidacji istnienia
  dependency ID i cyklu nie ma kontroli statusu zależności.
- Dowód: task z `Depends on: RA-002` jest akceptowany jako `READY` i
  `IN_PROGRESS`, gdy RA-002 ma `READY`. Odwrotnie,
  `BLOCKED_BY_DEPENDENCIES` jest akceptowany, gdy wszystkie zależności są
  `DONE`.
- Wpływ: `continue` może zacząć task przed dostarczeniem jego fundamentów lub
  pozostawić gotowy task permanentnie zablokowany; kolejka przestaje być
  deterministycznym źródłem prawdy dla agentów.
- Wymagana zmiana: po zbudowaniu mapy tasków egzekwować invariant zależności.
  Task z nierozstrzygniętą istniejącą zależnością nie może wejść w stan
  wykonywalny/terminalny; `BLOCKED_BY_DEPENDENCIES` wymaga co najmniej jednej
  zależności niebędącej `DONE`. Jawnie udokumentować zachowanie `BLOCKED`, które
  protokół dopuszcza jako blokadę z dowolnego stanu. Dodać macierz pozytywną i
  negatywną dla tasków bez zależności, z częścią i wszystkimi zależnościami
  `DONE`.

### MEDIUM — Malformed wiersze, zależności i numery kolejności są akceptowane lub pomijane

- Lokalizacja: `scripts/workflow/validate.ts` — `parseTaskIndex` ignoruje każdy
  wiersz, którego pierwsza komórka nie jest integerem, `extractTaskIds` wycina
  tylko pasujące substringi, a `validate` nie sprawdza dodatniości/unikalności
  `Order`.
- Dowód: osobne fixture'y z dwoma taskami o `Order=1`, z `Order=0`, z dependency
  `RA-02` oraz z wierszem `Order=one` (wiersz RA-001 został cicho usunięty)
  wszystkie zwracają `{ ok: true, errors: [] }`.
- Wpływ: remis łamie regułę deterministycznego wyboru pierwszego taska, malformed
  dependency znika z grafu, a cały task może wypaść z operacyjnej kolejki bez
  błędu.
- Wymagana zmiana: walidować sekcję `Queue` zamkniętą gramatyką. Każdy wiersz
  danych musi być parsowalny, `Order` musi być dodatni, unikalny i jednoznacznie
  porządkować taski (zalecane rosnące, ciągłe `1..N`), a komórka dependencies ma
  być `—` albo listą pełnych `RA-NNN` bez śmieci/duplikatów. Dodać wymienione
  fixture'y i zachować wykrywanie missing task file, unknown dependency i cyklu.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `git archive HEAD` do pustego katalogu | 0 | 139 plików z commita `c53e349`. |
| Exact runtime frozen install + `pnpm run check` w archiwum | 0 | Node `v24.19.0`, pnpm `10.26.1`; 48/48 testów, 20/20 buildów, 0 cache; workflow OK. |
| Macierz causality handoff/audit | 0 procesu | 3/3 niedozwolone stany zwróciły `ok: true`. |
| Macierz statusów zależności | 0 procesu | `READY` i `IN_PROGRESS` przed dependency `DONE` oraz stale `BLOCKED_BY_DEPENDENCIES` zwróciły `ok: true`. |
| Macierz parsera kolejki | 0 procesu | Duplicate/zero order, malformed dependency i dropped row zwróciły `ok: true`. |
| Skan tracked tree | 0 | 139 blobów; 0 content findings, 0 suspicious filenames, 0 tracked-ignored. |
| `docker compose config --quiet`; `git fsck --full` | 0 | Compose poprawny; repo integralne, branch `main`, brak remote. |

## Ryzyka przekrojowe

- Security/privacy: tracked tree jest czyste; findingi dotyczą integralności
  bramki sterującej pracą agentów.
- Idempotencja/recovery: clean build jest odtwarzalny, ale stale audit może
  błędnie uznać nową pracę za zakończoną po wznowieniu.
- Współbieżność: dependency gating jest warunkiem bezpiecznego uruchamiania
  niezależnych tasków; aktualnie może uruchomić pracę przed jej prerequisite.
- Observability: błędy powinny wskazywać linię, task, offending token/revision i
  oczekiwany invariant.
- Kompatybilność: bieżący indeks `1..26`, dependency cells i artefakty są
  kanoniczne; zaostrzenie nie wymaga migracji.

## Wymagane działania po `continue`

1. Dodać causality handoff/audit dla wszystkich statusów artefaktowych.
2. Dodać dwukierunkową kontrolę statusu zależności zgodną z algorytmem
   `continue`, z jawną regułą dla `BLOCKED`.
3. Zamknąć gramatykę wierszy Queue, Order i dependency cells oraz dodać wszystkie
   adwersarialne regresje z tego audytu.
4. Zachować testy malformed/duplicate artefaktów, verdict parsera i provenance
   `BLOCKED`; uruchomić pełny clean-archive gate na Node `24.19.0`.
5. Zapisać poprawkę, utworzyć `HANDOFF-07`, ustawić `AWAITING_AUDIT` i nie
   rozpoczynać RA-002.

## Uzasadnienie werdyktu

Poprzedni finding i reprodukowalność są zamknięte, ale dwa fail-open HIGH mogą
zaakceptować niezaudytowaną pracę albo uruchomić task bez prerequisite, a parser
kolejki ma finding MEDIUM. Zgodnie z `AGENTS.md` wyklucza to `PASS`, więc werdykt
to `CHANGES_REQUIRED`.
