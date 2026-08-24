# RA-031 — Work units

Bazowy commit: `fa293a4` (po RA-030). Node 24.

## WU-01 — Tabela + repo wiadomości właściciela (packages/database)

- Rezultat: migracja `033_case_thread_messages` (append-only: `message_id, case_id, owner_id,
  connection_id, provider, content, trust, created_at`, FK do cases, scope). `CaseThreadMessageRepository`:
  `append(tx, input)` + `listRecent(q, caseId, limit)`.
- Weryfikacja: `vitest run packages/database/test/case-thread-message*`. Mutacja: brak append → list pusta.

## WU-02 — Transakcyjne `receiveOwnerMessage` (packages/database)

- Rezultat: repo/metoda w jednej transakcji: lock case `FOR UPDATE`, guard stanu (nie w terminalnym),
  append wiadomości, `WorkUnitRepository.insert` PENDING SUPERVISOR (objective konwersacyjny),
  `JobStore.enqueue` `case.resume` (serializationKey=caseId). Idempotencja: ta sama wiadomość
  (dedupe key) nie duplikuje unitu/joba.
- Weryfikacja: integracyjny — po wywołaniu: 1 wiadomość, 1 PENDING unit, 1 job; drugie wywołanie
  z tym samym kluczem → bez duplikatu. Mutacja: brak insertu unitu → recover nie ma czego podjąć.

## WU-03 — Assembler emituje `thread_excerpt` — PRZENIESIONE DO RA-032

Powód (`2026-08-24`): dodanie wiadomości do snapshotu wymaga zmiany restrykcyjnego, krytycznego
parsera `recovery.ts` (`exact()` na kluczach snapshotu, `buildRecoveryPlan`), a jedyny sensowny
dowód, że run *widzi* wiadomość, wymaga uruchomionego modelu. Zmiana tej ścieżki „w ciemno" bez
end-to-end weryfikacji jest ryzykowna. Emisję `thread_excerpt` robię jako pierwszy krok RA-032
(kontekst + model razem), gdzie potwierdzę, że agent czyta wiadomość i odpisuje.

RA-031 domyka więc **hydraulikę wejścia**: wiadomość → trwała praca (PENDING unit + `case.resume`)
+ wpięcie `onInboundOutcome`. To jest testowalne bez modelu i jest warunkiem RA-032.

## WU-04 — Wpięcie `onInboundOutcome` (apps/discord-bot)

- Rezultat: `createDiscordBotFromEnv` przekazuje `onInboundOutcome` wołający `receiveOwnerMessage`
  dla `kind==="message"` (db z env). Bez tego — drop (jak dziś).
- Weryfikacja: composition test — outcome message → `receiveOwnerMessage` wywołany z caseId/content.
  Mutacja: brak wpięcia → nic nie zapisane.

## WU-05 — Bramka + docs + domknięcie

- Pełna bramka (Node 24), typecheck/build/lint/format, przebiegi. LOCAL_BRINGUP: co robi odpowiedź
  w wątku dziś (kontekst+unit) i czego brakuje do widocznej odpowiedzi (RA-032). Handoff + audyt +
  TASK_INDEX + validate.
