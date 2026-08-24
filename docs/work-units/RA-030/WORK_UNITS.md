# RA-030 — Work units

Bazowy commit: `89e0dfd` (po domknięciu RA-029 + Node 24). Model auth: ADR-0010.

## WU-01 — Reużywalny transport Basic + config Jiry z env (apps/agent-worker)

- Rezultat: `jira-auth.ts` — `basicAuthTransport(email, token)` (wydzielony z dev-skryptu, ten sam
  kontrakt: `redirect: "manual"`, `finalUrl`/`redirected`, brak logowania tokenu) oraz
  `jiraReconcileConfigFromEnv(env)` → `{ origin, email, token, ownerId, connectionId, alias,
  channels, guildId }` z fail-closed na braku wymaganych. Parsowalny **bez DB i bez sieci**.
- Allowed paths: `apps/agent-worker/src/jira-auth.ts`, testy.
- Weryfikacja: `pnpm vitest run apps/agent-worker/test/jira-auth*`.
- Canary: token nie pojawia się w błędach parsera ani w reprezentacji configu.

## WU-02 — Rejestracja handlera `jira.reconcile` w worker main() (apps/agent-worker)

- Rezultat: `worker main()` buduje `JiraRestClient` (getAccessToken z env, transport Basic) +
  `ChannelRegistry` z env i rejestruje `[JobType.JIRA_RECONCILE]: createReconcileHandler(run)`
  przez `extra` — **tylko gdy** `jiraReconcileConfigFromEnv` się powiedzie; inaczej nie rejestruje.
- Allowed paths: `apps/agent-worker/src/worker.ts`, `handlers.ts` (drobny wrapper), testy kompozycyjne.
- Weryfikacja: `pnpm vitest run apps/agent-worker/test` (kompozycja: z configiem rejestruje, bez — nie).

## WU-03 — Provisioning ownera + connectiona Jira (idempotentny)

- Rezultat: `ensureJiraConnection({ db, ownerId, connectionId, alias, displayName })` — idempotentny
  upsert ownera i connectiona (provider `jira`), tak jak robi to dev-poll, ale reużywalnie.
  Wołany przy starcie workera, gdy config Jiry obecny.
- Allowed paths: `apps/agent-worker/src/*`, testy integracyjne.
- Weryfikacja: `pnpm vitest run apps/agent-worker/test` — po ensure correlate scope przechodzi;
  drugi ensure nie duplikuje.

## WU-04 — Task reconcile w scheduler main() (apps/scheduler)

- Rezultat: `scheduler main()` czyta projekty z env (`RA_JIRA_RECONCILE_PROJECTS` albo pojedynczy
  `JIRA_*`) i rejestruje `createJiraReconcileTask`; brak → brak taska + loud log.
- Allowed paths: `apps/scheduler/src/scheduler.ts` + parser env, testy.
- Weryfikacja: `pnpm vitest run apps/scheduler/test`.

## WU-05 — Bramka + docs + domknięcie

- Rezultat: pełna bramka pod Node 24 (touched + całe repo, `RA_REQUIRE_POSTGRES=1`),
  typecheck/build/lint/format, liczba przebiegów. `LOCAL_BRINGUP.md`: jak uruchomić pętlę
  produkcyjnie (3 procesy: scheduler + worker + discord-bot, wymagane env). Handoff + audyt +
  TASK_INDEX + `workflow:validate`.
