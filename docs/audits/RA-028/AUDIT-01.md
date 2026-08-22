# RA-028 — AUDIT-01

- Task: `RA-028` Handlery workera: system wykonuje pracę
- Data: `2026-08-22`
- Bazowy commit: `88001ea` (stan po domknięciu RA-027)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt jest w §8.

## 1. Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run          (całe repo)
  → 2398/2398, 168 plików, exit 0, PIĘĆ przebiegów z rzędu, zero `FAIL`

RA_REQUIRE_POSTGRES=1 pnpm vitest run apps/agent-worker/test test/processes
  → 56/56, exit 0

pnpm run lint                              → exit 0
pnpm run format                            → exit 0
node …/tsc.js -p tsconfig.json --noEmit    → exit 0
pnpm run typecheck --force                 → 38 successful, 0 cached
pnpm run build --force                     → 26 successful, 0 cached
git diff --check                           → exit 0
```

Testy: 2374 → **2398** (+24). Pliki: 166 → 168.

## 2. Dowód, że system wykonuje pracę

RA-027 udowodnił, że proces **startuje**. To jest dowód, że **wykonuje pracę** — jedyna
rzecz, której nie miał żaden poprzedni task, i cała treść tego taska.

`test/processes/process-behaviour.integration.test.ts` wkłada wiersz do kolejki, startuje
**realny** proces `worker` nad **realnym** PostgreSQL-em i czeka, aż własna pętla
`Scheduler`a podejmie joba. Nic w tym teście nie woła handlera bezpośrednio. Wynik
odczytany z bazy:

```text
run_completions                → 1 wiersz
cases.checkpoint_revision      → 0 → 1
outbox                         → agent.completion.recorded
transport.requests             → 1 (FakeTransport, zero ruchu do AWS)
jobs.status                    → SUCCEEDED
```

Przed RA-028 **ten sam setup** kończył się `UnknownJobTypeError` i joba w DLQ, bo proces
startował z pustą mapą handlerów. Sprawdzone mutacją: przywrócenie `handlers: {}` czerwieni
ten test.

Zbudowany artefakt też został sprawdzony, nie tylko źródła:

```text
$ node … dist/handlers.js
registered job types: ["case.resume","agent.implementer"]
```

## 3. Kryteria akceptacji — każde osobno

### AC1 — `case.resume` przenosi case przez `pumpOnce()` i zapisuje completion

**Spełnione.** §2 plus `apps/agent-worker/test/handlers.integration.test.ts`.

Asercje czytają **bazę**, nie wartość zwracaną. To nie jest kosmetyka: `pumpOnce()`
zwraca wynik również wtedy, gdy nic nie zrobił, więc `await handler(...)` bez asercji na
stanie bazy przechodzi dla handlera, który nie robi nic. Dokładnie ten test wykrył trzy
realne defekty z §5.

### AC2 — nieznany `job_type` nadal fail-closed

**Spełnione.** Regresja na `D1`/`D2` z RA-027: test rejestruje trzy handlery i sprawdza, że
**czwarty**, nieznany typ nadal rzuca `UnknownJobTypeError`. Podłączenie handlerów nie
otworzyło cichej ścieżki — to kształt `CTF-010` finding 4.

Drugi przypadek: `jira.webhook.renewal` **bez** rejestracji też trafia do DLQ. „Nie
skonfigurowane" jest widoczne i alarmowane, nie jest cichym dropem.

### AC3 — `agent.implementer` respektuje writer lease

**Spełnione, w obu kierunkach**, co jest istotne — sam test negatywny przechodzi dla
implementacji, która nigdy nie pozwala pisać.

- **Pozytywny:** pod realnym, żywym leasem `agent.implementer` writer wykonuje pracę i
  completion trafia do bazy. `WriterLeaseGuard` re-asertuje lease wobec wiersza `jobs`, więc
  to przechodzi tylko przy faktycznie żywym leasie.
- **Negatywny:** unit `IMPLEMENTER` osiągnięty z `case.resume` (bez leasu writera) failuje
  closed, **i** run zostaje `AMBIGUOUS`, **i** `recover()` raportuje case writer-blocked.
- **Stale token:** lease z podbitym fencing tokenem — czyli to, co niesie wyprzedzony
  holder — jest odrzucony i nic nie zostaje zapisane.

Dodatkowo: `cases.active_run_id` jest teraz **durable single-writer gate** — §5.1.

### AC4 — job, którego handler rzuca, nie zostaje `LEASED` na zawsze

**Spełnione.** Handler **rzuca** przy nierozstrzygniętej pracy, więc `Scheduler` widzi
porażkę i stosuje bounded retry, a potem DLQ. Wcześniejsza wersja robiła `return` przy
`ambiguous` — §5.2, bo to był realny defekt, nie wybór stylu.

### AC5 — `AMBIGUOUS` nigdy nie jest replayowany

**Spełnione.** `markAmbiguous` zapisuje stan durable, `recover()` traktuje `AMBIGUOUS` jako
blokujący, a unit `RUNNING` bez potwierdzonego completion nie wraca do schedulera. Retry
re-raportuje tę samą niejednoznaczność i **nie woła modelu ponownie** — asertowane licznikiem
wywołań transportu, nie tylko obecnością wiersza.

Guard na `safety_state = 'STARTED'` sprawdzony osobno: spóźniony raport nie wciąga
zakończonego runa z powrotem w `AMBIGUOUS`, co zablokowałoby case na zawsze.

### AC6 — transport modelu jest wstrzykiwany, żaden test nie woła AWS

**Spełnione, i sprawdzone STRUKTURALNIE.** Test **liczy** wywołania transportu (`1`) i
sprawdza, że request zawiera **objective work unitu**, nie zaszyty prompt. Sprawdzenie
behawioralne („completion jest poprawne") przeszłoby dla handlera, który konstruuje własny
transport — i próbowałby dosięgnąć Bedrocka w CI.

`AwsBedrockTransport` na ścieżce produkcyjnej, `FakeTransport` w testach, **ten sam**
`createRoles`/`createWorkerHandlers` w obu.

### AC7 — golden path przez uruchomiony proces

**Spełnione.** §2. To domyka jedyne częściowe kryterium projektu (RA-027 AC6).

## 4. Mutation checki — 13 mutacji

```text
baseline                                          green
H1  handler resolves on unresolved work            red
H2  usunięty explicit recover() (heartbeat)        red   (po naprawie — §4.1)
H3  implementer akceptuje dowolny job_type         red
P1  active_run_id bez guardu                       red
P2  blind cast zamiast parse                       red
P3  listCaseIds obejmuje terminalne case'y         red
P4  markAmbiguous jako no-op                       red
P5  multi-provider wybiera arbitralnie             red
R1  rola ignoruje objective                        red
AC7 przywrócone `handlers: {}`                     red
H4  writerAuthority też dla case.resume            GREEN — defence-in-depth, §4.2
H5  READ_ONLY traktowane jako write authority       GREEN — NIEOSIĄGALNE, §4.2
H6  brak checkpointu wymyśla revision 0            GREEN — diagnostyka, §4.2
restored                                          green
```

### 4.1 Mutacja, która obaliła mój własny komentarz

`H2` usuwa jawne `await runtime.recover()` przed `pumpOnce()`. **Przeszła.** Mój komentarz
twierdził, że ten call jest „nie opcjonalny, bo świeży runtime nie wie nic o case'ie" — i
to była **nieprawda**: `pumpOnce()` sam woła `recover()`, single-flight, więc praca dzieje
się tak czy inaczej.

Realna wartość tego calla to **heartbeat między recovery a pompą**: recovery czyta wszystkie
niedokończone case'y, więc na obciążonej bazie jest wolną częścią, a przedłużenie leasu przed
wywołaniem modelu chroni przed zreapowaniem joba w trakcie legalnie trwającego passu.

Naprawione **oba**: komentarz mówi teraz prawdę (guard latencyjny, nie inwariant), i doszedł
test asertujący **kolejność** `heartbeat` → `model`. „Heartbeat został wywołany" zostaje
prawdą, gdy nastąpi po modelu, czyli gdy jest bezużyteczny.

To jest wzorzec z zasady 9 `AGENTS.md`: komentarz nie jest dowodem, uruchomiony test
rozstrzyga.

### 4.2 Trzy ocalałe, każdy udowodniony sondą — nie założony

- **`H5` jest NIEOSIĄGALNE.** `writerAuthority.acquire` jest wołane wyłącznie w gałęzi
  `role === "IMPLEMENTER"`, a `WriterLeaseGuard` zwraca `READ_ONLY` wyłącznie gdy
  `role !== "IMPLEMENTER"`. Te dwa warunki są rozłączne. Guard zostaje, bo kosztuje jedno
  porównanie i miałby znaczenie przy drugim call site.
- **`H4` to defence-in-depth.** Podanie leasu `case.resume` jako writer lease nadal failuje,
  bo guard niezależnie sprawdza `jobType !== WRITER_JOB_TYPE`. Redundancja jest teraz
  **udokumentowana testem**, który przedstawia lease żywy i poprawny pod każdym względem
  **poza** typem joba — więc nie jest niewyjaśnionym ocalałym.
- **`H6` to diagnostyka, nie guard.** `prepareCompletion` parsuje `current` wobec
  `caseCheckpoint`, więc `null` rzuca tam i tak. Bez tej linii traci się tylko komunikat.
  Komentarz zmieniony na uczciwy: „DIAGNOSTIC, NOT A GUARD".

## 5. Findingi tego audytu

### 5.1 `cases.active_run_id` nie było ustawiane przez ŻADEN kod produkcyjny

**BLOCKER, wykryty pierwszym realnym przebiegiem.** `RunCompletionRepository.apply()`
wymaga `caseRow.active_run_id === completion.run_id`, a `grep` po całym repozytorium pokazał,
że tę kolumnę **tylko się czyści** (`SET active_run_id = NULL`) — nigdy nie ustawia.

Każdy test, który dotąd dochodził do completion, ustawiał ją **ręcznie**
(`UPDATE cases SET active_run_id='run-1'`). Pierwszy realny pass failował z
`run/case is not eligible for completion`. Luka istniała od RA-003 i przeżyła każdy audyt, bo
żaden nie uruchomił pełnej ścieżki bez fixture'u.

Naprawione w `start()`, w jednej transakcji z przejściem `PLANNED → STARTED`, z guardem
`active_run_id IS NULL OR = $2`. Guard robi z tego **durable single-writer gate** dla case'a
(`AGENTS.md` §7): drugi run nie przejmie case'a, który już ma aktywny, a FK z migracji 011
pinuje run do tego samego case'a. Ponowienie z tym samym run id jest idempotentne, na czym
polega recovery.

### 5.2 Handler kończył się sukcesem, gdy praca nie została wykonana

`SupervisorRuntime.pumpOnce()` **nie rzuca** przy failującym uniocie — łapie błąd i
raportuje unit jako `ambiguous`/`blocked`. Dla runtime'u to poprawne: ma dokończyć pass i
zostawić durable marker, i nie może wiedzieć, czy błąd po `start` zostawił efekt zewnętrzny.

Dla **handlera joba** to nie jest poprawne. `return` mówi `Scheduler`owi, że job się udał,
więc job zostaje oznaczony jako zrobiony i nigdy nie jest ponawiany, mimo że praca się nie
wykonała. To dokładnie ten kształt cichego sukcesu, który to repozytorium traktuje jako
gorszy od crasha — i tak właśnie się objawił: handler zwracał, a baza była pusta.

Naprawione: handler **rzuca** przy `ambiguous` **albo** `blocked`. To nie jest blind replay:
retry nie może powtórzyć failującego unitu, bo `markAmbiguous` zapisał go durable, a
`recover()` trzyma `RUNNING` bez completion poza schedulerem. Retry re-raportuje tę samą
niejednoznaczność i dojeżdża do DLQ, gdzie odzywa się alarm — a tam trzeba dojechać.

### 5.3 Blind cast dawał wartość, która typechecku przechodzi i failuje w runtime

Pierwsza wersja robiła `row as unknown as WorkUnit`. `WorkUnitRow` typuje
`created_at`/`updated_at` jako `Date`, a kontrakt `WorkUnit` wymaga **stringów ISO** — więc
cast produkował wartość, która kompiluje się i nie przechodzi `workUnit.safeParse`.

Wykryte przez `WriterLeaseGuard`, który re-parsuje unit: writer był odrzucany komunikatem
„invalid work unit for writer lease" **pod całkowicie poprawnym leasem**. Naprawione na
`toWorkUnit()` w obu miejscach (`claim` i `start`).

### 5.4 Trzy artefakty testowe w promowanym kodzie

`PgRuntimeStore` (199 linii w pliku testowym) był pisany, by przejść jeden test. Trzy rzeczy
akceptowalne w harnessie i nieakceptowalne w produkcji:

1. **Zaszyte timestampy** (`started_at = '2026-08-20T10:00:00Z'` jako literał SQL). W
   produkcji każdy run raportowałby ten sam moment, więc czas trwania i staleness — dwie
   rzeczy, które operator czyta w incydencie — byłyby bez znaczenia. Wstrzyknięty `Clock`.
2. **Ręczny `INSERT INTO run_completions`**, obchodzący `RunCompletionRepository.apply()`,
   czyli advisory lock, `FOR UPDATE`, awans checkpointu i wiersz outboxa w jednej
   transakcji. Obejście gubi awans i event — run zostaje zapisany, a nic w systemie się o
   tym nie dowiaduje. Teraz przez audytowaną ścieżkę.
3. **`provider` z mapy podanej przez test.** To klucz per-provider limitu `FairScheduler`; bez
   niego limit **cicho nie obowiązuje** (`fairness.ts` traktuje brak jako brak ograniczenia).
   Wyprowadzony z `external_entities`, a case wielo-providerowy daje `undefined` zamiast
   arbitralnego wyboru — obciążanie limitu jednego providera zależałoby od kolejności wierszy.

Plus `listCaseIds` zawężone do niedokończonej pracy: harness robił `DISTINCT` po wszystkich
wierszach `work_units`, więc recovery przechodziłoby przy każdym starcie po każdym case'ie,
jaki system kiedykolwiek obsłużył.

### 5.5 Zła nazwa tabeli, której typecheck nie mógł wykryć

Napisałem `JOIN case_entities`. Tabela nazywa się `external_entities`. Zapytanie SQL w
stringu jest dla kompilatora nieprzejrzyste, więc `typecheck` był zielony — wykrył to
pierwszy uruchomiony test.

### 5.6 Flake rozstrzygnięty, nie przemilczany

Test AC7 failował **raz na dziewięć** pełnych przebiegów: `expected 'LEASED' to be 'SUCCEEDED'`.

Dwie osobne przyczyny, obie w **teście**, nie w produkcie, obie naprawione u źródła:

1. **Rozjazd źródeł czasu.** Test enqueue'ował z zamrożonym zegarem (13:00), a
   `bootstrapWorker` buduje własny `JobStore` z `productionRuntime()` — zegar systemowy,
   `leaseTime: 'db'`. Czy job zostanie podjęty, zależało od tego, jak te dwa się rozjeżdżają.
   Zegar w teście jest teraz realny; deterministyczne zostają tylko id.
2. **Czekanie na zły wiersz.** Poll czekał na `run_completions`, ale `Scheduler` oznacza joba
   `SUCCEEDED` **po** powrocie handlera — więc completion jest widoczny, gdy job jest jeszcze
   `LEASED`. Poll czeka teraz na status joba, który ustala się ostatni.

Po naprawie: **pięć pełnych przebiegów z rzędu, 2398/2398, zero `FAIL`.**

## 6. Czego ten task NIE zrobił

Zapisane jawnie, bo „nie wspomniane" czyta się jak „pokryte".

| Pozycja | Stan |
|---|---|
| `ProviderAdapter` per provider (executor) | **nie** — pozycja 2 z handoffu RA-027, bez zmian |
| Routy ingressu | **nie** — pozycja 3, nadal 404 |
| Taski schedulera | **nie** — pozycja 4, nadal `warn` na starcie |
| `jira.webhook.renewal` w produkcyjnym `main()` | **częściowo** — handler jest wstrzykiwalny i przetestowany, ale `main()` go nie rejestruje, bo wymaga `JiraWebhookConfig` i żywego tokenu |
| Realny call do Bedrocka | **nie** — każdy test używa `FakeTransport`; ścieżka AWS jest złożona, nie wywołana |
| Docker build | **nie** — niezgodny client/engine, bez zmian od RA-027 |
| Realny deploy | **nie** — wymaga zgody właściciela |

Konsekwencja postawiona wprost: **worker wykonuje pracę end-to-end, pozostałe trzy procesy
nadal nie.** `case.resume` i `agent.implementer` przechodzą przez uruchomiony proces do
completion, checkpointu i outboxa. Executor bez adaptera nadal rzuca, ingress nadal 404,
scheduler nadal nie ma tasków.

Osobno: **model nie jest jeszcze wołany narzędziami.** `createRole` wysyła objective i
odbiera `AgentCompletion`, bez katalogu narzędzi — więc agent nie edytuje jeszcze workspace'u.
`runStructuredCompletion` przyjmuje `tools` i `execute`; podłączenie ich to następny krok.

## 7. Zgodność z zasadami implementacji

- **Kontrakty i architektura** — bez zmian bez ADR. Żaden pakiet domenowy nie zmienił
  zachowania. Adapter persystencji **świadomie** wylądował w appce, nie w
  `agent-orchestrator`: ten pakiet zależy od `contracts` i `observability`, definiuje port
  `RuntimePersistence` i nie wie, że po drugiej stronie jest PostgreSQL. Dodanie tam
  zależności od bazy odwróciłoby tę granicę.
- **Model nie jest warstwą autoryzacji** — objective jest supervisor-authored; nic, co model
  zwróci, nie poszerza `authoritative_scope`, a completion jest walidowane wobec kontraktu
  przed persystencją. Writer authority pochodzi z durable job lease, nie z argumentu.
- **Fail closed** — nieznany `job_type` do DLQ; brak konfiguracji renewalu do DLQ; brak
  writer leasu rzuca; niezgodny `job_type` writera rzuca; brak checkpointu rzuca.
- **Idempotencja** — `apply()` jest idempotentne po tożsamości; powtórzony pass jest
  `replayed`, nie duplikatem ani konfliktem. Asertowane: druga próba nie awansuje rewizji i
  **nie woła modelu**.
- **Jeden writer** — `cases.active_run_id` z guardem (§5.1) plus `WriterLeaseGuard` z
  re-asercją fencing tokena.
- **Sekrety** — brak nowych. Żaden test nie nosi credentiala; `FakeTransport` jest
  credential-free.
- **Komentarz nie jest dowodem** — §4.1 to przypadek, w którym mój komentarz był fałszywy i
  rozstrzygnęła mutacja.

## 8. Werdykt

Siedem kryteriów, **wszystkie spełnione**. Zero BLOCKER, zero HIGH, zero MEDIUM otwartych.

Trzy realne defekty wykryte i naprawione (§5.1 brak `active_run_id` — luka od RA-003;
§5.2 cichy sukces handlera; §5.3 blind cast), wszystkie przez **uruchomiony test**, żaden
przez przegląd. Jedna mutacja obaliła mój własny komentarz i wymusiła nowy test (§4.1).
Trzy ocalałe mutacje wyjaśnione sondą, nie założeniem (§4.2). Flake rozstrzygnięty u źródła,
z pięcioma czystymi przebiegami po naprawie (§5.6).

**RA-027 AC6 — jedyne częściowe kryterium projektu — jest domknięte.** System nie tylko
startuje: worker przenosi joba z kolejki do trwałego completion, przez uruchomiony proces,
przeciwko realnej bazie.

- Werdykt: `PASS`
