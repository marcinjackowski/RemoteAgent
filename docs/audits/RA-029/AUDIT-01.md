# RA-029 — AUDIT-01

- Task: `RA-029` Okablowanie pętli Jira → Discord (routing outboxu + reconciler)
- Data: `2026-08-24`
- Bazowy commit: `8bf005c` (po fixach connectora Jira)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt jest w §7.

## 1. Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 vitest run   (podsystemy dotknięte przez RA-029)
  packages/database/test/queue.integration.test.ts
  packages/database/test/dispatch.test.ts
  packages/connector-jira
  apps/agent-worker/test
  apps/scheduler/test
  test/processes/discord-relay.integration.test.ts
  → 150/150, 21 plików, exit 0

pnpm run typecheck --force   → 38 successful, 0 cached
pnpm run build --force       → 26 successful, 0 cached
pnpm run lint                → exit 0
pnpm run format              → exit 0
git diff --check             → clean
```

Pełny przebieg repo: **2380/2403, 23 faile** — patrz §6 (22 środowiskowe = `CTF-019`,
1 to zaktualizowany `dispatch.test.ts`, teraz zielony).

## 2. Kryteria akceptacji — osobno

- **AC1** (relay przyjmuje allow-listę aggregatów; brak = obecne zachowanie; klaim filtruje po
  `outbox.aggregate`): **spełnione**. `relayOnce` + `Scheduler.relay.aggregates`
  (`outbox.ts`, `scheduler.ts`). Test `queue.integration` (scoped + pusta lista + default).
  Mutacja: filtr → tautologia, wiersz spoza scope klaimowany (`attempts` 0→1), test czerwony.
- **AC2** (worker nie klaimuje/DLQ-uje `discord_case`): **spełnione**. `worker.ts`
  `relay: { aggregates: [] }`. Test `relay-scope.integration`. Mutacja: scope usunięty →
  `attempts` 0→1, czerwony.
- **AC3** (discord-bot prowadzi relay `discord_case` przez dispatcher): **spełnione**.
  `createDiscordProcess` startuje `startOutboxRelay` scoped do `DISCORD_OUTBOX_AGGREGATE`.
  Test `test/processes/discord-relay.integration`. Mutacja: zła lista aggregatów → nic
  dostarczone, czerwony.
- **AC4** (periodyczny reconcile z realnym `applyIssue` → `correlateJiraIssueInTransaction`
  produkuje wiersz `discord_case`): **spełnione**. `apps/agent-worker/src/jira-reconcile.ts`
  (worker run) + `apps/scheduler/src/jira-reconcile-task.ts` (enqueue+dedupe). Testy
  `jira-reconcile.integration` (worker: wiersz `discord.root_thread`) i
  `jira-reconcile-task.integration` (scheduler: enqueue+dedupe). Mutacja: `applyIssue` no-op →
  brak wiersza `discord_case`, czerwony.
- **AC5** (pełna bramka repo zielona): **NIESPEŁNIONE — blokada środowiskowa, nie RA-029**.
  Patrz §6 i `CTF-019`.

## 3. Decyzja architektoniczna

Routing outboxu per-aggregat rozstrzygnięty w [ADR-0009](../../decisions/ADR-0009-outbox-aggregate-routing.md):
aggregate-scoped relay (allow-lista w `relayOnce`/`Scheduler`), a nie routing sink. Wstecznie
kompatybilne (brak listy = obecne zachowanie), więc istniejące testy RA-004 pozostają ważne.

## 4. Świadome zawężenia

- Dostawa aggregatów `case` i `jira_webhook` — poza zakresem (brak konsumenta dziś, nie na
  ścieżce Jira→Discord). Po zmianie worker zostawia je `PENDING` (nie DLQ) — poprawa.
- Rejestracja reconcile handlera w `worker main()` i tasku w `scheduler main()` z **żywym
  tokenem Jiry** (OAuth prod / Basic dev) — deferred jak `jira.webhook.renewal` w RA-028.
  Building blocki istnieją i są przetestowane; wiązanie credentiali to krok wdrożeniowy.
- Deploy `scheduler` do CDK — osobny krok (nieweryfikowalny bez AWS).

## 5. Diff od bazy — przeczytany

`packages/database/src/queue/{outbox,scheduler,dispatch}.ts` (routing + JobType),
`apps/agent-worker/src/{worker,jira-reconcile}.ts` + package.json (dep discord),
`apps/discord-bot/src/{discord,index,outbox-relay}.ts`, `apps/scheduler/src/jira-reconcile-task.ts`,
plus testy i `dispatch.test.ts`. Żadna zmiana kontraktu poza ADR-0009.

## 6. Pełna bramka repo — 22 faile środowiskowe (`CTF-019`)

Pełny `vitest run`: 22 faile w `workspace-runner/process-runner`, `test-evidence/evidence`,
`implementation-tools/command`, `golden-path` — wszystkie w klasyfikacji wyniku procesu
(`AMBIGUOUS`/`TIMED_OUT`/`INCONCLUSIVE`). **Zmierzone na czystej bazie** (`git stash -u`): te same
faile bez zmian RA-029 → preexisting. Przyczyna: Node **v25.2.1** vs przypięty **24.19.0** (brak
realnego Node 24 na maszynie). RA-029 nie dotyka żadnego z tych pakietów. Ujęte jako `CTF-019`.

## 7. Werdykt

Kryteria własne RA-029 (AC1–AC4) spełnione z uruchomionym dowodem i mutation checkiem; AC5
zablokowane wyłącznie blokadą środowiskową `CTF-019` (Node v25, reprodukcja na bazie, poza
zakresem RA-029). Odebrane decyzją właściciela (`2026-08-24`) na dowodzie in-scope.

- Werdykt: `PASS`
