# RA-040 — WORK_UNITS

- Task: `RA-040`
- Bazowy commit: `8d69796dc45c9bf117403adc4167d875fe11586c`
- Status: `DONE`

## Ustalenia projektowe

- Nie powstaje drugi orchestrator, subsystem kontekstu ani drugi journal. Compiler rozwija
  istniejące `agent-orchestrator/src/context/*`, a trwałe źródła czyta z istniejących tabel
  Postgresa. `buildContext()` może pozostać compatibility wrapperem, ale nie może zostać drugim
  algorytmem wyboru.
- Każdy packet powstaje od nowa dla konkretnego `EngineeringStage`. Historia rozmowy pozostaje
  append-only raw evidence; do promptu trafia wyłącznie wybór relewancy/budget-aware.
- Warstwy są rozłączne: raw evidence, durable knowledge oraz `UNTRUSTED_DATA` working projection.
  Żadna treść źródła ani `MemoryUpdate` nie ustala policy, tool scope, process class lub gate
  catalogu. Te wartości pozostają wyłącznie server-owned inputem przyszłego workflow engine.
- Manifest używa zaakceptowanego kontraktu RA-037. `byte_budget` jest twardym limitem; compiler
  raportuje także oszacowanie tokenów i rzeczywiste `inputTokens`, jeśli transport je zwróci.
- Digest źródła opisuje trwały, pełny artefakt; inline packet jest redagowany i może być skrócony.
  Skrót zawsze niesie jawny marker, bezpieczną referencję i digest pełnego źródła.
- Redakcja jest jedną granicą używaną przed każdym wyjściem compilera: packet, manifest,
  projection, log/evidence i telemetry. Referencje są nieprzezroczystymi identyfikatorami, nigdy
  ścieżkami hosta.
- Snapshot z DB jest odczytywany w jednej transakcji `REPEATABLE READ READ ONLY`. Authority jest
  wyprowadzane z dokładnego `agent_runs -> work_units -> cases -> case_connections -> checkpoint`;
  caller nie deklaruje ownera, integration scope ani checkpoint revision. Cutoff `run.created_at`
  sprawia, że restart starego runu nie wciąga późniejszych wiadomości.
- `MemoryUpdate` jest tylko propozycją projekcji. Czysta funkcja przygotowująca checkpoint patch
  wymaga zgodności case/run, docelowej checkpoint revision, watermarku z trwałym
  `ContextManifest` i dozwolonych evidence digestów. Faktyczny zapis użyje istniejącego CAS w
  RA-041; RA-040 nie dodaje drugiej ścieżki materializacji.

## WU-00 — Stage registry i czysty context compiler

**Status:** DONE

**Rezultat:** jeden deterministyczny compiler waliduje źródła, exact case/owner/integration scope i
allowlistę typów dla każdego etapu; buduje stage packet oraz ścisły `ContextManifest`, nie kopiując
do authority żadnej wartości z treści źródeł.

**Allowed paths:**

- `packages/agent-orchestrator/src/context/compiler.ts`
- `packages/agent-orchestrator/src/context/source-policy.ts`
- `packages/agent-orchestrator/src/context/types.ts`
- `packages/agent-orchestrator/src/context/builder.ts`
- `packages/agent-orchestrator/src/context/compaction.ts`
- `packages/agent-orchestrator/src/engineering/registry.ts`
- `packages/agent-orchestrator/src/index.ts`
- `packages/agent-orchestrator/test/context-compiler.test.ts`
- `packages/agent-orchestrator/test/engineering-registry.test.ts`
- ten plik

**Komenda weryfikacyjna:**

```bash
pnpm exec vitest run packages/agent-orchestrator/test/context-compiler.test.ts packages/agent-orchestrator/test/engineering-registry.test.ts && pnpm --filter @remoteagent/agent-orchestrator typecheck
```

**Wymagana mutacja:** usunięcie stage allowlisty albo exact scope check daje RED; po przywróceniu
pełna komenda jest GREEN.

**Dowód wykonania (`2026-08-26`):**

- dokładna komenda WU po korekcie pre-audit: exit `0`; Vitest `13/13` w `2` plikach, package
  typecheck exit `0`;
- zamknięty `EngineeringContextSourceType` rozróżnia źródła domenowe, które legacy renderer
  przedstawia tym samym fragment kind (np. `SYSTEM_DESIGN` i `PROGRAM_DESIGN` jako `plan`). Osobny,
  frozen `engineeringContextSourcePolicy` jest kompletny względem wszystkich etapów, a
  `GATE_CATALOG` nie istnieje w source union ani policy;
- compiler używa istniejącego `buildContext()` jako jedynego algorytmu selekcji, waliduje exact
  case/owner/pełny integration scope i tworzy zaakceptowany `EngineeringContextManifest`.
  Provider/model/repo/working content pozostaje `UNTRUSTED_DATA`; treść źródła nie wpływa na
  authority;
- `CASE_MESSAGE` ma jawny origin `external` i jest case-scoped bez zgadywanego connection binding.
  Provider origin nadal wymaga connection, a `ISSUE_CONTEXT` bez lub z obcym bindingiem failuje;
- finding pre-audit: caller mógł pierwotnie relabelować trzy warstwy pamięci. Frozen, kompletna
  `engineeringContextLayerBySourceType` pinuje teraz `CASE_CHECKPOINT`/`MEMORY_UPDATE` do
  `WORKING_PROJECTION`, messages/issue/repo state/diff/log/tool receipts/evidence do
  `RAW_EVIDENCE`, a pozostałą trwałą wiedzę do `DURABLE_KNOWLEDGE`. Relabelacja
  `CASE_MESSAGE → DURABLE_KNOWLEDGE` i `CASE_CHECKPOINT → RAW_EVIDENCE` failuje osobnym kodem
  `CONTEXT_SOURCE_LAYER_VIOLATION`;
- mutacja usuwająca stage allowlistę dała exit `1`: dokładnie test różnicy
  `SYSTEM_DESIGN`/`PROGRAM_DESIGN` był RED (`1 failed | 11 passed`). Po restore dokładna bramka
  wróciła do GREEN;
- mutacja usuwająca exact layer check dała exit `1`: test relabelacji był RED
  (`1 failed | 12 passed`); po restore pełna bramka oraz regresje builder/compaction wróciły do
  GREEN;
- dodatkowa regresja istniejącego context builder/compaction: exit `0`, `22/22` w `3` plikach;
  scoped ESLint i `git diff --check` exit `0` (wyłącznie preexistujące warnings konfiguracji
  boundaries).

## WU-01 — Spójny snapshot źródeł z Postgresa

**Status:** DONE

**Rezultat:** repository odczytuje case, owner, dokładne connection bindings, rewizję checkpointu
przypiętą do runu, bounded recent i full-text relevance lanes wiadomości oraz trwałe artefakty jako
jeden spójny snapshot. Zwraca wyłącznie server-derived deskryptory z raw refs/digestami. Ten sam run
po restarcie daje identyczny manifest; późniejsze wiadomości są odcięte przez `run.created_at`.

**Allowed paths:**

- `packages/database/src/repositories/engineering-context.ts`
- `packages/database/src/repositories/index.ts`
- `packages/database/test/engineering-context.integration.test.ts`
- ten plik

**Komenda weryfikacyjna:**

```bash
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/engineering-context.integration.test.ts && pnpm --filter @remoteagent/database typecheck
```

**Wymagane mutacje:** usunięcie owner/case/connection join guard lub cutoffu `run.created_at` daje
RED; po przywróceniu realna bramka Postgresa jest GREEN bez skipów.

**Dowód wykonania (`2026-08-26`):**

- dokładna komenda WU: exit `0`; realny PostgreSQL, Vitest `5/5`, package typecheck exit `0`;
- snapshot jest czytany w jednej transakcji `REPEATABLE READ READ ONLY`; authority powstaje z
  dokładnego `agent_runs -> work_units -> cases -> case_connections -> checkpoint`, a strict input
  nie przyjmuje ownera, scope, checkpoint revision ani tekstu relevance;
- dwie niezależne, byte-bounded lanes zastępują fixed-count replay: recent zachowuje najnowsze
  wiadomości, a relevance wyprowadza leksykę wyłącznie z trwałego objective/open questions i
  odzyskuje starą wiadomość spoza ostatnich 20;
- issue context pochodzi z trwałego receipt + outbox, niesie bounded untrusted body, receipt digest
  i exact opaque `jira-receipt:*` ref. Artefakty dokładnego runu są strict-parsowane, wiązane z
  case/run/revision, weryfikowane przez `engineeringArtifactDigest` i wskazują dokładną rewizję;
- deterministyczny `snapshotDigest` obejmuje server-derived authority oraz source descriptors.
  Nowa instancja repository zwraca ten sam snapshot, a wiadomość po `run.created_at` i dane obcego
  ownera/case'a nie trafiają do wyniku;
- tie-break wiadomości używa binarnego porównania identyfikatorów w TypeScript i jawnego
  `COLLATE "C"` w obu SQL lanes. Wiadomości `A`/`a` z identycznym timestampem mają stabilną
  kolejność niezależną od locale;
- mutacja case guard dała exit `1`: cross-case request rozwiązał się zamiast fail-closed (`1 failed
  | 4 passed`). Mutacja obu cutoffów wiadomości dała exit `1`: late message weszła do snapshotu
  (`1 failed | 4 passed`). Po obu restore dokładna bramka wróciła do GREEN;
- mutacja odwracająca binarny tie-break dała exit `1`: asercja kolejności `A` przed `a` była RED
  (`1 failed | 4 passed`); restore zakończył GREEN;
- corruption checks dla payload digest artefaktu i brakującego issue body są GREEN; scoped ESLint i
  `git diff --check` exit `0` (wyłącznie preexistujące warnings konfiguracji boundaries).

## WU-02 — `MemoryUpdate` → checkpoint projection

**Status:** DONE

**Rezultat:** strict `MemoryUpdate` przygotowuje wyłącznie niewładczy, wersjonowany checkpoint patch.
Czysta funkcja dowodzi dokładnego case/run/revision, source watermarku i dozwolonych evidence
digestów, redaguje summary i zachowuje referencję do pełnego artefaktu. Nie przyjmuje ani nie zwraca
policy, tool scope, process class lub gate catalogu.

**Allowed paths:**

- `packages/agent-orchestrator/src/context/memory-projection.ts`
- `packages/agent-orchestrator/src/index.ts`
- `packages/agent-orchestrator/test/memory-projection.test.ts`
- `packages/agent-orchestrator/test/checkpoint-patch.test.ts`
- ten plik

**Komenda weryfikacyjna:**

```bash
pnpm exec vitest run packages/agent-orchestrator/test/memory-projection.test.ts packages/agent-orchestrator/test/checkpoint-patch.test.ts && pnpm --filter @remoteagent/agent-orchestrator typecheck
```

**Wymagana mutacja:** pominięcie watermarku/evidence allowlist albo uznanie projekcji za `TRUSTED`
daje RED; restore kończy GREEN.

**Dowód wykonania (`2026-08-26`):**

- dokładna komenda WU po restore: exit `0`; Vitest `13/13` w `2` plikach, package typecheck
  exit `0`;
- `prepareMemoryProjection()` strict-parsuje server-owned request i kanoniczny
  `engineeringMemoryUpdate`, wymaga exact case/run/target revision/source watermark oraz przynależności
  każdego evidence digestu do server allowlisty;
- wynik jest wyłącznie strict `CheckpointPatch`: wersjonowane deterministyczne summary pozostaje
  `UNTRUSTED_DATA`, completed/open text jest redagowany, a evidence wskazuje bezpieczny opaque ref
  pełnego `MemoryUpdate`. Input, wynik ani tekst modelu nie przenoszą policy, tool scope, process
  class lub gate catalogu;
- ref zawierający known secret, host path albo nie-opaque path shape failuje; test hostile content
  dowodzi, że authority-shaped tekst pozostaje wyłącznie niewładczym contentem. Test aplikacji patcha
  zachowuje case, plan revision, decyzje, approvals, workspace/branch state i trwałe run/event refs;
- finding podczas pierwszej bramki: bezpośredni import `zod` był niedozwoloną, niezadeklarowaną
  zależnością pakietu i dał RED przed uruchomieniem testów. Strict input boundary został oparty na
  istniejących schema objects z `@remoteagent/contracts`, bez poszerzania `package.json`;
- mutacja usuwająca exact watermark guard: exit `1`, targeted test `1 failed | 5 skipped`; restore;
  osobna mutacja usuwająca evidence-membership guard: exit `1`, targeted test
  `1 failed | 5 skipped`; po restore pełna bramka wróciła do GREEN;
- niezależna mutacja Sol usuwająca evidence-membership guard ponownie dała exit `1`
  (`1 failed | 5 skipped`); po restore dokładna bramka WU była GREEN (`13/13`) i package
  typecheck zakończył exit `0`;
- scoped Prettier, ESLint i `git diff --check`: exit `0`; ESLint wypisał wyłącznie istniejące
  warnings migracyjne konfiguracji boundaries.

## WU-03 — Production reply-loop, observability i actual usage

**Status:** DONE

**Rezultat:** produkcyjny worker składa prompt z latest working projection, relevant/budgeted recent
messages i issue context przez nowy compiler; `listRecent(20)` nie jest już granicą kontekstu.
Compiler wybiera źródła deterministycznie według mandatory/latest owner/lexical overlap/priority/
recency pod byte budgetem, a worker rejestruje bezpieczne statystyki warstw, compaction oraz
rzeczywiste `usage.inputTokens`. Cache ma stany `HIT/MISS/NOT_OBSERVED`; brak sygnału transportu nie
jest fabrykowany jako hit.

**Allowed paths:**

- `apps/agent-worker/src/context.ts`
- `apps/agent-worker/src/roles.ts`
- `apps/agent-worker/src/worker.ts`
- `apps/agent-worker/test/role-context.test.ts`
- `apps/agent-worker/test/context.integration.test.ts`
- `packages/observability/src/metrics.ts`
- `packages/observability/test/context-metrics.test.ts`
- `packages/database/src/repositories/engineering-context.ts`
- `packages/database/test/engineering-context.integration.test.ts`
- `packages/agent-orchestrator/src/context/types.ts`
- `packages/agent-orchestrator/src/context/builder.ts`
- `packages/agent-orchestrator/src/context/compiler.ts`
- `packages/agent-orchestrator/src/context/source-policy.ts`
- `packages/agent-orchestrator/test/context-builder.test.ts`
- `packages/agent-orchestrator/test/context-compiler.test.ts`
- ten plik

**Komenda weryfikacyjna:**

```bash
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run apps/agent-worker/test/role-context.test.ts apps/agent-worker/test/context.integration.test.ts packages/observability/test/context-metrics.test.ts
```

**Wymagana mutacja:** powrót do full/fixed-count replayu albo przedstawienie estymacji jako actual
usage daje RED; przywrócenie kończy GREEN.

**Dowód wykonania (`2026-08-26`):**

- dokładna bramka WU przed korektą rankingu: exit `0`, `8/8` w `3` plikach; agent-worker i
  observability typecheck oraz scoped ESLint/diff-check zakończyły exit `0`;
- production composition nie importuje `CaseMessageRepository` i nie wywołuje `listRecent(20)`.
  Worker tworzy fresh context przez exact case/run/work-unit binding, a dla świeżego case'a
  idempotentnie materializuje brakujący baseline checkpoint przed snapshotem;
- packet jest renderowany wyłącznie z `compiled.context.fragments` oraz odpowiadających im
  deskryptorów manifestu. Test z compiler seam zmienia content/ref i dowodzi, że raw snapshot nie
  ma bocznej ścieżki do promptu;
- provider `usage.inputTokens` zasila actual metric wyłącznie, gdy istnieje; estymacja ma osobną
  serię. Cache bez sygnału ma jawny `NOT_OBSERVED`; metryki klas pamięci i compaction używają tylko
  zamkniętych stage/layer/outcome labels;
- finding pre-audit: app-level newest/oldest anchors były pozornym rankingiem, bo `buildContext()`
  ponownie sortował coarse kind/ref, a DB zgubiła informację o recent/relevant lane i roli.
  Wprowadzono closed, server-derived klasy `MANDATORY -> LATEST_OWNER -> LEXICAL_RELEVANCE ->
  PRIORITY -> RECENCY`. DB pobiera latest `OWNER` osobnym cutoff-pinned query bez interpretowania
  contentu, zachowuje lane membership i obejmuje metadata snapshot digestem. Compiler fail-closed
  waliduje klasę/observedAt, dopuszcza najwyżej jeden latest-owner source, a builder chroni go przed
  cichym pominięciem. Fitter konsumuje dokładnie kolejność compilera;
- korekta rankingu: bramka Luna `22/22` w `3` plikach, oba package typechecki i diff-check exit `0`.
  Niezależna łączna bramka Sol po buildzie zależności: exit `0`, `30/30` w `6` plikach oraz
  database/orchestrator/worker typecheck exit `0`;
- mutacja fabrykująca actual usage przy braku danych providera: RED (`137` zamiast `37`), restore
  GREEN. Mutacja production composition bez context readera: RED. Mutacje DB pinningu latest OWNER,
  dozwolonej klasy selection oraz ochrony latest-owner przed overflow: każda osobno RED; niezależna
  mutacja Sol ochrony buildera ponownie dała `1 failed`, po restore GREEN;
- `git diff --check` exit `0`.

## WU-04 — Canary redaction, artifact clipping i evidence baseline

**Status:** DONE

**Rezultat:** wszystkie powierzchnie compiler output przechodzą wspólną redakcję; refs zawierające
secret/PII/host path failują. Oversized diff/log jest skracany na granicy pełnego code pointu z
markerem/ref/digestem. Baseline na >20 wiadomościach zapisuje legacy i nowy byte/token footprint;
nowy packet zachowuje latest owner steering, issue context i starą relewantną wiadomość bez pełnej
historii. Compatibility reply persistence i projection pozostają zielone.

**Allowed paths:**

- `packages/agent-orchestrator/src/context/compiler.ts`
- `packages/agent-orchestrator/src/context/redaction.ts`
- `packages/agent-orchestrator/src/context/memory-projection.ts`
- `packages/agent-orchestrator/test/context-compiler.test.ts`
- `packages/agent-orchestrator/test/context-redaction.test.ts`
- `packages/agent-orchestrator/test/memory-projection.test.ts`
- `packages/observability/src/secret-patterns.ts`
- `packages/observability/src/metrics.ts`
- `packages/observability/test/secret-patterns.test.ts`
- `packages/observability/test/redaction.test.ts`
- `packages/observability/test/context-metrics.test.ts`
- `apps/agent-worker/src/context.ts`
- `apps/agent-worker/test/context.integration.test.ts`
- `test/security/canary.test.ts`
- `test/security/injection.test.ts`
- `test/context/ra-040-baseline.test.ts`
- `apps/agent-worker/test/handlers.integration.test.ts`
- `apps/agent-worker/test/completion-reply.integration.test.ts`
- `docs/evidence/RA-040/context-baseline.md`
- ten plik

**Komenda weryfikacyjna:**

```bash
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/agent-orchestrator/test/context-compiler.test.ts packages/agent-orchestrator/test/context-redaction.test.ts test/security/canary.test.ts test/security/injection.test.ts test/context/ra-040-baseline.test.ts apps/agent-worker/test/handlers.integration.test.ts apps/agent-worker/test/completion-reply.integration.test.ts
```

**Wymagane mutacje:** wyłączenie redaktora osobno przed prompt/projection/telemetry daje RED na
canary sekretu, PII i host path; clip bez marker/full ref albo po code units daje RED na emoji.

**Dowód wykonania (`2026-08-26`):**

- wspólna tabela `observability/secret-patterns` obejmuje teraz także konserwatywny email i jawnie
  międzynarodowy telefon. `ContextOutputBoundary` używa tego samego `SecretRedactor`: maskuje
  content/freshness/inclusion reason, natomiast sensitive albo known-literal authority IDs,
  connection IDs, tool names, source IDs i refs odrzuca fail-closed;
- compiler sanitizuje źródła przed `buildContext()` i manifestem, a production packet bierze
  wyłącznie compiled fragment + compiled manifest. Bearer znany procesowi jest przekazywany jako
  known literal do loggera, metrics registry i context compiler;
- `DIFF_EXCERPT`/`LOG_EXCERPT` są redagowane przed clippingiem. Binary search działa po pełnych
  code points (`Array.from`), wynik mieści się dokładnie w limicie UTF-8, a marker zawiera tylko
  zweryfikowany opaque `full_ref` i `sha256` digest. Marker, którego nie da się zmieścić, failuje;
- `MemoryUpdate` projection korzysta z tej samej granicy. `MetricRegistry` redaguje i freeze-copy
  labels zarówno przy zapisie, jak i przy labeled lookup; cache state ma runtime closed validation
  `HIT | MISS | NOT_OBSERVED`;
- realny baseline PostgreSQL (`1/1`, exit `0`): full history `4053 B / ~1014`, legacy-20
  `2935 B / ~734`, compiled packet `2764 B / ~691`. Zachowane: latest OWNER steering, literalna
  stara relewantna treść i Jira; odcięte: post-cutoff i full replay. Estymata jest jawnie oddzielona
  od provider actual usage. Dowód: `docs/evidence/RA-040/context-baseline.md`;
- finalna rozszerzona bramka Luna po restore: build czterech pakietów exit `0`, `239/239` w `12`
  plikach z realnym PG, cztery package typechecki/scoped ESLint/diff-check exit `0`;
- niezależna bramka Sol: build czterech pakietów exit `0`, `255/255` w `15` plikach z realnym PG,
  cztery package typechecki i diff-check exit `0`;
- mutacje Luna: compiler/projection/telemetry redaction, valid-opaque known-secret ref guard, marker,
  code-unit clip, latest-owner DB role guard, builder pinning i invalid selection relabel — każda
  osobno RED, wszystkie restore. Niezależne mutacje Sol ponownie dały RED dla compiler redaction
  (`1 failed`), telemetry redaction/freeze (`1 failed`), code-unit clipping (`1 failed`), ref guard
  (`1 failed`) i projection redaction (`1 failed`); po restore bramka wróciła do GREEN;
- findingi w toku: cross-package testy wymagały jawnego build dist; email regex musiał następować po
  URL-userinfo, aby nie zepsuć zachowania prefiksu; pierwszy ref canary łamał także opaque grammar,
  więc zastąpił go valid-opaque known literal; test latest OWNER dostał nowszą wiadomość AGENT,
  dzięki czemu naprawdę dowodzi role guard;
- `git diff --check` exit `0`.

## Pełna bramka taska

```bash
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm build --force && RA_REQUIRE_POSTGRES=1 pnpm test && pnpm typecheck --force && pnpm workflow:validate && git diff --check
```

**Dowód wykonania (`2026-08-26`):** pierwszy przebieg doszedł przez build `26/26` (`0 cached`) i
testy `2583/2583`, po czym root `tsc` dał RED na dwóch testowych granicach typów. Finding
przekrojowy `CTF-023` został naprawiony od razu: `env` ma dokładny `NodeJS.ProcessEnv`, a root
baseline jawnie mostkuje nominalnie różne deklaracje source/dist wyłącznie w setupie testu.
Celowane root `tsc`, env `8/8` i realny baseline `1/1` zakończyły exit `0`.

Powtórzona pełna komenda od początku zakończyła exit `0`: lint/format `0`, build `26/26` i
typecheck `38/38` z `0 cached`, pełne testy PostgreSQL `2583/2583` w `201` plikach bez flake,
`workflow:validate OK — 45 tasks` oraz `git diff --check` exit `0`. Korekta `CTF-023` poszerzyła
zakres wyłącznie o zaakceptowany wcześniej test `test/processes/env-script.test.ts` i rejestr
findingów; nie zmieniła kodu produkcyjnego ani kontraktów RA-038.
