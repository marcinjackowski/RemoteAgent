# RA-003 — Handoff 05

## Metadata

- Task: `RA-003`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po HANDOFF-04 + werdykt
  AUDIT-04 `CHANGES_REQUIRED` (1×HIGH, wąski błąd upgrade'u)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (poprawka backfillu w migracji 011 + jeden dodatni test upgrade'u; zachowane
  wszystkie wcześniejsze poprawne zmiany i migracje 001-010)

## Wynik

Naprawiony wąski, blokujący błąd upgrade'u wskazany w AUDIT-04. Migracja 011
poprawnie backfilluje `owner_id` na istniejących, append-only checkpointach z
poprawnej bazy v10, transakcyjnie zawieszając i odtwarzając guard append-only, z
zachowaniem atomowego rollbacku. Wszystkie zamknięcia z AUDIT-01..03 pozostają w
mocy. Clean-room `pnpm run check` PASS na przypiętym Node 24.19.0 / pnpm 10.26.1 z
realnym PostgreSQL; 313/313 testów (56 DB).

## Finding AUDIT-04 i naprawa

- **HIGH — Upgrade 010→011 zawsze zawodził, gdy istniał checkpoint.**
  - Przyczyna: `UPDATE case_checkpoints SET owner_id = ...` (backfill sekcji 3c
    migracji 011) uruchamiał trigger `case_checkpoints_append_only`
    (`ra_deny_mutation`, SQLSTATE `P0100`), więc każda niepusta historia
    checkpointów blokowała upgrade.
  - Naprawa (`011_authoritative_scope_and_recovery.up.sql`, sekcja 3c): przed
    jednorazowym backfillem migracja wykonuje `DROP TRIGGER
    case_checkpoints_append_only`, robi `UPDATE ... owner_id`, a następnie
    **odtwarza** trigger (`CREATE TRIGGER ... EXECUTE FUNCTION ra_deny_mutation()`)
    jeszcze przed końcem migracji. Wszystko dzieje się w jednej transakcji migracji
    (runner: transakcja na migrację), więc:
    - sukces → guard jest z powrotem aktywny, `owner_id` zbackfillowany;
    - dowolny późniejszy błąd migracji (np. wadliwy legacy scope) → cała
      transakcja rolluje się back, w tym `DROP TRIGGER`, więc ledger nigdy nie
      zostaje bez guardu.
  - Funkcja `ra_deny_mutation()` istnieje od migracji 001, więc odtworzenie
    triggera nie wymaga jej redefiniowania. `agent_runs` nie jest append-only
    (brak `ra_deny_mutation`), więc jego backfill `owner_id` nie wymagał zmian.

## Dowody (real PostgreSQL, niezależne probes)

- Upgrade 010→011 z jednym poprawnym checkpointem: `migrate up` → `applied 11`;
  `case_checkpoints.owner_id = 'A'` (zbackfillowany).
- Po upgrade: `UPDATE case_checkpoints ...` i `DELETE FROM case_checkpoints ...`
  oba zwracają `P0100` (`table case_checkpoints is append-only`).
- Upgrade z wadliwym legacy scope (pusty `integration_scope`) nadal fail-closed:
  migracja przerwana, `schema_migrations` max = 10, a append-only guard **nadal
  aktywny** po aborcie (dowód: `UPDATE` zwraca `P0100`) — potwierdza transakcyjny
  rollback `DROP TRIGGER`.
- up/down/up (001-011) deterministyczny.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/migrations/011_authoritative_scope_and_recovery.up.sql` | sekcja 3c: transakcyjne `DROP TRIGGER`→backfill `owner_id`→`CREATE TRIGGER` append-only | AUDIT-04 HIGH |
| `packages/database/test/migrations.integration.test.ts` | +1 test: upgrade 010→011 z istniejącym poprawnym checkpointem, asercje backfillu i regresji `P0100` (UPDATE i DELETE) | AUDIT-04 wymóg dowodowy |

Migracja `011_...down.sql` bez zmian: down nie backfilluje, więc nie dotyka
append-only guardu (odtwarza jedynie constraints/kolumny z sekcji 3c).

## Decyzje i uzasadnienie

- **Kontrolowane zawieszenie guardu tylko na czas backfillu.** DROP+CREATE
  triggera w tej samej transakcji jest najprostszym, deterministycznym
  mechanizmem; rollback DDL przez PostgreSQL gwarantuje, że przy błędzie guard
  wraca automatycznie. Alternatywa (`ALTER TABLE ... DISABLE TRIGGER`) również
  działa, ale DROP/CREATE jest jawny w diffie i symetryczny.
- **Brak zmian w innych sekcjach.** Zakres ograniczony do wąskiego findingu; nie
  ruszam zamkniętych już mechanizmów allowlisty/recovery/approval/contract.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Pusta baza migruje od zera i cofa (ADR) | PASS | lifecycle 001-011 up/down/up |
| Ponowny provider event bez duplikatu | PASS | repositories dedupe |
| Dwie aktualizacje rewizji — jeden zwycięzca | PASS | CAS concurrency + rollback |
| Entity/connection nie przekracza owner scope | PASS | member FK + tamper guard (AUDIT-03) |
| Append-only bez publicznego update/delete | PASS | P0100; teraz też potwierdzone PO upgrade 011 |
| Integration na realnym PostgreSQL | PASS | fail-closed; 56/56 DB |
| Transakcja przerwana nie zostawia częściowego stanu | PASS | branded Transaction + abort rollback guardu |
| Bezpieczna przyszła migracja (audit focus) | PASS | upgrade 010→011 z istniejącym checkpointem działa |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| clean-room `pnpm run check` (node 24.19.0, pnpm 10.26.1, realny PG via host.docker.internal:5433) | 0 | 313/313; build 20/20; workflow OK |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 56/56 (repo 8, migrations 7, scope 41) |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 313/313 |
| fail-closed brak PG (`RA_PGPORT=65432 RA_REQUIRE_POSTGRES=1`) | ≠0 | twardy fail |
| migracje up/down/up (011 włącznie) na czystej bazie | 0 | applied 1..11 / reverted 11..1 / applied 1..11 |
| upgrade 010→011 z istniejącym checkpointem | 0 | applied 11; owner_id backfilled; UPDATE/DELETE → P0100 |
| upgrade 010→011 z pustym legacy scope | ≠0 | przerwany; max applied = 10; append-only nadal aktywny po aborcie |
| `pnpm run lint` / `format` / `typecheck` / `build` / `workflow:validate` | 0 | PASS |

Clean-room: świeża kopia working tree bez `.git`, `node_modules`, `dist`,
`.turbo`, `.pnpm-store`, `.remote-agent` i gitignored `.claude/settings.local.json`;
Docker `node:24.19.0-bookworm-slim`; pnpm 10.26.1 przez `corepack prepare`;
`PNPM_STORE_DIR=/tmp/pnpm-store`.

## Snapshoty i artefakty

- Migracje `packages/database/migrations/001-011` (up/down); zmiana tylko w
  011 up (sekcja 3c).
- Brak zmian kontraktów `@remoteagent/contracts`.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak w handoffie; `.claude/settings.local.json` nietknięty
  i wyłączony z formattera.
- Izolacja kont/scope: bez zmian względem HANDOFF-04 (allowlista, recovery,
  approval, runtime contract nadal egzekwowane).
- Side effecty i idempotencja: append-only guard checkpointów jest zawieszany
  wyłącznie w obrębie jednej transakcji migracji i odtwarzany przed jej końcem;
  przy aborcie wraca automatycznie — ledger nigdy nie zostaje odsłonięty.
- Dane zewnętrzne: `integration_scope` nadal UNTRUSTED_DATA (repo + DB walidacja).

## Znane ograniczenia i ryzyka

- Testy integracyjne wymagają PostgreSQL na 5433 (fail-closed z
  `RA_REQUIRE_POSTGRES=1`).
- Audyt powinien niezależnie zweryfikować: upgrade 010→011 z istniejącym
  checkpointem (sukces + backfill), regresję P0100 (UPDATE/DELETE) po upgrade oraz
  fail-closed + zachowanie guardu po aborcie na wadliwym legacy scope.
- Zmiany nie są zacommitowane (brak commita/pusha zgodnie z regułami).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: finding AUDIT-04 zremediowany; migracja 011 upgrade'uje bazę z
  istniejącymi checkpointami; 56/56 DB, 313/313 full; clean-room `pnpm run check`
  PASS na Node 24.19.0; status `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać
  RA-004/RA-005.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian:
  `packages/database/migrations/011_authoritative_scope_and_recovery.up.sql`
  (sekcja 3c), `packages/database/test/migrations.integration.test.ts`.
