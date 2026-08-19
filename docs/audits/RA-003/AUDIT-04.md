# RA-003 — Audit 04

## Metadata

- Task: `RA-003`
- Audytowany handoff: `docs/handoffs/RA-003/HANDOFF-04.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Wszystkie reprodukcje z AUDIT-03 są obecnie zamknięte: membership case,
recovery pointers, exact approval digest i runtime validation działają zgodnie
z kontraktem. Migracja 011 nie może jednak zostać zastosowana do poprawnej bazy
wersji 10 zawierającej checkpoint, ponieważ jej backfill wykonuje zabroniony
UPDATE na tabeli append-only. Jest to wąski, ale blokujący błąd upgrade'u.

## Finding

### HIGH — Upgrade 010→011 zawsze zawodzi, gdy istnieje checkpoint

- Lokalizacja: `packages/database/migrations/011_authoritative_scope_and_recovery.up.sql:100-106`; trigger append-only z `packages/database/migrations/004_runs_checkpoints.up.sql:87-90`.
- Dowód: audyt utworzył czystą bazę, zastosował 001-011, cofnął 011 do poprawnego
  schematu wersji 10, zapisał poprawnego ownera, connection, case i jeden
  checkpoint, po czym ponownie uruchomił `migrate up`. Migracja zakończyła się
  błędem `table case_checkpoints is append-only: UPDATE is not permitted`, a 011
  nie została zastosowana.
- Przyczyna: `UPDATE case_checkpoints ... SET owner_id = ...` uruchamia
  `case_checkpoints_append_only`; obecne testy upgrade'u zawierają case, ale nie
  istniejący checkpoint.
- Wpływ: każda realna baza korzystająca już z podstawowego mechanizmu trwałych
  checkpointów jest niemożliwa do zaktualizowania do nowego schematu. Fail-closed
  chroni dane, ale wdrożenie pozostaje zablokowane.
- Wymagana zmiana: migracja musi kontrolowanie zawiesić/usunąć append-only guard
  wyłącznie na czas transakcyjnego backfillu i odtworzyć go przed końcem migracji
  (rollback ma automatycznie odtworzyć poprzedni stan), albo zastosować
  równoważny mechanizm niewymagający UPDATE ledgeru. Dodać dodatni test
  010→011 z istniejącym poprawnym checkpointem oraz potwierdzić po upgrade, że
  jego UPDATE/DELETE nadal zwracają P0100. Zachować test atomowego odrzucenia
  wadliwych legacy danych.

## Pozostała weryfikacja

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 55/55 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 312/312 PASS |
| `pnpm run typecheck && pnpm run workflow:validate` | 0 | PASS; 26 tasks |
| niezależne scope/recovery/digest probes | — | wcześniejsze obejścia odrzucone |
| upgrade 010→011 z jednym poprawnym checkpointem | non-zero | błędnie odrzucony przez P0100 |

## Uzasadnienie werdyktu

Security findings z AUDIT-03 są zamknięte, ale bezpieczna przyszła migracja jest
jawnym audit focus RA-003, a obecny upgrade blokuje każdą niepustą historię
checkpointów. Przy unresolved HIGH `PASS` jest niedozwolony.

## Wymagane działania po `continue`

1. Naprawić transakcyjny backfill append-only checkpointów w migracji 011.
2. Dodać dodatni test upgrade'u z istniejącym checkpointem i regresję P0100 po
   upgrade.
3. Ponowić lifecycle, real PostgreSQL suite, full checks i dokładny HANDOFF-05.
