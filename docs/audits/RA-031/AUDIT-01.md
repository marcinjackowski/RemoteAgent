# RA-031 — AUDIT-01

- Task: `RA-031` Inbound conversation loop (wiadomość → praca agenta)
- Data: `2026-08-24`
- Bazowy commit: `fa293a4` (po RA-030)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt w §5.

## 1. Bramka — uruchomiona (Node 24.19.0)

```text
RA_REQUIRE_POSTGRES=1 vitest run   (całe repo)   2423/2423, 179 plików, DWA przebiegi, exit 0
typecheck --force 38/38   build --force 26/26   lint OK   format OK
```

Testy 2414 → **2423** (+9): case-message 2, inbound-message 3, intake-message-id 2,
owner-message-sink 2. Mutation checki: usunięcie insertu unitu w `receiveOwnerMessage` → czerwone.

## 2. Kryteria akceptacji — osobno

- **AC1** (magazyn wiadomości): **spełnione**. Odkryto, że tabela `case_messages` istnieje od
  migracji 003 (OWNER/AGENT/SYSTEM, trust, append-only) — bez repo. Napisano `CaseMessageRepository`
  (append idempotentny na `message_id`, listRecent). Bez nowej migracji.
- **AC2** (transakcyjne `receiveOwnerMessage`): **spełnione**. Jedna transakcja: lock case → guard
  stanu (terminalny → ignored) → zapis wiadomości (idempotentny) → **PENDING SUPERVISOR unit**
  (read-only scope) → enqueue `case.resume`. Idempotencja na `message_id` (replay bez duplikatu).
  Mutation-checked.
- **AC3** (`thread_excerpt` w kontekście): **PRZENIESIONE DO RA-032** (`2026-08-24`). Wymaga zmiany
  krytycznego parsera `recovery.ts` (`exact()` na kluczach snapshotu), a jedyny sensowny dowód „run
  widzi wiadomość" wymaga modelu. Robione jako pierwszy krok RA-032, end-to-end. Zapisane w planie.
- **AC4** (`onInboundOutcome`): **spełnione**. `createOwnerMessageSink(db)` (eksportowany, testowalny)
  wpięty w `createDiscordBotFromEnv`; dla `kind==="message"` woła `receiveOwnerMessage`. Id wiadomości
  Discord przewleczone przez pakiet `discord` (`InboundMessage.messageId` → `IntakeOutcome`) do
  dedupe. Composition test + unit test threadingu.
- **AC5** (bramka zielona): **spełnione** — §1.

## 3. Świadome zawężenia

- **Agent jeszcze nie ODPISUJE** — wymaga RA-032 (emisja `thread_excerpt` + model + projekcja
  completion→`discord_case` thread_message). RA-031 dowodzi: wiadomość → trwała praca, i że praca
  jest materializowana tak, że `recover()` ją podejmie (`SupervisorRuntime` uruchamia tylko PENDING
  unit z objective — bez tego samo `case.resume` byłoby no-opem).
- Objective SUPERVISOR jest deterministyczny i read-only.

## 4. Diff od bazy — przeczytany

`packages/database/src/repositories/{case-message,inbound-message}.ts` + index; `packages/discord/src/intake.ts`
(+messageId); `apps/discord-bot/src/{env,lifecycle}.ts` (sink + id); testy. Żadna zmiana zaakceptowanego
kontraktu (tabela `case_messages` istniała; `messageId` jest additive-optional).

## 5. Werdykt

AC1/AC2/AC4/AC5 spełnione z uruchomionym dowodem i mutation checkiem; AC3 świadomie przeniesione do
RA-032 (verifiable end-to-end z modelem), zapisane w planie — nie jest to nierozwiązany brak, lecz
przesunięcie granicy tasku.

- Werdykt: `PASS`
