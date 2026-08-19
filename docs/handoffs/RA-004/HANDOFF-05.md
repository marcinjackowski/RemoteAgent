# RA-004 — Handoff 05

## Metadata

- Task: `RA-004`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po `HANDOFF-04` i `AUDIT-04`; RA-004 miał status `CHANGES_REQUESTED`; repo zawierało niezwiązane, niecommitowane zmiany
- Końcowy commit lub stan working tree: bez commita; zmiany tego przebiegu ograniczone do remediacji RA-004 AUDIT-04, testów, tego handoffu i statusu taska
- Audyt źródłowy: `docs/audits/RA-004/AUDIT-04.md`
- Budżet: owner podał około USD 104 / USD 150 przed tym przebiegiem; brak dokładnego pomiaru kosztu tego przebiegu w repo

## Wynik

Usunięto wszystkie findingi AUDIT-04: jeden HIGH i trzy MEDIUM.
`recordIntent` utrzymuje teraz blokadę dokładnego żywego jobu przez świeży insert
i conflict replay, a exact replay wymaga tego samego fencing tokenu. Descriptor
jest porównywany semantycznie jako JSONB. Completion odrzuca lease innego jobu.
Domyślna początkowa dostępność jobs i outbox dispatch używa clock mode, bez
mieszania process time z PostgreSQL DB-time.

## Zrealizowany zakres

- HIGH-01: live owner/token/status/expiry job jest blokowany `FOR UPDATE` przed `recordIntent` insert i pozostaje zablokowany do commitu.
- HIGH-01: stale exact replay po `ABSENT` i takeover zwraca `StaleFencingTokenError`.
- HIGH-01: bieżący token nie może adoptować intentu zapisanego wcześniejszym tokenem.
- MEDIUM-02: descriptor exact/reordered replay używa PostgreSQL `jsonb IS NOT DISTINCT FROM`; mismatch failuje zamknięcie.
- MEDIUM-03: `recordCompletion` wymaga `input.jobId === input.lease.jobId` przed transakcją.
- MEDIUM-04: domyślny `jobs.available_at` i `outbox_dispatch.available_at` używa `scheduleBase`; jawny `availableAtMs` pozostaje honorowany.
- Dodano siedem regresji AUDIT-04 na realnym PostgreSQL.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/src/queue/job-store.ts` | `recordIntent` najpierw blokuje dokładny live job przez `FOR UPDATE`, następnie wykonuje `VALUES ... ON CONFLICT DO NOTHING` i rozstrzyga konflikt pod tym samym lockiem | Reaper/takeover nie może wejść między gate, insert i replay |
| `packages/database/src/queue/job-store.ts` | Conflict replay sprawdza `job_id`, `fencing_token`, `kind` i `descriptor IS NOT DISTINCT FROM $json::jsonb` | Exact replay jest dozwolony tylko dla tego samego lease generation i semantyki |
| `packages/database/src/queue/job-store.ts` | `recordCompletion` przed transakcją odrzuca mismatch `input.jobId` / `lease.jobId` | Lease jest capability dokładnego jobu, także gdy owner i token są równe na dwóch jobach |
| `packages/database/src/queue/job-store.ts` | Brak jawnego `availableAtMs` wybiera `${scheduleBase}`; jawna wartość używa `to_timestamp` | DB mode używa PostgreSQL clock; injected pozostaje deterministyczny; explicit schedule bez zmian |
| `packages/database/src/queue/outbox.ts` | Początkowy `outbox_dispatch.available_at` używa `${scheduleBase}` | Immediate dispatch jest zgodny z zegarem używanym przez relay due predicate |
| `packages/database/test/queue-adversarial.integration.test.ts` | Dodano controlled pause intent race, stale/current-token replay, descriptor JSONB, cross-job completion oraz trzy scheduling regressions | Dokładne odtworzenie dowodów AUDIT-04 bez timing luck |
| `docs/tasks/TASK_INDEX.md` | `CHANGES_REQUESTED` → `IN_PROGRESS` → `AWAITING_AUDIT` | Wymagany cykl implementera |

## Decyzje i uzasadnienie

Wybrano jawny `SELECT ... FOR UPDATE` przed insertem intentu. Sam
`INSERT ... SELECT` nie utrzymywał blokady jobu podczas triggera i pozwalał
reaperowi oraz takeover przejść przed finalizacją insertu. Blokada obejmuje
`job_id`, ownera, token, status `LEASED` i żywy expiry. Jest utrzymywana również
na ścieżce `ON CONFLICT`, dlatego stale replay nie może wrócić sukcesem po
takeover.

Wpis istniejącego intentu musi mieć ten sam `job_id` oraz `fencing_token` co
prezentowany lease. To celowo zabrania workerowi z tokenem 2 przejęcia intentu
utworzonego tokenem 1, nawet jeśli kind, key i descriptor są identyczne.

Default scheduling rozróżnia brak wartości od jawnej wartości. Dla braku
`availableAtMs`, `scheduleBase` emituje `clock_timestamp()` w DB mode i injected
timestamp w test mode. Jawny `availableAtMs` nadal jest bezpośrednio konwertowany
na timestamptz. Outbox nie ma jawnego scheduling input, więc jego początkowy
dispatch zawsze używa `scheduleBase`.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Pełny PostgreSQL gate 370/370; istniejące rollback/outbox testy przechodzą |
| 2. Crash po intent nie replayuje write | PASS | Exact replay wymaga live tego samego tokenu; stale i current-token adoption regressions przechodzą |
| 3. Wygasły worker nie zapisze po takeover | PASS | Controlled pause przed `job_intents` INSERT: zablokowany job nie jest reaped/claimed; insert commit poprzedza późniejszy token 2 |
| 4. Per-case serialization | PASS | Queue concurrency suite przeszła trzy kolejne focused runs |
| 5. Bounded backoff i DLQ | PASS | Istniejące retry/DLQ/DB-time regressions oraz nowy immediate scheduling przechodzą |
| 6. Reconciliation idempotentne i audytowalne | PASS | Potwierdzone poprawki AUDIT-03 pozostają zielone w adversarial/full suite |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm --filter @remoteagent/database run typecheck` | 0 | Source i test TypeScript PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm --filter @remoteagent/database exec vitest run test/queue-adversarial.integration.test.ts test/queue.integration.test.ts test/queue-concurrency.integration.test.ts test/queue-runtime.test.ts` | 0 | Run 1: 4 pliki, 57/57 PASS |
| Ta sama focused komenda, dwa dodatkowe równoległe przebiegi | 0 / 0 | Run 2: 57/57 PASS; Run 3: 57/57 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 0 | lint, format, typecheck, test, build i workflow validate PASS; 19 plików, 370/370 testów; build 20/20 |
| `git diff --check -- packages/database/src/queue/job-store.ts packages/database/src/queue/outbox.ts packages/database/test/queue-adversarial.integration.test.ts docs/tasks/TASK_INDEX.md` | 0 | Brak błędów whitespace przed handoffem |

## Snapshoty i artefakty

- Artefakt/ścieżka: brak nowych snapshotów; test evidence opisano powyżej.
- Czy snapshot się zmienił i dlaczego: nie.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; fixtures używają wyłącznie syntetycznych identyfikatorów.
- Izolacja kont/scope: bez zmian; cross-job completion jest teraz jawnie odrzucany przed SQL.
- Side effecty i idempotencja: intent fresh/replay jest lock-fenced i generation-bound; descriptor jest porównywany w PostgreSQL; stale worker failuje zamknięcie.
- Dane zewnętrzne traktowane jako niezaufane: payload/descriptor pozostają parametryzowanym JSONB; brak interpolacji danych do SQL.

## Znane ograniczenia i ryzyka

- Node uruchamiający gate to `v25.2.1`, repo deklaruje `24.19.0`; istniejące ostrzeżenie engine nie zablokowało żadnej kontroli.
- ESLint nadal raportuje istniejące ostrzeżenia migracyjne `boundaries` v5→v6; brak błędów.
- Repo pozostaje w szerokim, wcześniej istniejącym niecommitowanym stanie; niezwiązanych zmian nie cofano ani nie modyfikowano.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: wszystkie HIGH/MEDIUM AUDIT-04 poprawione; focused suite przeszła trzy razy, pełny PostgreSQL gate jest zielony.
- Czego nie robić przed audytem: nie rozpoczynać RA-005, nie ustawiać RA-004 na `AUDIT_PASSED` ani `DONE`, nie zmieniać implementacji bez nowego findingu.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: najnowszy audyt RA-004, następnie `packages/database/src/queue/job-store.ts`, `packages/database/src/queue/outbox.ts` i `packages/database/test/queue-adversarial.integration.test.ts`.
