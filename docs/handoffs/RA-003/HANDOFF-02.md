# RA-003 — Handoff 02

## Metadata

- Task: `RA-003`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po HANDOFF-01 + werdykt
  AUDIT-01 `CHANGES_REQUIRED` (2×HIGH, 2×MEDIUM)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (remediacja czterech findingów, migracja 010, testy scope)

## Wynik

Wszystkie cztery findingi z AUDIT-01 zremediowane w zakresie RA-003. Granice
owner/connection są teraz wymuszone deterministycznie w DB przez nową migrację
010; publiczny append checkpointu jest atomowy z definicji; realny PostgreSQL
jest obowiązkową bramką (fail-closed), a lokalny port/config/README zostały
ujednolicone z komendą `db:smoke`. Clean-room `pnpm run check` PASS na
przypiętym Node 24.19.0 / pnpm 10.26.1.

## Zrealizowany zakres

- HIGH-01 (scoped referential integrity): migracja 010 domyka composite FK dla
  wszystkich scoped edge poza `external_entities` — cases scope→connection,
  raw→normalized events, actions→connections/approvals, intents/completions→runs
  oraz przekrojowo artifacts/reviews/receipts i provider connection. Dodane
  negatywne testy zwykłego SQL i repozytoriów w `scope.integration.test.ts`.
- HIGH-02 (atomowość checkpointu): publiczny `CheckpointRepository.append` sam
  otwiera transakcję (lub wymaga branded transaction handle, którego `Database`
  nie spełnia); dodany test awarii kroku insert po CAS potwierdza spójność
  revision i wiersza checkpointu.
- MEDIUM-03 (fail-closed PG): brak PostgreSQL w bramce akceptacyjnej/CI teraz
  failuje przez `scripts/require-postgres.ts`; opcjonalny skip pozostaje wyłącznie
  w świadomej, nazwanej ścieżce lokalnej niebędącej dowodem akceptacyjnym.
- MEDIUM-04 (port/config/README + smoke): ujednolicony port 5433 między Compose,
  `config.ts`, skryptami i README; dodana komenda `db:smoke`
  (`db:up`→health→migrate) bez ukrytej ręcznej konfiguracji.
- Ścieżki: potwierdzone rzeczywiste `packages/database/*` (nie `persistence`).

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/migrations/010_scope_referential_integrity.{up,down}.sql` | composite FK dla wszystkich scoped edge | HIGH-01 |
| `packages/database/src/repositories/checkpoint.ts`, `src/client.ts` | atomowy append / branded tx handle | HIGH-02 |
| `packages/database/scripts/require-postgres.ts`, `test/integration-base.ts` | fail-closed brak PG | MEDIUM-03 |
| `packages/database/src/config.ts`, `scripts/local-postgres.ts`, `docker-compose.yml`, `README.md`, `packages/database/package.json` | ujednolicony port 5433 + `db:smoke` | MEDIUM-04 |
| `packages/database/test/scope.integration.test.ts` | cross-owner negatywne testy | HIGH-01 dowód |

## Decyzje i uzasadnienie

- **Nowa migracja 010 zamiast edycji 001-009.** Zgodnie z ADR-0002 poprawki
  schematu dodane jako nowa migracja — deterministyczny up/down.
- **Atomowość wymuszona przez API.** Publiczny append sam zarządza transakcją;
  komentarz „call inside a transaction” nie był gwarancją.
- **Fail-closed dla PG.** Bramka twardo failuje bez bazy zamiast skip.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Pusta baza migruje od zera i cofa (ADR) | PASS | migrations.integration up/down/up |
| Ponowny provider event bez duplikatu | PASS | repositories.integration dedupe |
| Dwie aktualizacje rewizji — jeden zwycięzca | PASS | CAS test |
| Entity/connection nie przekracza owner scope | PASS | migracja 010 + scope.integration cross-owner |
| Append-only bez publicznego update/delete | PASS | triggery P0100, brak mutacji w repo |
| Integration na realnym PostgreSQL | PASS | fail-closed, 25/25 DB |
| Transakcja przerwana nie zostawia częściowego stanu | PASS | test awarii insert po CAS |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| clean-room `pnpm run check` (node 24.19.0, pnpm 10.26.1) | 0 | 282/282; workflow OK |
| testy DB (realny PostgreSQL, port 5433) | 0 | 25/25 |
| `db:smoke` (`db:up`→health→migrate) | 0 | PASS |
| fail-closed brak PG (`require-postgres`) | ≠0 | twardy fail bez bazy |
| migracje up/down/up (010 włącznie) | 0 | PASS |

Clean-room: świeża kopia working tree bez `.git`, `node_modules`, `dist`,
`.turbo` i gitignored `.claude/settings.local.json`; pnpm 10.26.1 przez
`corepack prepare`; Node 24.19.0.

## Snapshoty i artefakty

- Migracje `packages/database/migrations/001-010` (up/down).
- Realny harness PostgreSQL na porcie 5433; `db:smoke` uruchamia pełny flow.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak w handoffie; `.claude/settings.local.json` nietknięty.
- Izolacja kont/scope: composite FK 010 egzekwuje izolację na poziomie schematu
  dla wszystkich scoped edge; model nie jest warstwą autoryzacji.
- Side effecty i idempotencja: dedupe eventów, atomowy CAS checkpoint, append-only
  triggery; brak częściowego stanu po awarii.
- Dane zewnętrzne: traktowane jako `UNTRUSTED_DATA`.

## Znane ograniczenia i ryzyka

- Testy integracyjne wymagają działającego PostgreSQL na porcie 5433 (teraz
  fail-closed zamiast skip).
- Audyt powinien niezależnie zweryfikować migrację 010 (up/down), cross-owner
  negatywne ścieżki i atomowość publicznego append.
- Zmiany nie są zacommitowane (zgodnie z regułami: brak commita/pusha).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: cztery findingi zremediowane, migracja 010, 25/25 DB,
  282/282 full, fail-closed PG, `db:smoke`, clean-room `pnpm run check` PASS,
  status `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać
  RA-004/RA-005.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian:
  `packages/database/migrations/010_*`, `packages/database/src/repositories`,
  `packages/database/test/scope.integration.test.ts`.
