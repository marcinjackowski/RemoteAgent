# RA-036 — AUDIT-01

- Task: `RA-036` Discord UX: informacja o błędzie agenta w wątku (DLQ → wiadomość)
- Data: `2026-08-25`
- Bazowy commit: `a326464` (po RA-035)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt w §6.

## 1. Bramka — uruchomiona (Node 24.19.0)

```text
RA_REQUIRE_POSTGRES=1 vitest run   (całe repo)   2457/2457, 190 plików, DWA przebiegi, exit 0
typecheck --force 38/38 (0 cached)   build --force 26/26 (0 cached)   lint exit 0   format OK
```

Testy 2453 → **2457** (+4 RA-036: 2 projekcja, 2 wpięcie handlera).
Środowisko: PG15/5432 przez `RA_PG*` (PG17/5433 zniknął).

## 2. Kryteria akceptacji — osobno

- **AC1** (DLQ → wiadomość w wątku): **spełnione**. `createCaseResumeHandler` na terminalnej próbie
  (`lease.attempts >= lease.maxAttempts` — to samo porównanie co `JobStore.fail`, `job-store.ts:410`)
  woła `projectDeadLetterNotice` przed rzutem. Test „the terminal attempt … posts the error and
  still throws".
- **AC2** (brak stack trace / wewnętrznych ID): **spełnione**. Body to stała
  `DEAD_LETTER_NOTICE_BODY`; test asertuje brak `jobId`, „stack", „Error:". Detal błędu zostaje w
  `jobs.last_error`/DLQ dla operatora.
- **AC3** (odróżnialna od odpowiedzi, prefix ⚠️): **spełnione**. Body zaczyna się od „⚠️ I ran into
  an error…".
- **AC4** (idempotencja): **spełnione**. Marker `error:<jobId>` w `case_messages` (silniejsze niż per
  case). Test „idempotent on the job id": 2× projekcja → 1 wiersz `thread_message` + 1 `case_message`.
- **AC5** (brak wątku → log, brak crashu): **spełnione**. `projectDeadLetterNotice` zwraca `false` gdy
  `discord_case_bindings` nie ma wiersza; wpięcie jest w `try/catch` z `logger.warn`, pass rzuca dalej
  (retry/DLQ bez zmian). Testy „a case with no Discord thread yields no notice" + best-effort catch.
- **AC6** (brak regresji): **spełnione** — §1, 2457/2457 ×2.

## 3. Diff od bazy — przegląd

- `apps/agent-worker/src/dead-letter-notice.ts` (NOWY) — `projectDeadLetterNotice` (mirror
  `completion-reply`: idempotencja `error:<jobId>`, reserveSeq, enqueue `discord.thread_message`,
  `case_message` AGENT/TRUSTED) + `DEAD_LETTER_NOTICE_BODY`.
- `apps/agent-worker/src/handlers.ts` — wpięcie przed terminalnym rzutem (gate owner_message +
  caseId + attempts>=max, best-effort) + import.
- `apps/agent-worker/src/persistence.ts` — usunięty tymczasowy diagnostyk `[markAmbiguous]`.
- `apps/agent-worker/test/dead-letter-notice.integration.test.ts` (NOWY, 4).
- Docs: `RA-036.md`, `WORK_UNITS.md`, `TASK_INDEX.md`.

## 4. Bezpieczeństwo / kontrakty

- §6 (side effect idempotentny): projekcja idempotentna na `jobId`, bezpieczna na crash + re-claim.
- §3 (brak sekretów/detali w wątku): body user-safe, bez ID/stack — potwierdzone testem.
- Kontrakt RA-004 (`JobStore`) NIETKNIĘTY — detekcja terminalności lustruje `fail()` po stronie
  handlera, addytywnie. Kontrakt RA-006/RA-029 użyty istniejącym `discord.thread_message` (bez zmian).
- Świadomy brzeg (zapisany w tasku): dead-lettery spoza handler-throw (czysty reap bez re-claimu) nie
  są notyfikowane; na re-claim handler przebiega ponownie i pokrywa przypadek.

## 5. Mutation check

WU-02 gate: `lease.attempts >= lease.maxAttempts` usunięty → test „a non-terminal attempt throws
WITHOUT posting an error" RED (1 ≠ 0), przywrócone GREEN.

## 6. Werdykt

- Werdykt: `PASS`

Wszystkie kryteria akceptacji spełnione, bramka uruchomiona (exit 0, dwa przebiegi), mutation check
potwierdzony. Brak otwartych findingów BLOCKER/HIGH/MEDIUM.
