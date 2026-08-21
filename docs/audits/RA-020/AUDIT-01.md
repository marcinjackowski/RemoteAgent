# RA-020 — Audit 01

## Metadata

- Task: `RA-020`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-020/HANDOFF-01.md`
- Data: `2026-08-21`
- Zakres diffu: `4c706f3..487bbc3`
- **Werdykt: `PASS`**

## Podstawa werdyktu

`Audit focus`: sync token semantics, watch authentication/renewal,
timezones/recurrence, privacy i account/calendar scope. Każde sprawdzone osobno, plus
8 mutacji i sondy adwersarialne. Sondy dały dwa findingi — **siódmy task z rzędu**.

## Kryteria akceptacji — każde sprawdzone osobno

| # | Werdykt | Jak sprawdzone |
|---|---|---|
| 1 | PASS | uwierzytelnienie z samych nagłówków; zły token, zły channel id i zły resource id odrzucone osobno; **stary kanał do wycofanego z allowlisty kalendarza przestaje działać** (kolekcja re-resolvowana, nie brana z rekordu kanału) |
| 2 | PASS | dwa kalendarze **tego samego konta**: drugi robi `listFull`, nie dziedziczy tokenu pierwszego; osobne stany w store; odnowienie jednego nie tworzy kanału dla drugiego |
| 3 | PASS | `reset_from` niesie odrzucony token; wszystkie wywołania resyncu mają klucz tej jednej kolekcji; token drugiego konta nietknięty po resyncu |
| 4 | PASS | ten sam etag → 0, nowy etag → 1; `createChannel` przed `stopChannel` (asercja na **indeksach** w nagranej liście wywołań); awaria `stopChannel` nie wywraca odnowienia |
| 5 | PASS | `series_id` + `original_start_time` — bo sam series id nie mówi, **która** instancja odwołana; `CANCELLED` ≠ `DELETED` |
| 6 | PASS | typ brandowany nad **parą**; kanał z refa; kłamiąca odpowiedź odrzucona; wspólny kanał między kontami odrzucony, ale **dozwolony w obrębie jednego konta** (świadomie — „wszystkie moje służbowe kalendarze w jednym kanale" jest normalne) |
| 7 | PASS | brak notification; reconciliation syncuje z zapisanego tokenu; brak re-emisji |

## Findingi

### Finding 1 — niejednoznaczny channel id routował cross-account (HIGH, **naprawiony**)

Sonda:

```text
AMBIGUOUS channel id across accounts -> resolved PRIVATE
(first match wins; !! possible cross-account routing)
```

Przy dwóch zarejestrowanych kanałach o tym samym `channel_id`/`resource_id` `find`
zwracał ten, który był pierwszy na liście. Notification konta służbowego mógł więc
rozwiązać się do kolekcji **prywatnej** i dostarczyć zdarzenie służbowe na kanał
prywatny — czyli dokładnie awaria, której zabrania kryterium 6.

Że w praktyce id Google'a są unikalne, jest argumentem **za** odmową, nie przeciw: jeśli
widzimy dwa dopasowania, to albo nasze rekordy są uszkodzone, albo ktoś powtarza
notification. Żadne z tych nie jest przypadkiem do odgadywania.

**Naprawa.** `filter` zamiast `find`; więcej niż jedno dopasowanie to
`CHANNEL_UNAUTHENTICATED`.

### Finding 2 — przycięta paginacja zerowała token (MEDIUM, **naprawiony**)

```text
sync_token after truncated pagination: null (next run does a FULL sync)
```

To subtelniejsze, niż wygląda, i warto zapisać **dlaczego jedna z dwóch oczywistych
poprawek byłaby błędem**:

- zerowanie tokenu (stan przed naprawą) → zbędny full sync, marnotrawstwo;
- przyjęcie `nextSyncToken` z przedwcześnie przerwanej sekwencji → **utrata danych**,
  bo Google wydaje ten token wyłącznie na ostatniej stronie, a tu strony pozostały
  nieprzeczytane;
- zachowanie **starego** tokenu → poprawne: nadal wskazuje ostatnią w pełni
  skonsumowaną pozycję, więc kolejny incremental sync wznawia i doczytuje resztę.

Wybrałem trzecie, plus `truncated` na wyniku, bo ciche ucięcie wygląda identycznie jak
„to było wszystko".

### Gap w testach znaleziony mutacją (naprawiony)

Usunięcie połowy `calendar_id` z `assertSameCollection` zostawiło **32/32 zielone**:
żaden test nie przekraczał granicy kalendarzy w obrębie jednego konta. To ta sama
klasa co gap w RA-013 (redakcja store'u) i RA-018 (stale dist) — test istnieje, ale nie
pokrywa osi, na której mechanizm faktycznie działa. Dodane dwa testy krzyżujące
kalendarze siostrzane.

### Probe'y bez findingu

- kanał `chan-2` konta służbowego rozwiązuje się poprawnie do `#cal-work`;
- `maxPages` faktycznie zatrzymuje patologiczną paginację (5 wywołań, `pages = 5`);
- instancja, której `series_id` równa się własnemu `event_id`, jest raportowana jako
  instancja — poprawnie, bo Google tak modeluje pierwszą instancję serii.

Brak otwartych findingów BLOCKER/HIGH/MEDIUM na moment werdyktu.

## Semantyka sync tokenu — ocena wprost

`Audit focus` wymienia to pierwsze, więc oceniam osobno. Kluczowe pytanie: czy
gdziekolwiek traktuję nieprzejrzysty token jak uporządkowany?

Sprawdziłem każde użycie. Token jest wyłącznie: (a) przekazywany do API, (b) zapisywany,
(c) porównywany na `null`/nie-`null`. **Nigdzie** nie jest porównywany względem innego
tokenu, sortowany ani parsowany — co jest właściwe, bo Google nie dokumentuje formatu.
Deduplikacja opiera się na `(event_id, etag)`, czyli na danych, które **mają**
zdefiniowaną semantykę wersji.

To jest realna różnica wobec RA-019, gdzie porządek `historyId` jest gwarantowany i
wykorzystany. Skopiowanie tamtego podejścia tutaj dałoby kod wyglądający poprawnie i
cicho mylący kolejność.

## Kontrole wykonane samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/connector-calendar/test` | 0 | 37/37 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | 1456/1456, 126 plików |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| 8 mutacji | — | każda wykryta (jedna po naprawie gapu w testach) |
| sondy adwersarialne | — | **findingi 1 i 2** |

## Ograniczenia, które potwierdzam jako właściwe dla zakresu

- Google API jako nagrywający fake — zgodnie z `Required verification`. **Nie
  przetestowano wobec prawdziwego Google Calendar**; to realna luka, jawnie zapisana.
- Brak persystencji i trwałych channel metadata: należą do taska spinającego
  connectory, nie do tego.
- Write intents poza zakresem (RA-022).

## Werdykt

- Werdykt: `PASS`

Siedem kryteriów spełnione i sprawdzone osobno. Jeden finding HIGH, jeden MEDIUM i
jeden gap w testach znalezione w tym audycie, wszystkie naprawione z testami
regresyjnymi przed werdyktem.

Status: `AUDIT_PASSED` → `DONE`. **M4 domknięty** (RA-019 i RA-020 oba `DONE`).
Odblokowuje RA-021 (MCP Tool Broker) — wszystkie osiem zależności `DONE`.
