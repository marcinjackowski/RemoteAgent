# RA-032 — Work units

Bazowy commit: `1b37895` (po RA-031). Node 24. Decyzje: patrz task.

## WU-01 — `agent_config` (DB server config dla model_id)

- Rezultat: migracja `033_agent_config` (klucz-wartość server-owned, np. single-row lub key/value;
  `model_id`). `AgentConfigRepository` get/set. `resolveModelId(db, env)` = DB → env
  (`BEDROCK_MODEL_ID`/`RA_MODEL_ID`) → bezpieczny default.
- Weryfikacja: `vitest run packages/database/test/agent-config*`. Mutacja: brak odczytu DB → zawsze default.

## WU-02 — Bearer token w `AwsBedrockTransport` (packages/bedrock-runtime)

- Rezultat: gdy `AWS_BEARER_TOKEN_BEDROCK` ustawione, `AwsBedrockTransport` buduje
  `BedrockRuntimeClient` z `token` (httpBearerAuth); region z `AWS_REGION`/opcji. Bez tokenu — obecny
  domyślny łańcuch (bez regresji).
- Weryfikacja: `vitest run packages/bedrock-runtime/test` — klient dostaje token gdy env obecny;
  brak env → brak tokenu. Mutacja: ignorowanie env → test czerwony.

## WU-03 — Worker rozwiązuje model z config przy dispatchu (apps/agent-worker)

- Rezultat: `roleConfigFromEnv`/wiring workera używa `resolveModelId(db, env)` zamiast czystego env.
  Bearer token czytany z env do transportu.
- Weryfikacja: `vitest run apps/agent-worker/test` — model z DB config wygrywa nad env.

## WU-04 — Emisja `thread_excerpt` (agent-orchestrator + worker snapshot)

- Rezultat: `WorkerPersistence.recover` niesie ostatnie `case_messages`; `recovery.ts` rozszerza
  `exact()` snapshotu o opcjonalne `messages` i emituje `thread_excerpt` (UNTRUSTED, scope=pierwszy
  binding). Agent-orchestrator DB-free.
- Weryfikacja: test recovery/buildContext — fragment obecny z treścią. Mutacja: brak emisji → brak fragmentu.

## WU-05 — Projekcja completion → `discord_case` thread_message

- Rezultat: konsument outboxu `aggregate:"case"` (albo rozszerzenie apply completion) emitujący
  `discord_case` `thread_message` z podsumowaniem completion, routowany do wątku case'a. Relay z RA-029
  dostarcza. Idempotentnie.
- Weryfikacja: test — completion → wiersz discord_case thread_message do właściwego wątku.

## WU-06 — Smoke na żywo + bramka + domknięcie

- Rezultat: z `~/.remoteagent-aws.env` (region + bearer) uruchomiony worker woła Bedrock; owner pisze
  w wątku → agent odpisuje. Pełna bramka (Node 24), typecheck/build/lint/format, przebiegi. Handoff +
  audyt + TASK_INDEX + validate + LOCAL_BRINGUP.
