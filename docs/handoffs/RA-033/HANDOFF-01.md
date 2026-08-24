# RA-033 — HANDOFF-01

- Task: `RA-033` Kontekst zadania dla agenta: issue Jiry w transkrypcie case'a
- Data: `2026-08-24`
- Bazowy commit: `d094e67`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## W jednym zdaniu

Reconciler zapisuje treść issue Jiry (klucz/status/summary/description) do `case_messages` jako
`SYSTEM`/`UNTRUSTED_DATA`, atomowo z korelacją i idempotentnie — więc SUPERVISOR odpowiadający w
wątku widzi, czego dotyczy zadanie, a nie tylko wiadomość właściciela.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `apps/agent-worker/src/jira-issue-context.ts` | czysty `renderJiraIssueContext` (etykiety, bounds, UNTRUSTED) |
| `apps/agent-worker/src/jira-reconcile.ts` | `applyIssue` dokłada `case_messages` w tej samej `tx`, klucz `jira-issue:<eventId>` |
| `apps/agent-worker/test/jira-issue-context.test.ts` | unit renderera (3) |
| `apps/agent-worker/test/jira-reconcile.integration.test.ts` | asercje kontekstu + idempotencja (+1) |

`connector-jira` i `packages/database` **nietknięte** (`description` już parsowane; `append` już
istnieje i jest idempotentne).

## Jak zobaczyć na żywo

3 procesy jak w HANDOFF RA-032 (discord-bot + worker + scheduler; worker z `~/.remoteagent-aws.env`).
Po reconcile issue KAN-* powstaje case z **pierwszym** `case_message` = kontekst issue. Napisz w
wątku → SUPERVISOR widzi w kontekście `[SYSTEM] Jira issue KAN-… Status/Summary/Description` obok
Twojej wiadomości i odpowiada uziemiony w treści zadania.

## Środowisko — WAŻNE dla następnej sesji

PG17 na `5433` **zniknął** z maszyny. Działa tylko `postgresql@15` na `5432` (+ zatrzymany
`postgresql@18` na `7432`). Bramkę uruchomiono wobec PG15/5432 przez:
`RA_PGPORT=5432 RA_PGUSER=marcinjackowski RA_PGPASSWORD= RA_PGDATABASE=postgres RA_PGHOST=127.0.0.1`.
Migracje aplikują się czysto na PG15. Jeśli następna sesja zobaczy `ECONNREFUSED 127.0.0.1:5433`,
to jest przyczyna — albo odtworzyć PG17/5433, albo użyć tego override.

## Wejściowe ustalenia dla następnego kroku (Opcja 2 / narzędzia)

- Aktywny brokerowany read tool Jiry (model pobiera issue/linked issues na żądanie) to **L**:
  wymaga (a) kompozycji `McpToolBroker` w workerze, (b) żywego `ToolTransport` do Jiry (dziś tylko
  fake'i — wzorzec CTF-018, transport nigdy nie sprawdzony wobec żywej Atlassian), (c) per-case
  grantu `project` (reconciler go nie tworzy → `resolveToolScope` odrzuci `OUT_OF_SCOPE`), (d) step
  policy dla `SUPERVISOR` w `mcp-tool-broker` (dziś żadna nie wymienia SUPERVISOR).
- Deskryptory już są: `JIRA_READ_TOOLS` (`jira.read_issue`, scope `project`, cap `jira:read`) w
  `packages/mcp-tool-broker/src/providers.ts`.
- Write/implementer loop (edycja kodu, MR) to osobny, największy kawałek (poprzednio szkicowany jako
  RA-034): workspace + writer fence + write/patch/command + git commit + draft MR.

## Stan drzewa

Czyste po commicie. `push`/MR/deploy — osobna zgoda. Żaden zapis do Jiry/Discorda/Bedrock nie został
wykonany przez ten task (zmiana czysto lokalna + testy integracyjne na throwaway DB).
