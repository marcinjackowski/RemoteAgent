# RA-006 — Audit 01

## Metadata

- Task: `RA-006`
- Audytowany handoff: `docs/handoffs/RA-006/HANDOFF-01.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja RA-002–RA-006 pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Implementacja tworzy sensowny podział na persistence, port gateway, dispatcher i
intake, a pełna bramka przechodzi: 32/32 pliki, 503/503 testy i build 21/21.
Nie pozwala to jednak na `PASS`. Audytor odtworzył duplikację tego samego outbox
eventu po udanym Discord send i błędzie przed zapisem receipt oraz cofnięcie
projekcji statusu przez spóźnioną rewizję. Routing root message nie sprawdza
zgodności z trwałym bindingiem case, denied interaction nie jest trwale
audytowana, a repo nie zawiera produkcyjnego adaptera Discord ani konfiguracji
minimalnych intents/permissions wymaganych przez scope.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Ten sam outbox event nie tworzy dwóch wiadomości ani threadów | FAIL | HIGH-01: receipt powstaje po side effekcie, a retry powtarza także błędy niejednoznaczne. Probe utworzył dwie kopie tej samej wiadomości. |
| 2. Nieautoryzowany user/guild/channel jest ignorowany i audytowany bez danych | FAIL | Odrzucenie i content-free DTO działają, ale MEDIUM-04: nigdzie nie zapisuje się go do append-only audit logu. |
| 3. Dwa cases mogą prowadzić niezależne rozmowy równolegle | PASS | Osobne binding row locks i test real-PG dwóch case przechodzą. |
| 4. Wiadomości jednego case zachowują kolejność po retry/reconnect | FAIL | Ordered thread messages mają sequence gate, lecz MEDIUM-05: status rev 1 dostarczony po rev 2 cofa pinned projection do rev 1. |
| 5. Decision button jest związany z decision ID i checkpoint revision | PASS | Strict custom-id encode/decode zachowuje ID, revision i option; downstream nadal musi walidować bieżący request. |
| 6. `/stop` dotyczy wyłącznie wskazanego case | PASS | Intake rozwiązuje case wyłącznie z aktualnego znanego threadu i nie emituje broadcast stop. |

## Findingi

### HIGH-01 — Discord write jest automatycznie powtarzany po niejednoznacznym wyniku

- Lokalizacja: `packages/discord/src/dispatcher.ts:227-258`, `:288-315` oraz
  `packages/discord/src/retry.ts:47-74`.
- Dowód: `sendThreadMessage` wykonuje zewnętrzny side effect przed
  `receipts.record`. Błąd zapisu receipt/commit po udanym sendzie pozostawia brak
  receipt, więc redelivery ponawia send. Niezależny probe wykonał dwa runy tego
  samego `outboxId` z symulowanym błędem persistence po sendzie i otrzymał
  `sameEventMessageCopies=2`. Handoff sam przyznaje to okno. Dodatkowo
  `withDiscordRetry` ponawia każdy `Error`; utrata odpowiedzi po zaakceptowanym
  POST może więc zdublować write już wewnątrz jednego runu. Ten sam problem
  dotyczy pierwszego status message i wieloczęściowej wiadomości.
- Wpływ: łamie AC1 oraz inwariant AGENTS.md, że niepotwierdzony write nie może być
  automatycznie powtórzony. Przy chunkingu awaria późniejszego chunku ponawia też
  wcześniejsze, już opublikowane części.
- Wymagana zmiana: zapisać trwały intent przed każdym Discord write i użyć
  adapterowego idempotency/reconciliation key dla root/message/status/chunk albo
  przejść do trwałego `AMBIGUOUS` bez automatycznego replay, gdy wynik może być
  wykonany. Retry musi klasyfikować wyłącznie dowodliwie bezpieczne błędy; po
  utracie odpowiedzi nie wolno ponawiać write bez reconciliation. Dodać fault
  tests dla response-lost, crash/DB-failure po każdym side effekcie oraz awarii
  między chunkami.

### HIGH-02 — Routing kanału nie jest związany z autorytatywnym bindingiem case

- Lokalizacja: `packages/discord/src/dispatcher.ts:142-182` i
  `packages/database/src/repositories/discord.ts:45-66`.
- Dowód: dispatcher wylicza `channelId` z `provider`/`alias` niesionych w payload,
  `ensure` przy istniejącym `case_id` ignoruje nowy owner/channel, a po row-locku
  kod nie porównuje `binding.owner_id` ani `binding.channel_id` z wyliczonymi
  wartościami. Gdy binding istnieje bez threadu, payload z innym aliasem tworzy
  thread w wyliczonym innym kanale, pozostawiając w DB wcześniejszy channel.
- Wpływ: błąd producenta lub replay zmienionego payloadu może opublikować treść
  private w kanale SonderMind albo odwrotnie; audit focus wprost wymaga braku
  przypadkowego ujawnienia między kanałami.
- Wymagana zmiana: routing musi pochodzić z trwałego, serwerowego scope/bindingu,
  a payload nie może go rozszerzyć. Po locku wymagane są exact owner/channel
  invariants i fail-closed mismatch przed jakimkolwiek gateway call. Dodać
  real-PG test private↔SonderMind mismatch i istniejącego bindingu z pustym
  threadem.

### HIGH-03 — Brak produkcyjnego adaptera Discord i uruchamialnego bota

- Lokalizacja: `apps/discord-bot/src/index.ts:1-40`,
  `packages/discord/src/gateway.ts:1-99`, package manifests.
- Dowód: repo zawiera wyłącznie interfejs `DiscordGateway`, fake oraz adapter
  `OutboxSink`. Nie ma implementacji Discord API/SDK, lifecycle klienta,
  reconnect handlera, odbioru eventów/interactions ani deklaracji minimalnych
  gateway intents i permissions. `rg` znajduje `discord.js` jedynie w
  komentarzach; zależność nie istnieje. Required verification mówi o contract
  tests adaptera z recorded fixtures, lecz obecne testy uruchamiają wyłącznie
  własny in-memory fake.
- Wpływ: goal i scope RA-006 nie są uruchamialne poza testem; bot nie może
  opublikować ani odebrać żadnego zdarzenia Discord, a minimal permissions nie są
  egzekwowane lub nawet zadeklarowane. Nie istnieje późniejszy task, który ma
  dostarczyć bazowy adapter Discord.
- Wymagana zmiana: dodać produkcyjny, wstrzykiwalny adapter Discord wraz z
  composition lifecycle, minimalnymi intents/permissions, reconnect i routingiem
  inbound/outbound. Token pozostaje poza promptem i logami. Dodać contract tests
  na recorded, zredagowanych fixtures oraz composition test bez prawdziwej sieci.

### MEDIUM-04 — Odrzucenie inbound jest DTO, a nie trwałym audytem

- Lokalizacja: `packages/discord/src/intake.ts:53-61`,
  `packages/discord/src/authorization.ts:86-100`, `apps/discord-bot/src/index.ts`.
- Dowód: `handleInbound` jedynie zwraca `{kind: "denied", audit: ...}`. Żaden
  kod produkcyjny nie wywołuje `AuditLogRepository.record`; opcjonalny `audit` w
  `DispatcherDeps` jest nieużywany i dotyczy outbound. Test sprawdza tylko
  serializację obiektu w pamięci.
- Wpływ: AC2 wymaga, aby próba była audytowana. Caller może ją porzucić, po
  restarcie nie ma evidence i operator nie zobaczy prób unauthorized access.
- Wymagana zmiana: production intake/composition musi append-only zapisywać
  content-free denial przed ackiem interakcji, z testem real-PG potwierdzającym
  brak body/secret w audit row.

### MEDIUM-05 — Spóźniony status cofa pinned projection

- Lokalizacja: `packages/discord/src/dispatcher.ts:262-315` i migracja 020;
  status events nie mają sequence ani trwałego `last_status_revision`.
- Dowód: niezależny probe dostarczył `checkpoint_revision=2`, potem osobny event
  rev 1. Oba receipts zapisano, a końcowa treść zawierała `rev 1` i `stale`.
- Wpływ: po retry/reconnect właściciel może widzieć nieaktualny phase, blockers
  albo approvals, mimo że nowszy checkpoint został wcześniej opublikowany. To
  narusza wymóg kolejności i poprawność projekcji.
- Wymagana zmiana: pod row-lockiem zastosować monotonic revision gate. Starszy
  lub równy projection event ma być deterministycznym no-opem z receipt, a nowszy
  atomowo awansuje durable revision. Dodać test delivery 2→1, concurrent 1/2 i
  reconnect.

### MEDIUM-06 — Root body powyżej 2000 znaków jest cicho obcinane

- Lokalizacja: `packages/discord/src/dispatcher.ts:367-371`.
- Dowód: `firstChunk` wywołuje `sanitizeMessage`, po czym zwraca wyłącznie
  `chunks[0]`; pozostałe części nie są wysyłane ani oznaczone jako truncated.
  Test sanitizera dowodzi zachowania helpera, ale dispatcher nie korzysta z jego
  pozostałych chunków. HANDOFF-01 twierdzi, że treści są chunkowane bez utraty.
- Wpływ: root event traci większość treści bez informacji dla właściciela, więc
  Discord limit jest spełniony kosztem niewidocznej utraty danych.
- Wymagana zmiana: jawnie wyślij bezpieczne continuation chunks z idempotency
  per chunk albo użyj jawnej, oznaczonej projekcji/truncation i trwałego odnośnika
  do pełnej treści. Dodać test end-to-end body >2000 znaków.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | lint/format/typecheck/test/build/workflow PASS; realny PostgreSQL; 32/32 pliki, 503/503 testy; build 21/21. |
| `pnpm exec tsx --eval '<receipt-failure and stale-status probes>'` | 0 | `sameEventMessageCopies=2`; status rev 2→1 zakończył się treścią `rev 1` / `stale`. |
| `rg 'discord.js|GatewayIntent|Permission|handleInbound|AuditLogRepository' ...` | 0 | Brak adaptera/intentów/permissions i brak production caller zapisującego denied audit. |
| Przegląd migracji 020 up/down i repozytoriów | — | Schemat migruje poprawnie, lecz nie modeluje intent/ambiguous write ani revision statusu. |

## Uzasadnienie werdyktu

Zielone testy pokrywają normalną redelivery po zapisanym receipt, ale nie okna
crash/response-lost, które są centralne dla AC1 i run safety. Dodatkowo nie ma
uruchamialnego adaptera Discord, trwałego denied-audit ani monotonicznej projekcji
statusu. Problemy są naprawialne w zakresie RA-006, dlatego werdykt to
`CHANGES_REQUIRED`, nie `BLOCKED`.

