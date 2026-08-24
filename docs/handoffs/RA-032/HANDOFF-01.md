# RA-032 — HANDOFF-01

- Task: `RA-032` Model runtime: agent myśli i odpisuje (Bedrock + config w DB)
- Data: `2026-08-24`
- Bazowy commit: `1b37895`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`; model zweryfikowany na żywo)

## W jednym zdaniu

Rola workera woła Bedrock (bearer token + model z DB config), widzi wiadomość właściciela jako
UNTRUSTED kontekst, i jej completion wraca do wątku Discorda — wszystko potwierdzone na żywo, w tym
naprawiony blocker structured-output transportu.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `packages/database/migrations/033_agent_config.*` + `repositories/agent-config.ts` | server config `model_id` + `resolveModelId` |
| `packages/bedrock-runtime/src/aws-transport.ts` | bearer token (`bedrockClientConfig`) + structured output przez tool-use (opakowany schemat) |
| `apps/agent-worker/src/roles.ts` | `createRole` karmi model rozmową (UNTRUSTED), model z DB config, bearer/region |
| `apps/agent-worker/src/completion-reply.ts` | `projectCompletionReply` → discord_case thread_message + AGENT message |
| `apps/agent-worker/src/{worker,handlers}.ts` | wpięcie resolveModelId, bearer, readCaseMessages, projekcja completion |

Testy: agent-config, bedrock-client-config, aws-transport (tool-use), role-context, completion-reply.

## Jak uruchomić pełną pętlę konwersacyjną na żywo (3 procesy)

Worker MUSI mieć w env AWS (bearer). Env: `~/.remoteagent-aws.env` (AWS_REGION + AWS_BEARER_TOKEN_BEDROCK)
+ `~/.remoteagent-discord.env` + `~/.remoteagent-jira.env`. Model w DB: `agent_config.model_id`
(ustawiony na `us.anthropic.claude-opus-4-8`).

```bash
. scripts/dev/env.sh; source ~/.remoteagent-aws.env; source ~/.remoteagent-discord.env; source ~/.remoteagent-jira.env
pnpm run build --force
RA_HEALTH_PORT=8080 node apps/discord-bot/dist/discord.js &   # relay + inbound gateway
RA_HEALTH_PORT=8081 node apps/agent-worker/dist/worker.js &   # case.resume → SUPERVISOR → Bedrock → reply
RA_HEALTH_PORT=8082 RA_SCHEDULER_INTERVAL_MS=15000 node apps/scheduler/dist/scheduler.js &
```

Napisz w **wątku istniejącego case'a** (np. KAN-74) na `#jira` → po ticku worker zbudzi się, SUPERVISOR
odpowie i odpowiedź wpadnie do wątku. (Wątek powstaje z issue Jira — RA-030.)

## Wejściowe ustalenia dla RA-033 (narzędzia)

- Agent dziś **rozmawia**, nie DZIAŁA. Tool-loop w transporcie już współistnieje z output-toolem
  (wymuszenie tylko gdy output jedyny), więc dodanie narzędzi to: adapter implementation-tools/MCP →
  `ToolExecutor` (`RuntimeToolDefinition`+`execute`), wpięcie w `createRole` per-unit, workspace per
  case (`WorkspaceRunner`), ledgery/scope. Patrz mapa w pamięci sesji.
- Model produkuje poprawny AgentCompletion przez wrapped-tool — dla RA-033 (tools + output razem)
  wymuszenia NIE ma, model sam kończy output-toolem; to już obsłużone.

## Stan drzewa

Czyste po commicie. `push`/MR/deploy — osobna zgoda. Żaden zapis do Jiry/Discorda nie został wysłany
przez ten task; wywołania Bedrock to read-only smoke (bez side-effectów).
