# RA-004 — Audit 05

## Metadata

- Task: `RA-004`
- Audytowany handoff: `docs/handoffs/RA-004/HANDOFF-05.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Wszystkie cztery findingi AUDIT-04 są skutecznie usunięte, a pełna bramka
audytora przechodzi 370/370. Pozostała jednak luka w recovery po trwałym
completion: crash po zapisaniu `job_completions(outcome='SUCCEEDED')`, lecz przed
`jobs.complete()`, powoduje automatyczne ustawienie joba na `PENDING`. Nowy
worker może użyć nowego klucza intentu i ponownie wykonać już potwierdzony
zewnętrzny write. Jest to dokładna granica fault-injection `complete` i narusza
główny cel taska oraz regułę Master Planu, że potwierdzony completion ma być
rekonstruowany bez powtórzenia operacji.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Pełny gate i rollback tests przechodzą. |
| 2. Crash po intent nie replayuje write | FAIL | Crash po potwierdzonym completion, przed finalizacją joba, prowadzi do PENDING i nowego intentu; HIGH-01. |
| 3. Wygasły worker nie zapisze po takeover | PASS | Exact trigger probe potwierdził row-lock fencing intentu i completion. |
| 4. Per-case serialization | PASS | Concurrency suite przechodzi; wcześniejsze DB-time flaki usunięte. |
| 5. Bounded backoff i DLQ | PASS | Retry/DLQ i authoritative schedule tests przechodzą. |
| 6. Reconciliation idempotentne i audytowalne | PASS | Exact/mismatch/provenance regressions przechodzą. |

## Finding

### HIGH-01 — Potwierdzony `SUCCEEDED` completion jest automatycznie replayowany po crashu

- Lokalizacja: `packages/database/src/queue/job-store.ts:918-1004`, szczególnie
  klasyfikacja `unfinished` i gałąź `else` w `reapExpired`.
- Dowód: audyt utworzył job i token 1, zapisał intent oraz
  `recordCompletion(... outcome='SUCCEEDED', receipt={externalId:'R'})`, po czym
  zasymulował crash bez `complete()`. Po expiry `reapExpired` zwrócił
  `requeued=[job-1]` i ustawił status `PENDING`; token 2 claimował job, a
  `recordIntent` z nowym kluczem `attempt-2` zakończył się sukcesem. Handler może
  więc ponownie wykonać ten sam zewnętrzny write.
- Przyczyna: query uznaje `SUCCEEDED` i `FAILED` za jednakowo „finished”, a każdy
  job bez `unfinished` trafia do `PENDING`. Potwierdzenie, że write się wykonał,
  jest błędnie traktowane jako dowód, że cały handler wolno uruchomić ponownie.
- Wpływ: bezpośrednie ryzyko podwójnego side effectu na crash boundary pomiędzy
  trwałym receipt a finalnym statusem joba; naruszenie celu „bez duplikowania
  efektów”, Master Plan §6.2 oraz wymaganej fault injection at complete.
- Wymagana zmiana: `reapExpired` musi klasyfikować outcome semantycznie, nie
  tylko przez brak unfinished. Dla pojedynczej/zakończonej operacji z trwałym
  `SUCCEEDED` ma zrekonstruować sukces joba bez claim/replay (status
  `SUCCEEDED`, wyczyszczony lease, `finished_at`, obserwowalny wynik recovery).
  `FAILED`/brak intentu może być bezpiecznie requeue; missing lub `AMBIGUOUS`
  pozostaje `RECONCILING`. Dla wielu intentów stan częściowy (co najmniej jeden
  `SUCCEEDED` oraz inny niepotwierdzony/FAILED) musi failować zamknięcie do
  `RECONCILING`, a nie replayować cały handler. Zachować atomowość statusu i
  attempt evidence. Dodać dokładny test crash po `recordCompletion(SUCCEEDED)`
  przed `complete()`, który dowodzi braku tokenu 2/nowego intentu i trwałego
  odtworzenia sukcesu.

## Potwierdzone poprawki AUDIT-04

- Trigger-paused fresh intent utrzymuje job lock: podczas pauzy reaper nic nie
  przeniósł, early claim zwrócił null, a po insercie job przeszedł do
  `RECONCILING` zamiast takeover.
- Stale exact replay po `ABSENT`/takeover jest odrzucony; token 2 nie adoptuje
  intentu tokenu 1.
- Wielopolowy descriptor exact/reordered zwraca ten sam ID, mismatch konfliktuje.
- Completion A z lease B jest odrzucone `StaleFencingTokenError`.
- Job i outbox default availability używają DB clock; suite nie wykazuje już
  wcześniejszych immediate-claim flaków.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 0 | 19 plików, 370/370 testów; lint/format/typecheck/build/workflow PASS. |
| Trigger-paused PostgreSQL `job_intents` insert + expiry/reap | 0 procesu | Brak takeover pod lockiem; po commicie missing completion trafia do RECONCILING. |
| Descriptor reordered + cross-job completion lease | 0 procesu | Ten sam intent ID; cross-job lease odrzucony. |
| `SUCCEEDED` receipt + crash + expiry/reap + token-2/new-key intent | 0 procesu | Błędnie PENDING, token 2 i nowy intent zapisane. |

## Wymagane działania po `continue`

1. Rozdzielić recovery `SUCCEEDED`, `FAILED`, `AMBIGUOUS`/missing i częściowy
   multi-intent state; nigdy nie replayować joba z potwierdzonym write.
2. Dodać exact crash-after-receipt-before-complete regression oraz multi-intent
   fail-closed test.
3. Uruchomić focused suite wielokrotnie i pełny PostgreSQL gate.
4. Utworzyć `HANDOFF-06`, ustawić `AWAITING_AUDIT` i wrócić do audytu.

## Uzasadnienie werdyktu

Zielone testy potwierdzają remediacje AUDIT-04, lecz nie obejmują krytycznej
granicy po trwałym receipt. Ponieważ obecny reaper może automatycznie powtórzyć
potwierdzony zewnętrzny write, pozostaje finding HIGH i `PASS` jest
niedozwolony. Właściwy werdykt to `CHANGES_REQUIRED`.
