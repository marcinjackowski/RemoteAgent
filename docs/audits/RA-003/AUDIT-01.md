# RA-003 — Audit 01

## Metadata

- Task: `RA-003`
- Audytowany handoff: `docs/handoffs/RA-003/HANDOFF-01.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Migracje, deduplikacja eventów, konkurencyjny CAS i append-only triggery działają
na prawdziwym PostgreSQL, a pełny zestaw kontroli jest zielony przy dostępnej
bazie. Implementacja nie spełnia jednak bramki audytowej: zwykłe zapisy mogą
tworzyć cross-owner powiązania poza jedną przetestowaną tabelą, a publiczne API
checkpointu pozwala wykonać dwuetapowy zapis bez transakcji i pozostawić
częściowy stan. Dodatkowo testy DB przechodzą jako skipped bez PostgreSQL, a
domyślna konfiguracja CLI nie wskazuje Postgresa uruchamianego przez Compose.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`,
  `docs/workflow/AUDIT_CHECKLIST.md`, `docs/tasks/TASK_INDEX.md`,
  `docs/tasks/RA-003.md`, `docs/decisions/ADR-0002-persistence-sql-migrations.md`,
  `docs/handoffs/RA-003/HANDOFF-01.md`.
- Sprawdzony diff/stan: cały niezacommitowany zakres RA-003, wszystkie pliki
  `packages/database/src`, `packages/database/migrations`,
  `packages/database/test`, konfiguracja pakietu, Compose, Turbo i lockfile.
- Uruchomione kontrole: pełny test repo, testy DB, lint, format zmienionego
  zakresu, typecheck, build, workflow validator oraz niezależne negatywne próby
  SQL/repository na izolowanej bazie PostgreSQL.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Pusta baza migruje od zera i cofa się zgodnie z ADR | PASS | `migrations.integration.test.ts`: up/down/up i rollback pojedynczej migracji, 4/4 PASS |
| 2. Ponowny provider event nie tworzy duplikatu | PASS | `repositories.integration.test.ts`, natywne `events_dedupe_unique`, 1/1 PASS |
| 3. Dwie aktualizacje tej samej rewizji nie mogą obie wygrać | PASS | równoległa próba daje dokładnie jednego zwycięzcę; oddzielny HIGH dotyczy możliwości pominięcia transakcji |
| 4. Entity/connection nie może przekroczyć owner scope | FAIL | niezależna próba zaakceptowała foreign connection w `cases.integration_scope` i `external_actions`; patrz HIGH-01 |
| 5. Append-only rekordy nie mają publicznego update/delete API | PASS | repo audit/checkpoint/event nie eksportują mutacji; triggery odrzucają UPDATE/DELETE kodem `P0100` |
| 6. Integration tests używają prawdziwego PostgreSQL | PASS | 10/10 uruchomione przez audytora na PostgreSQL; MEDIUM-03: brak bazy powoduje skip i exit 0 |
| Transakcja przerwana nie pozostawia częściowego stanu | FAIL | publiczne `CheckpointRepository.append(Database, ...)` pozostawiło revision=1 i 0 checkpointów po błędzie FK; patrz HIGH-02 |

## Findingi

### HIGH — Granice owner/connection i scoped referential integrity są niepełne

- Lokalizacja: `packages/database/migrations/003_cases_entities.up.sql:14`,
  `packages/database/migrations/002_events.up.sql:49`,
  `packages/database/migrations/004_runs_checkpoints.up.sql:36`,
  `packages/database/migrations/008_actions_approvals_receipts.up.sql:10`.
- Dowód: na świeżej, zmigrowanej bazie zwykłe zapisy zaakceptowały kolejno:
  case ownera A z `integration_scope.connection_ids=[connection B]`, action dla
  case A skierowaną przez connection B, normalized event ownera A wskazujący
  raw event ownera B oraz intent z `run_id` case A i `case_id` case B.
  Przetestowany composite FK chroni wyłącznie `external_entities`.
- Wpływ: autorytatywny scope i provenance mogą wskazywać zasoby innego ownera.
  To otwiera cross-account read/write routing i łamie kryterium 4, audit focus
  oraz zasadę, że model/aplikacja nie są warstwą autoryzacji.
- Wymagana zmiana: znormalizować scope case→connection albo dodać równoważne
  deterministyczne wymuszenie w DB; związać każdą tabelę zawierającą równoległe
  `case_id`/`run_id`/`connection_id`/`raw_event_id` z tym samym ownerem i case
  przez composite keys/FK. Co najmniej objąć cases scope, raw→normalized events,
  actions→connections/approvals oraz intents/completions→runs; przejrzeć w ten
  sam sposób artifacts/reviews/receipts i provider connection. Dodać negatywne
  testy zwykłego SQL i repozytoriów dla każdego scoped edge.

### HIGH — Publiczne API checkpointu nie gwarantuje atomowości

- Lokalizacja: `packages/database/src/repositories/checkpoint.ts:51-98` oraz
  `packages/database/src/client.ts` (`Database implements Queryable`).
- Dowód: `append` przyjmuje dowolny `Queryable`, więc audytor wywołał je
  bezpośrednio z publicznym `Database`. CAS zaktualizował case z rewizji 0 do 1,
  po czym insert checkpointu upadł na celowo błędnym `last_event_id`.
  Stan końcowy: `cases.checkpoint_revision=1`, liczba checkpointów `0`.
- Wpływ: zwykłe, typowane użycie eksportowanego API może uszkodzić źródło
  prawdy checkpointów i uniemożliwić bezpieczne recovery. Komentarz „must be
  called inside a transaction” nie jest gwarancją transakcyjną.
- Wymagana zmiana: publiczna operacja ma sama otwierać transakcję albo wymagać
  niepodrabialnego/branded transaction handle, którego `Database` nie spełnia.
  Dodać test awarii drugiego kroku wywołany przez publiczne API i potwierdzić,
  że revision oraz wiersz checkpointu pozostają spójne. Warto również wymusić
  zgodność `checkpoint.case_id`/`revision` z kolumnami rekordu.

### MEDIUM — Brak PostgreSQL daje zielony wynik z pominięciem wszystkich testów DB

- Lokalizacja: `packages/database/test/integration-base.ts:18-36`.
- Dowód: `RA_PGPORT=65432 pnpm exec vitest run packages/database` zakończyło się
  kodem `0`, raportując `2 skipped` suites i `10 skipped` testów.
- Wpływ: CI albo clean-room bez poprawnie uruchomionej usługi może deklarować
  zielony `pnpm run check`, choć żadne kryterium persistence nie zostało
  zweryfikowane. Regresja migracji/constraints może przejść niezauważona.
- Wymagana zmiana: obowiązkowa ścieżka CI/check dla RA-003 ma failować, gdy
  PostgreSQL jest niedostępny (lub jawnie uruchamiać usługę/testcontainer).
  Opcjonalny skip może pozostać wyłącznie w nazwanej, świadomej ścieżce lokalnej,
  która nie jest dowodem akceptacyjnym.

### MEDIUM — Domyślny CLI nie łączy się z PostgreSQL uruchomionym przez Compose

- Lokalizacja: `packages/database/src/config.ts:12-19`,
  `docker-compose.yml:14-18`, `packages/database/scripts/local-postgres.ts`.
- Dowód: Compose publikuje `5433:5432`, natomiast `resolvePoolConfig()` bez env
  wybiera port 5432. `db:up` tylko uruchamia Compose i nie ustawia zmiennych dla
  następnego procesu, więc udokumentowane `migrate` bez `RA_PGPORT=5433` trafia
  do innego lokalnego klastra albo failuje.
- Wpływ: lokalny Postgres/migration harness nie działa jako spójny domyślny flow
  i może przypadkowo migrować inną bazę nasłuchującą na 5432.
- Wymagana zmiana: ujednolicić port/default URL między Compose, config, skryptami
  i README; dodać smoke test lub komendę, która wykonuje `db:up`→health→migrate
  bez ukrytej ręcznej konfiguracji.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 pnpm exec vitest run packages/database` | 0 | 2 suites, 10/10 PASS na realnym PostgreSQL |
| `RA_PGPORT=5433 pnpm run test` | 0 | 14 plików, 267/267 PASS |
| `pnpm run lint` | 0 | PASS; tylko istniejące warningi konfiguracji boundaries |
| `pnpm exec prettier --check packages/database docker-compose.yml turbo.json` | 0 | PASS |
| `pnpm run typecheck` | 0 | 21/21 zadań PASS (wliczony dependency build) |
| `pnpm run build` | 0 | 20/20 PASS |
| `pnpm run workflow:validate` przed audytem | 0 | `OK — 26 tasks` |
| Izolowana próba cross-owner/partial checkpoint | 0 | wszystkie cztery cross-owner zapisy zaakceptowane; partial checkpoint odtworzony |
| `RA_PGPORT=65432 pnpm exec vitest run packages/database` | 0 | 2 suites / 10 tests skipped — finding MEDIUM |

## Ryzyka przekrojowe

- Security/privacy: HIGH — cross-owner scope jest możliwy przez kilka zwykłych
  zapisów mimo poprawnego composite FK dla `external_entities`.
- Idempotencja/recovery: HIGH — checkpoint revision może wyprzedzić faktyczny
  append, gdy caller pominie niewymuszoną transakcję.
- Współbieżność: właściwie opakowany CAS ma jednego zwycięzcę; interfejs nie
  wymusza jednak właściwej granicy transakcji.
- Observability: błędy PG są mapowane domenowo w części repozytoriów; brak bazy w
  testach jest obecnie raportowany jako skip, nie actionable failure.
- Kompatybilność: migracje up/down/up i checksum guard działają; poprawki schema
  muszą zostać dodane jako nowa migracja lub — przed pierwszym wdrożeniem —
  świadomie odtworzone i ponownie zweryfikowane zgodnie z ADR.

## Wymagane działania po `continue`

1. Zamknąć wszystkie scoped referential edges w DB i dodać cross-owner testy.
2. Uczynić publiczny append checkpointu atomowym z definicji i dodać test awarii
   pomiędzy CAS a insertem.
3. Uczynić realny PostgreSQL obowiązkową bramką akceptacyjną/CI.
4. Ujednolicić lokalny port/config/README i zweryfikować smoke flow.
5. Poprawić ścieżki `packages/persistence/*` w następnym handoffie na rzeczywiste
   `packages/database/*`, ponowić clean-room i wymagane testy.

## Uzasadnienie werdyktu

Zielone testy nie kompensują reprodukowalnych naruszeń owner scope i
atomowości trwałego checkpointu. Ponieważ pozostały findingi HIGH i MEDIUM,
`PASS` jest zabroniony przez `AGENTS.md` i checklistę. Problemy są naprawialne w
zakresie RA-003, więc właściwy werdykt to `CHANGES_REQUIRED`.
