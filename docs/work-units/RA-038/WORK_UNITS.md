# RA-038 — WORK_UNITS

- Task: `RA-038` Trwałe operacje, eventy i recovery control plane
- Bazowy commit: `8c9708e3a2fcc2fc633c5897e8cb0184d779f663`
- Status: `DONE`
- ADR: `ADR-0011`, `ADR-0013`

## Inwariant projektu

RA-038 rozszerza istniejący durability core. `job_intents`, `job_completions` i
`job_reconciliations` pozostają źródłem prawdy dla intent-before-effect,
potwierdzonego wyniku i AMBIGUOUS reconciliation. `run_completions` pozostaje
write-once wynikiem one-shot model runu, a `case_checkpoints` wersjonowanym
snapshotem biznesowym/kontekstowym. Nowe tabele nie powielają tych ledgerów:
wiążą je z engineering stage i przechowują append-only artefakty/eventy oraz
odbudowywalną projekcję.

## RA-038-WU-00 — Formalny start i rzeczywiste środowisko PostgreSQL

**Status:** DONE

**Rezultat:** task jest `IN_PROGRESS`, a `CTF-022` zostaje naprawiony bez
instalowania/uruchamiania usług i bez ukrytego skipu integracji. `env.sh` wybiera
jawnie skonfigurowany serwer albo bezpieczny dostępny local fallback i eksportuje
dyskretne `RA_PG*`, tak aby override per-test database nadal działał.

**Allowed paths:**

- `scripts/dev/env.sh`
- `AGENTS.md`
- `test/processes/env-script.test.ts` (jeżeli deterministyczny harness jest
  potrzebny)
- `docs/audits/CROSS_TASK_FINDINGS.md`
- `docs/tasks/RA-038.md`
- `docs/tasks/TASK_INDEX.md`
- `docs/work-units/RA-038/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && test "${RA_PGPORT}" = "5432" && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/repositories.integration.test.ts && pnpm workflow:validate
```

**Dowód `2026-08-25`:**

- `. scripts/dev/env.sh` — exit `0`; wybrany `local fallback
  127.0.0.1:5432`, eksport `RA_PGHOST=127.0.0.1`, `RA_PGPORT=5432`,
  `RA_PGUSER=marcinjackowski`, `RA_PGDATABASE=postgres`, bez URL-a;
- `pnpm exec vitest run test/processes/env-script.test.ts` — exit `0`, `8/8`;
  fake `psql` wymaga `-X`, `-w`, timeoutów i `SELECT 1`; testy dowodzą też, że
  unreachable explicit URL/discrete nie przechodzi do fallbacku, a canary hasła
  nie trafia do stdout/stderr;
- `RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
  packages/database/test/repositories.integration.test.ts` — exit `0`, `8/8`;
- mutation eksportu fallbacku `RA_PGPORT=5432→5433` — harness exit `1`, test
  fallbacku RED; po przywróceniu i zmianie probe na realny `SELECT 1` exit `0`,
  `8/8`;
- `pnpm workflow:validate` — exit `0`, `OK — 45 tasks`;
- `pnpm format` — exit `0`, wszystkie pliki zgodne.

**Ustalenie dla WU-01+:** bramki po `. scripts/dev/env.sh` dziedziczą dyskretne
`RA_PG*`; nie ustawiać dodatkowego `RA_DATABASE_URL`, ponieważ uniemożliwia on
izolowany override `database` w nowych poolach testowych.

## RA-038-WU-01 — Ownership map i addytywna migracja trwałości

**Status:** DONE

**Rezultat:** addytywna migracja definiuje dokładnie cztery struktury, bez
drugiego effect journalu:

1. immutable `engineering_operations` wiąże `operation_id`, istniejący
   `job_intent`, job/case/owner/run, stage+attempt, checkpoint revision,
   effect-class, deadline oraz server-owned scope/input/config/schema digests;
2. append-only `engineering_artifact_revisions` ma unikalność
   `(run_id, artifact_key, revision)` i source operation;
3. append-only `engineering_stage_events` ma monotoniczny sequence per run,
   typowany event, source operation/artifact/completion/reconciliation i
   singleton `STARTED` per operation;
4. `engineering_run_projections` jest jedyną usuwalną/mutowalną,
   odbudowywalną materializacją eventów.

Każda krawędź jest przypięta kompozytowym FK do właściwego
case/owner/run/job/intent, checkpoint revision nie może wyprzedzać bindingu
runu, a wszystkie digesty mają bazodanowy format SHA-256. `down` usuwa tylko
nowe struktury w odwrotnej kolejności i pełny `up→down→up` odtwarza schemat.

**Allowed paths:**

- `packages/database/migrations/034_engineering_control_plane.up.sql`
- `packages/database/migrations/034_engineering_control_plane.down.sql`
- `packages/database/test/migrations.integration.test.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `docs/work-units/RA-038/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/migrations.integration.test.ts packages/database/test/engineering-control-plane.integration.test.ts
```

**Dowód `2026-08-25`:**

- celowana bramka na realnym PostgreSQL — exit `0`, `12/12` (`8` migration
  lifecycle, w tym `up→down→up`, oraz `4` schema/integrity);
- append-only mutation: usunięcie triggera `engineering_operations_append_only`
  — exit `1`, test ledger mutation RED; po przywróceniu exit `0`;
- identity mutation: usunięcie `CHECK (operation_id = idempotency_key)` — exit
  `1`, test split identity RED; po przywróceniu pełne `12/12` GREEN;
- `eslint` nowego testu i `git diff --check` — exit `0`.

## RA-038-WU-02 — Strict repository: intent binding, artifacts i event append

**Status:** DONE

**Rezultat:** repository strict-parse'uje input, semantycznie replayuje identyczny
`op_id`, odrzuca collision, obcy scope/digest i stary fence. `JobStore` udostępnia
transaction-scoped `recordIntentInTransaction(tx, ...)`, a dotychczasowe
`recordIntent(db, ...)` pozostaje kompatybilnym wrapperem. Engineering repository
zapisuje intent i jego operation binding atomowo w tej samej transakcji, więc
crash nie może zostawić osieroconego intentu. `STARTED` jest committed
bezpośrednio przed dispatch; artefakty i eventy są write-once, a terminalny
receipt jest brany wyłącznie z istniejącego completion ledgeru.

**Allowed paths:**

- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/src/repositories/index.ts`
- `packages/database/src/index.ts`
- `packages/database/src/errors.ts`
- `packages/database/src/queue/job-store.ts`
- `packages/database/test/queue.integration.test.ts`
- `packages/database/test/queue-adversarial.integration.test.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `docs/work-units/RA-038/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/engineering-control-plane.integration.test.ts && pnpm --filter @remoteagent/database typecheck
```

**Dowód `2026-08-26`:**

- real PostgreSQL: schema + migration + queue regression/adversarial + control
  repository — exit `0`, `71/71`;
- database production+test typecheck, celowany ESLint i `git diff --check` — exit
  `0`;
- atomicity mutation: zamiana transaction-scoped intentu na osobny
  `JobStore.recordIntent(db, ...)` — fault-injection test exit `1`, pozostawiony
  intent (`1` zamiast `0`); po przywróceniu GREEN;
- fence mutation: usunięcie live-lease replay z `commitOperationStarted` — test
  stale fence exit `1`, obcy token zapisał `STARTED`; po przywróceniu pełne
  `71/71` GREEN.

## RA-038-WU-03 — Rekonstrukcja projekcji i crash/recovery matrix

**Status:** DONE

**Rezultat:** `prepareResume()` odtwarza stage i klasyfikuje `RECOVERED`, `DIRTY`,
`AMBIGUOUS`, `BLOCKED`, `CANCELLED` wyłącznie z durable ledgerów. Usunięcie
materialized projection i rebuild daje ten sam canonical digest. Osobne testy
utrwalają macierz crash boundaries i precedence:

- binding/intent bez `STARTED` → `DIRTY`, efekt nie był dispatchowany;
- `STARTED` read/model bez completion → `DIRTY`, tylko bounded retry z nowym
  operation ID;
- `STARTED` mutującej komendy bez pewnego receiptu → `AMBIGUOUS`, bez replayu;
- completion/receipt bez artifactu/projekcji → `RECOVERED`, konsumuj istniejący
  receipt;
- scope/digest/fence mismatch → `BLOCKED`;
- cancellation bez unresolved effect → `CANCELLED`, ale unknown write zachowuje
  `AMBIGUOUS` z `cancellation_requested` (`AMBIGUOUS > CANCELLED`).

**Allowed paths:**

- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `docs/work-units/RA-038/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/engineering-control-plane.integration.test.ts
```

**Dowód `2026-08-26`:**

- real PostgreSQL crash/recovery matrix — exit `0`, `22/22`; obejmuje no
  `STARTED`, retry-safe `STARTED`, unknown mutating write, receipt bez projekcji,
  UNRESOLVED/CONFIRMED/ABSENT, cancellation precedence, scope/fence/kill switch,
  deadline `EXHAUSTED` oraz delete+rebuild z identycznym digestem;
- database production+test typecheck i `git diff --check` — exit `0`;
- unknown-write mutation: `AMBIGUOUS→DIRTY` — exit `1`, test mutującego
  `STARTED` RED; po przywróceniu GREEN;
- scope mutation: usunięcie `scopeChanged` z fail-closed guardu — exit `1`,
  test zmiany integration scope RED; po przywróceniu finalne `22/22` GREEN.

## RA-038-WU-04 — Minimalny operator-safe recovery port

**Status:** DONE

**Rezultat:** read-only status oraz autoryzowane acknowledge/cancel/reconcile/
retry tworzą append-only operator intent+event+completion. `reconcile` deleguje
do `JobStore.reconcile()` i dopuszcza wyłącznie `CONFIRMED`, `ABSENT` albo
`UNRESOLVED`; acknowledge zapisuje wiedzę, nie outcome; retry wymaga `ABSENT`
albo braku `STARTED` i zawsze dostaje nowy operation ID; cancel jest trwałym
requestem i nie zaciera unknown write. Operator nie może nadać `SUCCESS`,
ominąć fence ani wykonać arbitralnej projekcji. Replay tej samej decyzji jest
idempotentny, kolizja fail-closed.

**Allowed paths:**

- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/src/errors.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `docs/work-units/RA-038/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/engineering-control-plane.integration.test.ts && pnpm --filter @remoteagent/database typecheck
```

**Dowód `2026-08-26`:**

- real PostgreSQL operator/recovery suite — exit `0`, `33/33`; obejmuje
  owner-scoped read bez zapisów, optimistic projection digest, acknowledge,
  cancel przed i po niepewnym efekcie, bounded retry, durable
  reconcile-request→receipt oraz ścieżkę `UNRESOLVED→ABSENT→DIRTY→retry`;
- API strict odrzuca `SUCCESS` i caller-supplied receipt fields przed zapisem;
  `commitOperationStarted` odrzuca replay, aby drugi dispatch nie mógł użyć
  istniejącego eventu `STARTED` jako pozwolenia;
- crash pomiędzy requestem reconcile a receiptem pozostaje bezpieczny:
  request jest trwały, `JobStore.reconcile()` używa `actionId` jako attempt key,
  a receipt można odtworzyć idempotentnie bez syntetycznego wyniku;
- regression z queue adversarial suite — exit `0`, łącznie `77/77`; database
  typecheck, celowany ESLint i `git diff --check` — exit `0`;
- authorization mutation: wyłączenie `actorId === owner_id` — exit `1`, test
  obcego operatora przyjął event zamiast go odrzucić; po przywróceniu GREEN;
- cancellation mutation: usunięcie durable cancel-event z pre-dispatch guardu
  — exit `1`, anulowana operacja zapisała `STARTED`; po przywróceniu finalne
  `33/33` GREEN.

## RA-038-WU-05 — Kompatybilność checkpoint/completion i mutation evidence

**Status:** DONE

**Rezultat:** istniejąca ścieżka `RunCompletionRepository`/baseline checkpoint/
outbox zachowuje semantykę, a nowe durability API nie zmienia
`SupervisorRuntime`. Osobne mutacje overwrite append-only row, pominięcia live
fence, usunięcia guardu `STARTED` i mapowania `AMBIGUOUS→SUCCESS` dają RED;
następnie po każdym przywróceniu odpowiednia bramka i na końcu pełna
niecache'owana bramka są zielone.

**Allowed paths:**

- tymczasowo ścieżki WU-01..04 do kontrolowanych mutacji i przywrócenia;
- `packages/database/test/completion-apply.integration.test.ts`
- `apps/agent-worker/test/handlers.integration.test.ts`
- `docs/tasks/RA-038.md`
- `docs/work-units/RA-038/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm lint && pnpm format && pnpm test && pnpm turbo run typecheck --force && pnpm turbo run build --force && pnpm workflow:validate
```

**Dowód `2026-08-26`:**

- kompatybilność istniejącej ścieżki completion/checkpoint/outbox oraz composition
  root workera — exit `0`, `24/24`;
- audyt locków wykrył i usunął odwróconą kolejność w
  `bindOperationIntent`: wszystkie ścieżki używają teraz `job fence→agent_run`;
  deterministyczny test blokuje job, uruchamia bind i dowodzi, że run pozostaje
  dostępny. Mutacja przywracająca `run→job` daje exit `1` przez `lock_timeout`,
  po restore test GREEN;
- mutation brakującego `STARTED`: mapowanie intent-only na `RECOVERED` — exit
  `1`, test RED; po restore GREEN;
- mutation unknown write: mapowanie unreceipted mutating `STARTED` na
  `RECOVERED` — exit `1`, test RED; po restore GREEN. Wcześniejsze unity
  dostarczyły osobne RED dla append-only overwrite i live-fence bypass;
- pełna bramka po ostatniej zmianie produkcyjnej — exit `0`: lint, format,
  `RA_REQUIRE_POSTGRES=1` testy, typecheck/build `--force` i
  `workflow:validate`; osobny finalny pełny test reporterem `dot` potwierdził
  `194/194` pliki i `2515/2515` testów;
- `typecheck --force`: `38/38`, `0 cached`; `build --force`: `26/26`,
  `0 cached`; `workflow:validate`: `OK — 45 tasks`.

## Następny task

Po `PASS`, handoffie, `DONE`, logicznych commitach i czystym drzewie Sol wybiera
pierwszy task `READY` z kolejki — RA-039 — i kontynuuje bez pauzy.
