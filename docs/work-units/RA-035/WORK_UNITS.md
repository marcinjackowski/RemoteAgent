# RA-035 — Work units

Bazowy commit: `1d7138b` (po CTF-020 + live-test fixes).

Decyzja właściciela (2026-08-25): loader = **natywny wskaźnik „Bot pisze…"** Discorda
(`POST /channels/{threadId}/typing`), efemeryczny ~10 s, bez śmieci w wątku. Nie placeholder,
nie osobna wiadomość.

Ograniczenia z mapowania ścieżki dostawy:
- Worker rozmawia z Discordem TYLKO przez outbox (relay ~1 s, aggregate `discord_case`).
- `editMessage` istnieje; `delete` i `typing` NIE — trzeba dodać metodę gateway.
- Typing jest jednorazowy, best-effort: nie może dead-letterować ani blokować kolejki seq.

## WU-01 — Port + payload + event type dla „typing"

- Rezultat: nowy event `discord.thread_typing` (payload `{ case_id }`, `z.strictObject`),
  `DISCORD_EVENT_TYPES.THREAD_TYPING`, oraz metoda portu
  `DiscordGateway.triggerTyping({ threadId }): Promise<void>`.
- Allowed paths: `packages/discord/src/messages.ts`, `packages/discord/src/gateway.ts`.
- Weryfikacja: `pnpm --filter @remoteagent/discord test` (schema + typy) — zielone.
- Status: `DONE`. `threadTypingPayload` + `THREAD_TYPING` + `triggerTyping` w porcie.

## WU-02 — Routing w dispatcherze + implementacje gateway

- Rezultat: `DiscordDispatcher.deliver` routuje `THREAD_TYPING` → prywatne
  `#deliverThreadTyping` (resolve binding → jeśli brak wątku, best-effort skip; inaczej
  `gateway.triggerTyping`, błąd połknięty; NIGDY nie rzuca → outbox oznacza PUBLISHED,
  brak dead-letter, brak seq/receipt). Implementacja `triggerTyping` w
  `DiscordRestGateway` (`POST /channels/{threadId}/typing`, bez body) i `FakeDiscordGateway`
  (nagrywa wywołania).
- Allowed paths: `packages/discord/src/dispatcher.ts`, `packages/discord/src/fakes.ts`,
  `apps/discord-bot/src/rest-gateway.ts`, plus testy dispatcher/rest-gateway.
- Weryfikacja: dispatcher test (routing → triggerTyping; brak wątku → brak throw, brak
  wywołania; throw gateway → połknięty, `delivered`); rest-gateway contract test
  (POST /typing). Mutation: routing usunięty → test RED.
- Status: `DONE`. `#deliverThreadTyping` (best-effort, no seq/receipt, nigdy nie rzuca) +
  `triggerTyping` w `DiscordRestGateway` i `FakeDiscordGateway`. 3 testy dispatcher + 1 rest-gateway
  contract. Mutation WU-02 (routing → `void gateway`): test „triggers native indicator" RED,
  przywrócone GREEN.

## WU-03 — Worker enqueue na starcie passa (tylko owner_message)

- Rezultat: `apps/agent-worker/src/thinking-indicator.ts` `projectThinkingIndicator({db, caseId})`
  enqueue `discord.thread_typing` (aggregate `discord_case`). Wpięte w
  `createCaseResumeHandler` po `recover()`/`heartbeat()`, PRZED `pumpOnce()`, best-effort
  (try/catch + log), i TYLKO gdy `lease.payload.reason === "owner_message"` (żeby recovery/
  implementer passy nie migały typing bez czekającego właściciela).
- Allowed paths: `apps/agent-worker/src/thinking-indicator.ts`,
  `apps/agent-worker/src/handlers.ts`, test integracyjny.
- Weryfikacja: integracyjny — owner_message resume → outbox ma wiersz `discord.thread_typing`;
  reason≠owner_message → brak wiersza. Mutation: gate reason usunięty → test „brak dla
  recovery" RED.
- Status: `DONE`. `thinking-indicator.ts` + wpięcie w `createCaseResumeHandler` (gate
  `reason === "owner_message" && caseId !== null`, best-effort try/catch). 2 testy integracyjne.
  Mutation WU-03 (gate usunięty): test „emits no typing hint" RED, przywrócone GREEN.

## Bramka taska (uruchomiona 2026-08-25, Node 24.19.0)

- `RA_REQUIRE_POSTGRES=1 vitest run` (całe repo): **2453/2453**, 189 plików, DWA przebiegi, exit 0.
- `typecheck --force` 38/38, `build --force` 26/26, `lint` exit 0, `format` OK.
- DB: PG15/5432 przez `RA_PG*` override (PG17/5433 zniknął — [[postgres-5433-drift]]).
