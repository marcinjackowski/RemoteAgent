# RA-036 — Work units

Bazowy commit: `a326464` (po RA-035).

Cel: gdy owner-driven `case.resume` wyczerpie próby i przejdzie do DLQ, właściciel widzi w wątku
wyraźną wiadomość błędu (⚠️), bez szczegółów technicznych.

Ustalenia z mapowania (RA-035 handoff): `JobStore.fail` dead-letteruje dokładnie gdy
`lease.attempts >= max_attempts`, BEZ hooka. Handler `case.resume` rzuca na nierozwiązanej pracy
(`handlers.ts`), a scheduler woła `fail()`. Więc terminalny rzut da się wykryć w handlerze przez
`lease.attempts >= lease.maxAttempts` — to samo porównanie co `fail()`.

Decyzja projektowa: notyfikacja **lokalnie w handlerze** (nie osobny poller), tuż przed rzutem na
terminalnej próbie. Idempotentna producencko (marker `error:<jobId>` w `case_messages`) → bezpieczna
na crash+re-claim. Gate `reason === "owner_message"` (jak RA-035: właściciel realnie czeka —
„agent nie odpowiedział"). Recovery/implementer passy nie zaśmiecają wątku.

## WU-01 — Projekcja wiadomości błędu do wątku (idempotentna)

- Rezultat: `apps/agent-worker/src/dead-letter-notice.ts` `projectDeadLetterNotice({db, caseId, jobId})`
  — wzorowane na `projectCompletionReply`: idempotencja na `case_messages.message_id = error:<jobId>`;
  `reserveSeq` z `discord_case_bindings` (0 wierszy = brak wątku → `false`, AC5); enqueue
  `discord.thread_message` z ustalonym, user-safe body (⚠️, bez stack trace/ID); zapis `case_message`
  (`AGENT`/`TRUSTED`, marker `error:<jobId>`). Zwraca `boolean` (false = brak wątku).
- Allowed paths: `apps/agent-worker/src/dead-letter-notice.ts`, test integracyjny.
- Weryfikacja: integracyjny — enqueue ×2 tego samego jobId → 1 wiersz `thread_message` + 1
  `case_message`; brak bindingu → `false`, brak wierszy; body nie zawiera „stack"/„Error:"/jobId.
- Status: `DONE`. `projectDeadLetterNotice` + `DEAD_LETTER_NOTICE_BODY`. 2 testy (idempotencja+bounds;
  brak bindingu → false).

## WU-02 — Wpięcie w terminalny rzut handlera (owner-driven)

- Rezultat: w `createCaseResumeHandler`, przy `unresolved.length > 0`, PRZED rzutem: jeśli
  `reason === "owner_message" && caseId !== null && lease.attempts >= lease.maxAttempts`, woła
  `projectDeadLetterNotice` (best-effort try/catch + log). Potem rzuca jak dotąd (retry/DLQ bez zmian).
- Allowed paths: `apps/agent-worker/src/handlers.ts`, test integracyjny.
- Weryfikacja: integracyjny — pass z nierozwiązaną pracą na terminalnej próbie (`attempts = max`) →
  1 wiadomość błędu w outboxie + handler nadal rzuca; próba nie-terminalna (`attempts < max`) → brak
  wiadomości, handler rzuca. Mutation: gate `attempts >= maxAttempts` usunięty → test „nie-terminalna
  → brak" RED.
- Status: `DONE`. Wpięte w `createCaseResumeHandler` przed rzutem (gate owner_message + caseId +
  `attempts >= maxAttempts`, best-effort try/catch). 2 testy (terminalna → 1 wiadomość + throw;
  nie-terminalna → 0 + throw). Mutation (gate próby usunięty): test nie-terminalny RED, przywrócone GREEN.

## WU-03 — Sprzątanie diagnostyka `[markAmbiguous]`

- Rezultat: usunąć tymczasowy `process.stderr.write("[markAmbiguous] …")` z `persistence.ts`
  (dodany w `1d7138b` do live-debugowania) — RA-036 daje trwałą, widoczną ścieżkę błędu.
- Allowed paths: `apps/agent-worker/src/persistence.ts`.
- Weryfikacja: pełna bramka (poniżej) zielona bez diagnostyka.
- Status: `DONE`. `process.stderr.write("[markAmbiguous] …")` usunięty z `persistence.ts`.

## Bramka taska (uruchomiona 2026-08-25, Node 24.19.0)

- `RA_REQUIRE_POSTGRES=1 vitest run` (całe repo): **2457/2457**, 190 plików, DWA przebiegi, exit 0
  (2453 → 2457: +4 RA-036).
- `typecheck --force` 38/38, `build --force` 26/26, `lint` exit 0, `format` OK.
- DB: PG15/5432 przez `RA_PG*` override ([[postgres-5433-drift]]).
