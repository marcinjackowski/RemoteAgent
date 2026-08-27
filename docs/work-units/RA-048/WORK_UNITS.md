# RA-048 — work units

Baseline: `d3d239594797ae8b2583baf272dbd6bafb0c89a5`.

Istniejące dirty paths z czwartego MOBL-2023 są częścią WU-02 i nie mogą zostać
utracone: create-only write guard oraz eksperymentalny limit 12/48. Limit zostanie
zastąpiony rezerwami, nie zachowany jako ślepe poszerzenie.

## WU-00 — strict blueprint contracts

- Status: `DONE`
- Rezultat: `ProgramDesign` niesie ordered strict slice blueprints, a
  `SliceContract` ma exact `test_paths`; schema odrzuca duplikaty, puste lub obce
  roots i niespójny `slice_order`.
- Allowed paths:
  - `packages/contracts/src/engineering-workflow.ts`
  - `packages/contracts/src/schema.ts`
  - `packages/contracts/test/engineering-workflow.test.ts`
  - `packages/contracts/test/schema-snapshot.test.ts`
  - `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
  - `docs/decisions/ADR-0015-bounded-progressive-engineering-execution.md`
  - `docs/work-units/RA-048/WORK_UNITS.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && pnpm exec vitest run packages/contracts/test/engineering-workflow.test.ts packages/contracts/test/schema-snapshot.test.ts && pnpm run typecheck --force --filter=@remoteagent/contracts`
- Evidence `2026-08-27`: dokładna bramka exit `0`; build exit `0`, focused
  Vitest `18/18`, typecheck `--force` exit `0` (`0 cached`). Mutation checks:
  odłączenie zgodności `slice_order` od blueprint order exit `1`; dopuszczenie
  zduplikowanych test paths exit `1`; usunięcie minimalnego jednego test path
  exit `1`; odłączenie containment test path od allowed roots exit `1` (dwa
  właściwe RED); dopuszczenie duplikatu blueprint allowed paths exit `1`;
  dopuszczenie duplikatu blueprint gate IDs exit `1`. Każda mutacja przywrócona;
  finalna bramka powtórzona GREEN.

## WU-00A — code-owned slice materialization

- Status: `DONE`
- Rezultat: runtime wybiera kolejny blueprint z durable `ProgramDesign`, materializuje
  exact `SliceContract` bez swobodnego replanningu paths/gates i prowadzi każdy slice
  przez implementation→gates→review przed następnym.
- Allowed paths:
  - `packages/agent-orchestrator/src/engineering/registry.ts`
  - `packages/agent-orchestrator/src/engineering/workflow.ts`
  - `packages/agent-orchestrator/src/supervisor/runtime.ts`
  - `packages/agent-orchestrator/test/engineering-registry.test.ts`
  - `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `docs/work-units/RA-048/WORK_UNITS.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-orchestrator build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/agent-orchestrator/test/engineering-registry.test.ts packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/agent-orchestrator --filter=@remoteagent/agent-worker`
- Evidence `2026-08-27`: dokładna bramka exit `0`; build exit `0`, focused
  Vitest `58/58`, root/package typecheck `--force` exit `0` (`0 cached`). V2
  `ProgramDesign` wymaga co najmniej 2 blueprints dla MEDIUM i 3 dla
  LARGE_OR_HIGH_RISK przed appendem. Dwa v2 slices zostały zmaterializowane w
  durable order z `modelCalls=0`; modelowy `SLICE_PLANNING` był celowo
  rozłączony, a oba slices zakończyły własny gate/review. Path ceiling, exact
  gate IDs, test-path containment i legacy identity/order mismatch fail-closed
  przed implementation. Mutation RED: odłączenie server materialization exit
  `1`; osłabienie minimalnej liczby slices exit `1` (3 właściwe testy);
  odłączenie path ceiling exit `1`; odłączenie exact gates exit `1`; odłączenie
  identity/order STOP exit `1`. Odłączenie jednego wczesnego parse test paths
  pozostało GREEN, ponieważ ten sam strict v2 contract jest ponownie egzekwowany
  przez durable append; load-bearing mutacja samego contract guardu jest RED w
  WU-00. Wszystkie mutacje przywrócone, finalna bramka GREEN.

## WU-01 — budżety i kompaktowanie working context

- Status: `DONE`
- Rezultat: implementer ma mutation/final/token reserves; read-only batches nie
  mogą ich zużyć, a starsza historia jest zastępowana bounded content-free
  projection bez naruszenia exactly-once.
- Allowed paths:
  - `packages/bedrock-runtime/src/config.ts`
  - `packages/bedrock-runtime/src/types.ts`
  - `packages/bedrock-runtime/src/tool-loop.ts`
  - `packages/bedrock-runtime/test/tool-loop.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `docs/work-units/RA-048/WORK_UNITS.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm --filter @remoteagent/bedrock-runtime build && pnpm exec vitest run packages/bedrock-runtime/test/tool-loop.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/bedrock-runtime --filter=@remoteagent/agent-worker`
- Evidence (2026-08-27): dokładna bramka zakończyła się exit code `0`;
  build zakończony poprawnie, Vitest `19/19`, wymuszony typecheck `16/16`
  przy `0 cached`. `ToolLoopPolicy` jest opt-in, projekcja zachowuje wszystkie
  początkowe wiadomości user i pełną jedną ostatnią parę assistant/tool, a starsze
  pary zapisuje bez raw input/output jako bounded nazwa/outcome/error code oraz
  canonical input/output digests. Zewnętrzny zbiór wykonanych ID zachowuje
  exactly-once także po kompakcji. Engineering implementation używa `6/32`,
  rezerwuje `3` rundy mutacji i zachowuje `1` pełną parę; default oraz
  prefetched mutation-only pozostają zgodne.
- Mutation evidence (2026-08-27): odłączenie reserve guard (`reserve boundary`),
  odłączenie kompakcji (`compacts old raw pairs`), wyczyszczenie executed-ID set
  (`duplicate ID after its full pair was compacted`) i wyzerowanie wiring rezerwy
  Engineering (`reserves mutation rounds`) dały po kolei exit code `1`; każdą
  zmianę przywrócono przed końcową zieloną bramką.

## WU-02 — test-first chronology i destructive guard

- Status: `DONE`
- Rezultat: pierwsza mutacja test-first dotyka test roots; create-only write i
  suspicious complete-file/large deletion guard odmawiają przed accepted receipt.
- Allowed paths:
  - `packages/implementation-tools/src/toolset.ts`
  - `packages/implementation-tools/test/toolset.integration.test.ts`
  - `apps/agent-worker/src/vertical-slice-executor.ts`
  - `apps/agent-worker/src/xcode-gate-adapter.ts`
  - `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `docs/work-units/RA-048/WORK_UNITS.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm --filter @remoteagent/implementation-tools build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/implementation-tools/test/toolset.integration.test.ts apps/agent-worker/test/vertical-slice-executor.integration.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/implementation-tools --filter=@remoteagent/agent-worker`
- Evidence (2026-08-27): dokładna bramka exit `0`; build exit `0`, focused
  Vitest `42/42`, wymuszony typecheck `16/16` przy `0 cached`. Server-owned
  `slice.test_paths` ogranicza wszystkie ścieżki pierwszej mutacji segmentowo;
  odmowa następuje bez mutation syscall i ledger row, a wyłącznie zakończony
  `SUCCEEDED` test write/patch/mkdir otwiera pozostały scope i stan nie resetuje
  się w próbie. Create-only write pozostał aktywny, zaś `patch.files` nie może
  zastąpić istniejącego pliku przed delegate/ledger. Frozen code-owned diff policy
  (`16` plików, `2000` łącznych zmian, `800` usunięć, destructive ratio `0.8`
  od `20` usunięć) jest egzekwowana na exact staged Git diff przed actual evidence
  i receipt oraz związana deployment i implementation config digestem.
- Mutation evidence (2026-08-27): odłączenie test-first guard, błędne uznanie
  failed test write za unlock, odłączenie create-only write, odłączenie existing
  `patch.files` guard, odłączenie exact `slice.test_paths` wiring, odłączenie diff
  policy enforcement i usunięcie policy z config digest dały po kolei exit code
  `1`; każdą mutację przywrócono przed finalną zieloną bramką.
- Finding audytowy (2026-08-27): udany `mkdir` pod test rootem mógł zastąpić
  zmianę pliku testowego i odblokować kod produkcyjny. Unlock wymaga teraz
  `SUCCEEDED` write/exact patch z niepustym `changed_files` zawartym w
  `test_paths`; `mkdir` sam nie wystarcza. Celowe przywrócenie unlocku przez
  `mkdir` dało exit `1` (`1 failed / 26 skipped`), restore dał focused `43/43`,
  a finalna pełna bramka pozostała GREEN.

## WU-02A — FAST/FULL gate tiers

- Status: `DONE`
- Rezultat: code-owned FAST gates wykonują się przed FULL; czerwony FAST zapisuje
  receipt i blokuje kosztowne FULL bez udawania kompletnego EvidenceBundle.
- Allowed paths:
  - `packages/test-evidence/src/engineering-gates.ts`
  - `packages/test-evidence/test/engineering-gates.integration.test.ts`
  - `apps/agent-worker/src/vertical-slice-executor.ts`
  - `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `docs/work-units/RA-048/WORK_UNITS.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm --filter @remoteagent/test-evidence build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/test-evidence/test/engineering-gates.integration.test.ts apps/agent-worker/test/vertical-slice-executor.integration.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/test-evidence --filter=@remoteagent/agent-worker`
- Evidence (2026-08-27): finalna dokładna bramka exit `0`; build exit `0`,
  focused Vitest `38/38`, wymuszony typecheck `16/16` przy `0 cached`, a
  `git diff --check` exit `0`. Strict `gate_tier` przyjmuje `FAST|FULL`, parser
  materializuje brakujące pole jako deterministyczne `FULL`, a catalog układa
  required gates jako FAST przed FULL i stabilnie po `gate_id` wewnątrz tieru.
  Tier jest związany zarówno command digestem, jak i catalog/deployment config
  digestem; production loader przyjął explicit FAST i zmiana na FULL zmieniła
  digest. Nieprzechodzący FAST test-first zakończył oba targets i zapisał dwa
  durable receipts, po czym zwrócił bounded `FAST_GATE_BLOCKED_FULL` bez FULL i
  bez bundle; missing recovery completion FAST zachował ten sam fail-closed stop.
  Zielony FAST uruchomił później FULL mimo leksykalnie wcześniejszego FULL ID.
- Mutation evidence (2026-08-27): zastąpienie tier sort samym `gate_id`,
  kontynuowanie FULL po czerwonym FAST, pominięcie FAST w required set, usunięcie
  tieru z command digest i osobno z catalog/config digest dały po kolei exit code
  `1`; każdą mutację przywrócono przed finalną zieloną bramką.

## WU-02B — receipt-bound code-owned generators

- Status: `DONE`
- Rezultat: generator ID pochodzi wyłącznie z deployment configu; executable działa
  w disposable copy, exact allowed delta jest materializowany pod świeżym fence i
  wiązany istniejącym durable operation receipt; model nadal nie ma command toola.
- Allowed paths:
  - `packages/test-evidence/src/generator.ts`
  - `packages/test-evidence/src/index.ts`
  - `packages/test-evidence/test/generator.integration.test.ts`
  - `apps/agent-worker/src/vertical-slice-executor.ts`
  - `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `docs/work-units/RA-048/WORK_UNITS.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm --filter @remoteagent/test-evidence build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/test-evidence/test/generator.integration.test.ts apps/agent-worker/test/vertical-slice-executor.integration.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/test-evidence --filter=@remoteagent/agent-worker`
- Evidence (2026-08-27): dokładna bramka exit `0`; build exit `0`, real-PG
  Vitest `25/25`, wymuszony typecheck `16/16` przy `0 cached`, `git diff --check`
  exit `0`. Strict catalog wybiera generator wyłącznie przez code-owned trigger,
  wiąże executable z allowlistą i config digestem, a outputy muszą być exact,
  unikalnymi UTF-8 files w `slice.allowed_paths`. Command działa w disposable
  copy bez `.git` i z network `DENY`; protected delta jest odrzucany. Dopiero
  exact command receipt pasujący do końcowego disposable tree pozwala na
  materializację przez durable write ledger pod świeżym writer fence. Modelowy
  raport jest porównany z pre-generator delta przed jakimkolwiek codegen, a
  finalne evidence obejmuje sumę modelowych i wygenerowanych pathów. Model nadal
  nie ma `command` toola.
- Mutation evidence (2026-08-27): odłączenie output-vs-slice guard, poszerzenie
  disposable mutable outputs o chroniony `README.md`, odłączenie stale-receipt
  digest check, usunięcie generator catalog z deployment config digest,
  odłączenie generator execution w vertical slice i usunięcie fresh fence przed
  materializacją dały kolejno exit code `1`; każdą mutację przywrócono przed
  finalną zieloną bramką.

## WU-03 — observable progress journal i kwalifikacja

- Status: `DONE`
- Rezultat: strict progress/checklist/budget/reason-code events są w osobnym
  `0600` JSONL, production composition jest load-bearing, wszystkie mutacje są
  RED→GREEN i opt-in iOS smoke ma porównanie usage.
- Allowed paths:
  - `apps/agent-worker/src/engineering-debug-journal.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/vertical-slice-executor.ts`
  - `apps/agent-worker/test/engineering-debug-journal.test.ts`
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-adversarial.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-control.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-risk.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-coordinator.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-recovery.integration.test.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
  - `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
  - `apps/agent-worker/test/xcode-gate-adapter.integration.test.ts`
  - `apps/discord-bot/src/env.ts`
  - `apps/discord-bot/test/env.test.ts`
  - `packages/contracts/src/engineering-workflow.ts`
  - `packages/contracts/src/schema.ts`
  - `packages/contracts/test/engineering-workflow.test.ts`
  - `packages/contracts/test/schema-snapshot.test.ts`
  - `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
  - `packages/agent-orchestrator/src/engineering/registry.ts`
  - `packages/agent-orchestrator/src/supervisor/runtime.ts`
  - `packages/agent-orchestrator/test/engineering-registry.test.ts`
  - `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
  - `packages/bedrock-runtime/src/config.ts`
  - `packages/bedrock-runtime/src/tool-loop.ts`
  - `packages/bedrock-runtime/src/types.ts`
  - `packages/bedrock-runtime/test/tool-loop.test.ts`
  - `packages/bedrock-runtime/test/structured-completion.test.ts`
  - `packages/implementation-tools/src/toolset.ts`
  - `packages/implementation-tools/test/toolset.integration.test.ts`
  - `packages/review-loop/src/pre-commit.ts`
  - `packages/review-loop/test/pre-commit.integration.test.ts`
  - `packages/test-evidence/src/engineering-gates.ts`
  - `packages/test-evidence/src/runner.ts`
  - `packages/test-evidence/test/engineering-gates.integration.test.ts`
  - `packages/test-evidence/test/evidence.integration.test.ts`
  - `packages/database/src/queue/scheduler.ts`
  - `packages/database/src/repositories/engineering-context.ts`
  - `packages/database/test/engineering-context.integration.test.ts`
  - `packages/database/test/queue-adversarial.integration.test.ts`
  - `packages/database/src/repositories/agent-config.ts`
  - `packages/database/test/agent-config.integration.test.ts`
  - `apps/agent-worker/src/roles.ts`
  - `apps/agent-worker/test/role-context.test.ts`
  - `test/engineering-approval-ingress/engineering-approval-ingress.integration.test.ts`
  - `docs/decisions/ADR-0015-bounded-progressive-engineering-execution.md`
  - `docs/evidence/RA-048/ENGINEERING_EFFICIENCY.md`
  - `docs/evidence/RA-045/IOS_ENGINEERING_SMOKE.md`
  - `docs/work-units/RA-048/WORK_UNITS.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm exec vitest run apps/agent-worker/test/engineering-debug-journal.test.ts apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts && pnpm --filter @remoteagent/agent-worker typecheck && git diff --check`
- Evidence (2026-08-27): focused gate exit `0`; Vitest `22/22`, agent-worker
  typecheck exit `0`. Każda invocation dostaje osobny plik `0600` JSONL z
  content-free `DECISION` i `PROGRESS_SNAPSHOT`: current stage/slice/attempt,
  dziewięcioelementowy checklist, rounds/calls/token budgets oraz FAST/FULL
  state. Po realnych pomiarach dwóch slice'ów target/warning/hard limit wynoszą
  odpowiednio `250000/400000/600000`, a final-call reserve `35000`. Journal nie zapisuje
  promptu, raw tool input/output, patch/file bytes, model prose, sekretów ani
  host paths.
- Mutation evidence (2026-08-27): odłączenie response record, slice identity,
  token reserve, gate state i raw-input redaction oraz zastąpienie unique nazwy
  pliku stałą nazwą dały exit `1`; wszystkie mutacje przywrócono. Dodatkowy
  code-owned limit maksymalnie czterech write roots na slice miał mutation
  `4→16`, która dała exit `1`; po restore focused `4/4` i forced typecheck były
  GREEN.
- Finding (2026-08-27): scheduler heartbeat używał domyślnych `30s` i skracał
  jawnie claimowaną lease `120s`, co pod obciążeniem powodowało stale fence.
  Heartbeat zachowuje teraz configured `claim.leaseMs`. Target queue/coordinator
  `47/47` i forced database/worker typecheck były GREEN; przywrócenie starego
  heartbeat dało load-bearing RED exit `1`, po restore test ponownie GREEN.
- Pełna bramka taska została uruchomiona po wszystkich restore i zakończyła się
  exit `0`: lint exit `0` (wyłącznie znane boundary warnings), format exit `0`,
  build `26/26` przy `0 cached`, Vitest `227` plików passed + `1` opt-in live
  skipped oraz `2896` testów passed + `1` skipped, typecheck `40/40` przy
  `0 cached`, `workflow:validate` `OK — 48 tasks`, `git diff --check` exit `0`.
  Wcześniejsze pełne przebiegi ujawniły kolejno format, siedem nieaktualnych v2
  fixtures oraz load-induced heartbeat defect; wszystkie zostały naprawione,
  nie przemilczane jako flake.
- Pierwszy live smoke ujawnił błędną diagnozę auth: produkcyjny wrapper korzysta
  z istniejącego `AWS_BEARER_TOKEN_BEDROCK`, nie z IAM. Check wrappera zwrócił
  `bedrock_auth_source=environment_api_key`, a kolejny czysty smoke rzeczywiście
  wywołał `us.anthropic.claude-opus-4-8` siedem razy. Provider usage wyniosło
  `88310` tokenów (`78141` input + `10169` output), czyli poniżej wcześniejszego
  baseline `236023` i wewnątrz estymaty `70000–110000`.
- Live run utworzył trzy pliki w izolowanym workspace i doszedł do required
  Xcode gate, który po `236300ms` zwrócił exit `65`; compiler diagnostic:
  `cannot find 'Bundle' in scope` w nowym accessorze. Commit/review nie nastąpił.
  Dwie późniejsze modelowe próby nadpisania istniejącego pliku i lokalizacji
  zostały prawidłowo odrzucone jako `WRITE_REQUIRES_NEW_FILE`, lecz model mimo
  dwóch wolnych tur zwrócił pusty final report. Czerwony gate został następnie
  zmapowany na terminalny `BLOCKED`. WU pozostaje otwarty do dodania
  load-bearing recovery-after-refusal, bounded gate correction i ponownego
  czystego smoke. JSONL:
  `engineering-bb3824e67d96712b53fe5ecdfbe444293b9f9ce3837de1c35969d44a0690eec9.jsonl`.
- Follow-up qualification rozstrzygnęła wcześniejszą diagnozę IAM jako błędną:
  płatne wywołania używają lokalnego `AWS_BEARER_TOKEN_BEDROCK`, regionu
  `us-east-1` i exact `us.anthropic.claude-opus-4-8`, przy usuniętym
  `BEDROCK_MODEL_ID`. Identyczny Xcode adapter z bearer secret zwrócił normalne
  `FAILED/65`, durable artifact i niezmienione drzewo.
- Dwa pełne runy kończyły Xcode po około `6s` jako `INFRASTRUCTURE`. Content-free
  error digest został dopasowany do exact błędu `Xcode gate destination differs
  from the server-selected simulator`: live harness przyjmował drugi, rozbieżny
  `RA_XCODE_DESTINATION`. Harness wyprowadza teraz destination wyłącznie z
  server-owned gate catalog przed modelem. Mutation odłączenia conflict guard
  dała exit `1`; restore dał adapter `4/4`, forced typecheck `15/15` przy
  `0 cached` i diff-check exit `0`.
- Po poprawce invocation
  `engineering-2ed31f8106f7b358595c44abeb3341b820b557077b40be4ff40c26f4e859e00a.jsonl`
  uruchomiła exact Xcode gate przez `358948ms`; receipt był prawdziwym
  `FAILED/65` z compiler logiem, po czym workflow rozpoczął correction attempt
  `2`. Provider zaraportował `13` odpowiedzi i `185961` tokenów (`168041` input
  + `17920` output), czyli `WARNING`. Korekta zakończyła się `Maximum tool
  iterations exceeded`: model wielokrotnie użył create-only `write` dla plików
  z poprzedniego attempt.
- Prompt korekty niesie teraz sorted, server-observed `existingAgentPaths` i
  nakazuje dla nich wyłącznie `patch.replacement_files` z exact old content;
  nie poszerza path authority ani limitu `6/32`. Mutation usuwająca tę listę
  dała exit `1`; po restore focused Engineering/Xcode `11/11`, forced typecheck
  `15/15` przy `0 cached` i diff-check zakończyły się exit `0`. Ponowny płatny
  smoke został wykonany po tej korekcie i ujawnił, że same nazwy ścieżek nie
  wystarczają świeżej sesji modelu.
- Paid smoke `engineering-8c95c9bf71724664c49af6df71646b231993beb0044d8f9981de47c9bcf585b9.jsonl`
  wykonał wyłącznie `us.anthropic.claude-opus-4-8`, trwał `1420.98s` i
  zakończył się exit `1`, bez commita. Provider usage: `16` responses,
  `240903` input + `30633` output = `271536` tokenów. Cztery realne FULL Xcode
  gate'y zwróciły `FAILED/65`; ostatni compiler diagnostic brzmiał `Multiple
  incompatible access-level modifiers specified`. Attempt `4` prawidłowo
  sfinalizował durable implementation receipt po odmowie kolejnego model call,
  ale workflow zdążył związać mutating STARTED dla attempt `5`, zanim wykrył
  wyczerpanie budżetu. Izolowany workspace został zachowany pod
  `engineering-6a8eecfbd80cd00357a8615a6340c0d3` do diagnostyki.
- Root cause: każda korekta otwiera fresh model session, lecz wcześniejsze
  server-observed ścieżki były tylko nazwami. Model nie otrzymywał exact bytes
  własnych plików i zgadywał `old_content`, tworząc kolejne równoległe typy.
  Produkcyjny context plan dołącza teraz sorted/deduplicated exact `READ`
  każdego `cumulative_agent_path` wyłącznie wtedy, gdy durable poprzedni
  `SliceImplementationReceipt` ma ten sam `slice_id` i attempt `current-1`.
  Obejmuje to zarówno GateFailure, jak i ReviewDecision `CHANGES_REQUIRED`, ale
  nie poszerza kontekstu zwykłego następnego slice'a. Preflight budżetu działa
  ponadto przed `readContext` i przed bindingiem mutating STARTED.
- Bramka po korekcie: real-PG Vitest `60/60` w czterech plikach exit `0`; forced
  Turbo typecheck agent-worker `15/15`, `0 cached`, i `git diff --check` exit
  `0`. Mutation odłączająca production correction context dała exit `1`
  (`correctionRequests` `0` zamiast `2`); mutation odłączająca pre-start budget
  fence dała exit `1` (mutating operation zostałaby związana). Obie przywrócono.
  Następny krok to czysty paid smoke na seed commit przed ponowną pełną bramką.
- Kolejny paid smoke, wyłącznie na `us.anthropic.claude-opus-4-8`, zużył
  `218339` tokenów (`199083` input + `19256` output) w `13` odpowiedziach.
  Slice przeszedł realny Xcode gate po korekcie, lecz reviewer zwrócił blocking
  evidence niebędące cytatem z actual patch. Strict review boundary prawidłowo
  odmówiła zaakceptowania reportu; commit nie powstał. Journal:
  `engineering-a5923bddb96ba25c67b209e2ac20e9e3630047f828690f095af87c19dd5629e3.jsonl`.
- Review prompt wymaga teraz jednego ciągłego cytatu z patcha, a blocking finding
  bez zakotwiczenia w actual patch jest deterministycznie degradowany do LOW i
  nie może sam zablokować gate-verified slice'a. Mutacje odłączające prompt i
  downgrade dały exit `1`; po restore szersza focused gate miała `98/98`, root
  forced typecheck `40/40` przy `0 cached`, a `git diff --check` exit `0`.
- Ostatni paid smoke został przerwany na jawne polecenie właściciela podczas
  kolejnego Xcode gate. Do momentu przerwania provider zaraportował `26`
  odpowiedzi, `526738` input + `30371` output = `557109` tokenów (`WARNING`).
  Nie powstał commit ani terminalny sukces. Journal i izolowany worktree zostały
  zachowane; live Bedrock tests są wstrzymane do nowej jawnej decyzji właściciela.

## WU-04 — pełna bramka, audyt i domknięcie

- Status: `DONE`
- Rezultat: pełna niecache'owana bramka, audyt PASS, handoff, statusy i logiczne
  commity; push/MR/Jira/Discord pozostają nieużyte.
- Allowed paths:
  - `docs/tasks/RA-048.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/work-units/RA-048/WORK_UNITS.md`
  - `docs/evidence/RA-048/ENGINEERING_EFFICIENCY.md`
  - `docs/audits/RA-048/AUDIT-01.md`
  - `docs/handoffs/RA-048/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `docs/MASTER_PLAN.md`
  - `docs/decisions/ADR-0016-subscription-cli-model-providers.md`
  - `docs/decisions/README.md`
  - `docs/tasks/RA-049.md`
  - `docs/tasks/RA-050.md`
  - `docs/tasks/RA-051.md`
  - `docs/tasks/RA-052.md`
  - `docs/tasks/RA-053.md`
- Weryfikacja: `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Owner decision (2026-08-27): nie uruchamiać kolejnych live Bedrock smoke.
  Wykonane próby, usage i failure boundaries pozostają evidence; udany Bedrock
  smoke nie jest już warunkiem akceptacji RA-048. Następny krok to pełna
  niecache'owana bramka, audyt i domknięcie taska. Migracja providerów należy do
  `RA-049`–`RA-053`.
- Evidence (2026-08-27): końcowa komenda po pełnym odczycie diffu i wszystkich
  restore zakończyła się exit `0`: lint exit `0` (wyłącznie znane warnings
  boundaries), format exit `0`, build `26/26` przy `0 cached`, real-PG Vitest
  `227` plików passed + `1` live skipped i `2926` testów passed + `1` skipped,
  typecheck `40/40` przy `0 cached`, `workflow:validate` `OK — 53 tasks` oraz
  `git diff --check` exit `0`.
- Finding z pełnej bramki: outer missing receipt FAST gate był błędnie mapowany
  na zwykły `FAST_GATE_BLOCKED_FULL`. Wszystkie niepotwierdzone receipt outcomes
  pozostają teraz `AMBIGUOUS`. Celowe przywrócenie błędu dało exit `1` i dwa
  właściwe RED; restore dał focused real-PG `43/43`, po czym powtórzono pełną
  bramkę od początku.
- Audyt `AUDIT-01` ma werdykt `PASS`; handoff `HANDOFF-01` zachowuje wejście do
  provider-neutralnego RA-049. Nie wykonano push, MR, Jira ani Discord.

## Stan przy pauzie

- RemoteAgent pozostaje celowo dirty wyłącznie zmianami RA-048 wymienionymi w
  allowed paths wszystkich WU; nie wykonano częściowego commita.
- Izolowany seed worktree MOBL-2023 pozostaje zachowany i czysty na branchu
  `remoteagent/mobl-2023-asset-seed`, commit
  `cd46c82de01d6ec4c5e614bcab9dc15f07560642`.
- Przerwany invocation zachowano w
  `/Users/marcinjackowski/.remoteagent/live-mobl-2023/workspaces/ra045_87503abf-22b8-447c-bf8a-c0e192554240-case/engineering-4542f7f8791b9ed04e4285755fcbc16b`:
  sześć staged nowych plików, `464` insertions, bez commita. Journal:
  `engineering-24bb973118e2b3f46486f32ea6ae55812a2be9ffa541c655b7eff371f84d4f2f.jsonl`.
- Live Bedrock pozostaje wstrzymany na polecenie właściciela; procesy Vitest i
  Xcode zostały zatrzymane i nie pozostawiono procesu potomnego.
- Nie wykonano push, MR, Jira ani Discord.
