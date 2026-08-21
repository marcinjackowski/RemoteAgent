# RA-020 — Handoff 01

## Metadata

- Task: `RA-020`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Data: `2026-08-21`
- Bazowy commit: `4c706f3`
- Końcowy commit: `487bbc3`
- Full-task verification: `pnpm vitest run packages/connector-calendar/test`

## Wynik

`@remoteagent/connector-calendar`: allowlista par (konto, kalendarz), obsługa
nieprzejrzystych sync tokenów, uwierzytelniane notification bez body, odnawianie
kanału z bezpiecznym overlapem, korelacja recurrence i rozdzielny routing.

## Dlaczego to NIE jest kopia RA-019

Dwie różnice determinują projekt, nie są detalem:

1. **`syncToken` jest nieprzejrzysty.** Brak porządku, brak lokalnej walidacji. Nie da
   się odpowiedzieć „czy to starsze?" przez porównanie, jak przy `historyId` Gmaila,
   a wygaśnięcie poznaje się **wyłącznie** przez użycie tokenu i HTTP 410. Dlatego 410
   jest normalną ścieżką kontroli, nie przypadkiem błędu.
2. **Notification nie ma body.** Tylko nagłówki. Może więc jedynie uwierzytelnić
   siebie i wskazać kolekcję.

Konsekwencja: **deduplikacja po `(event_id, etag)`**, nie po cursorze. Google zmienia
etag przy każdej mutacji, więc ten sam etag dwa razy to duplikat — dokładnie to, co
dostarcza celowo nakładający się kanał przy odnowieniu — a realna druga edycja ma nowy
etag i jest emitowana. Klucz po samym `event_id` zgubiłby realne update'y; klucz po
cursorze nie deduplikowałby wcale.

Przeniesienie tu projektu opartego na porównaniu z RA-019 dałoby kod, który **wygląda
poprawnie i cicho myli kolejność syncu**.

## Kryteria akceptacji

| # | Status | Dowód |
|---|---|---|
| 1. Notification bez body → właściwy incremental sync | PASS | uwierzytelnienie z samych nagłówków; token kanału w constant time; kolekcja re-resolvowana przez allowlistę, więc stary kanał do wycofanego kalendarza przestaje działać |
| 2. Każda kolekcja ma własny cursor i watch lifecycle | PASS | **dwa kalendarze tego samego konta** prowadzone niezależnie; drugi robi full sync, nie dziedziczy tokenu pierwszego |
| 3. HTTP 410 → audytowalny full resync bez mieszania danych | PASS | `reset_from` niesie odrzucony token; wszystkie wywołania resyncu dotyczą tylko tej kolekcji; token drugiego konta nietknięty |
| 4. Overlap starego/nowego watcha nie tworzy duplikatów | PASS | ten sam etag → 0 zdarzeń, nowy etag → 1; `createChannel` **przed** `stopChannel` (asercja na kolejności wywołań) |
| 5. Recurring instance koreluje z właściwą serią | PASS | `series_id` + `original_start_time`; `CANCELLED` odróżnione od `DELETED` |
| 6. Private i SonderMind rozdzielone w DB, context i Discordzie | PASS | typ brandowany nad parą; kanał z refa; odpowiedź kłamiąca odrzucona; wspólny kanał **między kontami** odrzucony przez rejestr |
| 7. Utracona notification wykryta przez reconciliation | PASS | brak notification; sync z zapisanego tokenu; brak re-emisji |

## Findingi z własnego audytu (naprawione przed handoffem)

1. **Niejednoznaczny channel id routował cross-account** (HIGH). Przy dwóch
   zarejestrowanych kanałach o tym samym id `find` zwracał pierwszy z listy, więc
   notification konta służbowego mógł rozwiązać się do kolekcji prywatnej i dostarczyć
   zdarzenie służbowe na kanał prywatny. Naprawa: niejednoznaczność to **odmowa**.
2. **Przycięta paginacja zerowała token** (MEDIUM). Sync ucięty przez `maxPages`
   zostawiał `null`, więc następny przebieg robił zbędny full sync. Naprawa: zachowanie
   **starego** tokenu (nadal wskazuje ostatnią w pełni skonsumowaną pozycję) plus
   raportowanie `truncated`. Przyjęcie **nowego** tokenu byłoby prawdziwym błędem:
   Google wydaje `nextSyncToken` tylko na ostatniej stronie, więc wzięcie go przy
   nieprzeczytanych stronach pominęłoby je.

## Gap w moich testach znaleziony mutacją

Usunięcie połowy `calendar_id` z kontroli scope zostawiło **wszystkie 32 testy
zielone**, bo żaden test nie przekraczał granicy kalendarzy **w obrębie jednego
konta** — a to jest dokładnie ta konflacja, której zabrania kryterium 2. Dodane dwa
testy krzyżujące kalendarze siostrzane; ta sama mutacja teraz wywala test.

## Testy i kontrole

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/connector-calendar/test` | 0 | 37/37 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1456/1456, 126 plików** |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| repo lint error count | — | 3 (baseline `CTF-008`, bez zmian) |

## Mutation testing

| Mutacja | Wynik |
|---|---|
| dedup po samym `event_id` | 1 FAIL |
| token kanału nieweryfikowany | 1 FAIL |
| 410 nieobsłużone | 2 FAIL |
| `stopChannel` przed `createChannel` | 1 FAIL |
| wspólny kanał między kontami dopuszczony | 1 FAIL |
| kontrola scope ignoruje `calendar_id` | **0 → gap w testach, naprawiony → 1 FAIL** |
| powrót do first-match-wins | 1 FAIL |
| przycięta paginacja przyjmuje przedwczesny token | 1 FAIL |

## Znane ograniczenia

- **Google API jest fake'em** (nagrywającym), zgodnie z `Required verification`.
  **Nie przetestowano wobec prawdziwego Google Calendar** — realna luka, nie
  formalność. Live OAuth wymaga credentiali, których nie ma.
- **Brak persystencji**: `InMemoryCalendarSyncStore` jest referencyjną implementacją;
  wersja bazodanowa i trwałe channel metadata należą do taska spinającego connectory.
  Migracja `028` wolna.
- **Write intents** (`events.insert` itp.) są `Out of scope` — RA-022 wnosi policy i
  approval engine.
- **DST/timezone**: przechowuję offset **i** strefę IANA, przetestowane na realnej
  granicy 2026-10-25 Europe/Warsaw. Renderowanie po stronie Discorda należy do
  konsumenta.
- `CTF-012` (LOW, niezdiagnozowany) — flake w `workspace-runner`; nie dotyczy tego
  pakietu.

## Stan dla audytu

Working tree czysty, `487bbc3`. Audyt powinien szukać dalszych ścieżek cross-account i
dalszych miejsc, w których nieprzejrzystość sync tokenu mogła zostać potraktowana jak
porządek.
