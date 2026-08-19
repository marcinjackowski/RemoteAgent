# RA-004 — Audit 06

## Metadata

- Task: `RA-004`
- Audytowany handoff: `docs/handoffs/RA-004/HANDOFF-06.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Recovery w `reapExpired` poprawnie rekonstruuje all-success i failuje zamknięcie
dla częściowych ledgerów; finding AUDIT-05 jest usunięty. Dalszy krok operatora
nie zachowuje jednak tej samej globalnej klasyfikacji. `reconcile` przełącza cały
job wyłącznie na podstawie jednego intentu: `ABSENT` zawsze ustawia `PENDING`, a
`CONFIRMED` zawsze `SUCCEEDED`. W częściowym multi-intent stanie operator może
więc ponownie otworzyć do replay job zawierający potwierdzony write albo zakończyć
job mimo innych nierozstrzygniętych intentów.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Pełny gate 376/376 przechodzi. |
| 2. Crash po intent nie replayuje write | FAIL | `reapExpired` jest bezpieczny, ale późniejsze `reconcile(ABSENT)` ponownie udostępnia częściowy job do replay; HIGH-01. |
| 3. Wygasły worker nie zapisze po takeover | PASS | Intent/completion fencing pozostaje skuteczne. |
| 4. Per-case serialization | PASS | Concurrency regressions przechodzą. |
| 5. Bounded backoff i DLQ | PASS | Retry/DLQ bez regresji. |
| 6. Reconciliation idempotentne i audytowalne | FAIL | Per-intent resolution bez globalnej klasyfikacji ustawia błędny status całego joba; HIGH-01. |

## Finding

### HIGH-01 — Reconciliation omija globalną macierz bezpieczeństwa multi-intent joba

- Lokalizacja: `packages/database/src/queue/job-store.ts:891-920` w relacji do
  klasyfikacji `reapExpired` z `packages/database/src/queue/job-store.ts:960-1057`.
- Dowód: job miał intent 1 z trwałym `SUCCEEDED` receipt oraz intent 2 bez
  completion. Po expiry reaper prawidłowo ustawił `RECONCILING`. Operator
  uzgodnił intent 2 jako `ABSENT`; `reconcile` bez sprawdzenia intentu 1 ustawił
  cały job `PENDING`. Worker tokenu 2 claimował job i zapisał nowy intent dla
  kroku 1 z nowym kluczem, co ponownie umożliwia wykonanie już potwierdzonego
  write.
- Dodatkowy wpływ: odwrotny przypadek jest również niebezpieczny — przy dwóch
  missing/niepewnych intentach `reconcile(CONFIRMED)` jednego z nich ustawia cały
  job `SUCCEEDED`, mimo że drugi nadal nie ma rozstrzygnięcia. Ponadto
  `INSERT ... ON CONFLICT DO NOTHING` nie sprawdza, czy istniejący completion ma
  outcome zgodny z `CONFIRMED`; ledger reconciliation i job status mogą więc
  semantycznie odbiegać od completion row.
- Przyczyna: reaper klasyfikuje cały ledger, lecz reconciliation ma stare,
  per-intent skróty `CONFIRMED → SUCCEEDED` i `ABSENT → PENDING`.
- Wpływ: operator recovery może zduplikować potwierdzony side effect albo ukryć
  nierozstrzygnięty krok, naruszając kryteria 2 i 6.
- Wymagana zmiana: po appendzie terminalnej reconciliation obliczać efektywny
  stan wszystkich intentów joba w tej samej transakcji. Terminal reconciliation
  ma być autorytatywnym resolution dla swojego intentu (`CONFIRMED` jako
  effective success, `ABSENT` jako effective definite absence), bez
  sprzecznego udawania aktualizacji append-only completion. Job może przejść do
  `SUCCEEDED` tylko gdy wszystkie intenty są efektywnie potwierdzone; do
  `PENDING` tylko gdy żaden intent nie ma potwierdzonego sukcesu i wszystkie są
  efektywnie absent/failed. Missing, `UNRESOLVED`, `AMBIGUOUS` lub mieszanka
  success+absence pozostaje `RECONCILING`. Zachować single-intent CONFIRMED/ABSENT
  behavior i idempotentny replay.
- Wymagane testy: (1) success + missing, potem ABSENT dla missing — nadal
  RECONCILING, brak claimu/tokenu 2; (2) dwa missing, CONFIRMED jednego — nadal
  RECONCILING; (3) domknięcie drugiego do stanu all-success daje SUCCEEDED;
  (4) single-intent CONFIRMED i ABSENT zachowują dotychczasowe bezpieczne
  przejścia; (5) existing completion outcome nie jest cicho ignorowany przy
  sprzecznym terminal resolution.

## Potwierdzone poprawki AUDIT-05

- Crash po trwałym `SUCCEEDED` receipt przed `complete()` rekonstruuje job
  `SUCCEEDED`, czyści lease i nie tworzy tokenu 2.
- All-success multi-intent ledger rekonstruuje sukces.
- Partial success + FAILED/missing/AMBIGUOUS trafia do `RECONCILING`.
- No-intent i FAILED-only bezpiecznie wracają do `PENDING`.
- `ReapResult.succeeded` oraz attempt evidence są obserwowalne i atomowe ze
  zmianą statusu.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 0 | 19 plików, 376/376 testów; lint/format/typecheck/build/workflow PASS. |
| Success receipt + missing intent + reap + `reconcile(ABSENT)` | 0 procesu | Błędnie PENDING, token 2 i nowy intent dla potwierdzonego kroku zapisane. |
| Inspekcja terminal branches `reconcile` | read-only | Obie gałęzie zmieniają status całego joba bez globalnej klasyfikacji ledgeru. |

## Wymagane działania po `continue`

1. Użyć jednej semantycznej, job-wide klasyfikacji zarówno w reaperze, jak i po
   każdej terminalnej reconciliation.
2. Dodać exact partial reconciliation regressions oraz konflikt istniejącego
   completion outcome.
3. Uruchomić focused suite wielokrotnie i pełny PostgreSQL gate.
4. Utworzyć `HANDOFF-07`, ustawić `AWAITING_AUDIT` i wrócić do audytu.

## Uzasadnienie werdyktu

Reaper nie replayuje już potwierdzonego write samodzielnie, ale publiczny i
oczekiwany flow recovery może natychmiast odwrócić tę ochronę. Przy ryzyku
duplikacji side effectu i błędnego terminalnego statusu pozostaje finding HIGH;
`PASS` jest niedozwolony, więc werdykt to `CHANGES_REQUIRED`.
