# RA-030 — AUDIT-01

- Task: `RA-030` Produkcyjne wpięcie reconcile Jiry (single-owner API token)
- Data: `2026-08-24`
- Bazowy commit: `89e0dfd` (po domknięciu RA-029 + Node 24 / CTF-019)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt jest w §6.

## 1. Bramka — uruchomiona (Node 24.19.0)

```text
RA_REQUIRE_POSTGRES=1 vitest run   (całe repo)   2414/2414, 175 plików, DWA przebiegi, exit 0
RA_REQUIRE_POSTGRES=1 vitest run apps/agent-worker/test apps/scheduler/test   37/37
pnpm run typecheck --force   38/38, 0 cached
pnpm run build --force       26/26, 0 cached
pnpm run lint                exit 0
pnpm run format              exit 0
```

Testy: 2403 → **2414** (+11: jira-auth 5, wiring 2, projects 4). Node egzekwowany po majorze
(CTF-019 domknięty), więc podsystem procesów/timeoutów jest zielony.

## 2. Kryteria akceptacji — osobno

- **AC1** (transport Basic + config z env, fail-closed): **spełnione**. `jira-auth.ts`:
  `basicAuthTransport` + `jiraReconcileConfigFromEnv` (null gdy brak tokenu, throw gdy token jest
  a reszta niekompletna). Test `jira-auth.test.ts` (5), w tym canary tokenu i nagłówek Basic.
- **AC2** (rejestracja handlera tylko gdy skonfigurowane): **spełnione**. `jiraReconcileHandlers`
  w `worker.ts` rejestruje `jira.reconcile` gdy config ≠ null; inaczej `{}`. Test
  `jira-reconcile-wiring.integration.test.ts`. Mutacja: `return {}` zamiast rejestracji →
  test czerwony.
- **AC3** (idempotentny provisioning owner+connection): **spełnione**. `ensureJiraConnection`
  (`jira-reconcile.ts`). Test: connection `provider=jira, owner=owner-local, alias=private`;
  drugie wywołanie nie duplikuje.
- **AC4** (env-kontrakt bez DB/sekretu/sieci; token nie w logach): **spełnione**. Parser czysty,
  błędy nazywają zmienną nie wartość; canary w teście. Alias walidowany `connectionAliasSchema`.
- **AC5** (bramka zielona): **spełnione** — §1, całe repo 2414/2414 pod Node 24.

## 3. Decyzja architektoniczna

Model auth rozstrzygnięty w [ADR-0010](../../decisions/ADR-0010-single-owner-jira-api-token.md):
personal API token + Basic (system jednego właściciela; OAuth 3LO świadomie pominięty). Transport
Basic to sankcjonowany punkt wstrzyknięcia klienta (RA-016), nie osłabienie kontraktu.

## 4. Świadome zawężenia

- Bez OAuth 3LO/refresh/multi-connection. `CredentialVault` nie na tej ścieżce (env = źródło).
- Deploy schedulera do CDK — osobny krok AWS (nieweryfikowalny lokalnie).
- Live end-to-end (realna wiadomość na Discordzie) wykonuje właściciel z credentialami; dowód
  automatyczny to `jira-reconcile.integration` (reconcile→correlate→outbox) + `discord-relay`
  (outbox→dispatcher) z RA-029, plus wiring/provisioning z tego taska.

## 5. Diff od bazy — przeczytany

`apps/agent-worker/src/{jira-auth,jira-reconcile,worker}.ts`, `apps/scheduler/src/{scheduler,
jira-reconcile-task}.ts`, testy, `docs` (ADR-0010, task, work units, LOCAL_BRINGUP). Żadna zmiana
kontraktu poza ADR-0010.

## 6. Werdykt

Wszystkie kryteria (AC1–AC5) spełnione z uruchomionym dowodem i mutation checkiem; pełna bramka
repo zielona pod Node 24. Pętla Jira→Discord jest uruchamialna produkcyjnie (3 procesy) w modelu
single-owner API token.

- Werdykt: `PASS`
