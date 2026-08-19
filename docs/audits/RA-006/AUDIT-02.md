# RA-006 — Audit 02

## Metadata

- Task: `RA-006`
- Audytowany handoff: `docs/handoffs/RA-006/HANDOFF-02.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacja zamknęła autorytatywny routing, trwały denied-audit, monotoniczny gate
statusu w normalnym przebiegu i utratę continuation chunks. Pełna bramka także
przechodzi: 36/36 plików, 524/524 testy i build 21/21. Nadal nie wolno jednak
zaakceptować taska. Niezależne próby pokazały, że dwa równoległe claimy tego
samego send intentu oba uznają się za świeżego właściciela, a gateway wykonuje
dispatches współbieżnie i potrafi odwrócić ich kolejność. Adapter produkcyjny
ponadto ignoruje `caseTag` podczas tworzenia threadu, klasyfikuje każdą utratę
odpowiedzi `fetch` jako bezpieczną do replay oraz nie ma bezpiecznej identyfikacji
status message. Te luki ponownie otwierają duplikację po retry/crash.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Ten sam outbox event nie tworzy dwóch wiadomości ani threadów | FAIL | HIGH-07 i HIGH-08: adapter produkcyjny może replayować write o nieznanym wyniku, nie potrafi odnaleźć utworzonego przez siebie threadu, a równoległe claimy intentu oba uzyskują `fresh=true`. |
| 2. Nieautoryzowany user/guild/channel jest ignorowany i audytowany bez danych | PASS | `processInbound` zapisuje content-free denial do append-only audit logu; test real-PG i composition test przechodzą. |
| 3. Dwa cases mogą prowadzić niezależne rozmowy równolegle | PASS | Per-case binding locks i test dwóch niezależnych cases przechodzą. |
| 4. Wiadomości jednego case zachowują kolejność po retry/reconnect | FAIL | MEDIUM-10: dwa dispatches odebrane w kolejności 1,2 zakończyły się w kolejności 2,1; brak serializacji i dedupe sequence po resume. |
| 5. Decision button jest związany z decision ID i checkpoint revision | PASS | Strict custom ID zachowuje decision ID, revision i option; testy domain przechodzą. |
| 6. `/stop` dotyczy wyłącznie wskazanego case | PASS | Intake rozwiązuje case z bieżącego threadu, bez ścieżki broadcast. |

## Status findingów AUDIT-01

- HIGH-01: NIEZAMKNIĘTY — intent ledger istnieje, ale HIGH-07/HIGH-08 nadal
  pozwalają na replay lub równoległe wykonanie write.
- HIGH-02: ZAMKNIĘTY — owner/channel są porównywane z trwałym bindingiem fail-closed.
- HIGH-03: CZĘŚCIOWO ZAMKNIĘTY — dodano REST i protokół gateway, ale MEDIUM-11
  pozostawia brak konkretnego runtime socket/composition i ACK interakcji.
- MEDIUM-04: ZAMKNIĘTY — odmowa jest trwale, content-free audytowana.
- MEDIUM-05: CZĘŚCIOWO ZAMKNIĘTY — revision gate działa, ale pierwsza projekcja
  statusu nadal ma niebezpieczne okno send-before-pin/commit (HIGH-07).
- MEDIUM-06: ZAMKNIĘTY — dalsze root chunks są publikowane osobno.

## Findingi

### HIGH-07 — Produkcyjny adapter nie zapewnia deklarowanej recovery/idempotencji

- Lokalizacja: `apps/discord-bot/src/fetch-transport.ts:15-27`,
  `apps/discord-bot/src/rest-gateway.ts:91-125`, `:188-195` oraz
  `packages/discord/src/dispatcher.ts:217-258`, `:417-455`.
- Dowód 1: `fetchRestTransport` zamienia każdy rejected `fetch` na
  `DiscordUnavailableError`. Rejection może nastąpić po przyjęciu POST przez
  serwer i utracie odpowiedzi; produkcyjny `isSafeToRetry` zwrócił dla takiego
  probe `true`, więc `withDiscordRetry` automatycznie powtórzy write.
- Dowód 2: `findCaseThread` szuka `caseTag` w nazwie, lecz `createRootThread`
  wysyła `{name: input.threadName}` i całkowicie ignoruje `input.caseTag`.
  Niezależny recorded-transport probe otrzymał
  `{"threadCreateBody":{"name":"Case title"},"containsTag":false}`.
  Fake gateway przechowuje tag osobno i maskuje błąd adaptera. Dodatkowo root
  powstaje przez dwa nieidempotentne POST-y (anchor, potem thread), więc crash po
  pierwszym tworzy sierotę i kolejny anchor.
- Dowód 3: pierwsza projekcja statusu nie używa send intentu. Po sendzie dopiero
  zapisuje ID i pinuje wiadomość. Crash/utrata odpowiedzi przed pinem pozostawia
  niewykrywalną wiadomość, a redelivery tworzy następną. `findStatusMessage`
  bierze pierwszy dowolny pin bez deterministycznego markera ani sprawdzenia
  autora, więc może też edytować niepowiązaną pinned message.
- Wpływ: łamie AC1 i inwariant run-safety; możliwe są zduplikowane wiadomości,
  anchory/thready/statusy oraz nadpisanie obcego pinu.
- Wymagana zmiana: transport-level failure po rozpoczęciu requestu traktować jako
  UNKNOWN/AMBIGUOUS, chyba że adapter ma pozytywny dowód braku delivery. Root
  creation musi mieć rzeczywiście deterministyczny, zapisany marker i recovery
  obejmujące oba POST-y (w tym orphan anchor), z paginowanym lookupiem. Status
  musi mieć własny trwały intent oraz jednoznaczny marker/author identity i
  recovery również przed pinem. Dodać adapterowe fault tests dla utraty
  odpowiedzi/crash po każdym write, nie tylko fake.

### HIGH-08 — Claim send intentu nie jest atomowym fencingiem

- Lokalizacja: `packages/database/src/repositories/discord.ts:235-269` i
  `packages/discord/src/dispatcher.ts:490-502`.
- Dowód: dispatcher najpierw robi osobny `find`, a `begin` używa
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING status`. Dwa transakcyjne
  claimy zsynchronizowane po `find=null` dostały na realnym PostgreSQL:
  `[{"found":false,"status":"STARTED","fresh":true},{"found":false,"status":"STARTED","fresh":true}]`.
  Drugi claimant widzi istniejący `STARTED`, lecz dispatcher interpretuje sam
  status jako dowód świeżości. Oba wywołają zewnętrzny side effect. `succeed` i
  `markAmbiguous` dodatkowo nie wymagają oczekiwanego stanu ani tokenu właściciela.
- Wpływ: równoległa dostawa tego samego outbox eventu może stworzyć dwie kopie,
  a racing terminal updates mogą przepisać wynik intentu; łamie AC1.
- Wymagana zmiana: claim ma atomowo zwracać, czy bieżąca transakcja faktycznie
  wstawiła rekord (np. insert-do-nothing + rozróżniony rezultat) i mieć fencing
  dla przejść terminalnych. Tylko zwycięzca może wykonać write. Dodać real-PG
  concurrency test z dwoma pełnymi `deliver` oraz fault test terminal-state race.

### MEDIUM-10 — Gateway nie zachowuje kolejności ani pełnej semantyki reconnect

- Lokalizacja: `apps/discord-bot/src/gateway-session.ts:122-180`, `:187-228`.
- Dowód: `onDispatch` jest uruchamiane fire-and-forget bez kolejki/await. Probe z
  dwoma frame'ami `s=1`, `s=2` zakończył się
  `{"beforeFirstCompleted":[2],"finalOrder":[2,1]}`. Session zapisuje sequence,
  ale nie odrzuca powtórzonego dispatchu po resume. HEARTBEAT_ACK jest ignorowany,
  brak ACK nie zrywa martwego połączenia, a każdy close code jest bezwarunkowo
  resumowany — również fatalny lub non-resumable.
- Wpływ: owner messages, decision i `/stop` mogą zostać zastosowane poza
  kolejnością lub dwukrotnie po reconnect; martwa sesja może pozostać pozornie
  zdrowa. To narusza AC4 i wymagane reconnect tests.
- Wymagana zmiana: serializować dispatch w kolejności `s`, deduplikować już
  zastosowane sequence, obsłużyć heartbeat ACK/zombie detection oraz klasy close
  code (fatal stop, non-resumable identify, resumable resume). Dodać testy async
  ordering, duplicate sequence, missing ACK i odpowiednich close codes.

### MEDIUM-11 — Composition nie jest jeszcze samodzielnie uruchamialnym botem interakcji

- Lokalizacja: `apps/discord-bot/src/index.ts:53-76`,
  `apps/discord-bot/src/gateway-session.ts:34-55` i
  `apps/discord-bot/src/lifecycle.ts:65-109`.
- Dowód: composition nadal wymaga od deploymentu gotowego `GatewaySocketFactory`,
  tokenu, URL-a, dispatcher/processor/map i nie dostarcza konkretnej fabryki
  WebSocket ani entrypointu/env wiring. `INTERACTION_CREATE` jest tylko mapowane;
  payload nie zachowuje `interaction id/token`, a kod nie wysyła wymaganej
  odpowiedzi/defer ACK. Discord może więc pokazać command/button jako failed,
  mimo że domain side effect się rozpoczął. Test sprawdza wyłącznie fake socket i
  callback w pamięci.
- Wpływ: wymagany odbiór komend/przycisków nie ma poprawnego lifecycle w realnym
  Discordzie, a deklaracja handoffu o runnable bot jest nieweryfikowalna.
- Wymagana zmiana: dostarczyć konkretną produkcyjną fabrykę socket i bezpieczne
  env/composition entrypoint albo jasno wskazany istniejący deployment adapter;
  dla interakcji zachować server-side dane ACK i odpowiedzieć/deferować w limicie,
  z contract/composition testem bez prawdziwego sekretu.

### MEDIUM-12 — Ledger usuwa dowód próby, a handoff przecenia pokrycie intentami

- Lokalizacja: `packages/database/src/repositories/discord.ts:296-304`,
  `packages/discord/src/dispatcher.ts:525-528`, migracja `021` i `HANDOFF-02`.
- Dowód: bezpieczny błąd wykonuje `DELETE` intentu, więc ledger nie zachowuje
  historii próby ani liczby retry. Migracja i handoff deklarują intent przed
  każdym write, w tym root/status, lecz dispatcher używa `#durableSideEffect`
  tylko dla continuation/thread chunks. Handoff deklaruje też dead-letter do
  `#system`, którego pokazany sink/relay nie implementuje.
- Wpływ: operator nie ma kompletnego evidence do diagnozy retry/AMBIGUOUS, a
  dokumentacja nie opisuje rzeczywistej granicy run-safety.
- Wymagana zmiana: zachować retryable/failed-safe stan i attempt evidence zamiast
  kasowania rekordu (lub zapisywać równoważny append-only audit), objąć faktycznie
  wszystkie nieidempotentne write intentem oraz skorygować handoff/runbook do
  realnego DLQ/operator notification.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | lint/format/typecheck/test/build/workflow PASS; realny PostgreSQL; 36/36 plików, 524/524 testy; build 21/21. |
| Probe rejected `fetch` przez produkcyjny transport | 0 | `DiscordUnavailableError`, `safeToRetry=true` mimo symulowanej utraty odpowiedzi po możliwym accepted POST. |
| Probe `createRootThread` przez recorded transport | 0 | Body nazwy threadu nie zawiera przekazanego `caseTag`. |
| Real-PG concurrent intent claim | 0 | Oba claimy zwróciły `STARTED` oraz `fresh=true`. |
| Async gateway ordering probe | 0 | Dispatch 1→2 zakończył się 2→1. |
| Niezależny przegląd adaptera, migracji, repozytorium i granic transakcji | — | Potwierdził status send-before-pin bez intentu, arbitralny first-pin reconcile i brak interaction ACK/concrete socket wiring. |

## Uzasadnienie werdyktu

Normalne testy oraz fake gateway są zielone, lecz nie odwzorowują zachowania
produkcyjnego adaptera przy utracie odpowiedzi ani atomowego claimu pod
contention. Reprodukcje real-PG i gateway wykazują bezpośrednie naruszenia AC1 i
AC4. Problemy są naprawialne w zakresie RA-006, więc task wraca do implementera.
