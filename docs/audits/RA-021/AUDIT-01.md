# RA-021 — AUDIT-01

- Task: `RA-021` MCP Tool Broker
- Data: `2026-08-21`
- Bazowy commit: `a19811a944a90bf24f38f69fbb9d4d71abaadf12`
- Bazowy tree: `381a88c850e23b604fa450261fba4d1ec307f3d9`
- Rola: jedna rola wykonawcza (ADR-0007) — ta sesja planowała, implementowała i
  weryfikowała. Podstawa werdyktu: odczyt pełnego diffu, własne uruchomienie
  bramek, mutation check każdego mechanizmu bezpieczeństwa oraz sonda
  adwersarialna. Werdykt w sekcji 9.

## 1. Uruchomione bramki

Wszystkie komendy uruchomione po `. scripts/dev/env.sh`, PostgreSQL 17 na `5433`.

| Bramka | Komenda | Wynik |
|---|---|---|
| Suite pakietu | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test` | `148/148 passed`, 7 plików, exit `0` |
| Całe repo | `RA_REQUIRE_POSTGRES=1 pnpm vitest run` | `1604/1604 passed`, 133 pliki — **11 przebiegów z rzędu** |
| Typecheck | `pnpm exec turbo run typecheck --force` | `36 successful, 0 cached` |
| Build | `pnpm run build --force` | `26 successful, 0 cached` |
| Lint (scoped) | `pnpm exec eslint packages/mcp-tool-broker` | exit `0` (tylko preexistujące warningi konfiguracji `boundaries`) |
| Format | `pnpm exec prettier --check "packages/mcp-tool-broker/**/*.ts"` | `All matched files use Prettier code style!` |
| Kolejka | `pnpm workflow:validate` | `OK — 26 tasks` |
| Whitespace | `git diff --check` | czysto |

`--force` użyty świadomie: `turbo` raportuje sukces z cache bez uruchomienia
czegokolwiek (`AGENTS.md`, „Zielony przebieg nie wystarcza" p. 2). Oba przebiegi
pokazały `0 cached`, więc naprawdę się wykonały.

### Flake w pełnym przebiegu — zapisany, nie przemilczany

Jeden przebieg na szesnaście dał `1603/1604`. **Tożsamości tego faila nie
przechwyciłem** — wystąpił w przebiegu bez zachowanego logu, a jedenaście kolejnych
przebiegów (trzy z zachowanym pełnym logiem) wyszło zielono. Zapisałem to w
`CTF-012` jako obserwację, jawnie **bez** twierdzenia, że to ten flake: brak dowodu
na tożsamość, a zgadywanie jest wzorcem, który ten rejestr trzykrotnie ukarał
(`CTF-010`). Nie blokuje `PASS` — nie dotyczy kodu RA-021, a suite pakietu jest
zielona 148/148 w każdym przebiegu.

## 2. Weryfikacja kryteriów akceptacji — każde osobno

### AC1 — model nie może wybrać connection/repo spoza scope przez tool arguments — SPEŁNIONE

Mechanizm jest trójwarstwowy i celowo **nie** polega na walidacji
model-supplied `connection_id`:

1. **strukturalnie** — zaakceptowany `contracts.toolIntent` nie ma pola scope, więc
   propozycja modelu jest *niezdolna* nazwać ownera/connection/repo;
2. **przy rejestracji** — descriptor deklarujący argument o nazwie scope jest
   odrzucany (`ToolBrokerError`), więc autor narzędzia nie może zalegalizować kanału;
3. **przy wywołaniu** — `assertNoScopeNamedKey` odrzuca taki klucz na **dowolnej
   głębokości** z kodem `SCOPE_IN_ARGUMENTS`.

Scope powstaje z `resolveConnectionScope` (RA-005) nad `case_connection_scopes`
(migracja `016`), **bez** przekazywania `requestedConnectionId` i `requestedTarget` —
resolver nie dostaje niczego pochodzącego od modelu.

Dowód: 18 nazwanych testów, m.in. `refuses a foreign connection_id with
SCOPE_IN_ARGUMENTS, not a generic error`, `refuses every scope-naming spelling in
arguments`, `refuses a cross-account attempt in BOTH directions`, `injects the granted
PRIVATE mailbox and never the work one`, `refuses to choose between two aliases of one
provider`, `refuses an ambiguous target rather than guessing the first grant`.

Asercje są na **konkretnym kodzie odmowy**, nie na klasie wyniku — `CTF-010`
finding 1. Mutation check to potwierdził: po usunięciu bramki call-time trzy testy AC1
zaczerwieniły się, bo odmowę wydała *słabsza* warstwa (strict schema → `ARGUMENTS_INVALID`),
czyli dokładnie różnica, którą kody istnieją, by ujawniać.

### AC2 — role widzą wyłącznie minimalny manifest — SPEŁNIONE

Zawężanie jest per `(rola, krok)`, nie per rola i nie per case. Manifest jest
*sealed* w sensie RA-011 (`WeakSet` + `Object.freeze`), a executor odrzuca manifest
niewyprodukowany przez registry — inaczej AC2 byłoby obejściem przez literał obiektu.

Nieznany krok daje **pusty** manifest, nie pełny zestaw roli (`CTF-010` finding 4:
brak deklaracji nie jest zgodą). Implementer ma jawnie zero narzędzi providerowych.

Dowód: 10 testów, m.in. `narrows per step, not per role`, `yields an EMPTY manifest for
an unknown step, not the full registry`, `refuses a hand-built manifest that looks
identical`, `refuses a step policy that widens past the descriptor's roles`.

### AC3 — remote schema/description nie nadpisze policy ani prompt authority — SPEŁNIONE

Najważniejsza właściwość: injection **nie jest sanityzowany — nigdy nie trafia do
promptu**. Manifest niesie opis server-authored, a zdalny opis jest przechowywany
wyłącznie do porównania. Test `keeps an injected description out of the manifest a role
sees` zostawia payload nietknięty i asertuje, że rola widzi opis lokalny; implementacja
sanityzująca ten test **nie** przeszłaby.

Schema drift jest odmową (`SCHEMA_DRIFT`), w obu kierunkach: dodatkowy wymagany
argument oraz — subtelniejsze — **pominięcie wstrzykniętego argumentu scope**, co
zamieniłoby scoped read na read z domyślnego projektu serwera. Nie ma ścieżki, którą
zdalny serwer zmienia registry.

Dowód: 12 testów przeciwko celowo wrogiemu serwerowi (`malicious.integration.test.ts`),
w tym `refuses a server that silently drops the injected scope argument`, `never adds an
advertised-but-unregistered tool to the registry`, `still scopes the call to the granted
project when the server lies about everything`.

### AC4 — oversized/malformed output ograniczony i zachowany jako artifact evidence — SPEŁNIONE

Output powyżej `MCP_MAX_TOOL_OUTPUT_BYTES` (262 144 B) jest obcinany dla modelu, a
**pełny payload trafia do `LocalArtifactStore`** (RA-013) z własnym digestem;
`artifact_id` jest w ledgerze i w wyniku. Malformed output (nie-JSON, `NaN`, zbyt
głębokie zagnieżdżenie, funkcja) jest odrzucany jako `PROTOCOL_VIOLATION` — ale
**najpierw zachowany jako evidence**, więc „serwer przysłał coś nieparsowalnego" jest
twierdzeniem sprawdzalnym. Klucze `__proto__`/`constructor`/`prototype` są usuwane.

Dowód: 6 testów, m.in. `truncates a huge response and keeps the full payload as an
artifact`, `refuses a non-finite number as a protocol violation`, `drops
prototype-polluting keys instead of carrying them`.

### AC5 — timeout/retry nie zmienia read failure w fałszywy success — SPEŁNIONE

Rozstrzygające jest rozróżnienie **przed/po dispatchu**, oparte na jawnym sygnale
`onDispatch` z transportu, nie na kształcie błędu:

- timeout **po** dispatchu → `AMBIGUOUS` (`TIMEOUT_AFTER_DISPATCH`), terminalne,
  **bez retry**;
- awaria **przed** dispatchem → `FAILED`, retryowalne;
- nieklasyfikowany błąd po dispatchu → `AMBIGUOUS` (kierunek fail-safe).

`AbortController` przestaje *nasłuchiwać*, nie cofa tego, co serwer już zrobił — stąd
zakaz blind replay. W kontrakcie `toolResult` (dwa statusy) `AMBIGUOUS` mapuje się na
`FAILED` z `requires_reconciliation: true` w payloadzie, a trójstanowy wynik jest
autorytatywny w ledgerze.

**Kluczowe: niemożliwość fałszywego sukcesu jest wymuszona w SQL, nie w
TypeScripcie.** `mcp_tool_calls_succeeded_digest_chk` czyni `SUCCEEDED` bez
`result_digest` niereprezentowalnym; test uderza w bazę bezpośrednio i dostaje nazwę
constraintu.

Dowód: 14 testów, m.in. `records AMBIGUOUS with a reason and does not call twice`
(asercja `transport.callCount === 1`), `rejects SUCCEEDED without a result digest AT THE
DATABASE`, `does not let a straggler overwrite a resolved AMBIGUOUS`, `still reads
AMBIGUOUS through a new repository over a NEW pool`.

### AC6 — każdy call ma intent, validated args, result digest, latency i trace — SPEŁNIONE

Trwały ledger (`mcp_tool_calls`, migracja `028`), nie log. Wiersz `DISPATCHED` jest
**commitowany przed** wysłaniem żądania — dowiedzione odczytem z osobnego połączenia
puli wewnątrz niezacommitowanej transakcji. Odmowy są w tym samym ledgerze z własnym
`refusal_code`: „model zaproponował cross-scope call i został odrzucony" to główne
pytanie audytowe, a odmowa istniejąca tylko w logu byłaby dla niego niewidoczna.

Argumenty są zapisywane jako **digest, nie tekst** — model output zapisany dosłownie
byłby kanałem stored injection do każdego narzędzia operatora czytającego tę tabelę.

Dowód: 12 testów, m.in. `commits the dispatch row BEFORE the request would be sent`,
`records a refusal as a terminal row with its own code`, `requires every AC6 field`.

## 3. Mutation check — każdy mechanizm bezpieczeństwa

Procedura: zepsuj mechanizm, potwierdź czerwony test, przywróć, potwierdź zielony.
Siedemnaście mutacji; **piętnaście** zaczerwieniło zamierzone testy natychmiast.

| # | Mutacja | Skutek |
|---|---|---|
| 1 | usunięta bramka AC1 call-time | 3 testy AC1 czerwone (odmowę wydała słabsza warstwa) |
| 2 | usunięty check sealed manifest | `refuses a hand-built manifest` czerwony |
| 3 | nieznany krok → pełny zestaw roli | `yields an EMPTY manifest` czerwony |
| 4 | ambiguous target → pierwszy grant | `refuses an ambiguous target` czerwony |
| 5 | rejestracja dopuszcza scope-named arg | 3 testy czerwone |
| A | usunięty fence `settle` | 2 testy czerwone |
| B | nieraportowany dispatch → `FAILED` | 4 testy czerwone |
| C | usunięty scope fence w `find` | 1 test czerwony |
| D | duplikat dispatchu dozwolony | 1 test czerwony |
| E | timeout po dispatchu → `FAILED` | `records AMBIGUOUS…` czerwony |
| F | ambiguous zapisany jako `SUCCEEDED` | 2 testy czerwone |
| G | usunięty limit rozmiaru output | `truncates a huge response` czerwony |
| H | `__proto__` przenoszony dalej | `drops prototype-polluting keys` czerwony |
| J | credential jako public property | 3 testy czerwone |
| L | nieapprowany remote użyty | 3 testy czerwone |
| M | pominięty scope arg nie jest driftem | `refuses a server that silently drops…` czerwony |
| N | nieznane narzędzie jako `CONFORMS` | `never adds an advertised-but-unregistered tool` czerwony |
| O | usunięty limit długości opisu | `bounds an enormous remote description` czerwony |
| P | nieogłoszone narzędzie dozwolone | `refuses an unadvertised tool` czerwony |
| Q | usunięta rekursja w nested guard | 2 testy czerwone |

**Dwie mutacje PRZEŻYŁY i obie ujawniły realny problem — oba naprawione:**

- **MUT-I (kolejność spreadu wstrzykniętego scope).** Komentarz twierdził, że
  wstrzyknięta wartość „nie może zostać nadpisana", ale odwrócenie dwóch linii nie
  zaczerwieniło żadnego testu. Dokładnie wzorzec `CTF-010`: komentarz opisywał
  gwarancję, której kod nie egzekwował. Naprawa: kolizja jest teraz **błędem**
  (`mergeServerScopeArgument` → `SCOPE_IN_ARGUMENTS`), nie regułą precedencji, z
  testem sterującym funkcją bezpośrednio (ścieżka w executorze jest nieosiągalna
  z projektu). Powtórzona mutacja: czerwona.
- **MUT-K (`toJSON`/`toString` na credential brokerze).** Usunięcie ich nie
  zaczerwieniło niczego. Sonda wykazała **dlaczego**: pole `#private` jest w tej
  wersji Node niewidoczne dla `JSON.stringify`, koercji do stringa **i** dla
  `util.inspect` nawet z `showHidden: true`. Komentarz twierdził przeciwnie. Kod
  nietestowalny, uzasadniony nieprawdziwym twierdzeniem — usunięty. Po usunięciu
  MUT-J (credential jako public property) zaczerwienia **trzy** testy, w tym
  `JSON.stringify`, który wcześniej override maskował.

## 4. Sonda adwersarialna — znalazła defekt, którego testy nie znalazły

Zgodnie z `CTF-010` finding 3 uruchomiłem sondę spoza zestawu testów. Znalazła
**realny defekt**, który przeszedł 145 zielonych testów:

```text
descriptor: arguments_schema = strictObject({ filters: record(string, string) })
intent:     { filters: { connection_id: "conn-elsewhere", project: "OTHER" } }
wynik:      RESOLVED — forwarded: {"filters":{"connection_id":"conn-elsewhere",…}}
scope:      conn-1 / MOBL   (authoritative scope POPRAWNY)
```

Bramka AC1 sprawdzała wyłącznie klucze **top-level**, więc descriptor legalnie
przyjmujący zagnieżdżony record przekazywał `connection_id` wprost do providera.

**Klasyfikacja: nie eskalacja uprawnień, ale realna luka.** Authoritative scope
pozostawał poprawny (resolver nigdy nie czyta argumentów modelu, co sonda
potwierdziła), więc model nie zyskiwał dostępu. Problem jest subtelniejszy: filtr o
nazwie `connection_id` po stronie providera może zawężić, poszerzyć albo przekierować
read, a broker nie wiedziałby, że to się stało. Kanał nie powinien istnieć.

Naprawione w tym samym przebiegu (`AGENTS.md` p. 4 — finding naprawiany od razu):
`assertNoScopeNamedKey` rekursywnie po obiektach i tablicach, z limitem głębokości 16
i pełną ścieżką w komunikacie (`filters.connection_id`). Trzy testy regresyjne, w tym
jeden potwierdzający, że **legalny** zagnieżdżony record nadal działa — guard nie może
uczynić zagnieżdżonych argumentów bezużytecznymi. Mutacja MUT-Q potwierdza, że
rekursja jest load-bearing. Sonda powtórzona po naprawie: odmowa z właściwym kodem.

Pozostałe sondy (prototype-borne klucz, homoglify `connectíon_id`, klucze
`scope.connection_id`) są **kontenowane przez allowlistę** strict schema — odmowa z
`ARGUMENTS_INVALID`. Detektor nazw ich nie łapie, i to jest akceptowalne: podstawową
bramką jest allowlista per-tool, a lista nazw chroni registry przed jego własnymi
maintainerami, nie runtime przed modelem. Zapisane jawnie w komentarzu przy
`FORBIDDEN_ARGUMENT_NAMES`, żeby nikt nie wziął jej za granicę bezpieczeństwa.

## 5. CTF — stan po tym tasku

- **`CTF-002` (kolizje eksportów) — warunek wejścia spełniony i utrzymany.**
  `RA-012-WU-01B` potwierdzony przed startem. Test przecięcia w
  `contracts.test.ts` **wyłapał trzy realne kolizje przy pierwszym uruchomieniu**:
  `RiskTier`/`riskTierSchema` (istniały już w `contracts`, R0–R4),
  `MAX_TOOL_OUTPUT_BYTES` (inna wartość w `implementation-tools`) i `AmbiguityReason`
  (inne warianty). Rozwiązane: `RiskTier` **konsumowany** z `contracts` zamiast
  duplikowany; dwie pozostałe nazwy sprefiksowane (`MCP_*`, `Mcp*`), bo semantyka
  faktycznie się różni (network read nie ma `PARTIAL_WRITE`).
  Sonda wartości po zmianie: kolizje to wyłącznie znane, otwarte `CTF-001` +
  `packageName` — **`mcp-tool-broker` nie występuje w żadnej** (jego `packageName`
  usunięty). Sonda **type-level** (`ts.Program` + `checker.getExportsOfModule`),
  wymagana przez `CTF-002` bo skan wartości nie widzi kolizji type-only:
  `NO BROKER TYPE-LEVEL OVERLAP`.
- **`CTF-009` (`isForbiddenPath` nie zna plików instrukcji) — nieosiągalne w RA-021,
  potwierdzone bramką.** Read tools tego pakietu są provider-facing (Jira/Gmail/
  Calendar/GitLab), nie filesystem-facing. Sprawdzone, nie założone: brak importu
  `createPlannerReadPort` i `isForbiddenPath` w pakiecie. Warunek na przyszłość
  zapisany w `providers.ts`.
- **`CTF-004` (`typecheck` nie pokrywa `test/**`) — częściowo poprawione, nie
  domknięte.** Pakiet dostał `tsconfig.test.json`, ale z wyłączeniem specek
  integracyjnych: importują harness bazy przez `src`, gdy `@remoteagent/database`
  rozwiązuje się do `dist`, a oba `Database` są strukturalnie różne (prywatne `pool`).
  To dokładnie konflikt src-vs-dist opisany w `CTF-004` — wszystkie cztery pakiety
  używające harnessu nie mają tego pliku z tego powodu. Efekt: **więcej** pokrycia niż
  mają tamte (ich unit-specki nie są typechecowane przez nic), bez udawania, że
  finding jest domknięty. Uzasadnienie zapisane w samym `tsconfig.test.json`.
- **`CTF-013` (nowy, MEDIUM) — `pnpm run typecheck` crashuje `RangeError` na kroku
  root.** Zdiagnozowany i **potwierdzony jako preexistujący**: występuje na czystym
  drzewie bazowym (`git stash -u`, `git status` pusty), izolowany do
  `test/golden-path` (RA-018, commit `8edd109`), przechodzi z
  `--stack-size=10000`. `turbo run typecheck --force` przechodzi dla wszystkich 36
  pakietów, więc każdy pakiet osobno jest czysty. Zapisany do rejestru; nie należy do
  RA-021 i nie blokuje jego `PASS`, ale razem z `CTF-008` oznacza dwie czerwone bramki
  repozytorialne na `main` przed `RA-026`.

## 6. Naprawione po drodze (nie zamienione w nowe unity)

Zgodnie z `AGENTS.md` p. 4:

1. **Regresja w RA-012 wywołana przez migrację `028`.**
   `packages/implementation-tools/test/ledger.integration.test.ts` asertował
   `down.reverted).toEqual([27])`. `migrateDown(to: 26)` cofa **każdą** migrację powyżej
   26, więc dodanie `028` zepsuło test, choć odwracalność `027` — rzecz badana — była
   nietknięta. Asercja była tripwire'em na liczniku migracji; zmieniona na
   `toContain(27)`. To realna regresja, którą wprowadziłem, i wykrył ją pełny przebieg
   repo, nie suite pakietu.
2. **Nested scope-key leak** — sekcja 4.
3. **MUT-I i MUT-K** — sekcja 3.

## 7. Odczyt diffu

Przeczytałem pełny diff od `381a88c8`. Nowe: 8 plików `src` (2 099 linii), 7 plików
test (3 050 linii), migracja `028` up/down (158 linii), `tsconfig.test.json`,
zależności w `package.json`. Zmodyfikowane: `index.ts` (barrel, usunięty
`packageName`), jeden test RA-012 (punkt 6.1), `TASK_INDEX.md`, plan, rejestr CTF.

Sprawdzone i potwierdzone:

- **brak cyklu provider↔broker** — pakiet nie importuje żadnego connectora (jedyne
  wystąpienie to komentarz dokumentacyjny), i nic nie importuje brokera. Zależności:
  `contracts`, `database`, `implementation-tools`, `policy`, `test-evidence`, `zod`.
  Kontrola własna, bo `eslint.config.mjs` pozwala `package → package`;
- **brak drugiego zestawu kontraktów** — `toolIntent`/`resolvedToolIntent`/`toolResult`
  konsumowane z `contracts`, test asertuje brak redeklaracji;
- **model nie jest warstwą autoryzacji** — scope wyłącznie z `resolveConnectionScope`
  nad grantami case'a; żaden argument nie poszerza scope;
- **sealed credential-use** — `#private`, brak akcesora, brak pola; ani jeden kontrakt
  nie ma pola na token; nazwy credentialowe są w liście zakazanej w obu kierunkach;
- **brak sekretów w promptach, logach i fixture'ach** — komunikaty odmów nie echują
  wartości (tylko klucz, który pochodzi z listy server-owned), `error_message`
  przechodzi przez `redactCommandOutput`; test canary sprawdza `glpat-` jawnie;
- **granice transakcji** — dispatch i settle to **dwie** transakcje celowo: jedna
  obejmująca wywołanie sieciowe trzymałaby połączenie puli przez cały request i
  **cofnęłaby wiersz ledgera przy błędzie**, niszcząc evidence, które czyni
  nieraportowany call rozwiązywalnym;
- **migracja `028`** — additywna (ADR-0002), nie edytuje zastosowanej migracji, nie
  dodaje constraintu do istniejącej tabeli, `down` jest kompletnym rewertem
  (potwierdzone testem down→up), FK złożony do `cases (case_id, owner_id)` czyni
  wiersz cross-owner niereprezentowalnym.

## 8. Findingi

Brak otwartych findingów klasy BLOCKER, HIGH ani MEDIUM w zakresie RA-021.

Trzy defekty wykryte w trakcie (nested scope-key leak, MUT-I, MUT-K) zostały
naprawione i pokryte testami z potwierdzoną mutacją, więc nie pozostają otwarte.
`CTF-013` jest MEDIUM, ale dotyczy RA-018 i jest potwierdzony jako preexistujący —
trafia do rejestru przekrojowego, zgodnie z jego regułą, i nie zmienia statusu tego
taska.

LOW, świadomie zaakceptowane i zapisane w kodzie:

- detektor `INJECTION_MARKERS` jest niekompletny **z założenia** — bezpieczeństwo nie
  od niego zależy (zdalny opis nie trafia do promptu), a jego rolą jest alert;
- `FORBIDDEN_ARGUMENT_NAMES` nie łapie homoglifów — kontenowane przez allowlistę
  strict schema, co potwierdziła sonda;
- `ProviderGuard` trzyma stan w pamięci — breaker resetujący się przy deployu jest
  akceptowalnym trybem awarii; źródłem prawdy o zdrowiu providera jest trwały ledger
  (`recentByProvider`).

## 9. Werdykt

- Werdykt: `PASS`

Wszystkie sześć kryteriów akceptacji spełnione i zweryfikowane osobno, każde
uruchomioną komendą i nazwanym testem. Każdy mechanizm bezpieczeństwa przeszedł
mutation check; dwie mutacje, które przeżyły, ujawniły realne problemy i zostały
naprawione. Sonda adwersarialna znalazła defekt, którego 145 zielonych testów nie
znalazło — naprawiony, pokryty i potwierdzony mutacją. Brak pozostałych findingów
BLOCKER/HIGH/MEDIUM w zakresie taska.
