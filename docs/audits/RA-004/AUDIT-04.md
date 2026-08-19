# RA-004 — Audit 04

## Metadata

- Task: `RA-004`
- Audytowany handoff: `docs/handoffs/RA-004/HANDOFF-04.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacje AUDIT-03 dla completion lock, JSONB receipt oraz reconciliation
provenance działają w niezależnych próbach. Audyt wykazał jednak, że analogiczna
granica fencing nadal jest otwarta w `recordIntent`: pojedynczy `INSERT ...
SELECT` nie blokuje wiersza jobu, a ścieżka konfliktu zwraca istniejący intent bez
ponownej walidacji żywego lease. Kontrolowane próby pozwoliły staremu tokenowi 1
zapisać nowy intent już po takeover tokenem 2, a także dostać sukces z istniejącego
intentu po `ABSENT` i takeover. Dodatkowo descriptor nie jest porównywany
semantycznie jako JSONB, completion nie wiąże przekazanego `lease.jobId` z
`input.jobId`, a domyślna dostępność job/outbox nadal miesza zegar procesu z
DB-time. Pełna bramka audytora zakończyła się 360/363 zamiast PASS.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Granice transakcji i rollback regressions bez nowego findingu. |
| 2. Crash po intent nie replayuje write | FAIL | Stary worker może ponownie uzyskać sukces z `recordIntent` po `ABSENT` i takeover; HIGH-01. |
| 3. Wygasły worker nie zapisze po takeover | FAIL | Trigger-paused fresh intent został zapisany tokenem 1 po claimie tokenem 2; HIGH-01. |
| 4. Per-case serialization | NOT_VERIFIED | Implementacja zachowuje DB backstop, ale wymagany test dwóch workerów był niestabilny i przetworzył 7–9/10 jobów wskutek clock mismatch; MEDIUM-04. |
| 5. Bounded backoff i DLQ | PASS | Backoff retry pozostaje DB-time i bounded. |
| 6. Reconciliation idempotentne i audytowalne | PASS | Exact/mismatched replay oraz wrong-job provenance przeszły; poprawki AUDIT-03 potwierdzone. |

## Findingi

### HIGH-01 — `recordIntent` nie jest fence'owany przez cały insert/replay

- Lokalizacja: `packages/database/src/queue/job-store.ts:542-615`.
- Dowód 1: na izolowanej bazie audyt dodał `BEFORE INSERT` trigger z
  `pg_sleep(1)`. Token 1 przeszedł warunek `INSERT ... SELECT`, następnie lease
  wygasł, reaper przeniósł job do `PENDING`, worker 2 claimował token 2, a stary
  insert mimo to zakończył się sukcesem i zapisał `job_intents.fencing_token=1`.
- Dowód 2: token 1 najpierw zapisał intent, po expiry job przeszedł przez
  reconciliation `ABSENT` i został claimowany tokenem 2. Identyczny call
  `recordIntent` ze starym lease tokenu 1 zwrócił istniejący `intent_id` zamiast
  `StaleFencingTokenError`. Bieżący token 2 również mógł adoptować intent tokenu
  1 z tym samym kluczem.
- Przyczyna: zwykły SELECT wewnątrz `INSERT ... SELECT` nie utrzymuje row locka
  chroniącego przed reaper/takeover. Po `ON CONFLICT DO NOTHING` kod porównuje
  tylko job/kind/descriptor i nie sprawdza ponownie żywego owner/token/status ani
  `job_intents.fencing_token`.
- Wpływ: worker po utracie fence może uzyskać potwierdzony intent i wykonać
  zewnętrzny write po takeover, co narusza kryteria 2 i 3 oraz grozi
  zduplikowaniem side effectu.
- Wymagana zmiana: przed insertem/replayem zablokować dokładny żywy wiersz jobu
  `FOR UPDATE` i utrzymać lock do commitu; powiązać job/owner/token/status/expiry
  oraz `lease.jobId`. Exact replay wolno zwrócić tylko pod nadal żywym, tym samym
  fencing tokenem i dla intentu zapisanego tym tokenem. Dodać oba opisane testy:
  pause-before-insert + takeover oraz stale exact replay po `ABSENT` + takeover.

### MEDIUM-02 — Identyczny descriptor JSONB może fałszywie konfliktować

- Lokalizacja: `packages/database/src/queue/job-store.ts:553,589-612`.
- Dowód: dwa wywołania tego samego joba/kind/key z descriptor
  `{b:2,a:1}`; pierwsze zapisało intent, drugie rzuciło
  `IdempotencyConflictError`. PostgreSQL zwrócił znormalizowany obiekt JSONB, a
  kod porównał `JSON.stringify` obiektu drivera z kolejnością wejściową JS.
- Wpływ: legalne redelivery po niejednoznacznym wyniku persistence zatrzymuje
  recovery mimo identycznej semantyki intentu.
- Wymagana zmiana: porównać descriptor po stronie PostgreSQL przez JSONB
  `IS NOT DISTINCT FROM` (razem z job/kind/token), dodać identyczny/reordered
  replay i rzeczywisty mismatch.

### MEDIUM-03 — Completion nie wiąże `lease.jobId` z `input.jobId`

- Lokalizacja: `packages/database/src/queue/job-store.ts:636-670`.
- Dowód: dwa żywe joby A/B claimowane przez ownera `W`, oba z tokenem 1.
  `recordCompletion(intentA, jobId=A, lease=leaseB)` zapisał completion A i
  zwrócił ID, ponieważ SQL używa wyłącznie owner/token z lease B, ale ignoruje
  jego `jobId`.
- Wpływ: typed lease nie jest deterministycznym capability dla dokładnego joba;
  pomyłka lub współdzielony worker może autoryzować ledger innego case/jobu.
- Wymagana zmiana: fail-closed wymagać `input.jobId === input.lease.jobId` przed
  transakcją/SQL i dodać cross-job lease regression (nawet przy równych
  owner/token).

### MEDIUM-04 — Początkowa dostępność miesza process clock z DB-time

- Lokalizacja: `packages/database/src/queue/job-store.ts:158-180` oraz
  `packages/database/src/queue/outbox.ts:91-119`.
- Dowód: w domyślnym trybie DB `enqueue` zapisuje `available_at` z
  `SystemClock`, natomiast claim/relay porównuje z `clock_timestamp()`. W dwóch
  kolejnych przebiegach audytora świeży claim zwracał `null`; pełna suite miała
  360/363 PASS, a focused suite 32/35 PASS. Nieudane były oba testy DB-time
  immediate claim oraz test jednego case (przetworzył kolejno 9/10 i 7/10).
- Wpływ: dodatni skew procesu może opóźnić nowy job/outbox arbitralnie; nawet
  milisekundowy skew powoduje flaki w wymaganej weryfikacji.
- Wymagana zmiana: gdy caller nie podaje jawnego `availableAtMs`, zapisywać
  początkowe `available_at` z tego samego `scheduleBase` co due predicate
  (`clock_timestamp()` w DB mode, injected clock w test mode). Zastosować to do
  jobs i `outbox_dispatch`; dodać skew/immediate regressions bez timing luck.

## Potwierdzone poprawki AUDIT-03

- `recordCompletion` blokuje wiersz jobu `FOR UPDATE OF j` przez insert/commit;
  reaper i claim nie overtookują kontrolowanej pauzy.
- Completion receipt exact/reordered replay zwraca ten sam ID, mismatch daje
  `CompletionConflictError`.
- Reconciliation waliduje `(intentId, jobId)` przed early return i wymaga
  zgodnego resolution/evidence dla same-key replay.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 1 | 19 plików, 360/363 testów; 3 queue failures, dalsze etapy bramki nieuruchomione. |
| Focused concurrency + adversarial suite | 1 | 2 pliki, 32/35; te same trzy failures. |
| Trigger-paused `recordIntent` + expiry/reap/claim token 2 | 0 procesu | Stary insert tokenu 1 zapisał się po takeover. |
| Exact stale intent replay po `ABSENT` + takeover | 0 procesu | Stary token 1 błędnie dostał istniejący intent ID. |
| Wielopolowy descriptor exact replay | 0 procesu | Błędny `IdempotencyConflictError`. |
| Completion A z lease B o równym owner/token | 0 procesu | Błędnie zapisano completion A. |

## Wymagane działania po `continue`

1. Zastosować row-lock fencing również do całego `recordIntent`, w tym conflict
   replay, i testować świeży race oraz stale replay.
2. Zastąpić descriptor `JSON.stringify` equality semantycznym porównaniem JSONB.
3. Powiązać completion z dokładnym `lease.jobId`.
4. Ujednolicić początkowy job/outbox `available_at` z autorytatywnym clock mode.
5. Uruchomić focused testy wielokrotnie, pełne `pnpm run check`, zapisać
   `HANDOFF-05` i wrócić do audytu.

## Uzasadnienie werdyktu

Trzy findingi AUDIT-03 są usunięte, lecz świeży i replayowany intent nadal może
przejść po utracie fencing tokenu, co bezpośrednio umożliwia duplikację write.
Przy HIGH/MEDIUM oraz nieprzechodzącej wymaganej suite `PASS` jest niedozwolony;
właściwy werdykt to `CHANGES_REQUIRED`.
