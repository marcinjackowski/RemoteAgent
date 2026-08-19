# RA-006 — Audit 03

## Metadata

- Task: `RA-006`
- Audytowany handoff: `docs/handoffs/RA-006/HANDOFF-03.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacja naprawiła klasyfikację utraty odpowiedzi, rozdzieliła root anchor od
thread start, dodała atomowy insert claimu, status intent, paginację, konkretny
WebSocket oraz ACK interakcji. Pełna bramka przechodzi: 38/38 plików, 548/548
testów i build 21/21. Nadal nie ma podstaw do akceptacji. Gateway oznacza sequence
jako zastosowany przed sukcesem handlera i po błędzie bezpowrotnie gubi event.
Marker jest dopasowywany przez substring, więc `case-1` adopuje obiekt `case-10`.
Błąd callbacku interakcji zawiera pełny interaction token i jest przekazywany do
loggera. Niezależny real-PG probe wykazał też, że loser równoległego intent claimu
zmienia aktywny intent zwycięzcy na `AMBIGUOUS` mimo udanego pojedynczego sendu.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Ten sam outbox event nie tworzy dwóch wiadomości ani threadów | FAIL | HIGH-14 może adoptować thread/anchor innego case; MEDIUM-16 nie ma owner fencing i pozostawia udany send jako AMBIGUOUS. |
| 2. Nieautoryzowany user/guild/channel jest ignorowany i audytowany bez danych | PASS | Content-free denied audit pozostaje trwały i test real-PG przechodzi. |
| 3. Dwa cases mogą prowadzić niezależne rozmowy równolegle | FAIL | HIGH-14: prefiksowe case IDs mogą zostać związane z tym samym Discord thread/status. |
| 4. Wiadomości jednego case zachowują kolejność po retry/reconnect | FAIL | HIGH-13: transient failure seq 1 jest połykany, replay seq 1 odrzucany, seq 2 wykonany. |
| 5. Decision button jest związany z decision ID i checkpoint revision | PASS | Strict custom ID nadal zachowuje ID/revision/option. |
| 6. `/stop` dotyczy wyłącznie wskazanego case | PASS | Intake nadal rozwiązuje case wyłącznie z bieżącego threadu. |

## Status findingów AUDIT-02

- HIGH-07: CZĘŚCIOWO ZAMKNIĘTY — transport jest konserwatywny, root/status mają
  intent i recovery, lecz HIGH-14 oraz MEDIUM-17 czynią marker niejednoznacznym i
  przekraczają limity Discorda.
- HIGH-08: CZĘŚCIOWO ZAMKNIĘTY — atomic insert ma jednego wykonawcę, lecz
  MEDIUM-16 pokazuje brak owner-token/lease fencing dla terminal transitions.
- MEDIUM-10: NIEZAMKNIĘTY — sukcesy są serializowane, ale błąd jest traktowany jak
  zastosowany event i kolejka idzie dalej (HIGH-13).
- MEDIUM-11: CZĘŚCIOWO ZAMKNIĘTY — concrete socket i ACK istnieją, lecz HIGH-15
  ujawnia sekret, a MEDIUM-18 podwaja reconnect.
- MEDIUM-12: CZĘŚCIOWO ZAMKNIĘTY — rekord retry jest zachowany, ale concurrency
  może zapisać fałszywy stan AMBIGUOUS; ledger jest mutowalny, nie append-only.

## Findingi

### HIGH-13 — Gateway gubi event po błędzie handlera i przepuszcza następny

- Lokalizacja: `apps/discord-bot/src/gateway-session.ts:220-248`.
- Dowód: `lastProcessedSeq` jest ustawiane w liniach 237-238 PRZED wykonaniem
  `onDispatch`; wyjątek jest łapany i tylko logowany w liniach 242-247, więc chain
  kończy się sukcesem. Probe: seq 1 (`FAIL`) rzucił transient DB error, replay seq
  1 został sklasyfikowany jako `gateway.dispatch_duplicate`, seq 2 wykonał się.
  Wynik: `handled=["NEXT"]`.
- Wpływ: wiadomość ownera, decision, approval lub `/stop` może zniknąć, a kolejny
  event wykonać się poza kolejnością; bezpośrednio łamie AC4. Discord definiuje
  `s` jako względną kolejność eventów i Resume służy replayowi brakujących eventów:
  [oficjalna dokumentacja Gateway](https://docs.discord.com/developers/events/gateway).
- Wymagana zmiana: rozdzielić received sequence od durably/applied sequence.
  Zwiększać applied/dedupe watermark dopiero po sukcesie durable handlera. Błąd
  musi zatrzymać kolejne eventy i prowadzić do bezpiecznego retry/reconnect lub
  trwałego inboxa, nie być połknięty. Dodać test transient failure → retry tego
  samego eventu → dopiero potem seq 2 oraz recovery po reconnect.

### HIGH-14 — Substring marker może związać case z cudzym Discord obiektem

- Lokalizacja: `packages/discord/src/markers.ts:23-35` oraz
  `apps/discord-bot/src/rest-gateway.ts:112-158`, `:246-269`, helpery
  `nameHasTag`/`contentHas`.
- Dowód: marker zawiera surowe ID (`RA:${caseId}`), a lookup używa `includes`.
  Produkcyjny adapter szukający `RA:case-1` zaakceptował bot-authored status z
  treścią `RA:case-10` i zwrócił `{messageId:"wrong"}`. Ten sam warunek działa dla
  anchor i thread name.
- Wpływ: case może adoptować thread/status innego case i później publikować tam
  prywatną treść. To narusza izolację cases oraz audit focus dotyczący wycieku
  między kanałami/cases.
- Wymagana zmiana: marker ma być ograniczony długościowo, collision-resistant dla
  pełnego case ID i dopasowywany dokładnie jako osobny token/linia/suffix, nigdy
  substring. Dodać contract/integration tests dla `case-1` vs `case-10`, podobnych
  prefiksów, bot/non-bot autora oraz maksymalnego 512-znakowego case ID.

### HIGH-15 — Interaction token trafia do komunikatu błędu i loggera

- Lokalizacja: `apps/discord-bot/src/rest-gateway.ts:272-313` oraz
  `apps/discord-bot/src/lifecycle.ts:145-166`.
- Dowód: callback path zawiera interaction token; każdy non-2xx tworzy
  `DiscordApiError(... path ...)`. Probe dla tokenu
  `TOP-SECRET-INTERACTION-TOKEN` zwrócił komunikat
  `discord POST /interactions/i/TOP-SECRET-INTERACTION-TOKEN/callback → 400`.
  Lifecycle przekazuje `errText(error)` do `inbound.ack_failed`, więc sekret
  trafia do produkcyjnego loggera. Komentarz `no token` jest nieprawdziwy.
- Wpływ: interaction token jest credentialem callback/webhook i może zostać
  przejęty z logów; narusza AGENTS.md zakaz ujawniania sekretów.
- Wymagana zmiana: błędy REST muszą używać redacted operation label/sanitized path,
  a ACK logger ma emitować tylko bezpieczny kod/klasę. Dodać negatywne testy dla
  wszystkich non-2xx i transport errors potwierdzające brak bot/interaction tokenu
  w error, log i serialized detail.

### MEDIUM-16 — Loser claimu może przepisać aktywny intent zwycięzcy

- Lokalizacja: `packages/discord/src/dispatcher.ts:597-672` i
  `packages/database/src/repositories/discord.ts:262-387`.
- Dowód: claim ma single insert winner, ale nie ma owner tokenu ani lease.
  Non-reconcilable loser widzący `STARTED` natychmiast wywołuje
  `markAmbiguous`; transition jest fenced wyłącznie po statusie, nie właścicielu.
  Real-PG full-delivery probe zatrzymał winnera w `sendThreadMessage`, uruchomił
  drugi ten sam event, potem zwolnił winnera. Wynik:
  `results=["delivered","DiscordAmbiguousError"]`, `messageCopies=1`, lecz
  końcowy `intentStatus="AMBIGUOUS"` mimo udanego sendu i receipt.
- Wpływ: evidence i stan operatora są fałszywe, może powstać zbędny DLQ/alarm, a
  safe failure zwycięzcy nie może już przejść do RETRYABLE. Handoff błędnie
  deklaruje fencing po „tokenie właściciela”.
- Wymagana zmiana: dodać rzeczywisty owner/fencing token + bounded lease albo
  inną serializację uniemożliwiającą loserowi mutację aktywnej próby. Każdy
  terminal update musi wymagać ownership/fence. Dodać real-PG full `deliver`
  concurrency test dla message chunk (winner w locie), safe failure i terminal race.

### MEDIUM-17 — Dodanie markera po sanitizacji przekracza limity Discorda

- Lokalizacja: `packages/discord/src/dispatcher.ts:214-245`, `:482-520` oraz
  `packages/discord/src/markers.ts:34-35`.
- Dowód: root jest najpierw dzielony do 2000 znaków, status obcinany do 2000, a
  marker dopiero potem dopisywany. Probe zwrócił `rootLength=2008` i
  `statusLength=2015` przy limicie 2000. Ponadto task dopuszcza case ID do 512
  znaków, więc suffix thread name może sam przekroczyć limit 100.
- Wpływ: prawidłowe payloady graniczne są odrzucane przez Discord; pierwszy root
  lub status zostaje AMBIGUOUS/failed zamiast dostarczony.
- Wymagana zmiana: rezerwować miejsce na bounded marker przed chunk/truncation,
  egzekwować końcowy limit na każdym adapter body/name i dodać boundary tests
  dokładnie 2000/2001 oraz case ID długości 512.

### MEDIUM-18 — Jedno zerwanie socketu może zaplanować wiele reconnectów

- Lokalizacja: `apps/discord-bot/src/ws-factory.ts:49-64` i
  `apps/discord-bot/src/gateway-session.ts:256-284`.
- Dowód: factory wywołuje `onClose(1006)` na `error`, po czym realny socket zwykle
  emituje także `close`. `#onClose` nie sprawdza generacji/socket identity ani
  istniejącego timeru. Dwukrotne `onClose(1006)` zaplanowało dwa reconnect timers
  (`scheduledReconnects=2`), mimo komentarza o idempotencji.
- Wpływ: powstają równoległe sesje Identify/Resume, podwójne heartbeats i eventy;
  to osłabia kolejność/dedupe i może wywołać close/rate-limit loop.
- Wymagana zmiana: terminal callback per socket musi być once/generation-fenced,
  stary socket nie może zamknąć nowego, a reconnect timer ma być pojedynczy.
  Dodać test error+close, stale close po reconnect i wielokrotne `start()`.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | 38/38 plików, 548/548 testów; build 21/21; workflow OK; diff clean. |
| Gateway handler-failure/replay probe | 0 | FAIL seq 1 połknięty, replay oznaczony duplicate, NEXT seq 2 wykonany. |
| REST interaction-token probe | 0 | `DiscordApiError.message` zawierał pełny token. |
| Marker prefix-collision probe | 0 | lookup `case-1` adoptował bot message oznaczoną `case-10`. |
| Marker boundary probe | 0 | root 2008 i status 2015 znaków przy limicie 2000. |
| Real-PG concurrent full thread-message delivery | 0 | jedna kopia, ale udany winner pozostawił intent `AMBIGUOUS`. |
| Double-close probe | 0 | dwa callbacki close zaplanowały dwa reconnect timers. |

## Uzasadnienie werdyktu

Zielone testy obejmują happy-path ordering i pojedynczy atomowy insert, ale nie
handler failure, prefiksowe markery, redakcję credentialu ani winner-in-flight.
Trzy reprodukcje naruszają kolejność, izolację i ochronę sekretów. Problemy są
naprawialne w zakresie RA-006, dlatego task wraca do implementera.
