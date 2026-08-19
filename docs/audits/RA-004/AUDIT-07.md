# RA-004 — Audit 07

## Metadata

- Task: `RA-004`
- Audytowany handoff: `docs/handoffs/RA-004/HANDOFF-07.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `PASS`

## Podsumowanie

Finding HIGH-01 z AUDIT-06 został usunięty. Reconciliation i recovery po
wygaśnięciu lease używają jednej klasyfikacji efektywnego stanu całego ledgeru
jobu. Rozstrzygnięcie pojedynczego intentu nie może już przedwcześnie otworzyć
całego jobu do replay ani oznaczyć go jako zakończony przy pozostałych
nierozstrzygniętych intentach.

Nie pozostały findingi klasy BLOCKER, HIGH ani MEDIUM.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Pełny PostgreSQL gate oraz istniejące fault-injection tests przechodzą. |
| 2. Crash po intent nie replayuje write | PASS | Success + missing, następnie `ABSENT`, pozostaje `RECONCILING`; brak claimu i tokenu 2. |
| 3. Wygasły worker nie zapisze po takeover | PASS | Lease/fencing regressions przechodzą; reconciliation nie omija mechanizmu claim. |
| 4. Per-case serialization | PASS | Testy dwóch workerów i ograniczeń serialization przechodzą. |
| 5. Bounded backoff i DLQ | PASS | Retry/DLQ regressions przechodzą w pełnym gate. |
| 6. Reconciliation idempotentne i audytowalne | PASS | Dwa missing: pierwszy `CONFIRMED` pozostawia `RECONCILING`, drugi daje `SUCCEEDED`; exact replay i single-intent paths są zachowane; konflikty definitywnych outcome failują zamknięcie. |

## Weryfikacja poprawki AUDIT-06

- `classifyIntentLedger` agreguje wszystkie intenty danego `job_id` i nadaje
  terminalnemu `CONFIRMED`/`ABSENT` pierwszeństwo nad missing, `AMBIGUOUS` i
  wcześniejszym `UNRESOLVED`.
- `SUCCEEDED` jest możliwe tylko dla all-effective-success.
- `PENDING` jest możliwe tylko przy braku sukcesu i pełnym effective
  absent/failed; stan pustego ledgeru pozostaje bezpiecznie requeueowalny.
- Mieszanka success+absence oraz każdy unresolved pozostaje `RECONCILING`.
- `reconcile` wykonuje append terminalnego wpisu, klasyfikację i zmianę statusu
  w jednej transakcji, pod tym samym advisory lockiem co claim/reap.
- Definitywnie sprzeczne pary `FAILED` + `CONFIRMED` oraz `SUCCEEDED` + `ABSENT`
  rzucają `ReconciliationConflictError` przed appendem; append-only completion
  nie jest modyfikowane ani cicho ignorowane.
- Reconciliation `CONFIRMED` nie tworzy syntetycznego completion; źródłem
  rozstrzygnięcia pozostaje append-only `job_reconciliations`.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm --filter @remoteagent/database exec vitest run test/queue-adversarial.integration.test.ts test/queue.integration.test.ts -t 'AUDIT-06 HIGH-01\|reconciliation is idempotent and auditable\|MEDIUM-06'` | 0 | 2 pliki; 7/7 wybranych testów PASS. |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 0 | lint, format, typecheck, test, build i workflow validate PASS; 19 plików, 380/380 testów; build 20/20. |
| Inspekcja `classifyIntentLedger`, `reconcile`, `reapExpired`, migracji i callerów | read-only | Granice transakcji, terminal uniqueness, precedence i status matrix są spójne. |

Środowisko zgłasza istniejące ostrzeżenie engine (repo deklaruje Node 24.19.0,
uruchomiono Node 25.2.1) oraz ostrzeżenia migracyjne ESLint boundaries; nie było
błędów i nie wpływa to na werdykt RA-004.

## Zakres i bezpieczeństwo

- Nie stwierdzono zmiany kontraktu poza zakresem RA-004 ani nowej migracji.
- JSON evidence pozostaje parametryzowanym JSONB; brak sekretów w fixture/logach.
- Status całego jobu wynika deterministycznie z durable ledgeru, nie z decyzji
  modelu ani pojedynczej odpowiedzi operatora.
- Potwierdzony side effect w częściowym ledgerze nie może wrócić do
  automatycznego replay.

## Uzasadnienie werdyktu

Wszystkie kryteria akceptacji RA-004 mają niezależny dowód w kodzie i testach,
a regresja wskazana w AUDIT-06 jest pokryta dokładnymi scenariuszami pozytywnymi,
negatywnymi i idempotencyjnymi. Brak nierozstrzygniętych findingów BLOCKER, HIGH
lub MEDIUM, dlatego werdykt to `PASS`.

