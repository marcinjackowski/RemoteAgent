# RA-029 — Work units

Kolejność wykonania. Jeden rezultat, jedna komenda weryfikacyjna na krok. Bazowy commit:
`8bf005c` (po fixach connectora Jira).

## WU-01 — Aggregate-scoped relay (packages/database)

- Rezultat: `relayOnce` przyjmuje `options.aggregates?: readonly string[]`; gdy podane, CTE
  `claimable` dołącza `outbox o` i filtruje `o.aggregate = ANY($n)`. `SchedulerDeps.relay`
  zyskuje `aggregates?`, przekazywane do `relayOnce`. Brak listy = obecne zachowanie.
- Allowed paths: `packages/database/src/queue/outbox.ts`,
  `packages/database/src/queue/scheduler.ts`, testy outboxu/schedulera.
- Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/outbox* packages/database/test/scheduler*`.
- Mutacja: usunięcie warunku `aggregate = ANY(...)` → test „relay ograniczony do X nie
  klaimuje Y" czerwieni się.

## WU-02 — Worker nie klaimuje cudzych aggregatów (apps/agent-worker)

- Rezultat: worker Scheduler dostaje `relay: { aggregates: [] }` (lub jawny zbiór własnych;
  dziś worker nie dostarcza żadnego aggregatu). `discord_case` nie jest już klaimowany ani
  DLQ-owany przez workera.
- Allowed paths: `apps/agent-worker/src/worker.ts`, jego testy kompozycyjne.
- Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run apps/agent-worker/test`.
- Mutacja: przywrócenie klaimowania wszystkiego → test „worker zostawia discord_case
  PENDING" czerwieni się.

## WU-03 — Discord-bot prowadzi relay wyjściowy (apps/discord-bot)

- Rezultat: uruchamialny proces discord-bota prowadzi relay ograniczony do
  `["discord_case"]` z `discordOutboxSink`, obok sesji wejściowej. Env-kontrakt parsowany
  osobno (konwencja `env.ts`).
- Allowed paths: `apps/discord-bot/src/{env,discord,index}.ts` + nowy plik relayu, testy.
- Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run apps/discord-bot/test`.
- Mutacja: wiersz `discord_case` PENDING → po ticku relayu dostarczony do fake gateway
  (startThread + sendThreadMessage); usunięcie relayu → wiersz zostaje PENDING.

## WU-04 — Periodyczny reconciler Jiry (apps/scheduler)

- Rezultat: `SchedulerTask` wykonujący `reconcileJiraIssues` z realnym `applyIssue` →
  `correlateJiraIssueInTransaction` (owner/connection/channelRegistry z env). Zarejestrowany
  w `apps/scheduler` `main()`. `JiraRestClient` z transportem produkcyjnym (Bearer/OAuth) —
  dev używa Basic przez `jira-poll.ts`, prod przez OAuth (poza zakresem konfiguracja tokenu).
- Allowed paths: `apps/scheduler/src/*`, testy integracyjne.
- Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run apps/scheduler/test`.
- Mutacja: `applyIssue` no-op → test „reconcile produkuje wiersz discord_case" czerwieni się.

## WU-05 — Pełna bramka + dowód lokalny + docs

- Rezultat: pełna bramka repo (lint/format/typecheck --force/build --force/vitest
  `RA_REQUIRE_POSTGRES=1`), liczba przebiegów. Aktualizacja `docs/operations/LOCAL_BRINGUP.md`
  o uruchomienie pętli lokalnie. Handoff + audyt + TASK_INDEX + `workflow:validate`.
- Weryfikacja: pełna bramka; `pnpm workflow:validate` = OK.
- Uwaga: live end-to-end (realna zmiana w Jirze → wiadomość na Discordzie) wykonuje
  operator z credentialami; automatyczny dowód to test integracyjny WU-03/WU-04.
