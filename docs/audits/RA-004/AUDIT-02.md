# RA-004 — Audit 02

## Metadata

- Task: `RA-004`
- Audytowany handoff: `docs/handoffs/RA-004/HANDOFF-02.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacje findingów AUDIT-01 poprawiły atomowość attemptów, fencing relaya,
per-case serialization, obsługę `AMBIGUOUS`, heartbeat i lease clock. Pełna
suite 354/354 jest zielona. Niezależne próby na PostgreSQL wykazały jednak, że
publiczny zapis completion nadal pozwala staremu workerowi usunąć lease nowego
workera, konfliktujące replay completion są cicho akceptowane, a reconciliation
nie wiąże klucza próby z intentem i nie egzekwuje stanu `RECONCILING`.
Domyślny tryb DB-time chroni samo expiry lease, ale zegar procesu nadal pozwala
ominąć godzinny backoff. Kryteria 3, 5 i 6 pozostają niespełnione.

## Zakres audytu

- Przeczytane: dokumenty obowiązkowe, checklist audytora, `AUDIT-01`,
  `HANDOFF-02`, migracje 012-014, cały kod kolejki i nowe testy RA-004.
- Sprawdzone niezależnie: fencing completion po takeover, semantyka idempotentnego
  completion, provenance/lifecycle reconciliation oraz clock skew względem
  `available_at`.
- Uruchomione: pełna suite z wymuszonym realnym PostgreSQL, cztery izolowane
  próby adwersarialne i `workflow:validate`.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Commit stanu i outbox message jest atomowy | PASS | Branded transaction i rollback test pozostają zielone. |
| 2. Crash po intent przed completion nie replayuje write | PASS | Reaper kieruje brak/`AMBIGUOUS` completion do `RECONCILING`; regresje przechodzą. |
| 3. Wygasły worker nie zapisze po takeover | FAIL | `recordCompletion` ma opcjonalny lease; stary intent po expiry, reconciliation `ABSENT` i takeover tokenem 2 usunął nowy lease i ustawił `RECONCILING`; HIGH-01. |
| 4. Jeden case sekwencyjnie, różne cases równolegle | PASS | API wymusza `serialization_key=case_id`, DB CHECK i testy dwóch workerów przechodzą. |
| 5. Bounded exponential backoff i obserwowalny DLQ | FAIL | Worker z przyszłym zegarem claimuje job godzinę przed bazodanowym `available_at` mimo domyślnego `leaseTime='db'`; MEDIUM-03. |
| 6. Reconciliation idempotentne i audytowalne | FAIL | Globalny `attempt_key` miesza różne intenty, a terminalne reconcile żywego joba zapisuje ledger i zwraca status niezgodny z bazą; HIGH-02. |

## Findingi

### HIGH-01 — Completion nie wymaga lease i stary worker może odebrać job nowemu workerowi

- Lokalizacja: `packages/database/src/queue/job-store.ts:613-694`.
- Dowód: worker 1 zapisał intent, utracił lease, reaper ustawił
  `RECONCILING`, a reconciliation `ABSENT` bezpiecznie przywróciło `PENDING`.
  Worker 2 przejął job z fencing tokenem 2. Następnie wywołanie starego workera
  `recordCompletion({intentId, jobId, outcome:'AMBIGUOUS'})` bez pola `lease`
  zakończyło się sukcesem, ustawiło job na `RECONCILING` i wyczyściło ownera
  workera 2. Warunkowanie lease jest opcjonalne, a UPDATE dla `AMBIGUOUS`
  filtruje tylko `job_id + status='LEASED'`.
- Dodatkowy dowód: drugi zapis tego samego intentu z innym outcome i receipt
  (`SUCCEEDED/A`, następnie `FAILED/B`) zwrócił ten sam completion ID bez błędu;
  ledger zachował pierwszy wynik. To nie realizuje wymagania z HIGH-04
  AUDIT-01, że conflict jest no-op tylko dla semantycznie identycznego zapisu.
- Wpływ: publiczne API bez tokena bezpośrednio łamie kryterium 3, może przerwać
  pracę aktualnego właściciela i ukryć sprzeczny wynik zewnętrznego efektu.
- Wymagana zmiana: uczynić `lease` obowiązkowym dla workerowego completion albo
  rozdzielić jawnie fence'owane API workerowe od kontrolowanego recovery.
  Insert/replay i przejście `AMBIGUOUS` muszą atomowo sprawdzać aktualny owner,
  token, żywy lease i zgodność `intentId/jobId`. Konflikt istniejącego completion
  ma zwracać sukces wyłącznie dla identycznych `jobId/outcome/receipt`, inaczej
  typowany conflict. Dodać dokładne regresje takeover i mismatched replay.

### HIGH-02 — Reconciliation nie izoluje intentów i może zapisać fałszywy terminalny stan

- Lokalizacja: `packages/database/src/queue/job-store.ts:715-821` oraz
  `packages/database/migrations/013_job_attempts_reconciliation.up.sql:112-134`.
- Dowód cross-intent: dwa joby z dwoma intentami trafiły do `RECONCILING`.
  Pierwszy zapisał `UNRESOLVED` z `attemptKey='shared-attempt'`; drugi wywołał
  `CONFIRMED` z tym samym kluczem. API drugiego zwróciło ID i `UNRESOLVED`
  pierwszego, a ledger nie dostał wpisu dla drugiego intentu. Schema ma globalne
  `UNIQUE(attempt_key)`, a lookup nie porównuje `intent_id`, `job_id`, resolution
  ani evidence.
- Dowód lifecycle: `reconcile(CONFIRMED)` wywołane na jobie nadal `LEASED`
  zapisało terminalną reconciliation i completion `SUCCEEDED`, po czym zwróciło
  `jobStatus='SUCCEEDED'`. Warunkowy UPDATE zmienił zero wierszy, więc faktyczny
  job pozostał `LEASED` z żywym ownerem. Row count i wejściowy stan joba nie są
  sprawdzane.
- Wpływ: audit ledger może przypisać wynik obcemu intentowi albo przeczyć
  autorytatywnemu statusowi joba. Recovery nie jest idempotentne ani audytowalne
  zgodnie z kryterium 6.
- Wymagana zmiana: zakres klucza ustalić jako `(intent_id, attempt_key)` albo przy
  globalnym kluczu failować zamknięcie na dowolnej nieidentycznej semantyce.
  Reconcile ma pod lockiem wymagać właściwego stanu `RECONCILING` przed insertem
  i atomowo potwierdzić row count przejścia; idempotentny replay stanu terminalnego
  musi porównywać pełną provenance i zwracać rzeczywisty status. Dodać testy
  cross-intent, mismatched resolution/evidence i reconcile żywego joba.

### MEDIUM-03 — Domyślny DB-time nie chroni harmonogramu retry przed clock skew

- Lokalizacja: `packages/database/src/queue/job-store.ts:214-277,356-408` oraz
  `packages/database/src/queue/outbox.ts:139-174,249-272`.
- Dowód: worker z normalnym zegarem wykonał `fail`, ustawiając
  `available_at = DB-now + 1h`. Natychmiast potem drugi `JobStore` w domyślnym
  `leaseTime='db'`, ale z zegarem procesu przesuniętym o rok do przodu, claimował
  ten job, mimo że `clock_timestamp()` bazy był godzinę przed `available_at`.
  Predykat due i wyliczenie retry nadal używają `$nowMs` procesu; analogiczny
  wzorzec występuje w outboxie.
- Wpływ: bounded exponential backoff jest liczony, lecz nie jest skutecznie
  egzekwowany w środowisku wieloworkerowym. Awaria/skew zegara może wywołać
  natychmiastowy retry i zwiększyć ryzyko duplikatów lub przeciążenia providera.
- Wymagana zmiana: w domyślnym trybie DB-time używać czasu PostgreSQL również do
  predykatu `available_at` i bazowego momentu retry/outbox; tryb `injected` może
  pozostać jawnym mechanizmem deterministycznych testów. Dodać test skew, który
  potwierdza brak claimu przed bazodanowym terminem backoff.

### LOW-04 — HANDOFF-02 opisuje inną schemę niż dostarczona

- Lokalizacja: `docs/handoffs/RA-004/HANDOFF-02.md:145-166`.
- Dowód: handoff deklaruje `attempt_key UUID` i unique
  `(intent_id, attempt_key)`, podczas gdy migracja używa `text NOT NULL UNIQUE`
  globalnie. Wskazane nazwy części testów i liczebności również nie odpowiadają
  bieżącemu drzewu (pełna suite ma 354 testy).
- Wpływ: evidence handoffu ukrywa dokładnie lukę provenance odtworzoną w HIGH-02.
- Wymagana zmiana: kolejny handoff ma opisywać rzeczywistą schemę, faktyczne
  pliki/komendy i wyniki, bez deklarowania niezaimplementowanych zabezpieczeń.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 19 plików, 354/354 PASS na realnym PostgreSQL. |
| `pnpm run workflow:validate` przed zapisem audytu | 0 | `workflow:validate OK — 26 tasks`. |
| Stary completion po expiry → `ABSENT` → takeover token 2 | 0 procesu | Błędnie wyczyścił nowy lease i ustawił `RECONCILING`. |
| Completion replay `SUCCEEDED/A` → `FAILED/B` | 0 procesu | Drugi call zaakceptowany; zwrócił ID pierwszego wpisu. |
| Wspólny `attemptKey` dla dwóch intentów | 0 procesu | Drugi intent dostał reconciliation pierwszego; brak własnego wpisu. |
| `reconcile(CONFIRMED)` na żywym `LEASED` jobie | 0 procesu | API/ledger `SUCCEEDED`, rzeczywisty job nadal `LEASED`. |
| Godzinny retry + worker ze skew +1 rok w DB-time | 0 procesu | Job claimowany godzinę przed `available_at` według DB. |

## Ryzyka przekrojowe

- Security/privacy: cross-intent collision miesza provenance operacji; brak
  nowych sekretów/PII w kodzie i fixtures.
- Idempotencja/recovery: HIGH — completion oraz reconciliation mogą zaakceptować
  sprzeczną semantykę lub wpłynąć na lease innego workera.
- Współbieżność: relay i podstawowe transition fencing są poprawione, lecz
  publiczny completion omija fencing.
- Operacyjność: DLQ i attempt ledger są obserwowalne, ale ledger reconciliation
  może przeczyć stanowi joba; handoff wymaga korekty.
- Clock assumptions: expiry korzysta z czasu DB, lecz due/backoff pozostają
  zależne od niezaufanego zegara procesu.

## Wymagane działania po `continue`

1. Domknąć fence i semantyczną idempotencję `recordCompletion` wraz z takeover
   testami.
2. Związać `attemptKey` z intentem, egzekwować lifecycle `RECONCILING` i sprawdzać
   rzeczywisty wynik transition.
3. Użyć DB clock dla due/backoff w produkcyjnym trybie jobów i outboxu.
4. Skorygować handoff, uruchomić pełną suite/fault injection i wystawić kolejny
   handoff do audytu.

## Uzasadnienie werdyktu

Większość findingów AUDIT-01 została skutecznie naprawiona, lecz niezależne
reprodukcje nadal wykazują bezpośrednie naruszenie fencing po takeover,
niespójny audit ledger i obejście retry backoff. Są to findingi HIGH/MEDIUM
naprawialne w zakresie RA-004, dlatego `PASS` jest niedozwolony, a werdykt to
`CHANGES_REQUIRED`.
