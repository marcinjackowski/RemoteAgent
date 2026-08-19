# RA-004 — Audit 03

## Metadata

- Task: `RA-004`
- Audytowany handoff: `docs/handoffs/RA-004/HANDOFF-03.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Scoping `(intent_id, attempt_key)`, odrzucenie pierwszego reconcile żywego joba
oraz DB-time dla due/backoff są skuteczne. Pełna suite 359/359 jest zielona.
Niezależne próby wykazały jednak trzy niepokryte luki: check lease i zapis
completion nadal nie są jedną operacją fence'owaną, przez co stary worker
zapisał wynik już po takeover tokenem 2; receipt JSONB jest porównywany z
łańcuchem JS i identyczny replay błędnie konfliktuje; replay reconciliation
omija walidację `jobId` i zgodność resolution/evidence. Kryteria 3 i 6 pozostają
niespełnione.

## Zakres audytu

- Przeczytane: dokumenty obowiązkowe, checklist audytora, AUDIT-01/02,
  HANDOFF-01/02/03, bieżące migracje 012-014, kod kolejki i testy.
- Wykonane niezależnie: pełna suite PostgreSQL, workflow validator, exact
  takeover race z kontrolowanym triggerem `pg_sleep`, replay identycznego
  completion oraz cross-job/mismatched reconciliation replay.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Branded transaction i rollback regressions przechodzą. |
| 2. Crash po intent nie replayuje write | PASS | missing/AMBIGUOUS nadal trafia do `RECONCILING`. |
| 3. Wygasły worker nie zapisze po takeover | FAIL | check-then-insert window pozwoliło staremu tokenowi 1 zapisać completion po claimie tokenem 2; HIGH-01. |
| 4. Per-case serialization | PASS | API + DB CHECK i dwa workery przechodzą. |
| 5. Bounded backoff i DLQ | PASS | DB-time chroni due i scheduling base job/outbox; skew regression przechodzi. |
| 6. Reconciliation idempotentne i audytowalne | FAIL | replay klucza omija provenance i semantykę; HIGH-03. |

## Findingi

### HIGH-01 — Lease check i completion insert nadal mają okno takeover

- Lokalizacja: `packages/database/src/queue/job-store.ts:648-728`.
- Dowód: audyt dodał na izolowanej bazie tymczasowy `BEFORE INSERT` trigger z
  `pg_sleep(1)`. Worker 1 przeszedł SELECT żywego lease tokenem 1 i zatrzymał się
  przed insertem. W tym czasie lease wygasł, reaper ustawił `RECONCILING`,
  reconciliation `ABSENT` przywróciło `PENDING`, a worker 2 claimował tokenem 2.
  Po wznowieniu worker 1 zapisał `job_completions(outcome='SUCCEEDED')` i metoda
  zwróciła sukces. Job pozostał prawidłowo `LEASED` przez workera 2, lecz trwały
  wynik starego workera znalazł się w ledgerze już po takeover.
- Przyczyna: SELECT weryfikujący lease nie blokuje joba ani nie jest częścią
  warunkowego INSERT-u. Dla `AMBIGUOUS` komentarz deklaruje kontrolę rowCount,
  lecz wynik UPDATE z linii 719 nie jest sprawdzany.
- Wpływ: bezpośrednie naruszenie kryterium 3; nowy worker/reaper może oprzeć
  recovery na wyniku zapisanym przez poprzedniego właściciela po utracie fence.
- Wymagana zmiana: związać provenance intentu, żywy owner/token i insert w jednym
  atomowym mechanizmie. Dopuszczalne jest zablokowanie job row `FOR UPDATE` przed
  weryfikacją i utrzymanie locka do commitu albo warunkowy INSERT zależny od
  bieżącego lease, bez check-then-act window. Intent fencing token również musi
  odpowiadać prezentowanemu lease. `AMBIGUOUS` transition ma sprawdzać rowCount.
  Dodać deterministyczny concurrency test z pauzą pomiędzy gate i insertem oraz
  dowodem braku completion po takeover.

### HIGH-02 — Reconciliation replay omija provenance i zgodność semantyczną

- Lokalizacja: `packages/database/src/queue/job-store.ts:776-828`.
- Dowód: po zapisaniu dla joba A próby `UNRESOLVED`, `attemptKey='same-key'`,
  ponowne wywołanie z tym samym intentem/kluczem, ale `resolution='CONFIRMED'` i
  innym evidence zwróciło bez błędu stary `UNRESOLVED`. Następnie call z intentem
  A, lecz `jobId` żywego, niepowiązanego joba B, również zwrócił reconciliation A
  i `jobStatus='LEASED'` od B.
- Przyczyna: lookup `priorAttempt` i terminal lookup wykonują early return przed
  walidacją `(intentId, jobId)`. Wiersz prior nie pobiera ani nie porównuje
  `job_id`, resolution ani evidence, mimo że AUDIT-02 wymagał pełnej provenance.
- Wpływ: API może przypisać wynik reconciliation do obcego joba i uznać
  konfliktującą próbę za idempotentny sukces; ledger nie jest wiarygodnie
  audytowalny.
- Wymagana zmiana: najpierw zawsze walidować, że intent należy do `jobId`, bez
  wymagania `RECONCILING` dla legalnego terminalnego replayu. Następnie replay
  `(intent_id, attempt_key)` może zwrócić sukces wyłącznie dla identycznych
  `job_id`, resolution i semantycznie równego evidence; mismatch ma być typowanym
  fail-closed conflict. Dodać oba dokładne testy.

### MEDIUM-03 — Identyczny completion receipt nie jest idempotentny

- Lokalizacja: `packages/database/src/queue/job-store.ts:689-708`.
- Dowód: dwa identyczne wywołania `recordCompletion` dla tego samego intentu,
  outcome `SUCCEEDED` i receipt `{a:1,b:2}`. Pierwsze zwróciło ID, drugie rzuciło
  `CompletionConflictError`; komunikat pokazał istniejący receipt jako
  `[object Object]` i wejściowy jako JSON string.
- Przyczyna: driver `pg` zwraca `jsonb` jako obiekt, mimo lokalnego typu
  `string | null`; kod porównuje go referencyjnie ze zserializowanym stringiem.
  Nie jest to deklarowana JSONB semantic equality.
- Wpływ: bezpieczne redelivery po niejednoznacznej odpowiedzi persistence nie
  jest idempotentne i może zatrzymać recovery mimo identycznego potwierdzenia.
- Wymagana zmiana: porównywać receipt po stronie PostgreSQL operatorem JSONB
  (`receipt IS NOT DISTINCT FROM $json::jsonb`) albo użyć stabilnej kanonizacji
  obu wartości. Dodać replay z identycznym obiektem, różną kolejnością kluczy
  oraz rzeczywisty mismatch.

### LOW-04 — HANDOFF-03 nadal zawiera niezgodne evidence

- Lokalizacja: `docs/handoffs/RA-004/HANDOFF-03.md`.
- Dowód: dokument deklaruje 3 HIGH + 1 MEDIUM zamiast 2 HIGH + 1 MEDIUM + LOW,
  używa nieistniejących ścieżek `src/db/...`, twierdzi, że reconciliation
  porównuje resolution/evidence JSONB, i podaje nazwy/liczebności testów inne niż
  rzeczywiste. Deklarowane ~50 USD kosztu remediacji także nie odpowiada statystyce
  OpenCode (całość w chwili audytu około 103,55 USD).
- Wpływ: handoff ponownie deklaruje zabezpieczenie, którego kod nie implementuje.
- Wymagana zmiana: HANDOFF-04 ma zawierać wyłącznie rzeczywiste ścieżki, komendy,
  liczby i mechanizmy zweryfikowane testami.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 19 plików, 359/359 PASS. |
| `pnpm run workflow:validate` | 0 | 26 tasks PASS. |
| `git diff --check` | 0 | Brak błędów whitespace. |
| Identyczny completion replay z non-null receipt | 0 procesu | Błędny `CompletionConflictError`. |
| Ten sam reconciliation key z innym resolution/evidence | 0 procesu | Błędnie zwrócono stary wynik bez conflict. |
| Replay intentu A z `jobId` joba B | 0 procesu | Błędnie zaakceptowany; status pobrany z joba B. |
| Trigger-paused completion + reap + ABSENT + takeover | 0 procesu | Stary token 1 zapisał completion po tokenie 2. |

## Wymagane działania po `continue`

1. Zamknąć atomowe fencing window completion i sprawdzać intent token/rowCount.
2. Walidować reconciliation provenance przed early return oraz porównywać pełną
   semantykę replayu.
3. Naprawić rzeczywistą JSONB equality completion i dodać trzy regresje replay.
4. Skorygować handoff, uruchomić focused/full PostgreSQL gate i wystawić HANDOFF-04.

## Uzasadnienie werdyktu

DB-time i podstawowy lifecycle zostały poprawione, ale kontrolowany race nadal
pozwala staremu workerowi zapisać wynik po takeover, a reconciliation replay
akceptuje obcy job i konfliktującą semantykę. Przy findingach HIGH/MEDIUM `PASS`
jest niedozwolony; właściwy werdykt to `CHANGES_REQUIRED`.
