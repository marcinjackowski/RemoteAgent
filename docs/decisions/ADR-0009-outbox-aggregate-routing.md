# ADR-0009 — Routing outboxu per-aggregat do sinków procesowych

- Status: Accepted
- Date: 2026-08-23
- Task: RA-029

## Kontekst

Pełna pętla produktu **zmiana w Jirze → wiadomość na Discordzie** nie jest dziś
uruchamialna. Cała logika środka istnieje i jest przetestowana, ale rozpoznanie
(`2026-08-23`) wykazało, że transakcyjny outbox relay (RA-004) **nie ma routingu
per-aggregat**:

- `OutboxRepository.relayOnce` (`packages/database/src/queue/outbox.ts:152`) klepie
  **dowolny** pending wiersz `outbox_dispatch` (`WHERE d.status='PENDING' ...`, bez
  warunku na `aggregate`) i oddaje go **jednemu** sinkowi.
- `Scheduler.tick` (`packages/database/src/queue/scheduler.ts:71`) woła `relayOnce`
  z pojedynczym `sink`.
- W produkcji relay prowadzi **tylko** worker (`apps/agent-worker/src/worker.ts:139`),
  a jego sink **rzuca** na każdy nie-swój aggregat
  (`worker.ts:237`). `discordOutboxSink` (`apps/discord-bot/src/index.ts:43`) rzuca na
  każdy nie-`discord_case`.

Outbox niesie trzy aggregaty o różnych konsumentach:

| aggregate | event_types | konsument |
|---|---|---|
| `discord_case` | `discord.root_thread`, `discord.thread_message`, `discord.status` | `DiscordDispatcher` → Discord |
| `case` | `agent.completion.recorded`, `decision.requested` | (brak — preexisting luka) |
| `jira_webhook` | renewal | (brak — preexisting luka) |

### Problem

1. **Dziś:** gdyby powstał wiersz `discord_case`, jedyny relay (worker) złapałby go i
   **rzucił** → retry → DLQ. Nic tego nie dostarczy.
2. **Naiwne dopięcie relayu do discord-bota:** dwa relaye biłyby się o wiersze —
   `FOR UPDATE SKIP LOCKED` nie rozróżnia aggregatów, więc każdy proces klepnąłby
   cudzy wiersz i dead-letterował go w swoim wąskim sinku.

Deployment jest wieloprocesowy (osobne serwisy ECS: `discord`, `worker`, `executor` —
`infra/cdk/src/compute-stack.ts`), a transport dostawy (gateway Discorda) żyje wyłącznie
w `discord-bot`. Nie da się więc mieć jednego sinka obsługującego wszystko bez
przeniesienia gatewaya między procesami.

## Decyzja

**Aggregate-scoped relay.** `relayOnce` i `Scheduler` dostają opcjonalną **allow-listę
aggregatów**. Każdy proces prowadzący relay deklaruje, które aggregaty konsumuje; klaim
filtruje po `outbox.aggregate` już w CTE `claimable`, więc proces **nigdy nie klaimuje**
wiersza, którego nie umie dostarczyć.

- `relayOnce(db, sink, { aggregates?: readonly string[] })`. Gdy `aggregates` jest
  podane, CTE `claimable` dołącza `outbox o` i filtruje `o.aggregate = ANY($aggregates)`.
  **Brak `aggregates` = obecne zachowanie** (klaimuje wszystko) — zmiana jest wstecznie
  kompatybilna, więc nie łamie istniejących bramek.
- `SchedulerDeps.relay` zyskuje `aggregates?`, przekazywane do `relayOnce`.
- `apps/discord-bot`: uruchamialny proces prowadzi relay ograniczony do
  `["discord_case"]` z `discordOutboxSink`.
- `apps/agent-worker`: relay ograniczony tak, by **nie klaimował** `discord_case`.
  Worker jest procesorem jobów, nie deliwererem — jego sink pozostaje siatką
  bezpieczeństwa, która nigdy nie powinna zostać wywołana.

### Dlaczego allow-lista, nie routing sink

Rozważono jeden proces z sinkiem rozgałęziającym po `message.aggregate`. Odrzucone:
wymagałby, żeby gateway Discorda (i przyszłe transporty dostawy) żyły w jednym procesie,
co przeczy wieloprocesowemu deploymentowi i skupia blast radius. Filtr klaimu jest
mniejszą zmianą, egzekwuje rozdział na poziomie bazy (`SKIP LOCKED` na rozłącznych
zbiorach = brak kontencji między procesami) i jest wstecznie kompatybilny.

### Zakres i świadome zawężenia

- W zakresie RA-029: dostawa `discord_case` (ścieżka Jira→Discord) i produkcyjne
  źródło tych wierszy (periodyczny reconciler Jiry z realnym `applyIssue` →
  `correlateJiraIssue`).
- **Poza zakresem, świadomie:** dostawa aggregatów `case` i `jira_webhook`. Nie mają
  konsumenta **dziś** (worker rzuca na oba) i **nie leżą** na ścieżce Jira→Discord.
  Po tej zmianie worker przestaje je DLQ-ować — zostają `PENDING` do czasu, aż dostaną
  własny scoped relay w osobnym tasku. To jest **poprawa**, nie regresja: `PENDING` jest
  odzyskiwalny, `DEAD_LETTER` nie.
- **Deployment AWS (CDK):** `scheduler` nie jest dziś wdrożony (pinned entrypoints:
  `discord`, `executor`, `ingress`, `worker`). RA-029 czyni pętlę uruchamialną i
  przetestowaną **lokalnie**; dodanie serwisu `scheduler` do CDK jest osobnym krokiem
  wdrożeniowym (nie da się go zweryfikować bez AWS na tej maszynie), odnotowanym w
  handoffie.

## Konsekwencje

- Zmiana dotyka zaakceptowanego kontraktu RA-004 (`relayOnce`, `Scheduler`) — stąd ten
  ADR. Domyślne zachowanie bez `aggregates` jest zachowane, więc istniejące testy RA-004
  pozostają ważne bez zmian.
- `discord-bot` przestaje być tylko sesją wejściową — prowadzi też relay wyjściowy.
- Inwariant: suma allow-list wszystkich prowadzonych relayów powinna pokrywać aggregaty,
  które mają być dostarczone; aggregat spoza sumy zostaje `PENDING` (widoczny, nie
  zgubiony). To jawny, testowalny warunek, nie ciche założenie.
