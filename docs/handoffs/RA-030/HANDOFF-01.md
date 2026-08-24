# RA-030 — HANDOFF-01

- Task: `RA-030` Produkcyjne wpięcie reconcile Jiry (single-owner API token)
- Data: `2026-08-24`
- Bazowy commit: `89e0dfd`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Najważniejsze w jednym zdaniu

Pętla **Jira → Discord działa przez uruchomione procesy**: scheduler enqueue'uje `jira.reconcile`,
worker odpytuje Jirę (personal API token + Basic, ADR-0010) i koreluje issue w case + wiersz
outbox `discord_case`, discord-bot relayuje go do `#jira`. Uruchamialne trzema procesami z env.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `apps/agent-worker/src/jira-auth.ts` | `basicAuthTransport` + `jiraReconcileConfigFromEnv` (fail-closed, canary tokenu) |
| `apps/agent-worker/src/jira-reconcile.ts` | `ensureJiraConnection` (idempotentny provisioning) |
| `apps/agent-worker/src/worker.ts` | `jiraReconcileHandlers` + rejestracja `jira.reconcile` w `main()` |
| `apps/scheduler/src/jira-reconcile-task.ts` | `jiraReconcileProjectsFromEnv` |
| `apps/scheduler/src/scheduler.ts` | rejestracja taska reconcile w `main()` gdy `JIRA_PROJECT_KEY` |

Testy: `jira-auth.test.ts` (5), `jira-reconcile-wiring.integration.test.ts` (2),
`jira-reconcile-projects.test.ts` (4).

## Bramka

```text
całe repo (Node 24)   2414/2414, 175 plików, DWA przebiegi, exit 0
typecheck --force 38/38   build --force 26/26   lint/format exit 0
mutacja: rejestracja handlera → {} czerwieni wiring test
```

## Jak uruchomić (produkcyjnie, lokalnie)

Trzy procesy z jednym env — pełny opis w `docs/operations/LOCAL_BRINGUP.md` §„Produkcyjna pętla".
Wymagane: `JIRA_ORIGIN/EMAIL/API_TOKEN/PROJECT_KEY` + `DISCORD_*` (kanały). `discord.js` +
`worker.js` + `scheduler.js`. Bez tokenu/projektu — handler/task niezarejestrowany (fail-closed).

## Wejściowe ustalenia dla następnego taska

- **OAuth 3LO** (jeśli kiedyś multi-account): osobny task, `Superseduje` ADR-0010. Punkty
  wstrzyknięcia (`getAccessToken`, transport) tak dobrane, by tamta zmiana nie dotykała reszty.
- **Deploy schedulera do CDK**: dziś nie w pinned entrypoints; krok AWS.
- **Pozostałe integracje** (Gmail/Calendar/GitLab): ten sam wzorzec — real-API-vs-fixture, testuj
  na żywym serwisie; producent zdarzeń analogiczny do `jira.reconcile`.
- **Katalog narzędzi roli**: agent nadal nie edytuje workspace'u (największa otwarta wartość).

## Stan drzewa

Czyste po commicie. `push`, MR, merge — osobna zgoda. Żaden write do Jiry/Discorda ani deploy nie
został wykonany przez ten task.
