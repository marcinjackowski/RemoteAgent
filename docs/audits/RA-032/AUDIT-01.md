# RA-032 — AUDIT-01

- Task: `RA-032` Model runtime: agent myśli i odpisuje (Bedrock + config w DB)
- Data: `2026-08-24`
- Bazowy commit: `1b37895` (po RA-031)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt w §6.

## 1. Bramka — uruchomiona (Node 24.19.0)

```text
RA_REQUIRE_POSTGRES=1 vitest run   (całe repo)   2430/2430, 183 pliki, DWA przebiegi, exit 0
typecheck --force 38/38   build --force 26/26   lint OK   format OK
```

Testy 2423 → **2430** (+7: agent-config 2, bedrock-client-config 3→ (net), aws-transport tool-use 3,
role-context 2, completion-reply 2; minus 4 obsolete outputConfig/non-finite). Model wywołany **na
żywo** (patrz §2).

## 2. Live verification (token AWS właściciela)

```text
plain converse us.anthropic.claude-opus-4-8         → "READY"        (bearer auth OK)
bare anthropic.claude-sonnet-4-5-... on-demand      → ValidationException (needs inference profile)
outputConfig structured output                      → ValidationException (Bedrock REJECTS)
tool-use structured output (wrapped oneOf schema)   → valid AgentCompletion
createRole.invoke (SUPERVISOR, live)                → status=COMPLETED, summary o pytaniu ownera
```

## 3. Kryteria akceptacji — osobno

- **AC1** (model_id w DB config): **spełnione**. `agent_config` (migracja 033) + `resolveModelId`
  (DB → env → default). Default naprawiony na `us.` inference profile (bare id nie działa on-demand).
- **AC2** (bearer auth): **spełnione + live**. `bedrockClientConfig` przekazuje `AWS_BEARER_TOKEN_BEDROCK`
  jako `token` (zweryfikowane: SDK nie auto-czyta tej zmiennej). Region z `AWS_REGION`.
- **AC3** (agent widzi wiadomość): **spełnione**. `createRole` wysyła rozmowę jako osobną UNTRUSTED turę.
- **AC4** (completion → Discord): **spełnione**. `projectCompletionReply` → `discord_case` thread_message
  (reserveSeq) + AGENT message, idempotentne, wpięte w completion path.
- **AC5** (smoke live): **spełnione**. SUPERVISOR na żywo → poprawny AgentCompletion (§2). Odkryto i
  naprawiono blocker transportu (§5).
- **AC6** (bramka): **spełnione** — §1.

## 4. Decyzje

Model backend: Bedrock direct (ADR-0007 transport). Auth: personal Bedrock API key (bearer). Model:
DB server config. (Wszystkie potwierdzone przez właściciela `2026-08-24`.)

## 5. Live-wykryty defekt RA-007 — naprawiony (wzorzec CTF-018)

`AwsBedrockTransport` prosił o structured output przez `outputConfig`, które **żywy Bedrock odrzuca**
(`output_config.format: Extra inputs are not permitted`). Transport nigdy nie był testowany wobec
realnego Bedrocka (fake w testach). Przebudowa: structured output przez **wymuszone narzędzie**
(`toolConfig`+`toolChoice`), a że schematy kontraktów bywają top-level `oneOf` (AgentCompletion),
a Bedrock tool inputSchema wymaga top-level `object`, schemat jest **opakowany** pod `output` i
odpakowany w `responseContent`. Współistnieje z pętlą narzędzi (RA-033): wymuszenie tylko gdy output
jest jedynym narzędziem. Zweryfikowane raw + live + 3 testy transportu. NIE dodane do
CROSS_TASK_FINDINGS (naprawione w tasku; otwarty HIGH wywróciłby test acceptance RA-026).

## 6. Werdykt

Wszystkie AC spełnione z uruchomionym dowodem, w tym live model. Rola SUPERVISOR na żywo czyta
wiadomość właściciela i zwraca poprawny AgentCompletion; projekcja dostarcza odpowiedź do wątku.
Świadome zawężenie: narzędzia/workspace (agent DZIAŁA, nie tylko rozmawia) — RA-033.

- Werdykt: `PASS`
