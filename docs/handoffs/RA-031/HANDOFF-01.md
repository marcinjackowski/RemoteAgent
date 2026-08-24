# RA-031 — HANDOFF-01

- Task: `RA-031` Inbound conversation loop
- Data: `2026-08-24`
- Bazowy commit: `fa293a4`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## W jednym zdaniu

Odpowiedź właściciela w wątku case'a staje się **trwałą pracą**: zapisana jako UNTRUSTED
`case_messages`, zmaterializowana w PENDING SUPERVISOR unit + `case.resume`, przez wpięty
`onInboundOutcome`. To warunek, żeby agent w ogóle mógł zareagować (dokończenie w RA-032).

## Co powstało

| Ścieżka | Rola |
|---|---|
| `packages/database/src/repositories/case-message.ts` | repo nad istniejącą (migracja 003) tabelą `case_messages` |
| `packages/database/src/repositories/inbound-message.ts` | `receiveOwnerMessage` — 1 tx: msg + PENDING SUPERVISOR unit + `case.resume`, idempotentne na message_id |
| `packages/discord/src/intake.ts` | `messageId` przewleczone do `IntakeOutcome.message` |
| `apps/discord-bot/src/{lifecycle,env}.ts` | id z MESSAGE_CREATE; `createOwnerMessageSink` wpięty w `onInboundOutcome` |

Testy: case-message (2), inbound-message (3, +mutacja), intake-message-id (2), owner-message-sink (2).

## Kluczowe ustalenia

- **Tabela `case_messages` istniała od RA-003, bez repo** — nie trzeba było migracji. OWNER/AGENT/SYSTEM
  + trust + append-only trigger. Odpowiedzi agenta zapiszą się jako `AGENT` (RA-032).
- **Samo `case.resume` nic nie robi** — `SupervisorRuntime` uruchamia rolę tylko dla trwałego
  PENDING unitu z objective. Dlatego `receiveOwnerMessage` materializuje unit, nie tylko enqueue.
- Dedupe redelivery gatewaya: `case_messages.message_id` = id wiadomości Discord (`ON CONFLICT`).

## Wejściowe ustalenia dla RA-032 (model)

1. **Najpierw AC3 RA-031**: `WorkerPersistence.recover` niesie ostatnie `case_messages` w snapshot;
   `recovery.ts` emituje `thread_excerpt` (UNTRUSTED, scope=pierwszy binding case'a) — wymaga
   rozszerzenia `exact()` snapshotu o opcjonalne `messages`. Weryfikować z modelem end-to-end.
2. **Transport modelu** — decyzja właściciela w toku (Bedrock bezpośredni vs bezpośrednie Anthropic
   API vs CLI). Kluczowe: backend MUSI zwracać bloki tool-use, żeby RemoteAgent mediował narzędzia
   przez policy/broker (RA-033). Agentowe CLI (claude/opencode/codex) prowadzą WŁASNĄ pętlę narzędzi
   → omijają policy/scope → niezgodne z kontraktem. Raw model API (Bedrock Converse / Anthropic) — tak.
3. **Projekcja completion→Discord**: `run_completions` emituje outbox `aggregate:"case"` — nikt go nie
   konsumuje. Żeby agent ODPISAŁ w wątku, trzeba projekcji `case`→`discord_case` thread_message
   (nowy brak, do RA-032).

## Stan drzewa

Czyste po commicie. `push`/MR/deploy — osobna zgoda. Żaden model nie został wywołany.
