# RA-003 — Handoff 04

## Metadata

- Task: `RA-003`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po HANDOFF-03 + werdykt
  AUDIT-03 `CHANGES_REQUIRED` (3×HIGH, 1×MEDIUM, 1×LOW)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (nowa migracja 011 + runtime contract w repo + testy; zachowane wszystkie
  wcześniejsze poprawne zmiany RA-002/RA-003 i migracje 001-010)

## Wynik

Wszystkie findingi z AUDIT-03 zremediowane deterministycznie w bazie i w write
path. `case_connections` jest teraz autorytatywną, niemodyfikowalną poza triggerem
allowlistą connection per case; entity i action są do niej związane; wskaźniki
recovery (active_run, trigger_event, last_event) są owner/case-bound z ownerem
przypiętym do case; approval jest związany z dokładnym action digestem; a runtime
kontrakt `integration_scope` jest egzekwowany zarówno w repozytorium (zod), jak i w
DB. Clean-room `pnpm run check` PASS na przypiętym Node 24.19.0 / pnpm 10.26.1 z
realnym PostgreSQL; 312/312 testów (55 DB).

## Faktyczne gwarancje i mechanizmy (dowiedzione DML probes + testy)

- **HIGH-01 — allowlista + brak desync.**
  - `external_entities` i `external_actions` mają composite FK
    `(case_id, connection_id) → case_connections(case_id, connection_id)`. Zwykły
    INSERT entity/action przez connection **tego samego ownera, ale spoza scope**
    (`cA2` nie w `[cA]`) jest **odrzucany** (FK 23503) — dowód w testach
    `rejects an external_entity/action via a same-owner connection outside the case allowlist`.
  - `case_connections` ma guard trigger `ra_guard_case_connections`
    (`BEFORE INSERT/UPDATE/DELETE`), który odrzuca każdą operację przy
    `pg_trigger_depth() <= 1`. **Nie da się go obejść zwykłym klientem**, bo
    top-level DML uruchamia guard na głębokości 1, a jedyna dozwolona ścieżka to
    zagnieżdżona DML z triggera synchronizującego `cases` (głębokość ≥ 2). Nie
    użyto GUC/`current_setting`, którego klient mógłby podrobić. Dowód: testy
    `forbids direct INSERT/UPDATE/DELETE ... (tamper guard)` (SQLSTATE `P0102` →
    `ProtectedTableError`) oraz test dodania connection wyłącznie przez zmianę
    `integration_scope`.
- **HIGH-02 — recovery pointers owner/case-bound (z pinowaniem ownera do case).**
  - `cases.active_run_id`: composite FK `(active_run_id, case_id) →
    agent_runs(run_id, case_id)` — run innego case odrzucony.
  - `agent_runs`: dodana kolumna `owner_id` **przypięta do case** przez
    `(case_id, owner_id) → cases`, oraz `(trigger_event_id, owner_id) →
    events(event_id, owner_id)`. Ponieważ owner jest wiązany z case przez FK,
    caller **nie może skłamać** ownera, aby podpiąć event innego ownera — próba
    `UPDATE agent_runs SET owner_id='B'` dla runa case A jest odrzucana.
  - `case_checkpoints`: analogiczny wzorzec — `owner_id` przypięty do case,
    `(last_event_id, owner_id) → events(event_id, owner_id)`; `CheckpointRepository`
    wyprowadza `owner_id` z case (nigdy z wejścia). Event innego ownera odrzucony.
- **HIGH-03 — approval = exact digest.** `approvals` ma
  `UNIQUE (approval_id, case_id, action_digest)`, a `external_actions` FK
  `(approval_id, case_id, action_digest) → approvals(...)`. Action `APPROVED` z
  approvalem dla innego digestu jest odrzucany; dokładne dopasowanie przechodzi.
- **MEDIUM — runtime contract.** `CaseRepository.insert` parsuje
  `integration_scope` i `status` schematami z `@remoteagent/contracts`
  (`integrationScope`, `caseStatusSchema`) przed zapisem → `ContractViolationError`
  dla pustych/nieznanych/źle typowanych wartości; **niezależnie** funkcja DB
  `ra_validate_integration_scope` (wpięta w trigger sync) egzekwuje zamknięty zbiór
  kluczy, granice tablic (providers 1..16, connection_ids 1..64), dozwolone
  providery i typy elementów, więc bezpośredni SQL z niepoprawnym scope też jest
  odrzucany (`ScopeViolationError`).

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/migrations/011_authoritative_scope_and_recovery.{up,down}.sql` | allowlista member FK, guard `pg_trigger_depth`, recovery owner-bound FK, approval exact-digest FK, runtime scope shape + backfill validation | AUDIT-03 HIGH-01/02/03 + MEDIUM |
| `packages/database/src/repositories/case.ts` | runtime parse `integration_scope`/`status` (zod) w write path | AUDIT-03 MEDIUM |
| `packages/database/src/repositories/checkpoint.ts` | `owner_id` wyprowadzany z case przy insert checkpointu | HIGH-02 |
| `packages/database/src/errors.ts`, `src/client.ts`, `src/index.ts` | `ContractViolationError`, `ProtectedTableError` + mapowanie `P0102` | nowe klasy błędów |
| `packages/database/test/scope.integration.test.ts` | +18 testów: allowlista, tamper guard (3), sync przez scope, recovery (5), approval digest (2), contract (4) | dowód każdego edge |
| `packages/database/test/migrations.integration.test.ts` | +1 test: upgrade z pustym legacy scope przerywa 011 | AUDIT-03 MEDIUM/upgrade |

## Decyzje i uzasadnienie

- **`pg_trigger_depth()` zamiast session GUC.** GUC (`current_setting`) można ustawić
  z dowolnego klienta i obejść guard; głębokość triggera jest własnością silnika i
  nie da się jej sfałszować top-level DML-em. Zweryfikowane osobnym eksperymentem i
  testami integracyjnymi.
- **Owner przypięty do case przy denormalizacji.** Sama kolumna `owner_id` na
  `agent_runs`/`case_checkpoints` nie wystarcza; bez `(case_id, owner_id) → cases`
  caller mógłby skłamać ownera. Composite FK do `cases` domyka tę lukę.
- **Podwójne egzekwowanie kontraktu (repo + DB).** Repo daje jasny
  `ContractViolationError` na granicy zapisu (UNTRUSTED_DATA nie ufa typom TS), a
  trigger DB chroni też ścieżki spoza repo.
- **Nowa migracja 011, bez edycji 001-010.** ADR-0002; deterministyczny up/down/up.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Pusta baza migruje od zera i cofa (ADR) | PASS | lifecycle 001-011 up/down/up |
| Ponowny provider event bez duplikatu | PASS | repositories dedupe |
| Dwie aktualizacje rewizji — jeden zwycięzca | PASS | CAS concurrency + rollback |
| Entity/connection nie przekracza owner scope | PASS | member FK + tamper guard + 18 testów |
| Append-only bez publicznego update/delete | PASS | triggery P0100 |
| Integration na realnym PostgreSQL | PASS | fail-closed; 55/55 DB |
| Transakcja przerwana nie zostawia częściowego stanu | PASS | branded Transaction + test |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| clean-room `pnpm run check` (node 24.19.0, pnpm 10.26.1, realny PG via host.docker.internal:5433) | 0 | 312/312; build 20/20; workflow OK |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 55/55 (repo 8, migrations 6, scope 41) |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 312/312 |
| fail-closed brak PG (`RA_PGPORT=65432 RA_REQUIRE_POSTGRES=1`) | ≠0 | twardy fail |
| migracje up/down/up (011 włącznie) na czystej bazie | 0 | applied 1..11 / reverted 11..1 / applied 1..11 |
| upgrade 010→011 z pustym legacy scope | ≠0 | migracja przerwana, max applied = 10 |
| upgrade 009→010 z wadliwym scope (z HANDOFF-03) | ≠0 | nadal przerywa (regresja zielona) |

Clean-room: świeża kopia working tree bez `.git`, `node_modules`, `dist`,
`.turbo`, `.pnpm-store`, `.remote-agent` i gitignored `.claude/settings.local.json`;
Docker `node:24.19.0-bookworm-slim`; pnpm 10.26.1 przez `corepack prepare`;
`PNPM_STORE_DIR=/tmp/pnpm-store`.

## Snapshoty i artefakty

- Migracje `packages/database/migrations/001-011` (up/down); 011 nowa.
- Brak zmian snapshotów kontraktów (`@remoteagent/contracts` nietknięty poza
  importem w repo).

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak w handoffie; `.claude/settings.local.json` nietknięty
  i wyłączony z formattera.
- Izolacja kont/scope: allowlista `case_connections` + member FK + tamper guard +
  recovery/approval composite FK egzekwują izolację trwale i deterministycznie;
  model/aplikacja nie są warstwą autoryzacji.
- Side effecty i idempotencja: dedupe eventów, atomowy CAS checkpoint (branded
  Transaction), append-only triggery; approval exact-digest.
- Dane zewnętrzne: `integration_scope` traktowany jako UNTRUSTED_DATA — runtime
  parse w repo + walidacja w DB.

## Znane ograniczenia i ryzyka

- Testy integracyjne wymagają PostgreSQL na 5433 (fail-closed z
  `RA_REQUIRE_POSTGRES=1`).
- Audyt powinien niezależnie zweryfikować: member FK entity/action przez same-owner
  connection spoza scope; direct DML na `case_connections` (INSERT/UPDATE/DELETE);
  recovery pointers i forge `owner_id`; approval digest mismatch/exact; runtime i
  DB walidację scope; upgrade z pustym legacy scope.
- Zmiany nie są zacommitowane (brak commita/pusha zgodnie z regułami).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: wszystkie findingi AUDIT-03 zremediowane; migracja 011;
  55/55 DB, 312/312 full; clean-room `pnpm run check` PASS na Node 24.19.0; status
  `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać
  RA-004/RA-005.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian:
  `packages/database/migrations/011_authoritative_scope_and_recovery.{up,down}.sql`,
  `packages/database/src/repositories/case.ts`,
  `packages/database/test/scope.integration.test.ts`,
  `packages/database/test/migrations.integration.test.ts`.
