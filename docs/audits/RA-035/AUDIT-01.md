# RA-035 — AUDIT-01

- Task: `RA-035` Discord UX: loader „Agent pisze…" w wątku (natywny wskaźnik pisania)
- Data: `2026-08-25`
- Bazowy commit: `1d7138b` (po CTF-020 + live-test fixes)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt w §6.

## 1. Bramka — uruchomiona (Node 24.19.0)

```text
RA_REQUIRE_POSTGRES=1 vitest run   (całe repo)   2453/2453, 189 plików, DWA przebiegi, exit 0
typecheck --force 38/38 (0 cached)   build --force 26/26 (0 cached)   lint exit 0   format OK
```

Testy 2434 → **2453** (+6 RA-035: 3 dispatcher typing, 1 rest-gateway contract, 2 worker
integracyjne; +2 asercje bindingu w `role-context`; reszta z porządkowania rejestru/formatu).

Środowisko: PG17/5433 zniknął z maszyny; bramkę uruchomiono wobec działającego PG15/5432 przez
override `RA_PG*` (superuser, trust auth). Migracje aplikują się czysto.

## 2. Kryteria akceptacji — osobno

- **AC1** (owner-driven → typing na wątku): **spełnione**. `createCaseResumeHandler`
  (`handlers.ts`) na `reason === "owner_message"` woła `projectThinkingIndicator`
  (`thinking-indicator.ts`) → enqueue `discord.thread_typing`; dispatcher routuje do
  `#deliverThreadTyping` (`dispatcher.ts`) → `gateway.triggerTyping({threadId})`. Test
  „a typing event triggers the native indicator on the case thread" (dispatcher) + „an
  owner-driven resume enqueues a discord.thread_typing hint" (worker).
- **AC2** (nie-owner-driven → brak): **spełnione**. Gate `reason === "owner_message"`. Test
  „a resume that is NOT owner-driven emits no typing hint". Mutation (gate usunięty) RED,
  przywrócone GREEN (§5).
- **AC3** (best-effort, brak dead-letter/seq/wiadomości): **spełnione**. `#deliverThreadTyping`
  nie rezerwuje seq, nie zapisuje receiptu, POŁYKA błąd gateway i zwraca `delivered` (outbox →
  PUBLISHED). Brak wątku → skip, `threadId: null`, bez defer. Testy: „before the thread exists
  is a best-effort no-op (not deferred)" + „a failed typing trigger is swallowed, never
  dead-lettering the outbox"; asercja `messagesIn(thread).length === 1` (typing nie tworzy
  wiadomości).
- **AC4** (nieudane enqueue nie failuje passa): **spełnione**. Wpięcie w `handlers.ts` w
  `try/catch` z `logger.warn`; pass idzie dalej do `pumpOnce()`.
- **AC5** (brak regresji): **spełnione** — §1, całe repo 2453/2453 ×2. Regresja z `1d7138b`
  (`role-context.test.ts` bez `run` w `invoke`) naprawiona w tym tasku.

## 3. Diff od bazy — przegląd

- `packages/discord/src/messages.ts` — `threadTypingPayload` (`{case_id}`, strict, bez seq),
  `THREAD_TYPING`, typ.
- `packages/discord/src/gateway.ts` — metoda portu `triggerTyping`.
- `packages/discord/src/dispatcher.ts` — routing + `#deliverThreadTyping` (best-effort).
- `packages/discord/src/fakes.ts` — `triggerTyping` + `typingCalls` w `FakeDiscordGateway`.
- `apps/discord-bot/src/rest-gateway.ts` — `POST /channels/{threadId}/typing`.
- `apps/agent-worker/src/thinking-indicator.ts` (NOWY) — enqueue eventu.
- `apps/agent-worker/src/handlers.ts` — wpięcie owner-driven + import.
- Testy: `dispatcher.integration` (+3), `rest-gateway.contract` (+1),
  `thinking-indicator.integration` (NOWY, 2), `role-context` (fix + binding assertions).
- Docs: `RA-035.md`, `WORK_UNITS.md`, `TASK_INDEX.md`, `CROSS_TASK_FINDINGS.md` (CTF-020 → ZAMKNIĘTY).

## 4. Bezpieczeństwo / kontrakty

- Model nie jest warstwą autoryzacji (§4): typing to sygnał UX, bez wpływu na scope.
- §6 (idempotencja/side effect): typing jest best-effort i BEZ receiptu — świadomie, bo
  duplikat wskaźnika jest niewidoczny, a brak dostarczenia nieszkodliwy. Nie łamie to
  uporządkowanego strumienia `thread_message` (brak seq).
- Kontrakt RA-006/RA-029 rozszerzony addytywnie (nowy event + metoda portu), bez zmiany
  istniejących ścieżek. Brak ADR wymaganego (dodanie, nie zmiana zaakceptowanego zachowania).

## 5. Mutation checks

1. WU-02 routing: `#deliverThreadTyping` → `void gateway` (skip triggerTyping), rebuild →
   test „triggers the native indicator" RED (`typingCalls` `[]` ≠ `[threadId]`), przywrócone GREEN.
2. WU-03 gate: `reason === "owner_message"` usunięty → test „emits no typing hint" RED
   (`0` ≠ `1`), przywrócone GREEN.

## 6. Werdykt

- Werdykt: `PASS`

Wszystkie kryteria akceptacji spełnione, bramka uruchomiona (exit 0, dwa przebiegi), dwa mutation
checki potwierdzone. Brak otwartych findingów BLOCKER/HIGH/MEDIUM (CTF-020 domknięty w rejestrze).
