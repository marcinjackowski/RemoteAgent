# RA-005 — Handoff 04

## Metadata

- Task: `RA-005`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: OpenCode Bedrock / IMPLEMENTER
- Data: 2026-08-19
- Poprzedni audyt: `docs/audits/RA-005/AUDIT-03.md` (`CHANGES_REQUIRED`, HIGH-05, MEDIUM-06)
- Stan: zmiany RA-005 oraz zachowany wcześniejszy stan RA-002–RA-004 pozostają w
  working tree (untracked, zgodnie z HANDOFF-02/03)

## Zakres

Wyłącznie remediacja dwóch findingów z AUDIT-03: HIGH-05 (równoległy retry tego
samego operation ID usuwa credential zwycięzcy) i MEDIUM-06 (stale case grant bez
targetu nadal selekcjonuje connection). Nie zmieniano zaakceptowanych kontraktów
ani migracji spoza RA-005. HIGH-05 wymaga trwałego, crash-safe pojedynczego
wykonawcy, dlatego dodano nową migrację `018`.

## HIGH-05 — durable lease + fencing + observer/takeover

Problem: `recordLifecycle`/status nie zapewniały claim ani fencingu dla jednego
wykonawcy operation ID. Dwa równoległe `refresh` z identycznym operation ID robiły
`acquire` (`acquireCalls=2`) i dochodziły do publish; przegrany CAS wykonywał
`#bestEffortRevoke(ref)` na WSPÓLNYM ref, usuwając credential opublikowany przez
zwycięzcę (`publishedRefStillExists=false`). Naruszało token-refresh race,
AGENTS.md §8 i run-safety.

Zmiana (`packages/policy/src/credential-refresh.ts`):

- Wprowadzono trwały lease z monotonicznym `fencingToken`. Przed jakimkolwiek
  `acquire`/publish `refresh` woła `store.claimLease(operationId, workerId, now,
  ttl)`. Zwrócony wynik jest jednym z: `acquired` (jesteśmy jedynym wykonawcą),
  `observer` (aktywny lease trzyma inny worker) lub `takeover` (poprzedni lease
  wygasł — przejmujemy z wyższym `fencingToken`).
- Tylko posiadacz aktualnego lease wykonuje `acquire`/`put`/publish; każdy write
  do vault i store niesie `fencingToken`, a store odrzuca zapis ze starym tokenem
  (`FencingTokenStaleError`). To gwarantuje dokładnie jeden `acquire`/write/publish
  na operation ID nawet przy crash-takeover.
- Ścieżka `observer` NIGDY nie robi `acquire`/write/revoke wspólnego ref —
  odczytuje i uzgadnia terminalny wynik zwycięzcy (poll na terminalny lifecycle),
  a następnie zwraca ten sam rezultat.
- Cleanup po przegranym CAS usuwa wyłącznie ref należący do przegrywającego
  intentu; dla TEGO SAMEGO operation ID `#bestEffortRevoke` jest pomijane, bo ref
  jest współdzielony i może należeć do zwycięzcy. Zamiast revoke przegrany wchodzi
  w ścieżkę observer i uzgadnia opublikowany wynik.
- Lease jest zwalniany/finalizowany dopiero po terminalnym statusie; przy crashu
  TTL pozwala na deterministyczny takeover z fencingiem, więc nie ma zakleszczenia.

Store (`InMemoryCredentialRefreshIntentStore` oraz repozytorium DB
`packages/database/src/repositories/credential-refresh-intent.ts`):

- Dodano `claimLease`/`renewLease`/`releaseLease` z atomową semantyką CAS na
  kolumnach lease. `assertFencingToken` odrzuca zapis lifecycle/status ze starym
  tokenem, egzekwując single-writer na granicy repozytorium (fail-closed przed
  probe/publish).
- Nowy błąd `FencingTokenStaleError` w policy oraz `packages/database/src/errors.ts`
  (eksport w `packages/database/src/index.ts`).

### Migracja 018

`packages/database/migrations/018_*.sql` dodaje do tabeli intentów kolumny lease:
`lease_owner`, `lease_fencing_token BIGINT`, `lease_expires_at`, wraz z indeksem
wspierającym atomowy claim/takeover po `operation_id`. `down` usuwa kolumny i
indeks. Migracja jest addytywna i nie narusza composite FK z 017. Zweryfikowano
`up/down/up` (PASS).

## MEDIUM-06 — odrzucenie stale grants przed wyborem connection

Problem: candidate filter wymagał samej obecności surowego grantu
(`grantsByConnection.has`) zanim policzył jego przecięcie z aktualnym
`selected.scopes`. Membership + stale repository grant przy pustym connection
scope i bez `requestedTarget` zwracał `conn-a` ze `scopes=[]` zamiast
`ScopeResolutionError` — brak fail-closed na granicy resolvera dla operacji
no-target/account-level.

Zmiana (`packages/policy/src/scope.ts`):

- Kandydaci są teraz budowani z NIEPUSTEGO przecięcia case grants ∩ configured
  scopes połączenia, a nie z samej obecności surowego grantu (`scope.ts:82-103`,
  `:120-142`). Połączenie z pustym przecięciem nie jest kandydatem.
- Gdy po zawężeniu nie ma żadnego kandydata z niepustym przecięciem — również bez
  `requestedTarget` — resolver failuje `ScopeResolutionError` PRZED wyborem
  connection (fail-closed no-target). Stale grant bez aktualnego exact scope nie
  może już wyselekcjonować credential-bearing connection.

## Decyzje i alternatywy

- Durable lease + fencing token zamiast in-process mutexu: mutex nie przeżywa
  crashu/multi-instance, a wymóg AUDIT-03 to crash recovery z jednym wykonawcą.
  Monotoniczny fencing token na trwałym store daje deterministyczny single-writer
  i bezpieczny takeover po TTL.
- Observer uzgadnia wynik zwycięzcy zamiast ponownego acquire: eliminuje drugi
  `acquire` i usunięcie wspólnego ref, zachowując idempotencję retry (AGENTS.md §8).
- Skip `#bestEffortRevoke` dla tego samego operation ID: revoke jest bezpieczny
  tylko dla ref należącego wyłącznie do przegrywającego intentu; dla wspólnego ref
  mógłby usunąć credential zwycięzcy.
- Nowa migracja 018 (kolumny lease) zamiast reużycia istniejących kolumn: lease i
  fencing to nowy stan trwały; addytywna migracja z `down` nie narusza 017.
- Candidate z niepustego przecięcia zamiast samej obecności grantu: egzekwuje
  fail-closed także no-target/account-level, zgodnie z AC2.

## Zmienione pliki

- `packages/policy/src/credential-refresh.ts` — durable lease claim, fencing,
  observer/takeover, brak revoke wspólnego ref, publish tylko przez posiadacza lease
- `packages/policy/src/scope.ts` — kandydaci z niepustego przecięcia grants ∩
  configured; fail-closed no-target
- `packages/database/src/repositories/credential-refresh-intent.ts` —
  `claimLease`/`renewLease`/`releaseLease`, `assertFencingToken`
- `packages/database/src/errors.ts` — `FencingTokenStaleError`
- `packages/database/src/index.ts` — eksport błędu
- `packages/database/migrations/018_*.sql` — kolumny lease + indeks (up/down)
- testy: `packages/policy/test/connection-security.test.ts`,
  `packages/policy/test/credential-refresh.test.ts`,
  `packages/database/test/case-scope-and-refresh.integration.test.ts`

## Testy dodane

- Unit + real-PostgreSQL concurrency: dokładnie dwa równoległe `refresh` tego
  samego operation ID — jeden `acquire`/write/publish, drugi jako observer;
  zachowany credential (`publishedRefStillExists=true`) i terminalny status zgodny
  z CAS.
- Fencing: zapis lifecycle/status ze starym tokenem → `FencingTokenStaleError`.
- Takeover: wygasły lease przejęty z wyższym fencing tokenem, brak podwójnego
  acquire.
- Stale-grant/no-target: membership + stale grant + puste przecięcie bez targetu
  → `ScopeResolutionError` przed wyborem connection.

## Test evidence

| Komenda | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS; 24 pliki / 447 testów; realny PostgreSQL |
| policy suite | 0 | 42 testy policy |
| database suite | 0 | 139 testów database (integration/concurrency) |
| build | 0 | 20/20 pakietów |
| migracja 018 `up`/`down`/`up` | 0 | PASS, bez rozjazdu schematu |
| `git diff --check` | 0 | brak błędów whitespace |

Engine warning bez zmian: repo pinuje Node `24.19.0`, uruchomiony `25.2.1`; pnpm
`10.26.1`. Istniejące ESLint boundaries warnings (spoza zakresu) bez błędu bramki.

## Ryzyka i ograniczenia

- Lease TTL musi być dłuższy niż realistyczny czas jednego refresh; zbyt krótki
  TTL może spowodować przedwczesny takeover. Wartość ustawiona konserwatywnie i
  konfigurowalna; fencing token zapewnia poprawność nawet przy błędnym TTL
  (stary writer jest odrzucany).
- AWS adapter nadal weryfikowany kontraktowo z mockiem klienta (bez live call).
- Local vault pozostaje test/dev only i traci stan po restarcie.

## Audit focus

- HIGH-05: dokładnie jeden `acquire`/write/publish na operation ID; observer nie
  robi acquire/write/revoke wspólnego ref; brak usunięcia credentiala zwycięzcy;
  crash-safe takeover z fencingiem; migracja 018 up/down/up; concurrency na
  realnym PG.
- MEDIUM-06: kandydaci wyłącznie z niepustego przecięcia grants ∩ configured;
  fail-closed przed wyborem connection również bez requested target.

## Otwarte pytania

- Brak. Decision Request nie jest wymagany.
