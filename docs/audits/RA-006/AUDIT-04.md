# RA-006 — Audit 04

## Metadata

- Task: `RA-006`
- Audytowany handoff: `docs/handoffs/RA-006/HANDOFF-04.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacja zamknęła kolizje markerów i limity Discorda, poprawiła once/generation
fencing socketu oraz zapobiega loserowi aktywnego claimu w bezpośrednim
przestawieniu winnera. Pełna bramka przechodzi. Nadal nie ma podstaw do `PASS`:
pierwszy błąd handlera po `READY` wysyła niepoprawny `RESUME` z `seq: null`, a
redakcja transport errors przepuszcza credentiale w wartościach niebędących
`Error` i w enumerowalnych polach błędu. Wyścig expiry z bezpiecznym terminalem
pozostawia fałszywe `AMBIGUOUS`, a migracja nie backfilluje istniejących intentów
zgodnie z własnym kontraktem.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Ten sam outbox event nie tworzy dwóch wiadomości ani threadów | PASS | Bounded exact markers i owner-fenced claim zapobiegają duplikatom w sprawdzonych ścieżkach. |
| 2. Nieautoryzowany user/guild/channel jest ignorowany i audytowany bez danych | PASS | Real-PG denial audit przechodzi bez regresji. |
| 3. Dwa cases mogą prowadzić niezależne rozmowy równolegle | PASS | Markery pełnego case ID są rozłączne; testy równoległości przechodzą. |
| 4. Wiadomości jednego case zachowują kolejność po retry/reconnect | FAIL | HIGH-19: pierwszy recovery po `READY` używa `seq: null`, więc test nie dowodzi poprawnego Resume/replay. |
| 5. Decision button jest związany z decision ID i checkpoint revision | PASS | Strict custom ID bez regresji. |
| 6. `/stop` dotyczy wyłącznie wskazanego case | PASS | Routing przez aktualny thread bez regresji. |

## Status findingów AUDIT-03

- HIGH-13: CZĘŚCIOWO ZAMKNIĘTY — watermark rośnie po sukcesie, lecz HIGH-19
  łamie realny protocol recovery pierwszego eventu po `READY`.
- HIGH-14: ZAMKNIĘTY — bounded digest i exact line/token usuwają prefiksowe
  cross-case adoption.
- HIGH-15: CZĘŚCIOWO ZAMKNIĘTY — typowe message/stack/cause są redagowane, lecz
  HIGH-20 nadal ujawnia credentiale dla legalnych kształtów `unknown`.
- MEDIUM-16: CZĘŚCIOWO ZAMKNIĘTY — owner token usuwa pierwotny false-AMBIGUOUS,
  lecz MEDIUM-21 pokazuje nadal błędny terminal race po wygaśnięciu lease.
- MEDIUM-17: ZAMKNIĘTY — końcowe body/name mieszczą się w 2000/100 i body nie jest
  tracone na granicy 2000/2001.
- MEDIUM-18: ZAMKNIĘTY — double close, stale close i double start są fence'owane.

## Findingi

### HIGH-19 — Pierwszy failed dispatch po READY próbuje Resume z `seq: null`

- Lokalizacja: `apps/discord-bot/src/gateway-session.ts:255-270`, `:390-398`.
- Dowód: `READY` z `s=1` ustawia session ID, ale nie aktualizuje applied watermark.
  Gdy pierwszy event aplikacyjny `s=2` rzuci, niezależny probe odtworzył dokładny
  frame: `{"op":6,"d":{"token":"secret","session_id":"sid","seq":null}}`.
  Test implementera sprawdza tylko obecność opcode `RESUME`, nie wartość/type
  `d.seq`, a potem ręcznie dostarcza replay mimo niepoprawnego frame.
- Wpływ: Discord wymaga sequence number w Resume. Odrzucenie/invalidacja sesji
  prowadzi do Identify bez replayu i utraty dokładnie tego eventu, który mechanizm
  miał uratować; AC4 pozostaje niespełnione.
- Wymagana zmiana: utrzymywać zawsze poprawny liczbowy resume watermark po
  przetworzeniu `READY`/`RESUMED` albo wybrać bezpieczny persistent-inbox design.
  Nie wysyłać Resume bez liczbowego sequence. Test musi asertować dokładny
  `d.seq` dla pierwszego failure po READY oraz przejście przez INVALID_SESSION.

### HIGH-20 — Redakcja transport error nie obejmuje całego `unknown`

- Lokalizacja: `apps/discord-bot/src/rest-gateway.ts:337-349`, `:414-441`.
- Dowód: `redactError` zwraca każdą wartość niebędącą `Error` bez zmian i mutuje
  tylko message/stack oraz jeden `Error.cause`. Dwa niezależne probe'y transportu:
  (1) rejection string `transport INTERACTION-SECRET BOT-SECRET`; (2) `Error` z
  enumerowalnym `detail.url` i `detail.authorization`. W obu `leaks=true`; w (2)
  `JSON.stringify(error)` zawierał oba pełne credentiale.
- Wpływ: wstrzykiwany transport ma kontrakt `Promise<RestResponse>` i rejection
  typu `unknown`; credential może trafić do serialized error/detail, telemetry lub
  persistence. Narusza AGENTS.md i niezamyka HIGH-15.
- Wymagana zmiana: fail-closed normalizować dowolny rejection do nowego,
  allowlistowanego błędu zachowującego wyłącznie bezpieczną klasę/kod i redagowany
  message; nie propagować dowolnych pól oryginału. Dodać testy string/object,
  nested/array/custom enumerable fields oraz pełne `String`/stack/JSON/log/detail.

### MEDIUM-21 — Expiry może zablokować prawdziwy terminal bezpiecznej próby

- Lokalizacja: `packages/database/src/repositories/discord.ts:397-457` oraz
  `packages/discord/src/dispatcher.ts:652-714`.
- Dowód: lease expiry samo w sobie nie dowodzi, że właściciel przestał działać;
  nie ma renewal. Observer może wykonać `expireToAmbiguous` podczas wolnego
  requestu. Real-PG probe: po claimie winnera i expiry observer uzyskał
  `expired=true`; następnie winner otrzymał definitywne 429, lecz
  `markRetryable(...ownerToken...)` zwróciło `false`, a rekord pozostał
  `status=AMBIGUOUS,last_error=observer`. Dispatcher ignoruje boolean terminala.
- Wpływ: provably-not-delivered write zostaje trwale opisany jako unknown outcome,
  co blokuje bezpieczny retry i fałszuje evidence/operator state. To jest brakujący
  safe-failure/terminal-race test wymagany przez AUDIT-03.
- Wymagana zmiana: zaprojektować expiry tak, aby aktywny holder tokenu mógł
  zapisać swój prawdziwy terminal po observer transition (albo odnawiać/fence'ować
  lease przed side effectem), oraz sprawdzać wynik każdej terminal transition.
  Dodać real-PG full-delivery race dla expiry + safe failure i expiry + success.

### MEDIUM-22 — Migracja 022 nie backfilluje istniejących STARTED intentów

- Lokalizacja: `packages/database/migrations/022_discord_send_intent_fencing.up.sql:27-33`.
- Dowód: komentarz deklaruje istniejące rekordy jako posiadające „already-expired
  lease”, lecz SQL wyłącznie dodaje nullable kolumny. Istniejący `STARTED` dostaje
  `lease_expires_at=NULL`, natomiast `expireToAmbiguous` jawnie wymaga
  `lease_expires_at IS NOT NULL`; taki rekord nie przejdzie recovery i pozostaje
  bez ownera w `STARTED` bezterminowo. Brak testu upgrade 021→022 z danymi.
- Wpływ: wdrożenie migracji na działający system pozostawia stare in-flight
  intenty w stanie niezgodnym z nowym state machine i opisem operacyjnym.
- Wymagana zmiana: wykonać deterministyczny backfill istniejących wierszy (z
  konserwatywnym terminalem dla unknown outcome), dodać odpowiednie constraints
  lub jawnie obsłużyć legacy NULL oraz test migracji 021→022 z każdym statusem.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | 39/39 plików, 568/568 testów; build 21/21; workflow OK; diff clean. |
| First-failure Resume frame probe | 0 | `d.seq=null` po READY `s=1` i failure `s=2`. |
| Transport rejection redaction probes | 0 | string i enumerowalny custom detail ujawniły bot + interaction token. |
| Real-PG expiry/safe-terminal probe | 0 | `expired=true`, owner `markRetryable=false`, final `AMBIGUOUS`. |
| Code/migration inspection | 0 | 022 pozostawia legacy lease NULL, którego expiry query nie dopasowuje. |

## Uzasadnienie werdyktu

Zielone testy potwierdzają dużą część remediacji, lecz nie modelują prawdziwego
Resume payloadu, pełnej granicy `unknown` transportu ani dwóch wymaganych terminal
races. Dwa findingi dotyczą bezpośrednio utraty eventu i wycieku credentialu.
Problemy są naprawialne w zakresie RA-006, dlatego task wraca do implementera.
