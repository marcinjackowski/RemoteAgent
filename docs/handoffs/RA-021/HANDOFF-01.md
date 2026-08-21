# RA-021 — Handoff 01

## Metadata

- Task: `RA-021`
- Status proponowany: `DONE` (audyt `AUDIT-01` — `PASS`)
- Autor/rola: jedna rola wykonawcza (Claude Opus 5), ADR-0007
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Data: `2026-08-21`
- Bazowy commit: `a19811a`
- Bazowy tree: `381a88c850e23b604fa450261fba4d1ec307f3d9`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test`
  → `148/148 passed`, 7 plików, exit `0`

## Wynik

`@remoteagent/mcp-tool-broker`: jedyna kontrolowana brama między agentem a narzędziem
MCP. Server-owned registry z manifestem per `(rola, krok)`, wstrzykiwanie scope z
grantów case'a, bounded transport z rozróżnieniem `FAILED`/`AMBIGUOUS`, trwały ledger
wywołań (migracja `028`), circuit breaker i rate limit per provider, sprawdzanie
konformancji zdalnego `tools/list`, sealed credential-use oraz katalog read-only
narzędzi dla Jiry, Gmaila, Calendara i GitLaba.

## Trzy właściwości, które są strukturalne, nie konwencjonalne

1. **Scope nie może przyjść od modelu.** Nie „walidujemy `connection_id` modelu" —
   zaakceptowany `contracts.toolIntent` **nie ma pola scope**, więc propozycja modelu
   jest niezdolna nazwać ownera, connection ani repo. Walidacja jest kontrolą, którą
   można pominąć; brak pola nie jest. Dwie dodatkowe warstwy: descriptor deklarujący
   argument o nazwie scope jest odrzucany przy rejestracji, a klucz o takiej nazwie w
   argumentach jest odrzucany na dowolnej głębokości.
2. **Zdalny serwer opisuje, nie decyduje.** `tools/list` jest `UNTRUSTED_DATA`.
   Injection w zdalnym opisie **nie jest sanityzowany — po prostu nigdy nie trafia do
   promptu**, bo manifest niesie opis server-authored. Rozbieżność między tym, co serwer
   ogłasza, a tym, co jest zarejestrowane, jest odmową (`SCHEMA_DRIFT`), nie aktualizacją.
3. **Read, który mógł się wykonać, jest `AMBIGUOUS`, nigdy `FAILED`.** Te dwa stany
   pozwalają na różne następne kroki — jeden jest retryowalny, drugi nie — więc ich
   zlanie zamienia timeout w duplikat albo w fałszywą porażkę. `AbortController` przestaje
   *nasłuchiwać*; nie cofa tego, co serwer już zrobił.

## Dlaczego ledger jest tabelą, a nie logiem

AC6 wymaga intentu, zwalidowanych argumentów, digestu wyniku, latency i trace'u. Log
nie daje żadnego z tego niezawodnie: ginie przy śmierci procesu, nie jest odpytywalny
jako stan i nie wyraża jedynego rozróżnienia, na którym opiera się AC5.

Wiersz `DISPATCHED` jest **commitowany przed** wysłaniem żądania, więc awaria między
żądaniem a odpowiedzią zostawia widoczny, rozwiązywalny stan zamiast ciszy. Trzy
CHECK-i migracji `028` czynią niebezpieczne kształty **niereprezentowalnymi**:
`SUCCEEDED` bez `result_digest`, `AMBIGUOUS` bez powodu, `REFUSED` z wynikiem. To AC5
zapisane w SQL, nie w komentarzu — `AGENTS.md` p. 9.

Odmowy są w tym samym ledgerze: „model zaproponował cross-scope call i został
odrzucony" to główne pytanie audytowe, a odmowa istniejąca tylko w logu byłaby dla
niego niewidoczna. Argumenty są zapisywane jako **digest, nie tekst** — model output
zapisany dosłownie byłby kanałem stored injection do narzędzi operatora.

## Kryteria akceptacji

Wszystkie sześć spełnione i zweryfikowane osobno; dowody w
[`AUDIT-01`](../../audits/RA-021/AUDIT-01.md) sekcja 2.

| AC | Mechanizm | Dowód |
|---|---|---|
| 1 | brak pola scope + odmowa przy rejestracji + odmowa na każdej głębokości | 18 testów |
| 2 | sealed manifest per `(rola, krok)`, nieznany krok → pusty | 10 testów |
| 3 | opis server-authored; drift i pominięty scope arg = odmowa | 12 testów |
| 4 | limit 256 KiB + pełny payload jako artifact (RA-013) | 6 testów |
| 5 | rozróżnienie przed/po dispatchu; CHECK-i w SQL | 14 testów |
| 6 | trwały ledger, commit przed dispatchem, digesty | 12 testów |

## Uruchomione bramki

| Bramka | Wynik |
|---|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test` | `148/148`, exit `0` |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | `1604/1604`, **11 przebiegów z rzędu** |
| `pnpm exec turbo run typecheck --force` | `36 successful, 0 cached` |
| `pnpm run build --force` | `26 successful, 0 cached` |
| `pnpm exec eslint packages/mcp-tool-broker` | exit `0` |
| `pnpm exec prettier --check` | czysto |
| `pnpm workflow:validate` | `OK` |
| `git diff --check` | czysto |

## Co znalazły mutacje i sonda — trzy realne defekty

Mutation check objął każdy mechanizm bezpieczeństwa (17 mutacji, 15 natychmiast
czerwonych). **Dwie przeżyły i obie ujawniły realny problem**, a sonda adwersarialna
znalazła trzeci, którego 145 zielonych testów nie znalazło:

1. **Nested scope-key leak (sonda).** Bramka AC1 sprawdzała tylko klucze top-level, więc
   descriptor przyjmujący zagnieżdżony record przekazywał `{ filters: { connection_id:
   … } }` wprost do providera. Authoritative scope pozostawał poprawny, więc **nie była
   to eskalacja uprawnień** — ale filtr o tej nazwie po stronie providera może zawężić
   albo przekierować read, a broker by o tym nie wiedział. Naprawione rekursywnie, z
   testem potwierdzającym, że legalne zagnieżdżone argumenty nadal działają.
2. **MUT-I: kolejność spreadu.** Komentarz twierdził, że wstrzyknięty scope „nie może
   być nadpisany", ale odwrócenie dwóch linii nie zaczerwieniło żadnego testu — wzorzec
   `CTF-010`. Kolizja jest teraz błędem, nie regułą precedencji.
3. **MUT-K: `toJSON`/`toString` na credential brokerze.** Sonda wykazała, że pole
   `#private` jest już niewidoczne dla `JSON.stringify`, koercji i `util.inspect` z
   `showHidden`. Komentarz twierdził przeciwnie — kod nietestowalny uzasadniony
   nieprawdziwym twierdzeniem, usunięty. Po usunięciu testy łapią regresję *mocniej*.

## Naprawione po drodze

- **Regresja w RA-012, którą wprowadziłem.** `ledger.integration.test.ts` asertował
  `down.reverted).toEqual([27])`; `migrateDown(to: 26)` cofa każdą migrację powyżej 26,
  więc `028` zepsuło test, choć odwracalność `027` była nietknięta. Asercja była
  tripwire'em na liczniku migracji → `toContain(27)`. Wykrył to pełny przebieg repo, nie
  suite pakietu.

## CTF

- **`CTF-002`** — warunek wejścia potwierdzony przed startem. Test przecięcia wyłapał
  **trzy realne kolizje przy pierwszym uruchomieniu** (`RiskTier`,
  `MAX_TOOL_OUTPUT_BYTES`, `AmbiguityReason`); `RiskTier` jest teraz **konsumowany** z
  `contracts`, nie duplikowany. Sonda wartości i sonda type-level: broker nie występuje
  w żadnej kolizji.
- **`CTF-009`** — nieosiągalne tutaj (narzędzia są provider-facing), potwierdzone
  bramką, nie założone.
- **`CTF-004`** — częściowo poprawione (`tsconfig.test.json` bez specek
  integracyjnych, z powodu udokumentowanego konfliktu src-vs-dist), jawnie nie domknięte.
- **`CTF-013` (nowy, MEDIUM)** — `pnpm run typecheck` crashuje `RangeError` na kroku
  root. Zdiagnozowane i **potwierdzone jako preexistujące** na czystym drzewie bazowym,
  izolowane do `test/golden-path` (RA-018). Nie należy do RA-021.
- **`CTF-012`** — jeden fail na szesnaście pełnych przebiegów, **tożsamości nie
  przechwyciłem**; zapisane jako obserwacja, jawnie bez twierdzenia, że to ten flake.

## Dla następnego taska (RA-022)

RA-022 dodaje policy, approval i external writes. Trzy rzeczy z tego pakietu są dla
niego wejściem:

1. `EXECUTABLE_RISK_TIERS` to dziś `[R0]` i registry **odrzuca** descriptor wyższego
   tieru przy konstrukcji. RA-022 poszerza tę jedną deklarację, nie rozsiane `if`-y.
2. Kolumna `risk_tier` w `mcp_tool_calls` przyjmuje już pełny zakres `R0`–`R4`, więc
   zapisanie zaakceptowanego write'u nie wymaga migracji.
3. Rozróżnienie `AMBIGUOUS`/`FAILED` i commit-przed-dispatchem są tu ustalone na
   readach, gdzie blast radius to duplikat odczytu. Dla write'ów RA-022 to różnica
   między jedną a dwiema akcjami — mechanizm jest już przetestowany.

`CTF-005` (approval nie wiąże zgody z rewizją checkpointu) pozostaje otwarte i należy
do RA-022; kształt rozstrzygnięty przez właściciela.
