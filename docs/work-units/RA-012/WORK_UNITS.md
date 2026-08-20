# RA-012 — Work units

## Metadata

- Task: `RA-012`
- Plan revision: `8`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 4.8 / variant high / IMPLEMENTER` (zob. [ADR-0006](../../decisions/ADR-0006-opus48-implementer.md))
- Plan status: `ACTIVE`
- Base commit/tree: `b2d6631` (+ niecommitowany, zaakceptowany WIP RA-011 i WIP RA-016)
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/implementation-tools/test`

## Global boundaries

- In scope: model-facing toolset do czytania, modyfikowania i sprawdzania kodu
  wewnątrz jednego workspace'u, z deterministyczną polityką po stronie serwera.
- Out of scope: semantyka test suite (RA-013), Git commit/push (RA-014), reviewer
  (RA-015), external MCP (RA-021).
- Nowy pakiet: `@remoteagent/implementation-tools`. NIE rozszerzamy
  `workspace-runner` o cały model-facing toolset — `workspace-runner` pozostaje
  warstwą niższą (path policy, process runner, digest, network policy) i jest
  konsumowany jako zależność.
- Scope, cwd, timeout, env allowlist, network mode i output limits są
  **server-owned**. Model nie jest warstwą autoryzacji: żaden argument toola nie
  może poszerzyć scope ani policy.
- Output narzędzi i treść plików repozytorium są `UNTRUSTED_DATA`.
- Filesystem nie daje prawdziwej transakcji. Częściowy patch musi zostawić stan
  wykrywalny i jawnie oznaczony, nigdy fałszywy `SUCCESS`.
- Numer migracji: najwyższy istniejący to `026` (`jira_reconciliation_watermarks`),
  więc RA-012 startuje od `027`. Sprawdzić ponownie przed zapisem — Sol nie
  rezerwuje numerów równolegle.

## Decyzje architektoniczne przed startem

1. **Osobny pakiet, nie rozszerzenie `workspace-runner`.** Uzasadnienie:
   `workspace-runner` jest zaakceptowany w RA-010 i konsumowany przez
   `repository-planner`; wstrzyknięcie tam warstwy model-facing rozszerzyłoby
   zaakceptowany kontrakt i zwiększyło blast radius zmian RA-012.
2. **Durable operation ledger w PostgreSQL, nie `JobStore` ani JSONL.** Istniejący
   `OperationLedger` z `workspace-runner` zapisuje `operations.jsonl` w metadata
   root i serializuje przez in-process `Map` (`chains`). To wystarcza dla
   single-process workspace lifecycle, ale **nie jest cross-process authority** —
   dwa procesy nie są przez niego serializowane. Intent ledger RA-012 wymaga
   trwałego, cross-process źródła prawdy, więc powstaje osobna tabela w Postgresie.
   `OperationLedger` nie jest usuwany ani zmieniany.
3. **Ports/adapters.** Pakiet wystawia porty; nie importuje brokera ani connectorów.

## Finding koordynatora — kolizja nazw eksportów (2026-08-20)

Wykryta przy planowaniu dalszych units, nie zgłoszona przez implementera.

`@remoteagent/contracts` **już** eksportuje `toolIntent` i `toolResult`
(`packages/contracts/src/tool.ts`, re-eksportowane przez `src/index.ts:28`) jako
kontrakty warstwy brokera MCP: `toolIntent` z `intent_id`/`tool_name`/`arguments`
oraz `toolResult` ze statusem `SUCCEEDED | FAILED` (bez `AMBIGUOUS`).
`RA-012-WU-01` utworzył w `@remoteagent/implementation-tools` **własne**
`toolIntent`/`toolResult` o innym kształcie.

Zweryfikowane empirycznie: import obu pakietów daje dokładnie dwie wspólne nazwy
(`toolIntent`, `toolResult`). Osobna sonda ESM potwierdza, że przy dwóch
`export *` dostarczających tę samą nazwę specyfikacja **cicho usuwa** ją z
barrela — nie ma błędu kompilacji, nazwa po prostu przestaje istnieć.

Obecnie nieosiągalne: żaden moduł nie importuje jeszcze
`implementation-tools`. Stanie się osiągalne, gdy RA-021 (MCP Tool Broker) użyje
`contracts.toolIntent`, a RA-012 swojego — wtedy wspólny barrel albo pomyłka
importu daje `undefined` zamiast schematu, czyli walidację, która nic nie
waliduje.

Wymagana zmiana, do wykonania **przed** `WU-03` (zanim cokolwiek zacznie
konsumować pakiet): jednoznaczne nazwy w `implementation-tools`, np.
`implementationToolIntent` / `implementationToolResult` (albo `workspaceToolIntent`
/ `workspaceToolResult`), wraz z odpowiadającymi typami. `packages/contracts`
pozostaje nietknięty — jego kontrakty są zaakceptowane i konsumowane. Ujęte jako
`RA-012-WU-01B`.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-012-WU-01` | `ACCEPTED` | strict tool contracts + scaffold pakietu | RA-011 DONE |
| `RA-012-WU-01B` | `ACCEPTED` | usunięcie kolizji nazw eksportów z `@remoteagent/contracts` | WU-01, WU-02 |
| `RA-012-WU-02` | `ACCEPTED` | durable operation intent ledger (migracja `027`) | WU-01 |
| `RA-012-WU-03` | `ACCEPTED` | bounded read/search/tree/config tools | WU-01B |
| `RA-012-WU-04` | `ACCEPTED` | journaled multi-file patch ze staging/digest/recovery | WU-02, WU-03 |
| `RA-012-WU-05` | `READY` (próba przerwana, do powtórzenia) | server-owned command policy + output/artifact sink | WU-02, WU-03 |
| `RA-012-WU-06` | `PENDING` | mkdir w scope + diagnostics | WU-03 |
| `RA-012-WU-07` | `PENDING` | composition + fault/restart matrix | WU-04, WU-05, WU-06 |

Dokładnie jeden unit tego taska jest `READY` w danym momencie (obecnie `WU-05`).
Kolejny odblokowuje koordynator po akceptacji poprzednika — units jednego taska
pozostają sekwencyjne, żeby zachować single-writer.

## `RA-012-WU-01` — Tool contracts and package scaffold

- Result: nowy pakiet `@remoteagent/implementation-tools` z wersjonowanymi,
  strict kontraktami dla tool intent i result envelope; bez logiki narzędzi.
- Allowed paths: `packages/implementation-tools/package.json`,
  `packages/implementation-tools/tsconfig.json`,
  `packages/implementation-tools/src/index.ts`,
  `packages/implementation-tools/src/contracts.ts`,
  `packages/implementation-tools/test/contracts.test.ts`.
- Context pack: `packages/repository-planner/package.json` i `tsconfig.json` jako
  wzór scaffoldu; `packages/contracts/src/repository-profile.ts` jako wzór
  `valueObject`/`z.literal(UNTRUSTED_DATA)`; `eslint.config.mjs` sekcja
  `boundaries/elements` (pakiet `packages/*` jest już objęty, nie wymaga zmian).
- Acceptance:
  1. `ToolIntent` i `ToolResult` są strict (`z.strictObject`), wersjonowane
     (`schema_version`) i zawierają `operationId`, `caseId`, `workspaceId`,
     `kind`, `beforeDigest`/`afterDigest` oraz `changedFiles`.
  2. `ToolResult` ma jawny, zamknięty zbiór outcome'ów obejmujący stan
     niejednoznaczny: `SUCCEEDED | FAILED | AMBIGUOUS` — `AMBIGUOUS` nie może być
     reprezentowany jako `SUCCEEDED`.
  3. Output narzędzia jest przypięty do `UNTRUSTED_DATA` na poziomie schematu
     (`z.literal`), tak jak `untrustedContent` w `packages/contracts`, i ma
     bounded rozmiar oraz jawny flag truncation.
- Verification: `pnpm vitest run packages/implementation-tools/test` z exit code `0`.
- Out of scope: implementacja jakiegokolwiek narzędzia, migracje, ledger, execution,
  zmiany w `packages/workspace-runner`, `packages/contracts` i `packages/database`,
  edycja dokumentacji/statusów, commit, remote writes.
- Coordinator gate: pakiet buduje się i typecheckuje; `pnpm vitest run` całego repo
  bez regresji; scoped ESLint/Prettier; brak `any`; brak importu brokera; schema
  odrzuca nadmiarowe pola (dowód testem, nie deklaracją).

## `RA-012-WU-02` — Durable operation intent ledger

- Result: migracja `027` + repozytorium trwałego intent/result ledgera z atomowym,
  cross-process wykrywaniem replay.
- Allowed paths (potwierdzone `2026-08-20`; najwyższa istniejąca migracja to `026`):
  - `packages/database/migrations/027_implementation_tool_operations.up.sql`
  - `packages/database/migrations/027_implementation_tool_operations.down.sql`
  - `packages/implementation-tools/src/ledger.ts`
  - `packages/implementation-tools/src/index.ts` (tylko dodanie re-eksportu)
  - `packages/implementation-tools/package.json` (tylko dodanie zależności
    `@remoteagent/database`)
  - `packages/implementation-tools/test/ledger.integration.test.ts`
- Context pack: `ToolIntent`/`ToolResult` z `src/contracts.ts` (WU-01, `ACCEPTED`);
  `Database.withTransaction` i `withAdvisoryLock` z
  `packages/database/src/client.ts`; wzór migracji `024_jira_projection_receipts`;
  wzór testu integracyjnego `createTestDatabase` z
  `packages/database/test/harness.js` i `describeIntegration` z
  `integration-base.js`; `OperationLedger` z `workspace-runner/src/operation-log.ts`
  **wyłącznie jako kontrprzykład** — jest in-process, nie cross-process authority,
  i nie wolno go użyć ani zmodyfikować.
- Acceptance:
  1. Intent jest trwale zapisany **przed** side effectem, a ten sam `operation_id`
     nigdy nie wykonuje operacji dwa razy — również przy równoległych,
     cross-process wywołaniach (dowód testem współbieżności na prawdziwym
     PostgreSQL, z licznikiem faktycznych wykonań).
  2. Operacja bez potwierdzonego receiptu (timeout, przerwanie) daje trwały stan
     `AMBIGUOUS` z `requires_reconciliation`, nigdy `SUCCEEDED` — zgodnie z
     kontraktem z WU-01.
  3. Ledger jest scope'owany po `case_id`/`workspace_id`; wpis jednego case nie
     jest widoczny ani nadpisywalny z innego (dowód testem cross-scope).
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/implementation-tools/test/ledger.integration.test.ts`
  z exit code `0`.
- Historia wykonania i **błąd proceduralny koordynatora** (`2026-08-20`):
  koordynator uznał sesję implementera za martwą na podstawie dwóch przesłanek —
  transcript agenta stał na 159 bajtach, a w repozytorium nie było żadnego z
  oczekiwanych plików przez ~15 minut — i uruchomił drugą sesję dla tego samego
  unitu. **Ten wniosek był błędny:** pierwsza sesja żyła, pracowała i ukończyła
  unit poprawnie. Rozmiar transcriptu i brak plików nie są dowodem śmierci agenta;
  implementer może długo czytać kontekst i projektować przed pierwszym zapisem.
  Skutkiem było chwilowe naruszenie zasady single-writer: dwie sesje miały tę samą
  allowlistę.
  Wykryte natychmiast po raporcie pierwszej sesji, duplikat zatrzymany.
  Weryfikacja braku szkody: `ledger.integration.test.ts` 23/23, typecheck, build,
  Prettier, `git diff --check` oraz całe repo 1144/1144 — pliki są spójne, nie
  są mieszanką dwóch sesji. Dodatkowo mutation testing (poniżej) potwierdził, że
  mechanizmy są sprawne, a nie przypadkowo zielone.
  **Wniosek na przyszłość:** nie wnioskować o śmierci implementera z braku plików
  ani z rozmiaru transcriptu. Jedyne bezpieczne przesłanki to jawny raport agenta,
  status `killed`/`failed` z harnessu albo odpowiedź na status check. Przy
  wątpliwości najpierw zapytać i **poczekać**, nigdy nie uruchamiać drugiej sesji
  na tej samej allowliście.
  Ta rewizja nie zużywa limitu prób, bo pierwsza sesja zakończyła się sukcesem.
- Out of scope: `JobStore` jako substytut, JSONL ledger, jakiekolwiek narzędzie,
  execution, filesystem, `child_process`, zmiany w `packages/workspace-runner`,
  `packages/contracts`, `src/contracts.ts`, innych migracjach, dokumentacji,
  commit, remote writes.
- Coordinator gate: migracja `up` i `down` czysta i odwracalna (`migrateUp` →
  `migrateDown` → `migrateUp`); brak kolizji numeru `027`; concurrency test realny,
  nie tautologiczny (mutacja usuwająca serializację musi go wywalić);
  **sprawdzić zużycie połączeń jak w RA-016-WU-08G** — jeżeli implementer użyje
  `withAdvisoryLock` owijającego `withTransaction`, to są dwa połączenia na
  operację i przy domyślnej puli 10 zakleszczy się dla N > 5; pełna suite pakietu,
  typecheck, build, scoped lint/format, `git diff --check`.

## `RA-012-WU-01B` — Remove export name collision

- Result: `@remoteagent/implementation-tools` nie eksportuje żadnej nazwy, którą
  eksportuje już `@remoteagent/contracts`.
- Allowed paths: `packages/implementation-tools/src/contracts.ts`,
  `packages/implementation-tools/src/ledger.ts`,
  `packages/implementation-tools/src/index.ts`,
  `packages/implementation-tools/test/contracts.test.ts`,
  `packages/implementation-tools/test/ledger.integration.test.ts`.
- Context pack: finding koordynatora powyżej; `packages/contracts/src/tool.ts`
  (czytać, NIE zmieniać); aktualny `src/contracts.ts`.
- Acceptance:
  1. Zmiana nazw `toolIntent`/`toolResult` (i powiązanych typów) na jednoznaczne;
     `packages/contracts` pozostaje nietknięty.
  2. Test dowodzi zerowego przecięcia: import obu barreli i asercja, że zbiór
     wspólnych nazw eksportów jest pusty — regresja musi wywalić test.
  3. Cała dotychczasowa semantyka kontraktów zachowana; suite pakietu zielona.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/implementation-tools/test`
  z exit code `0`.
- Out of scope: zmiany w `packages/contracts`, nowe zachowania kontraktów,
  narzędzia, migracje, dokumentacja, commit, remote writes.
- Coordinator gate: własna sonda przecięcia eksportów zwraca `[]`; pełne repo bez
  regresji; typecheck/build/lint/format.

## `RA-012-WU-03` — Bounded read/search/tree/config tools

- Result: read-only narzędzia model-facing (read, search, tree, config) nad
  zaakceptowanym boundary RA-010/RA-011, z intentem i result envelope z WU-01.
- Allowed paths: `packages/implementation-tools/src/read-tools.ts`,
  `packages/implementation-tools/src/index.ts` (tylko re-eksport),
  `packages/implementation-tools/package.json` (tylko zależności),
  `packages/implementation-tools/test/read-tools.test.ts`.
- Context pack: `implementationToolIntent`/`implementationToolResult` z
  `src/contracts.ts` (WU-01B, `ACCEPTED`); **`packages/repository-planner/src/discovery-policy.ts`**
  z gotowymi, przetestowanymi primitywami — `DISCOVERY_LIMITS`
  (`maxFileBytes` 1 MiB, `maxTotalScanBytes` 16 MiB, `maxEntries` 512,
  `maxDepth` 32, `maxResults` 128), `readSafeFile`, `listSafeTree`, `ScanBudget`,
  `isForbiddenPath` (odrzuca `.git`, `.env`), `DiscoveryPolicyError`;
  `WorkspacePathPolicy` i `validateWorkspaceRoot` z `workspace-runner/src/path-policy.ts`
  (`validateCreateTarget`, `validateCommandCwd`, `validateDestructiveTarget`,
  odrzucanie komponentów symlink); `createPlannerReadPort` z
  `repository-planner/src/read-tools.ts` jako wzór kompozycji.
- Acceptance:
  1. Cztery narzędzia (read/search/tree/config) są **bounded** — plik, łączny
     skan, liczba wpisów, głębokość i liczba wyników mieszczą się w jawnych
     limitach; przekroczenie daje typed błąd, nie obciętą ciszę.
  2. Path traversal, symlink escape i ścieżki zabronione (`.git`, `.env`,
     credential paths, repo instructions) są odrzucane — testy negatywne dla
     każdego z tych czterech przypadków osobno.
  3. Ponowny odczyt tego samego stanu jest idempotentny i zwraca ten sam digest;
     każdy wynik jest owinięty w `implementationToolResult` z `output` przypiętym
     do `UNTRUSTED_DATA`.
- Verification: `pnpm vitest run packages/implementation-tools/test/read-tools.test.ts`
  z exit code `0`.
- Out of scope: jakikolwiek zapis, patch, mkdir, wykonywanie komend, ledger
  (WU-02 gotowy — nie zmieniać), zmiany w `packages/repository-planner`,
  `packages/workspace-runner`, `packages/contracts`, `src/contracts.ts`,
  `src/ledger.ts`, migracje, dokumentacja, commit, remote writes.
- Coordinator gate: **nie zduplikowano `discovery-policy`** — przegląd kodu, nie
  tylko testy; brak `any`/`as unknown as`; testy negatywne realne (mutation:
  osłabienie `isForbiddenPath` musi wywalić test); pełna suite pakietu, całe repo
  bez regresji, typecheck/build/lint/format, sonda przecięcia eksportów.
- Wynik gate'u (`2026-08-20`): **ACCEPTED**. Brak duplikacji potwierdzony
  mechanicznie — zero bezpośrednich wywołań `fs` w `read-tools.ts` (`grep` na
  `readdir|readFile|lstat|realpath|statSync|createReadStream` → `0`), cały dostęp
  do dysku delegowany do `createPlannerReadPort` i `validateWorkspaceRoot`.
  Mutation test koordynatora: zamiana `catch (error) { refuse(...) }` na cichy
  `succeed` z pustym body wywala **8 testów** (cztery klasy odmowy, mapowanie
  `config`, limity rozmiaru, wspólny budżet skanu) — ścieżki odmowy są
  load-bearing, nie dekoracyjne. Suite pakietu 64/64, całe repo 1160/116.
- Rozstrzygnięcie ryzyka zgłoszonego przez implementera: `config` dzieli
  `ToolKind.READ_FILE` z `read`, więc implementer pytał, czy ledger nie potrzebuje
  rozróżnienia po `kind`. Sprawdzone w `src/ledger.ts`: `kind` jest wyłącznie
  **zapisywane** (kolumna, projekcja, `INSERT`), nie występuje w żadnym `WHERE`
  ani `ON CONFLICT` — exactly-once opiera się na `operation_id`. Ryzyko nie
  materializuje się; rozróżnienie po polu `tool` w payloadzie jest wystarczające.

## `RA-012-WU-04` — Journaled multi-file patch with staging and recovery

- Result: zapis wielu plików z journalem, pre/post digestem i wykrywalnym stanem
  częściowym; filesystem nie daje transakcji, więc częściowy zapis kończy się
  jawnym `AMBIGUOUS`, nigdy `SUCCEEDED`.
- Allowed paths: `packages/implementation-tools/src/patch.ts`,
  `packages/implementation-tools/src/index.ts` (tylko re-eksport),
  `packages/implementation-tools/test/patch.integration.test.ts`.
- Context pack: `implementationToolResult` i wariant
  `ambiguousImplementationToolResult` z `src/contracts.ts` (WU-01B) —
  `ambiguity_reason: PARTIAL_WRITE | INTERRUPTED | UNVERIFIED_POST_STATE`
  i `requires_reconciliation: z.literal(true)`; `OperationLedgerRepository` z
  `src/ledger.ts` (WU-02) — intent przed side effectem, `settle` fenced na
  `INTENT_RECORDED`, `markAbandonedAmbiguous` jako ścieżka recovery;
  `computeTreeDigest` z `workspace-runner/src/digest.ts`; `RecoveryState`
  (`CLEAN | DIRTY | AMBIGUOUS`) z `workspace-runner/src/recovery.ts`;
  `WorkspacePathPolicy.validateCreateTarget`; narzędzia read z WU-03.
- Acceptance:
  1. Zapis jest journalowany: intent (z listą plików i pre-digestem) trwale
     zapisany **przed** pierwszym dotknięciem filesystemu, przez ledger z WU-02.
  2. Przerwanie w połowie zapisu daje `AMBIGUOUS` z `PARTIAL_WRITE` i listą
     plików, które mogły zostać zmienione — **test wymusza realne przerwanie**
     (fault injection po N-tym pliku), nie symuluje go asercją.
  3. Po restarcie (świeża instancja nad tą samą bazą) stan częściowy jest
     odczytywalny i wskazuje wymaganą reconciliation; brak ścieżki z „częściowy
     zapis" do `SUCCEEDED`.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/implementation-tools/test/patch.integration.test.ts`
  z exit code `0`.
- Out of scope: wykonywanie komend, mkdir jako osobne narzędzie (WU-06), Git
  (RA-014), zmiany w `src/contracts.ts`, `src/ledger.ts`, `src/read-tools.ts`,
  `packages/workspace-runner`, migracje, dokumentacja, commit, remote writes.
- Coordinator gate: **mutation test obowiązkowy** — zmiana `AMBIGUOUS` na
  `SUCCEEDED` w ścieżce częściowego zapisu musi wywalić test; sprawdzić, że
  intent naprawdę poprzedza zapis (odczyt ledgera z osobnego połączenia w trakcie
  operacji, wzór z WU-02); brak `try/catch` tłumiącego błąd na `SUCCEEDED`.
- Wynik gate'u (`2026-08-20`): **ACCEPTED**. Struktura potwierdzona przeglądem
  kodu: dokładnie **jedna** konstrukcja `SUCCEEDED` w pliku (`patch.ts:416`),
  strzeżona przez `contentsMatch(plan.files)`, plus jedno mapowanie z wiersza
  ledgera (`decide`, `patch.ts:466`) wymagające `status === SUCCEEDED` **i**
  `afterDigest !== null`. Ścieżka `FAILED` jest strzeżona przez
  `touched.length === 0`, więc nie jest osiągalna po pierwszym `open`.
  Dwie mutacje koordynatora, obie wykryte:
  1. zwinięcie `PARTIAL_WRITE` w `FAILED` → 6 testów czerwonych, w tym asercje na
     realnych bajtach na dysku i na trwałym wierszu ledgera;
  2. zmapowanie nierozstrzygniętego `INTENT_RECORDED` na `SUCCEEDED` (hazard
     replay-po-crashu) → test „reports AMBIGUOUS for a replay that arrives while
     the claim is unsettled" czerwony.
  Suite pakietu 93/93, całe repo 1189/1189 (117 plików). Trzy powtórzenia testu
  fault injection bez flake'u — determinizm wynika z sortowania ścieżek zapisu.
- Uwaga do audytu taska: `path traversal` jest odrzucany przez
  `workspaceRelativePath` na granicy kontraktu, **przed** path policy, więc kod
  błędu to `INVALID_REQUEST`, nie `PATH_ESCAPE`. Dwie niezależne warstwy odmawiają;
  odpowiada zewnętrzna. To nie luka — ale audyt taska musi to potwierdzić jako
  świadomą kolejność, nie przypadek.

## `RA-012-WU-05` — Server-owned command policy and output sink

- Result: wykonywanie komend wyłącznie według polityki server-owned, z redakcją
  outputu przed logowaniem i przed przekazaniem modelowi, oraz z pełnym artefaktem
  zachowanym poza promptem.
- Allowed paths: `packages/implementation-tools/src/command.ts`,
  `packages/implementation-tools/src/index.ts` (tylko re-eksport),
  `packages/implementation-tools/test/command.integration.test.ts`.
- Context pack: **`runProcess` z `workspace-runner/src/process-runner.ts`** — ma
  już `ProcessLimits` (`timeoutMs`, `outputBytes`), `timedOut`, `outputTruncated`,
  `spawn` z `shell: false` i tablicą argumentów, `SAFE_PATH`, `HOME` ustawiony na
  root, env allowlistę (`LANG`/`LC_ALL`/`LC_CTYPE`/`TZ` — reszta odrzucana kodem
  `INVALID_ENVIRONMENT`), `prepareNetworkLaunch` z `NetworkMode`, `killTree`,
  potrójne `validateCommandCwd` (przed i bezpośrednio przed launch, żeby symlink
  swap failował closed), oraz odrzucanie `cpuTimeMs`/`memoryBytes` kodem
  `NOT_ENFORCEABLE`; `SecretRedactor` z `packages/observability/src/redaction.ts`;
  `implementationToolResult` i `toolOutput` (`MAX_TOOL_OUTPUT_BYTES` 65 536) z
  `src/contracts.ts`; ledger z `src/ledger.ts`; wzór envelope z `src/read-tools.ts`.
- Acceptance:
  1. Polityka jest **server-owned i nieposzerzalna przez argument** — cwd,
     timeout, env allowlist, network mode i limity outputu pochodzą z konfiguracji
     serwera; próba przekazania własnej zmiennej środowiskowej, cwd poza rootem
     albo `network: "ALLOW"` gdy polityka mówi `DENY` jest odrzucana (test
     negatywny dla każdego z tych czterech).
  2. Output jest redagowany **przed logowaniem i przed przekazaniem modelowi**;
     canary secret w stdout i stderr nie pojawia się w żadnej z tych dróg.
     Obcięcie jest jawne, a pełny artefakt pozostaje dostępny poza promptem z
     referencją/digestem.
     **UWAGA — `SecretRedactor` jest niekompletny (`CTF-006`).** Sonda
     koordynatora wykazała, że przepuszcza: absolutne host paths (`/Users/`,
     `/home/`), `glpat-`, `AKIA`, `-----BEGIN … PRIVATE KEY-----` i JWT (`eyJ…`);
     pokrywa `Bearer`/`Basic`, wrażliwe klucze obiektów i URL-e z hasłem. Output
     komendy jest pełen host paths, więc **nie wolno polegać wyłącznie na
     `SecretRedactor`**. Ten unit musi dołożyć własną warstwę dla host paths i
     tokenów providerów, a test canary sprawdzać je jawnie. Docelowe ujednolicenie
     wzorców należy do RA-024 — tutaj nie zmieniamy
     `packages/observability` ani `packages/repository-planner`.
  3. `timedOut`, cancel i zwykły niezerowy exit są **rozróżnialne** — timeout po
     możliwym side effekcie daje `AMBIGUOUS`, nie `FAILED` udający brak skutków.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/implementation-tools/test/command.integration.test.ts`
  z exit code `0`.
- Out of scope: **nie zmieniać `runProcess`** ani niczego w `workspace-runner`;
  `cpuTimeMs`/`memoryBytes` pozostają nieobsługiwane (adapter zwraca
  `NOT_ENFORCEABLE`) — nie udawać, że OOM jest wykrywalny limitem pamięci; Git,
  mkdir (WU-06), zmiany w `src/contracts.ts`/`src/ledger.ts`/`src/read-tools.ts`/
  `src/patch.ts`, migracje, dokumentacja, commit, remote writes.
- Coordinator gate: **nie zduplikowano `runProcess` ani `SecretRedactor`** —
  przegląd kodu; canary secret sprawdzony osobno w logu i w output modelu;
  mutation test: usunięcie redakcji musi wywalić test; pełna suite pakietu, całe
  repo bez regresji, typecheck/build/lint/format.
- Historia wykonania (`2026-08-20`): pierwsza próba **przerwana przez koordynatora
  w trakcie pracy**, gdy właściciel polecił pauzę. Implementer zapisał
  `src/command.ts` (37 KB) i przeszedł typecheck, ale nie zapisał wymaganego
  `test/command.integration.test.ts` ani nie zaraportował wyniku. Zostawił też
  poza allowlistą `test/zz-tmp-probe.test.ts` — sondę sprawdzającą rozwiązywanie
  `@remoteagent/observability` pod vitest, czego pakiet nie ma w `dependencies`.
  To był materialny Decision Request, którego implementer nie zgłosił.
  **Unit jest do powtórzenia od zera**: `command.ts` nie ma wartości dowodowej bez
  testu i raportu. Przy wznowieniu context pack musi jawnie rozstrzygnąć dostęp do
  `@remoteagent/observability` — albo dodać go do allowlisty `package.json`, albo
  zabronić i wskazać alternatywę dla redakcji.
  Ta próba **nie** zużywa limitu dwóch prób tego samego celu, bo została przerwana
  decyzją koordynatora, a nie zakończona niepowodzeniem merytorycznym.
  Szczegóły i zapis błędu proceduralnego: `docs/handoffs/RA-012/HANDOFF-01.md`.
- **Rozstrzygnięcie koordynatora przed drugą próbą (`2026-08-20`, plan rev. 8) —
  dostęp do `@remoteagent/observability`: ZABRONIONY.** Nie dodajemy tej zależności
  do `package.json`; `package.json` pozostaje poza allowlistą. Uzasadnienie: (1)
  `SecretRedactor` jest niekompletny dokładnie dla danych, które nosi output
  komendy (absolutne host paths) — patrz `CTF-006`, więc i tak nie wolno na nim
  polegać; (2) rozszerzanie zależności pakietu było `Out of scope` tego unitu; (3)
  ujednolicenie wzorców redakcji należy do RA-024 i ma objąć również tabelę z tego
  unitu. Wymagana jest więc **lokalna, samowystarczalna warstwa redakcji** w
  `src/command.ts` (host paths, `glpat-`, `AKIA`, `-----BEGIN … PRIVATE KEY-----`,
  JWT `eyJ…`, `Bearer`/`Basic`, znane literały sekretów przekazane przez serwer),
  z jawnym komentarzem, że jest to stan przejściowy do domknięcia w RA-024.
- **Materiał wyjściowy:** `packages/implementation-tools/src/command.ts` z
  przerwanej próby (37 KB) pozostaje na dysku i jest w allowliście. Implementer może
  go zachować, przerobić albo napisać od zera — decyzja jest jego, ale plik **nie
  jest** zaakceptowany i bez testu oraz raportu nie ma wartości dowodowej. Zawiera
  już lokalną tabelę `redactCommandOutput`, zgodną z rozstrzygnięciem powyżej.

## `RA-012-WU-06` — Scoped mkdir and diagnostics

- Result: tworzenie katalogów wyłącznie w obrębie workspace scope oraz
  diagnostyka narzędzi bez wycieku host paths.
- Allowed paths: `packages/implementation-tools/src/mkdir.ts`,
  `packages/implementation-tools/src/index.ts` (tylko re-eksport),
  `packages/implementation-tools/test/mkdir.integration.test.ts`.
- Context pack: `WorkspacePathPolicy.validateCreateTarget` z
  `workspace-runner/src/path-policy.ts` (odrzuca komponenty symlink i wyjście poza
  root); `implementationToolResult` z `src/contracts.ts`; ledger z `src/ledger.ts`;
  wzorce mapowania błędów z `src/read-tools.ts` i `src/patch.ts`.
  Uwaga: `patch.ts` (WU-04) celowo **nie** tworzy katalogów — brakujący rodzic
  daje tam czysty pre-flight `FAILED` / `PARENT_NOT_A_DIRECTORY`. Ten unit
  dostarcza brakującą zdolność, ale nie zmienia zachowania `patch.ts`.
- Acceptance:
  1. `mkdir` tworzy katalog tylko wewnątrz scope; traversal, symlink escape i
     ścieżka absolutna są odrzucane osobnymi testami negatywnymi.
  2. Operacja jest idempotentna: powtórzone `mkdir` istniejącego katalogu nie jest
     błędem i nie zmienia stanu (ten sam digest drzewa).
  3. Diagnostyka narzędzia zwraca kody i liczniki, **nigdy absolutnych host
     paths** — test canary na `/Users/`, `/home/` w całym output.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/implementation-tools/test/mkdir.integration.test.ts`
  z exit code `0`.
- Out of scope: zapis plików (WU-04), komendy (WU-05), usuwanie katalogów, Git,
  zmiany w zaakceptowanych plikach `src/*`, `package.json`, migracje, dokumentacja,
  commit, remote writes.
- Coordinator gate: brak `fs.mkdir` poza delegacją do zwalidowanej ścieżki;
  mutation test: pominięcie `validateCreateTarget` musi wywalić testy negatywne;
  pełna suite pakietu, całe repo bez regresji, typecheck/build/lint/format.

## `RA-012-WU-07` — Composition and fault/restart matrix

- Result: jeden spójny toolset model-facing z dowodem, że scope jest
  nieposzerzalny, a każda granica jest odporna na fault i restart.
- Allowed paths: `packages/implementation-tools/src/toolset.ts`,
  `packages/implementation-tools/src/index.ts` (tylko re-eksport),
  `packages/implementation-tools/test/toolset.integration.test.ts`.
- Context pack: wszystkie zaakceptowane moduły pakietu (`contracts`, `ledger`,
  `read-tools`, `patch`, `command`, `mkdir`); `RecoveryState` z
  `workspace-runner/src/recovery.ts`.
- Acceptance:
  1. **Model nie może zmienić scope żadnym argumentem toola** — jeden
     `case_id`/`workspace_id` jest wstrzykiwany server-side dla całego toolsetu;
     test adwersarialny podający obcy scope w argumencie każdego z narzędzi.
  2. Chronione są: pliki repo instructions (`AGENTS.md` i warianty), credential
     paths i konfiguracja systemowa — zapis/odczyt poza politykę odrzucony.
  3. Macierz fault/restart: przerwanie w każdej istotnej granicy (read, patch,
     command, mkdir) po restarcie daje stan wymagający reconciliation albo czysty
     stan, **nigdy fałszywego sukcesu**; ponowne wykonanie tego samego
     `operation_id` nie powtarza side effectu.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/implementation-tools/test`
  z exit code `0` (pełna suite pakietu).
- Out of scope: nowe narzędzia, zmiany w zaakceptowanych modułach, Git, reviewer,
  MCP, dokumentacja, commit, remote writes.
- Coordinator gate: sonda przecięcia eksportów; przegląd, że `toolset.ts` nie
  obchodzi żadnej polityki niższej warstwy; mutation test dla wstrzykiwania scope;
  **sześć kryteriów akceptacji RA-012 weryfikowanych osobno** przed handoffem.

## Pokrycie kryteriów akceptacji RA-012

Wszystkie units są rozpisane szczegółowo powyżej. Poniższa tabela służy final task
gate: mapuje sześć kryteriów taska na units, które je dowodzą, żeby żadne nie
zostało zaliczone „przy okazji".

| Kryterium RA-012 | Dowodzone w |
|---|---|
| 1. Path traversal, symlink escape i cwd escape zablokowane | `WU-03` (read), `WU-04` (write), `WU-05` (cwd), `WU-06` (mkdir) |
| 2. Command nie wstrzyknie sekretów ani nie poszerzy network policy | `WU-05` — cztery testy negatywne + canary |
| 3. Każda zmiana ma intent, wynik, pre/post digest i listę plików | `WU-02` (ledger), `WU-04` (digest + `changed_files`) |
| 4. Truncated output zachowuje pełny artefakt i wskazuje obcięcie | `WU-03` (odczyt), `WU-05` (output komendy) |
| 5. Nieudany/częściowy patch zostawia wykrywalny stan, nie fałszywy sukces | `WU-04` — `AMBIGUOUS`/`PARTIAL_WRITE`, potwierdzone mutacją |
| 6. Implementer nie zmieni scope argumentem toola | `WU-07` — test adwersarialny dla każdego narzędzia |

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, oraz osobno weryfikuje sześć kryteriów akceptacji RA-012:
path/symlink/cwd escape, brak wstrzyknięcia sekretów i poszerzenia network policy,
kompletność intent/digest/changed-files, truncation z zachowanym artefaktem,
wykrywalność częściowego patcha i niezmienialność scope przez argument toola.
Następnie handoff i niezależny audyt.
