# RA-035 — HANDOFF-01

- Task: `RA-035` Discord UX: natywny wskaźnik „Bot pisze…" w wątku
- Data: `2026-08-25`
- Bazowy commit: `1d7138b`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## W jednym zdaniu

Na starcie owner-driven passa `case.resume` worker enqueue'uje efemeryczny event
`discord.thread_typing`, a discord-bot wyzwala natywny wskaźnik „RemoteAgent is typing…" na
wątku case'a — best-effort (nigdy nie dead-letteruje), tylko gdy właściciel realnie czeka.

## Decyzja właściciela

Loader = **natywny typing indicator** (`POST /channels/{id}/typing`), NIE placeholder-wiadomość.
Efemeryczny (~10 s), zero śmieci w wątku. Odrzucone: placeholder-edytowany-w-odpowiedź i osobna
wiadomość placeholder (Discord API nie ma `delete`).

## Co powstało / zmienione

| Ścieżka | Rola |
|---|---|
| `packages/discord/src/messages.ts` | event `discord.thread_typing` + `threadTypingPayload` (bez seq) |
| `packages/discord/src/gateway.ts` | metoda portu `triggerTyping({threadId})` |
| `packages/discord/src/dispatcher.ts` | routing → `#deliverThreadTyping` (best-effort, no seq/receipt, nigdy nie rzuca) |
| `packages/discord/src/fakes.ts` | `triggerTyping` + `typingCalls` w `FakeDiscordGateway` |
| `apps/discord-bot/src/rest-gateway.ts` | `POST /channels/{threadId}/typing` |
| `apps/agent-worker/src/thinking-indicator.ts` (NOWY) | `projectThinkingIndicator` enqueue eventu |
| `apps/agent-worker/src/handlers.ts` | wpięcie w owner-driven `case.resume` (gate + try/catch) |
| testy | dispatcher (+3), rest-gateway contract (+1), `thinking-indicator.integration` (NOWY, 2), `role-context` (fix + binding) |

## Kluczowe właściwości (dla następnej sesji)

- **Best-effort**: `#deliverThreadTyping` POŁYKA błąd gateway i zawsze zwraca `delivered` → outbox
  oznacza PUBLISHED, nigdy dead-letter. Brak wątku → skip (`threadId: null`), bez `defer`.
- **Bez seq**: typing jest ortogonalny do uporządkowanego strumienia `thread_message` — nie
  rezerwuje ani nie advance'uje seq, nie tworzy `case_message`.
- **Gate**: tylko `lease.payload.reason === "owner_message"` (recovery/implementer passy nie migają).
- Discord ma `editMessage`, NIE ma `deleteMessage`; `triggerTyping` dodane w tym tasku.

## Jak zobaczyć na żywo

3 procesy przez `bash scripts/dev/start-all.sh` (auto-sourcuje `~/.remoteagent-*.env`, PG15/5432,
porty health 8081/8082/8083, tworzy+migruje `remoteagent`). Napisz w wątku KAN-* → tuż przed
odpowiedzią pojawia się „RemoteAgent is typing…". Wskaźnik jedzie relayem outboxu (~1 s), więc nie
jest natychmiastowy; przy modelu <10 s pokrywa cały czas myślenia.

## Naprawione przy okazji

- `role-context.test.ts` nie przekazywał `run` do `createRole.invoke` — regresja z `1d7138b`
  (commit modelu/promptu poszedł bez pełnej bramki). Dodano `run: { runId }` + asercje bindingu.
- CTF-020 domknięty w `CROSS_TASK_FINDINGS.md` (fix `3a0c5ed`) — odblokowało acceptance test
  `criteria.test.ts` (open HIGH tripował AC2/AC3).

## Stan drzewa

Czyste po commicie. `push`/MR/deploy — osobna zgoda. Żaden zapis do Discorda/Jiry/Bedrock nie
został wykonany przez ten task (zmiana lokalna + testy na throwaway DB). Tymczasowy diagnostyk
`[markAmbiguous]` w `persistence.ts` (z `1d7138b`) ZOSTAJE do RA-036 (trwała ścieżka błędu).

## Następny task

`RA-036` (READY) — informacja o błędzie agenta w wątku (DLQ → wiadomość w wątku). Mapowanie:
`JobStore.fail` ustawia `DEAD_LETTER` bez hooka; plan = addytywny poller nad
`JobStore.listDeadLettered` (nie ruszać kontraktu RA-004), który enqueue'uje wyraźnie oznaczoną
wiadomość błędu (⚠️), idempotentnie per case.
