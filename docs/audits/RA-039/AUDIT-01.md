# RA-039 — AUDIT-01

- Task: `RA-039` Generyczne structured output dla etapów Bedrock
- Data: `2026-08-26`
- Bazowy commit: `750b1479197943e7b5f7db587d7092f0aff1ecac`
- Role: Sol — plan, odczyt pełnego diffu, własna weryfikacja i audyt; Luna —
  bounded implementacja WU-00..03

Werdykt w §8.

## 1. Uruchomione bramki

Sol przeczytał pełny diff od bazowego commita, kod transportu/tool-loop/retry,
publiczny `Runtime`, AWS adapter oraz workerowy consumer. Po ostatniej poprawce
produkcyjnej uruchomił od początku:

```text
. scripts/dev/env.sh                    PG15/5432 reachable
pnpm lint                               exit 0
pnpm format                             exit 0
pnpm turbo run build --force            26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm test         2534/2534, 194/194 pliki, exit 0
pnpm turbo run typecheck --force        38/38, 0 cached, exit 0
pnpm workflow:validate                  OK — 45 tasks, exit 0
git diff --check                        exit 0
```

Targeted końcowy przebieg structured output miał `27/27`, a compatibility
runtime/worker `53/53` w sześciu plikach. Nie było flake ani cichego skipu DB.
Live AWS nie jest wymaganą bramką taska i nie został wywołany.

## 2. Kryteria akceptacji — każde osobno

1. **Dwa strict schemas i typowanie:** spełnione. `defineStructuredContract()`
   wyprowadza parser, provider JSON Schema i digest z jednego obiektu Zod.
   `engineeringProgramDesign` i `engineeringReviewDecision` zachowują przez
   `z.output<TSchema>` różne typy bez castu omijającego parse.
2. **Pełne provenance:** spełnione. Wynik wiąże model, durable stage, schema
   name/version/digest, prompt version, request ID, usage, transport/tool counts,
   repair flag oraz per-call `modelCompletions`.
3. **Bounded repair:** spełnione. Read-only stage ma dokładnie jeden tools-off
   repair z pełną historią. `SLICE_IMPLEMENTATION` po malformed output kończy
   się po pierwszej odpowiedzi i nie ponawia modelu ani narzędzi.
4. **Fail-closed identity:** spełnione. Expected digest jest sprawdzany przed
   transportem. Wrapper sprawdza provider/model po każdej odpowiedzi, zanim
   `runToolLoop` zobaczy tool-use. Oba guardy mają mutation RED→GREEN.
5. **Abort/timeout:** spełnione. Initial i repair cancellation/timeout zachowują
   ten sam obiekt i kod `CANCELLED`/`TIMEOUT`; model identity z repair także nie
   jest mapowane na structured-output error.
6. **Legacy reply-loop:** spełnione. `runStructuredCompletion`, alias
   `runAgentCompletion` i `Runtime` nadal zwracają `.completion`; worker nie
   został przepisany i role→persist→reply pozostaje zielone.
7. **Bramki:** spełnione. Pełna bramka oraz `workflow:validate` zakończyły się
   exit code `0`.

## 3. Kod i granice architektury

Nie powstał drugi klient, retry loop ani tool loop. Generyczny adapter deleguje
do istniejącego `runToolLoop`/`executeTransportDetailed`; legacy API pozostało
niezmienione. JSON Schema jest głęboko zamrożone, digest liczy istniejący
canonical encoder, a name/version/strict top-level są walidowane przed użyciem.

Audyt wykrył materialny drift: początkowo frozen definition miała `parse()`
domknięte nad mutowalnym obiektem wejściowym. Caller mógł po konstrukcji zmienić
schema/version i rozdzielić parser od provider schema/digestu. Naprawa snapshotuje
name/version/schema/description przed generacją; regression mutuje wszystkie
cztery pola i dowodzi zachowania pierwotnej tożsamości. Finding nie pozostał
otwarty.

## 4. Security i operacyjność

- Model nie ustala stage, schema digest ani prompt version; są inputem
  server-owned przyszłego orchestratora.
- Obcy model jest odrzucany przed tool execution; komunikaty błędów nie zawierają
  provider/model, digestu ani malformed payloadu.
- Repair nie otrzymuje tools, nie powtarza side effectów i zachowuje pełne
  provenance/liczniki.
- Task nie wykonuje trwałych zapisów, nie zmienia scope/policy i nie dotyka
  workspace; transakcje, fencing i recovery pozostają zakresem RA-038/041+.

## 5. Mutation evidence

Każdą mutację wykonano na kodzie, przywrócono i ponowiono GREEN:

| Mechanizm | Mutacja | Dowód RED |
|---|---|---|
| strict boundary | usunięcie `additionalProperties: false` guard | 1 test RED |
| version pin | usunięcie zgodności JSON Schema `const` | 1 test RED |
| model pin | wyłączenie provider/model comparison | 2 testy RED, w tym tool-use |
| schema identity | wyłączenie expected digest guard | 1 test RED i transport call |
| implementer no-repair | dopuszczenie repair implementera | 1 test RED |
| immutable definition | closure ponownie używa `input.schema/version` | 1 test RED |

## 6. Public API i findings przekrojowe

Ręczna sonda `ts.Program` + `checker.getExportsOfModule()` po świeżym buildzie
przeskanowała 19 `dist/index.d.ts`. Nie ma nowej kolizji; wynik zawiera wyłącznie
siedem wcześniej zaakceptowanych nazw z `CTF-002`/`CTF-015`. Nie powstał nowy
finding przekrojowy, a rejestr nie ma otwartego BLOCKER/HIGH/MEDIUM.

## 7. Niezależność i zakres

Plan i kryteria powstały przed kodem. Luna edytowała wyłącznie allowed paths
WU-00..03, nie tworzyła audytu, handoffu ani commita. Sol niezależnie od raportu
Luny przeczytał diff i kod sąsiedni, wykrył oraz zweryfikował poprawkę driftu,
uruchomił pełną bramkę i sondę eksportów. Nie wykonano push, MR, merge ani
zewnętrznego write.

## 8. Werdykt

- Werdykt: `PASS`

Wszystkie siedem kryteriów RA-039 jest spełnionych, load-bearing guardy mają
mutation evidence, pełna bramka ma exit code `0`, a po audycie nie pozostaje
finding BLOCKER, HIGH ani MEDIUM.
