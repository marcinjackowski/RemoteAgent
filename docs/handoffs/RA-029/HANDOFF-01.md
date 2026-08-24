# RA-029 — HANDOFF-01

- Task: `RA-029` Okablowanie pętli Jira → Discord (routing outboxu + reconciler)
- Data: `2026-08-24`
- Bazowy commit: `8bf005c` (po fixach connectora Jira)
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`, z blokadą środowiskową `CTF-019` poza zakresem)

## Najważniejsze w jednym zdaniu

Outbox routuje teraz per-aggregat, discord-bot dostarcza `discord_case`, a `jira.reconcile`
zamienia zmianę w Jirze w case + wiersz outbox — czyli składniki pętli **Jira → Discord** są
okablowane i przetestowane. Przed tym taskiem jedyny relay (worker) rzucał na `discord_case`, więc
żadna wiadomość nie mogła dotrzeć do Discorda.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `packages/database/src/queue/outbox.ts` | `relayOnce` przyjmuje `aggregates?` — klaim filtruje po `outbox.aggregate` (ADR-0009) |
| `packages/database/src/queue/scheduler.ts` | `Scheduler.relay.aggregates` przekazywane do `relayOnce` |
| `packages/database/src/queue/dispatch.ts` | nowy `JobType.JIRA_RECONCILE` |
| `apps/agent-worker/src/worker.ts` | worker relay scoped `aggregates: []` — nie klaimuje `discord_case` |
| `apps/discord-bot/src/outbox-relay.ts` | `startOutboxRelay` — lekki loop tylko-relay |
| `apps/discord-bot/src/discord.ts` | `createDiscordProcess` startuje relay scoped `["discord_case"]` |
| `apps/agent-worker/src/jira-reconcile.ts` | `createJiraReconcileRun` — reconcile + correlate (search wstrzykiwany) |
| `apps/scheduler/src/jira-reconcile-task.ts` | `createJiraReconcileTask` — enqueue `jira.reconcile` + dedupe |

Testy: `queue.integration` (scoped relay), `relay-scope.integration` (worker),
`test/processes/discord-relay.integration` (discord proc), `jira-reconcile.integration` (worker run),
`jira-reconcile-task.integration` (scheduler), zaktualizowany `dispatch.test.ts`.

## Bramka

```text
RA_REQUIRE_POSTGRES=1 vitest run  (podsystemy RA-029, 21 plików)   150/150, exit 0
typecheck --force   38/38    build --force   26/26    lint/format   exit 0
git diff --check    clean
mutation checks: 4 units, każdy czerwony po zepsuciu i zielony po przywróceniu
```

Pełny przebieg repo: **22 faile środowiskowe** (`CTF-019`, Node v25 vs przypięty 24.19.0),
reprodukcja na bazie, w pakietach których RA-029 nie dotyka. NIE jest to regresja RA-029.

## Jak uruchomić pętlę (wejściowe ustalenia dla następnego taska)

Trzy rzeczy do podłączenia, żeby pętla ruszyła na żywo — w kolejności:

1. **Żywy token Jiry dla workera.** `createJiraReconcileRun` przyjmuje wstrzykiwany `search`
   (`JiraRestClient`). Dev: transport Basic jak w `scripts/dev/jira-poll.ts`; prod: OAuth 3LO.
   Zarejestrować handler w `worker main()` przez `extra` (jak `jira.webhook.renewal` — oba
   czekają na tę samą decyzję credentiali).
2. **Task reconcile w `scheduler main()`** z listą projektów (owner/connection/project) z env.
   Enqueue jest creds-free; włączać dopiero razem z (1), inaczej joby idą do DLQ.
3. **Deploy `scheduler` do CDK** (dziś nie w entrypointach) — krok AWS, nieweryfikowalny lokalnie.

Routing (WU-01..03) jest już w produkcyjnych `main()`: discord-bot prowadzi relay, worker nie
klaimuje `discord_case`. Brakuje tylko produkcyjnego **źródła** wierszy (reconcile z tokenem).

## Blokada do naprawy: `CTF-019` (Node)

Maszyna ma Node v25.2.1; repo chce 24.19.0; brew `node@24` też wskazuje v25. Postawić Node 24
(nvm) i powtórzyć pełną bramkę — wtedy 22 faile znikają. `env.sh` powinien fail-closować na
niezgodnym majorze. To blokada repo-szeroka, nie RA-029.

## Stan drzewa

Czyste po commicie. `push`, MR i merge **wymagają osobnej zgody**. Żaden deploy ani call do AWS
nie został wykonany; żaden write do Jiry ani Discorda nie został wysłany przez ten task.
