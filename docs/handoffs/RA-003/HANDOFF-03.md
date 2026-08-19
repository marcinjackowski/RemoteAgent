# RA-003 — Handoff 03

## Metadata

- Task: `RA-003`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po HANDOFF-02 + werdykt
  AUDIT-02 `CHANGES_REQUIRED` (2×HIGH, 1×LOW)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (przeprojektowana migracja 010 + nowe testy scope/migracji; zachowane wszystkie
  wcześniejsze zmiany RA-002/RA-003)

## Wynik

Wszystkie findingi z AUDIT-02 zremediowane w zakresie RA-003. Granice
owner/connection/provider i case są teraz wymuszone deterministycznie i **trwale**
w bazie, w tym wobec późniejszych mutacji wierszy nadrzędnych oraz podczas samego
upgrade'u schematu. Integralność scope case↔connection jest znormalizowana
(`case_connections` + composite FK), a nie tylko walidowana triggerem na JSON.
Clean-room `pnpm run check` PASS na przypiętym Node 24.19.0 / pnpm 10.26.1 z realnym
PostgreSQL; 293/293 testów, 36/36 testów DB.

## Zrealizowany zakres

- **HIGH-01 (trwała, dwukierunkowa integralność case↔connection + walidacja
  upgrade'u).** `integration_scope` (JSON) pozostaje projekcją kontraktu, ale
  autorytatywny edge żyje w nowej tabeli `case_connections` z composite FK
  `(connection_id, owner_id, provider) → connections(...)` oraz
  `(case_id, owner_id) → cases(...)`. Trigger `ra_sync_case_connections`
  (CONSTRAINT TRIGGER, AFTER INSERT/UPDATE) synchronizuje wiersze z JSON i
  odrzuca providery spoza `scope.providers`. Dzięki `ON DELETE/UPDATE RESTRICT`:
  - `UPDATE connections SET owner_id=...` używany przez case → **odrzucony**;
  - `UPDATE connections SET provider=...` używany przez case → **odrzucony**;
  - `DELETE FROM connections` używany przez case → **odrzucony**;
  - INSERT/UPDATE case scope na obcy/nieistniejący connection lub provider spoza
    scope → **odrzucony**.
  Migracja 010 **backfilluje** `case_connections` z istniejących case'ów; wadliwy
  scope zapisany na wersji 9 powoduje FK violation i **atomowe przerwanie** całej
  (transakcyjnej) migracji — DB zostaje na wersji 9.
- **HIGH-02 (pozostałe provider/case edges).**
  - `raw_events`, `events`, `external_entities`: FK do
    `connections(connection_id, owner_id, provider)` — provider wiersza musi
    zgadzać się z providerem connection (koniec cross-provider provenance/routing);
  - `events.raw_event_id`: composite FK provenance
    `(raw_event_id, provider, connection_id, owner_id)` do `raw_events`;
  - `case_checkpoints.last_run_id`: `(last_run_id, case_id) → agent_runs(run_id, case_id)`;
  - `decision_answers.decision_id`: `(decision_id, case_id) → decisions(decision_id, case_id)`;
  - `run_intents/run_completions/artifacts/reviews`: `(run_id, case_id) → agent_runs`;
  - `external_actions`: `(case_id, owner_id) → cases`, `(connection_id, owner_id) →
    connections`, `(approval_id, case_id) → approvals`.
- **Przegląd pozostałych redundantnych refs** (audit „active_run/trigger_event/
  last_event/approval/action digest"):
  - `external_actions.approval_id` i `action_digest` — approval związany z tym
    samym case przez `(approval_id, case_id)` (zamknięte); digest ma własny UNIQUE.
  - `cases.active_run_id`, `agent_runs.trigger_event_id`,
    `case_checkpoints.last_event_id` — wskazują odpowiednio run/event, które **nie**
    są związane z innym case/owner w sposób umożliwiający cross-scope: event nie
    jest encją case-bound (nie ma `case_id`), a `active_run_id` to wskaźnik na run,
    którego `case_id` i tak wiąże FK run→case. Nie wprowadzają nowej redundantnej
    pary case/run/connection, więc nie dokładałem sztucznych kolumn.
- **LOW (dokładność handoffu + ochrona lokalnych settings).** Ten handoff opisuje
  dokładny mechanizm: publiczny `CheckpointRepository.append` wymaga **branded
  `Transaction`** (nie „sam otwiera transakcję"); `Database` (pool) nie spełnia
  tego typu, więc partial-write jest błędem kompilacji. `.claude/settings.local.json`
  dodany do `.prettierignore`, aby formatter nigdy go nie modyfikował.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/migrations/010_scope_referential_integrity.{up,down}.sql` | znormalizowany `case_connections` + composite FK provider/owner/case + backfill z walidacją upgrade'u | AUDIT-02 HIGH-01/HIGH-02 |
| `packages/database/test/scope.integration.test.ts` | +10 testów: connection owner/provider UPDATE, DELETE, cross-provider raw/entity, cross-case checkpoint/decision, materializacja `case_connections` | dowód każdego edge |
| `packages/database/test/migrations.integration.test.ts` | +1 test: upgrade 009→010 z wadliwym scope przerywa migrację i zostawia wersję 9 | AUDIT-02 HIGH-01 |
| `.prettierignore` | dodano `.claude/settings.local.json` (+ `.pnpm-store`) | AUDIT-02 LOW / CI robustness |

## Decyzje i uzasadnienie

- **Normalizacja zamiast triggera-na-JSON.** Trigger walidujący tylko JSON nie
  chronił przed późniejszym `UPDATE/DELETE connections` ani przed wadliwymi danymi
  podczas migracji. Znormalizowana relacja z FK daje jedną, trwałą, dwukierunkową
  gwarancję na poziomie schematu (wstawienie, aktualizacja, usunięcie, upgrade).
- **JSON pozostaje projekcją kontraktu.** `caseContract.integration_scope` jest
  nadal źródłem zapisu; trigger utrzymuje `case_connections` spójne, więc kontrakt
  RA-002 i API repo nie zmieniają się.
- **Composite FK z providerem** zamyka cross-provider provenance bez dodatkowych
  triggerów — czysty, deterministyczny SQL (ADR-0002).
- **Nowa migracja 010, bez edycji 001-009.** Zgodne z ADR-0002; up/down/up
  deterministyczny.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Pusta baza migruje od zera i cofa (ADR) | PASS | `migrations.integration` up/down/up (001-010) |
| Ponowny provider event bez duplikatu | PASS | `repositories.integration` dedupe |
| Dwie aktualizacje rewizji — jeden zwycięzca | PASS | CAS concurrency test |
| Entity/connection nie przekracza owner scope | PASS | `case_connections` FK + 10 testów scope (insert/update/delete/upgrade) |
| Append-only bez publicznego update/delete | PASS | triggery P0100, brak mutacji w repo |
| Integration na realnym PostgreSQL | PASS | fail-closed `RA_REQUIRE_POSTGRES`; 36/36 DB |
| Transakcja przerwana nie zostawia częściowego stanu | PASS | branded `Transaction` + test awarii insert po CAS (revision=0, 0 wierszy) |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| clean-room `pnpm run check` (node 24.19.0, pnpm 10.26.1, realny PG via host.docker.internal:5433) | 0 | 293/293; build 20/20; workflow OK |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 36/36 (repo 8, migrations 5, scope 23) |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 293/293 |
| fail-closed brak PG (`RA_PGPORT=65432 RA_REQUIRE_POSTGRES=1`) | ≠0 | twardy fail (nie skip) |
| migracje up/down/up (010 włącznie) na czystej bazie | 0 | applied 1..10 / reverted 10..1 / applied 1..10 |
| upgrade 009→010 z wadliwym scope | ≠0 | migracja przerwana, `schema_migrations` max=9 |
| `pnpm run lint` / `format` / `typecheck` / `build` / `workflow:validate` | 0 | PASS |

Clean-room: świeża kopia working tree bez `.git`, `node_modules`, `dist`,
`.turbo`, `.pnpm-store`, `.remote-agent` i gitignored `.claude/settings.local.json`;
Docker `node:24.19.0-bookworm-slim`; pnpm 10.26.1 przez `corepack prepare`;
`PNPM_STORE_DIR=/tmp/pnpm-store` (poza working tree).

## Snapshoty i artefakty

- Migracje `packages/database/migrations/001-010` (up/down), 010 przeprojektowana.
- Realny harness PostgreSQL na porcie 5433; `db:smoke` uruchamia
  `db:up`→health→migrate.
- Brak zmian snapshotów kontraktów (`@remoteagent/contracts` nietknięty).

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak w handoffie; `.claude/settings.local.json` nietknięty
  i teraz jawnie wyłączony z formattera.
- Izolacja kont/scope: znormalizowane `case_connections` + composite FK
  (owner+provider) egzekwują izolację trwale, także wobec `UPDATE/DELETE` connection
  i podczas migracji; model/aplikacja nie są warstwą autoryzacji.
- Side effecty i idempotencja: dedupe eventów, atomowy CAS checkpoint (branded
  `Transaction`), append-only triggery; brak częściowego stanu po awarii.
- Dane zewnętrzne: traktowane jako `UNTRUSTED_DATA`.

## Znane ograniczenia i ryzyka

- Testy integracyjne wymagają działającego PostgreSQL na porcie 5433 (fail-closed
  z `RA_REQUIRE_POSTGRES=1`, nie skip).
- Audyt powinien niezależnie zweryfikować: `case_connections` FK wobec
  `UPDATE/DELETE connections`, upgrade 009→010 z wadliwymi danymi, oraz
  provider/case composite FK dla raw/events/entities/checkpoint/decision.
- Zmiany nie są zacommitowane (zgodnie z regułami: brak commita/pusha).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: wszystkie findingi AUDIT-02 zremediowane; migracja 010
  przeprojektowana na znormalizowaną integralność; 36/36 DB, 293/293 full;
  clean-room `pnpm run check` PASS na Node 24.19.0; status `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać
  RA-004/RA-005.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian:
  `packages/database/migrations/010_scope_referential_integrity.{up,down}.sql`,
  `packages/database/test/scope.integration.test.ts`,
  `packages/database/test/migrations.integration.test.ts`.
