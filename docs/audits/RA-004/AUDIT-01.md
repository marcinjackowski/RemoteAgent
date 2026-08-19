# RA-004 — Audit 01

## Metadata

- Task: `RA-004`
- Audytowany handoff: `docs/handoffs/RA-004/HANDOFF-01.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Migracje, podstawowy claim/fencing, retry/DLQ i testy dwóch workerów działają na
prawdziwym PostgreSQL, a pełna suite 337/337 jest zielona. Niezależne próby
adwersarialne odtworzyły jednak kilka nieprzetestowanych naruszeń głównego celu
RA-004: completion `AMBIGUOUS` jest automatycznie requeue'owane, błąd zapisu po
udanym handlerze powoduje replay, spóźniony relay może cofnąć `PUBLISHED` do
`PENDING`, idempotency key może przypisać intent innego joba, a jawne
`serializationKey=null` pozwala uruchomić dwa joby jednego case równolegle.
Reconciliation `UNRESOLVED` nie może później przejść do rozstrzygnięcia. Z tego
powodu kryteria 2, 3, 4 i 6 nie są spełnione.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`,
  `docs/workflow/AUDIT_CHECKLIST.md`, `docs/tasks/TASK_INDEX.md`,
  `docs/tasks/RA-004.md`, `docs/handoffs/RA-004/HANDOFF-01.md`.
- Sprawdzony stan: migracje 012-014, cały `packages/database/src/queue`, eksporty,
  trzy nowe pliki testowe, wywoływany `Database`/`Transaction` i schema bazowa
  RA-003.
- Kontrole: pełna suite z obowiązkowym realnym PostgreSQL oraz niezależne próby
  recovery, stale relay, kolizji idempotency, clock skew, serializacji i błędu
  persistence po handlerze na osobnych, migrowanych bazach.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Commit stanu i outbox message jest atomowy | PASS | `OutboxRepository.enqueue` wymaga branded `Transaction`; test rollbacku i pełna suite PASS |
| 2. Crash po intent przed completion nie replayuje write | FAIL | missing completion trafia do `RECONCILING`, ale completion `AMBIGUOUS` jest uznawane za zakończone i requeue'owane do `PENDING`; HIGH-01 |
| 3. Wygasły worker nie zapisze po takeover | FAIL | status joba jest fence'owany, lecz `recordCompletion` nie przyjmuje lease/token; relay finalizuje bez ownera/tokena/expiry; HIGH-02 i HIGH-03 |
| 4. Jeden case sekwencyjnie, różne cases równolegle | FAIL | dwa joby z tym samym `case_id` i `serializationKey=null` zostały równocześnie claimed; HIGH-05 |
| 5. Bounded exponential backoff i obserwowalny DLQ | PASS | bounded schedule, job/outbox DLQ i widoki przechodzą; stan relaya nadal wymaga fencing z HIGH-03 |
| 6. Reconciliation idempotentne i audytowalne | FAIL | `UNRESOLVED` zajmuje jedyny rekord 1:1 i blokuje późniejsze `CONFIRMED`; równoległy reconcile nie jest idempotentny; MEDIUM-06 |

## Findingi

### HIGH-01 — Completion `AMBIGUOUS` jest automatycznie replayowane

- Lokalizacja: `packages/database/src/queue/job-store.ts:486-524` oraz
  `packages/database/src/queue/job-store.ts:641-668`.
- Dowód: zapisano intent i completion z `outcome='AMBIGUOUS'`, wygaszono lease i
  uruchomiono `reapExpired`. Wynik: `reconciling=[]`, `requeued=[job-1]`, status
  `PENDING`. Reaper sprawdza tylko brak wiersza completion, nie jego outcome.
- Wpływ: zewnętrzny write o nieznanym wyniku może zostać wykonany ponownie, co
  bezpośrednio łamie kryterium 2 i zasadę `AMBIGUOUS` z Master Planu.
- Wymagana zmiana: traktować brak completion **lub** outcome `AMBIGUOUS` jako
  wymagające `RECONCILING`; najlepiej atomowo przechodzić do `RECONCILING` przy
  zapisie AMBIGUOUS. Dodać test crash/reap dla completion `AMBIGUOUS` i dowód, że
  job pozostaje nieclaimowalny do rozstrzygnięcia.

### HIGH-02 — Scheduler replayuje udany side effect po błędzie zapisu completion

- Lokalizacja: `packages/database/src/queue/scheduler.ts:72-80`.
- Dowód: handler zwiększył licznik efektów, następnie kontrolowany błąd wystąpił
  tylko w `jobs.complete`. Wspólny `catch` wywołał `jobs.fail`, ustawił `PENDING`,
  a kolejny tick uruchomił handler drugi raz. Stan końcowy `SUCCEEDED`, licznik
  efektów `2`.
- Wpływ: błąd/niejednoznaczny commit persistence po udanym write jest traktowany
  jak błąd pracy i prowadzi do automatycznego duplikatu efektu.
- Wymagana zmiana: rozdzielić błąd handlera od błędu finalizacji. Po rozpoczęciu
  side effectu nie wolno kierować niejednoznacznego completion do zwykłego retry;
  potrzebny jest trwały intent/completion protocol oraz przejście do
  `RECONCILING`/recovery. Dodać fault injection dokładnie po udanym handlerze i
  przed/na commit completion, z dowodem jednego efektu.

### HIGH-03 — Outbox relay nie fence'uje finalizacji i może cofnąć opublikowany stan

- Lokalizacja: `packages/database/src/queue/outbox.ts:139-210` oraz migracja
  `014_outbox_relay.up.sql`.
- Dowód: relay A claimował wiadomość i przekroczył lease; relay B przejął ją i
  ustawił `PUBLISHED`; spóźniony A zgłosił błąd. Bezwarunkowy UPDATE A zmienił
  końcowy stan z `PUBLISHED` na `PENDING` (`attempts=1`). Wszystkie trzy UPDATE-y
  końcowe filtrują tylko po `outbox_id`.
- Wpływ: stale relay może nadpisać wynik aktualnego właściciela, wywołać kolejne
  publikacje albo nawet cofnąć sukces do DLQ. Batch przetwarzany sekwencyjnie może
  też wygasnąć przed dojściem do późniejszych rekordów.
- Wymagana zmiana: dodać monotoniczny dispatch fencing token/generation i
  warunkować publish/fail/retry na `outbox_id + lease_owner + token + live lease`;
  zero rows ma failować zamknięcie bez zmiany stanu. Zapewnić renewal albo claim
  per-message dla długich batchy. Dodać dwurelayowy test takeover ze spóźnionym
  success i failure oraz brak regresji `PUBLISHED`.

### HIGH-04 — Intent idempotency może zwrócić intent innego joba, a zapis nie jest atomowo lease-gated

- Lokalizacja: `packages/database/src/queue/job-store.ts:428-478`.
- Dowód: dwa aktywne joby zapisały różne kind/descriptor z tym samym
  `idempotencyKey`. Drugi call zwrócił `intent_id` pierwszego joba; odczyt ledgeru
  wskazywał pierwszy `job_id`, bez błędu. Ponadto SELECT sprawdzający lease i
  późniejszy INSERT są osobnymi auto-commit statementami, więc expiry/reap/takeover
  może wejść między nie.
- Wpływ: worker może uznać, że własny intent jest trwały, wykonać write, a reaper
  jego joba nie znajdzie intentu i bezpiecznie-looking requeue'uje go do replay.
  Stale worker może też zapisać intent po utracie lease.
- Wymagana zmiana: wykonać conditional intent insert atomowo w transakcji/CTE
  zależnym od aktualnego ownera, tokena, statusu i expiry. Konflikt idempotency ma
  być no-op wyłącznie dla identycznego joba/kind/canonical descriptor; każda inna
  kolizja fail-closed. Analogicznie completion conflict musi porównywać job,
  outcome i receipt zamiast zwracać dowolny istniejący rekord. Dodać cross-job,
  mismatched-payload i lease-takeover tests.

### HIGH-05 — Publiczne API pozwala wyłączyć per-case serialization

- Lokalizacja: `packages/database/src/queue/job-store.ts:43-50` i
  `packages/database/src/queue/job-store.ts:143-168`; migracja
  `012_jobs_leases_retry.up.sql:47-62`.
- Dowód: dwa joby z identycznym `case_id='case-x'` i jawnym
  `serializationKey=null` zostały równolegle claimed przez dwóch workerów; oba
  lease miały `case-x` i null key.
- Wpływ: zwykłe, typowane użycie eksportowanego API łamie kryterium 4; partial
  unique index nie chroni null ani alternatywnego klucza.
- Wymagana zmiana: dla każdego joba z `case_id` deterministycznie wymuszać
  `serialization_key=case_id` poza modelem/callerem, najlepiej również CHECK lub
  triggerem DB. Custom/null group może dotyczyć wyłącznie jobów bez case. Dodać
  negatywne testy null i innego klucza.

### MEDIUM-06 — Reconciliation `UNRESOLVED` jest nieodwracalnym ślepym zaułkiem

- Lokalizacja: `packages/database/src/queue/job-store.ts:534-607` oraz
  `packages/database/migrations/013_job_attempts_reconciliation.up.sql:107-118`.
- Dowód: pierwsze `reconcile(...UNRESOLVED)` pozostawiło job `RECONCILING`;
  następne `reconcile(...CONFIRMED)` zwróciło stary `UNRESOLVED` i job nadal był
  `RECONCILING`. `UNIQUE(intent_id)` dopuszcza tylko jeden wpis. Dwa równoległe
  pierwsze wywołania mogą też oba minąć SELECT, a przegrany dostanie unique error
  zamiast idempotentnego rezultatu.
- Wpływ: operator nie może ponowić późniejszej kontroli i domknąć wcześniej
  nierozstrzygniętego efektu; audyt nie ma historii kolejnych prób.
- Wymagana zmiana: modelować append-only próby reconciliation z osobnym kluczem
  idempotency i terminalnym rozstrzygnięciem, pozwalając `UNRESOLVED` → późniejsze
  `CONFIRMED|ABSENT`; obsłużyć race przez lock/UPSERT i walidować zgodność
  `intentId/jobId`. Dodać test sekwencyjny i równoległy.

### MEDIUM-07 — Lease lifecycle i attempt history nie mają bezpiecznych granic transakcyjnych

- Lokalizacja: `packages/database/src/queue/job-store.ts:288-406`,
  `packages/database/src/queue/job-store.ts:621-672` oraz
  `packages/database/src/queue/scheduler.ts:61-80`.
- Dowód: `complete`/`fail` aktualizują job, a dopiero osobnym auto-commit INSERT-em
  zapisują attempt; crash/drugi błąd pozostawia finalny status bez historii.
  `reapExpired` deklaruje `LEASE_LOST`, lecz nie zapisuje żadnego attemptu.
  Scheduler nie heartbeat'uje/renewuje lease podczas handlera. Dodatkowo dwaj
  workerzy z clockami 1000 i 1000000 spowodowali natychmiastowy reap i takeover
  żywego 30-sekundowego lease, bo wszystkie granice używają zegara procesu.
- Wpływ: historia prób nie jest trwałym źródłem prawdy, długi handler może utracić
  lease, a clock skew może przedwcześnie uruchomić drugi worker.
- Wymagana zmiana: atomowo łączyć transition joba z attempt append; reaper ma
  zapisywać `LEASE_LOST`. Dodać jawny renewal/heartbeat contract schedulera oraz
  użyć jednego autorytatywnego czasu dla lease (preferencyjnie PostgreSQL) albo
  udokumentować i wymusić bezpieczny mechanizm tolerancji skew. Dodać test awarii
  między transition i attempt, długi handler z renewal oraz skew/takeover.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 18 plików, 337/337 PASS na realnym PostgreSQL |
| izolowany probe intent + completion `AMBIGUOUS` + reap | 0 | błędnie `PENDING`, nie `RECONCILING` |
| izolowany cross-job idempotency collision | 0 | drugi job dostał intent pierwszego |
| dwa claimy `case_id` z `serializationKey=null` | 0 | oba claimy aktywne równocześnie |
| `UNRESOLVED` następnie `CONFIRMED` | 0 | drugie rozstrzygnięcie zignorowane; job nadal `RECONCILING` |
| dwa relaye: expired A, successful B, late failed A | 0 | `PUBLISHED` cofnięte do `PENDING` |
| handler success + kontrolowany błąd `complete` + następny tick | 0 | handler wykonany 2 razy |
| dwa różne client clocks i 30 s lease | 0 | natychmiastowy reap i takeover, token 2 |

## Ryzyka przekrojowe

- Security/privacy: brak sekretów w nowym zakresie; cross-job idempotency może
  jednak pomylić provenance i scope side effectu.
- Idempotencja/recovery: HIGH — kilka odtworzonych ścieżek automatycznie replayuje
  lub ponownie publikuje możliwie wykonany efekt.
- Współbieżność: advisory lock i partial unique działają dla domyślnego key, ale
  relay nie ma fencing, a per-case key jest opcjonalny dla callera.
- Observability: DLQ jest widoczny, lecz attempt history może nie odpowiadać
  statusowi joba; loop schedulera dodatkowo połyka błędy bez hooka/logu.
- Kompatybilność: migracje 012-014 przechodzą lifecycle, lecz naprawy schema muszą
  zachować addytywny upgrade albo świadomie odtworzyć jeszcze niewydane migracje.

## Wymagane działania po `continue`

1. Zamknąć HIGH-01..05 i dodać wskazane adwersarialne testy na realnym PG.
2. Przebudować reconciliation tak, by `UNRESOLVED` można było później domknąć i
   by równoległe/idempotentne wywołania miały deterministyczny wynik.
3. Uczynić transition+attempt atomowym, dodać `LEASE_LOST`, renewal oraz
   autorytatywny czas lease.
4. Ponowić fault injection commit/publish/start/complete, dwa workery, skew,
   retry/DLQ, migracje up/down/up i clean-room; zapisać `HANDOFF-02`.

## Uzasadnienie werdyktu

Zielone testy pokrywają happy paths, lecz niezależne próby odtworzyły automatyczny
replay `AMBIGUOUS`, podwójny handler, stale relay state regression i obejście
per-case serialization. Są to bezpośrednie naruszenia celu i czterech kryteriów
RA-004. Problemy są naprawialne w zakresie taska, więc właściwy werdykt to
`CHANGES_REQUIRED`.
