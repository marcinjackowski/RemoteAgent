# RA-043 — Work units

- Task: `RA-043` Vertical-slice executor, GitLifecycle i review loop
- Bazowy commit: `1a76869cc5d67cfe27b98251221b8811203e3175`
- Status taska: `IN_PROGRESS`
- Decyzje: `ADR-0007`, `ADR-0011`, `ADR-0012`, `ADR-0013`

## Ustalenia wejściowe

- `SupervisorRuntime` pozostaje jedynym driverem workflow. System executor wykonuje dokładnie
  jeden stage i nie ukrywa własnego orchestratora.
- Pętla slice'ów jest runtime-owned. Dyspozycje po review są zamknięte:
  `NEXT_SLICE`, `CORRECT_SLICE`, `COMPLETE`, `STOP`. Korekta zachowuje `slice_id` i zwiększa
  `attempt`; po restarcie stan jest odtwarzany z trwałych artefaktów, nie z pamięci procesu.
- Do kontraktu dochodzi jawny systemowy stage `LOCAL_COMMIT`, uruchamiany raz i dopiero po
  `FINAL_VERIFICATION=VERIFIED`. Commit ma własną operację, receipt i recovery; nie jest ukrytym
  side effectem modelowego final verification.
- Baseline gate'ów jest snapshotem drzewa bezpośrednio sprzed danego slice'a. Slice 2 nie używa
  początkowego base repo.
- Raport implementera jest `UNTRUSTED_DATA`. Źródłem prawdy są actual status, staged diff i tree
  digest odczytane przez serwer. Nowy plik musi wejść do diffu.
- Model implementera nie dostaje command toola. Dostaje tylko bounded read/search/tree/config oraz
  write/patch/mkdir z server-owned operation ID, exact `allowed_paths` i fence checkiem tuż przed
  syscall. `AMBIGUOUS` zatrzymuje przebieg.
- Review jest fresh, read-only, tools-disabled i pre-commit. Istniejący post-commit
  `ReviewResolution` nie dostaje syntetycznego SHA.
- Git działa z pustym HOME poza targetem oraz wyłączonym global/system config. Push, MR i merge nie
  należą do osiągalnej powierzchni tej ścieżki.

## RA-043-WU-00 — Runtime-owned slice loop i jawny `LOCAL_COMMIT`

**Status:** DONE

**Rezultat:** wersjonowane kontrakty i `SupervisorRuntime` wykonują wiele slice'ów oraz korekty z
trwałymi attemptami, a po zielonym final verification przechodzą przez osobny `LOCAL_COMMIT`.

**Allowed paths:**

- `packages/contracts/src/engineering-workflow.ts`
- `packages/contracts/src/schema.ts`
- `packages/contracts/test/engineering-workflow.test.ts`
- `packages/contracts/test/schema-snapshot.test.ts`
- `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- `packages/agent-orchestrator/src/engineering/registry.ts`
- `packages/agent-orchestrator/src/engineering/workflow.ts`
- `packages/agent-orchestrator/src/supervisor/runtime.ts`
- `packages/agent-orchestrator/src/context/source-policy.ts`
- `packages/agent-orchestrator/test/engineering-registry.test.ts`
- `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
- `packages/agent-orchestrator/test/context-compiler.test.ts`
- `packages/database/migrations/035_engineering_local_commit_stage.up.sql`
- `packages/database/migrations/035_engineering_local_commit_stage.down.sql`
- `packages/database/test/migrations.integration.test.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `docs/work-units/RA-043/WORK_UNITS.md`

**Wymagane dowody:** attempt `>1`; correction zachowuje slice; NEXT bierze następny element
`ProgramDesign.slice_order`; resume odtwarza aktywny slice/attempt/fingerprint history; BLOCKED i
limity kończą loop; `LOCAL_COMMIT` jest po verified i ma efekt mutujący; crash nie powoduje replay.
Mutation RED→GREEN co najmniej dla wymuszenia `attempt=1`, terminalizacji correction, zmiany
`slice_id` przy correction, zgubienia historii po resume i pominięcia `LOCAL_COMMIT`.

**Komenda weryfikacyjna:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/contracts/test/engineering-workflow.test.ts \
  packages/contracts/test/schema-snapshot.test.ts \
  packages/agent-orchestrator/test/engineering-registry.test.ts \
  packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts \
  packages/agent-orchestrator/test/context-compiler.test.ts \
  packages/database/test/migrations.integration.test.ts \
  packages/database/test/engineering-control-plane.integration.test.ts \
  apps/agent-worker/test/engineering-workflow.integration.test.ts && \
pnpm --filter @remoteagent/contracts typecheck && \
pnpm --filter @remoteagent/agent-orchestrator typecheck && \
pnpm --filter @remoteagent/database typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Evidence (`2026-08-26`):**

- Przed dokładną bramką przebudowano lokalne `dist` zależności
  `@remoteagent/contracts` i `@remoteagent/agent-orchestrator`; test workera importuje pakiety przez
  ich publiczne entry pointy, więc pozostawiony przez mutation stary build mógłby uruchomić stary
  graf. Oba buildy zakończyły się exit code `0`.
- Dokładna komenda WU powyżej: exit code `0`; Vitest `96/96` w `8/8` plikach, realny PostgreSQL
  wymagany przez `RA_REQUIRE_POSTGRES=1`; typecheck `contracts`, `agent-orchestrator`, `database` i
  `agent-worker`: każdy exit code `0`.
- `pnpm format`: exit code `0`; `git diff --check`: exit code `0`.
- Mutation `attempt > 1 -> attempt === 1`: RED, exit `1`, `2` testy fail (durable correction i
  `NEXT_SLICE` attempt 2); po przywróceniu final GREEN.
- Mutation `CHANGES_REQUIRED -> TERMINAL`: RED, exit `1`, test durable correction oczekiwał
  `COMPLETED/CORRECT_SLICE`; po przywróceniu final GREEN.
- Mutation wyłączająca guard identity podczas correction: RED, exit `1`, test zamiast
  `SLICE_BLOCKED` doszedł do `COMPLETED`; po przywróceniu final GREEN.
- Mutation zerująca fingerprint history podczas `open()`/resume: RED, exit `1`, `2` testy fail
  (`0` zamiast `1` i `4` fingerprintów); po przywróceniu final GREEN.
- Mutation usuwająca `LOCAL_COMMIT` z completion graph: RED, exit `1`, `3` testy fail (registry,
  reachability i final ordering); po przywróceniu final GREEN.
- Mutation usuwająca `LOCAL_COMMIT` z jednego z dwóch CHECK-ów migracji 035: RED, exit `1`, test
  obu constraintów fail; mutation wyłączająca jawny down-guard: RED, exit `1`, test rozpoznał brak
  oczekiwanego fail-closed reason; po przywróceniu final GREEN.
- Mutation usuwająca `EngineeringLocalCommitReceipt` z schema registry: RED, exit `1`, snapshot
  schema map fail; po przywróceniu final GREEN.
- Ustalenie dla następnych WU: `LocalCommitReceipt` jest strict `SERVER_OWNED`, wiąże canonical
  branch, exact Git SHA-1 commit/parent oraz tree/diff/evidence/final-verification digests.

## RA-043-WU-01 — Workspace, fence i bounded implementation tools

**Status:** DONE

**Rezultat:** systemowy executor materializuje deterministyczny per-case workspace i wykonuje
pojedynczy `SliceContract` wyłącznie przez model-facing tools zawężone przez serwer.

**Allowed paths:**

- `apps/agent-worker/src/workspace-config.ts`
- `apps/agent-worker/src/vertical-slice-executor.ts`
- `apps/agent-worker/src/index.ts`
- `apps/agent-worker/package.json`
- `apps/agent-worker/test/workspace-config.test.ts`
- `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
- `packages/implementation-tools/src/toolset.ts`
- `packages/implementation-tools/src/patch.ts`
- `packages/implementation-tools/src/mkdir.ts`
- `packages/implementation-tools/src/index.ts`
- `packages/implementation-tools/test/toolset.integration.test.ts`
- `packages/implementation-tools/test/patch.integration.test.ts`
- `packages/implementation-tools/test/mkdir.integration.test.ts`
- `pnpm-lock.yaml`
- `docs/work-units/RA-043/WORK_UNITS.md`

**Wymagane dowody:** exact allowed path/root semantics; drugi writer i stale/missing fence są
odrzucone przed pierwszą zmianą drzewa; fence bezpośrednio przed write/patch/mkdir syscall;
operation ID pochodzi z serwera; command nie istnieje w implementer surface; `AMBIGUOUS` nie jest
ponawiany. Mutation RED→GREEN dla guard-after-write, brakującego per-mutation fence, obcego writera,
caller-controlled operation ID i wystawienia command toola.

**Komenda weryfikacyjna:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/implementation-tools/test/toolset.integration.test.ts \
  packages/implementation-tools/test/patch.integration.test.ts \
  packages/implementation-tools/test/mkdir.integration.test.ts \
  apps/agent-worker/test/workspace-config.test.ts \
  apps/agent-worker/test/vertical-slice-executor.integration.test.ts && \
pnpm --filter @remoteagent/implementation-tools typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Evidence (`2026-08-26`):**

- `SliceContract` jest exact związany z server-owned `caseId`, `runId` i
  `checkpointRevision` przed materializacją. Deterministyczne operation IDs wiążą dodatkowo
  workspace, slice, attempt, tool i kolejność; input modelu jest strict i nie przyjmuje
  `operation_id`.
- Bounded implementer surface ma dokładnie `read/search/tree/config/write/patch/mkdir`. Nie zawiera
  `command`, identity, root ani fence; command tool nie jest nawet konstruowany. Mutacje przechodzą
  przez exact allowed-root semantics (`path === root || path.startsWith(root + "/")`).
- `beforeMutation` jest wymagane przez bounded toolset, wykonywane po durable intent i bezpośrednio
  przed każdym `open`/`mkdir`. First-guard failure daje terminalne `FAILED`, identyczne bytes i
  replay bez drugiego guard/syscall; later per-file failure daje `AMBIGUOUS` i blokuje dalsze tool
  calls do reconciliation.
- Dokładna komenda WU: exit code `0`; Vitest `79/79` w `5/5` plikach z realnym PostgreSQL wymaganym
  przez `RA_REQUIRE_POSTGRES=1`; typecheck `implementation-tools` i `agent-worker`: każdy exit code
  `0`. Przed testem przebudowano publiczne `dist` zależności `implementation-tools` i
  `workspace-runner`, oba exit code `0`.
- `pnpm format`: exit code `0`; `git diff --check`: exit code `0`.
- Mutation guard przeniesiony po syscall: RED, exit `1`, test wykrył zapis drugiego pliku przed
  odmową. Mutation guard wywoływany tylko dla pierwszego pliku: RED, exit `1`, test wykrył jeden
  check zamiast dwóch. Po przywróceniu final GREEN.
- Mutation permissive initial i adapter fence: RED, exit `1`, obcy writer utworzył workspace
  zamiast zostać odrzucony. Mutation bounded-write schema z `.passthrough()`: RED, exit `1`,
  caller-controlled `operation_id` został zaakceptowany. Mutation dodająca runtime key `command`:
  RED, exit `1`, exact surface-key test wykrył poszerzenie. Po każdej mutacji przywrócono kod.
- Ustalenie dla WU-02: `VerticalSliceExecutionResult.implementerReport` pozostaje jawnie
  model-authored i nie jest evidence. WU-02 ma zbudować actual baseline/status/diff/tree oraz
  porównać z raportem, nie rozszerzając implementer surface.

## RA-043-WU-02 — Per-slice baseline i rzeczywiste evidence

**Status:** DONE

**Rezultat:** każdy slice ma immutable pre-slice baseline, durable RA-042 EvidenceBundle oraz actual
status/diff/tree, które fail-closed weryfikują twierdzenia workera.

**Allowed paths:**

- `packages/test-evidence/src/disposable-workspace.ts`
- `packages/test-evidence/src/baseline-workspace.ts`
- `packages/test-evidence/src/index.ts`
- `packages/test-evidence/test/disposable-workspace.integration.test.ts`
- `packages/test-evidence/test/engineering-gates.integration.test.ts`
- `packages/test-evidence/test/baseline-workspace.integration.test.ts`
- `packages/git-lifecycle/src/lifecycle.ts`
- `packages/git-lifecycle/test/lifecycle.integration.test.ts`
- `apps/agent-worker/src/vertical-slice-executor.ts`
- `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
- `apps/agent-worker/package.json`
- `pnpm-lock.yaml`
- `docs/work-units/RA-043/WORK_UNITS.md`

**Wymagane dowody:** baseline powstaje przed slice i pozostaje niezmienny do końca gate batch;
drugi slice bazuje na stanie po pierwszym; foreign/untracked/stale paths są widoczne; review nie
rusza bez kompletnego PASS; changed files, diff digest i tree digest są porównane z actual.
Mutation RED→GREEN dla snapshot-after-write, base-repo użytego w slice 2, modyfikacji baseline,
pominięcia untracked oraz kłamliwego reportu.

**Komenda weryfikacyjna:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/test-evidence/test/disposable-workspace.integration.test.ts \
  packages/test-evidence/test/engineering-gates.integration.test.ts \
  packages/test-evidence/test/baseline-workspace.integration.test.ts \
  packages/git-lifecycle/test/lifecycle.integration.test.ts \
  apps/agent-worker/test/vertical-slice-executor.integration.test.ts && \
pnpm --filter @remoteagent/test-evidence typecheck && \
pnpm --filter @remoteagent/git-lifecycle typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Evidence (`2026-08-26`):**

- Baseline jest opaque `BaselineWorkspaceReference`, tworzony przed pierwszym model-facing write,
  w deterministycznym katalogu poza authoritative worktree. Manifest wiąże case/workspace/run/
  revision/slice/attempt oraz digest canonical authority; nowa instancja store odzyskuje dokładnie
  ten sam snapshot. Digest jest sprawdzany po copy, przy recovery oraz bezpośrednio przed bounded
  cleanup po durable append artifactu. Gate return nie usuwa snapshotu: crash przed append może
  wejść w exact replay i odzyskać durable receipts bez ponownego dispatchu. Cleanup usuwa tylko
  duże tree, zachowuje manifest-tombstone i jest exact-bound oraz idempotentny. Root i nested
  `.git`/symlink escape są fail-closed.
- Actual evidence powstaje z porównania leaf bytes/types/modes baseline→current. Exact delta jest
  sprawdzany względem `allowed_paths`, porównywany ze strict untrusted `changed_files`, a po fresh
  fence stage'owany przez `GitLifecycle`; dzięki temu diff obejmuje untracked files. Cumulative
  prior paths są jawnie server-owned, a obcy Git status zatrzymuje wykonanie.
- Gate stage wiąże exact lease owner/token oraz payload case/work-unit/run, wybiera dokładnie
  `SliceContract.gate_ids` z code-owned catalogu i używa istniejącego
  `executeVerificationGateBatch`. Baseline jest przekazywany tylko gate'om, które go wymagają;
  failed/incomplete/PASS-without-bound-bundle zwracają `BLOCKED`, nigdy review-ready evidence.
- Git spawn ma świeży pusty HOME poza targetem, `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, a diff ma
  `--no-ext-diff`; target-controlled `.gitconfig` i local external diff nie uruchomiły canary.
- Przed dokładną bramką przebudowano publiczne `dist` `test-evidence` i `git-lifecycle`, oba exit
  code `0`. Dokładna komenda WU powyżej: exit code `0`; Vitest `67/67` w `5/5` plikach, realny
  PostgreSQL wymagany przez `RA_REQUIRE_POSTGRES=1`; typecheck `test-evidence`, `git-lifecycle` i
  `agent-worker`: każdy exit code `0`.
- `pnpm format`: exit code `0`; `git diff --check`: exit code `0`.
- Mutation snapshot przeniesiony po implementacji: RED exit `1`, two-slice E2E zatrzymał false
  zero-delta. Mutation slice 2 na initial source: RED exit `1`, opaque binding odrzucił obcy
  authority zamiast zaakceptować base repo. Mutation wyłączająca baseline digest comparison: RED
  exit `1`, tamper test zaakceptował zmienione bytes. Po restore final GREEN.
- Mutation pomijająca current-only/untracked leaves: po wymaganym rebuild publicznego `dist` RED
  exit `1`, implementer/actual delta mismatch. Mutation wyłączająca porównanie untrusted reportu:
  RED exit `1`, false `src/claimed.ts` został zaakceptowany dla actual `src/actual.ts`. Po restore
  final GREEN.
- Mutation usuwająca pre-stage fence: RED exit `1`, stale writer zdołał stage'ować untracked file.
  Mutation unconditional `baseline_root`: RED exit `1`, RA-042 odrzucił unused baseline dla gate
  bez baseline. Mutation wyłączająca exact work-unit lease guard: RED exit `1`, foreign work unit
  wykonał gate. Mutation ukrywająca nested `.git`: RED exit `1`, delta stał się fałszywie pusty.
  Mutation wyłączająca łącznie isolated HOME/global config/`--no-ext-diff`: RED exit `1`, target
  external diff przejął obserwację. Po każdej mutacji przywrócono kod i final GREEN.
- Mutation gate `inspect` → destructive `consume`: RED exit `1`, restart po PASS nie mógł odzyskać
  receipts, bo baseline zniknął przed durable stage artifact. Mutation wyłączająca exact reference
  check cleanupu: RED exit `1`, obcy tree digest usunął prawidłowy baseline. Po restore test nowej
  instancji store potwierdził PASS replay bez wzrostu `engineering_operations`, obecność baseline do
  jawnego cleanupu, `CLEANED` → `ALREADY_CLEANED` oraz odmowę foreign binding/reference.

## Ustalenia wejściowe dla WU-03

- `VerticalSliceGateResult.status === "PASS"` jest jedynym wejściem review. Reviewer dostaje
  `actual.patch`, exact `treeDigest`/`diffDigest` oraz nie-null `EvidenceBundle`; nie dostaje host
  path baseline ani implementer tools.
- Review ma pozostać pre-commit i fresh. Nie wolno syntetyzować SHA ani użyć post-commit
  `ReviewResolution`; correction wraca jako runtime directive dla tego samego slice i nowego
  attemptu.
- Baseline nie jest sprzątany przez gate executor. Composition może wywołać exact idempotent
  `BaselineWorkspaceStore.cleanup(...)` dopiero po potwierdzeniu durable appendu zwróconego
  `EvidenceBundle`/terminal artifactu. Correction attempt tworzy nowy baseline z aktualnego drzewa,
  a `priorAgentPaths` musi pochodzić z poprzedniego server-owned `actual`, nie z modelu.

## RA-043-WU-03 — Fresh pre-commit review i correction loop

**Status:** DONE

**Rezultat:** osobna pre-commit granica review ocenia wyłącznie fresh actual diff/tree/evidence i
zwraca deterministyczną dyspozycję do runtime-owned correction loopu.

**Allowed paths:**

- `packages/review-loop/src/contracts.ts`
- `packages/review-loop/src/pre-commit.ts`
- `packages/review-loop/src/index.ts`
- `packages/review-loop/test/review.integration.test.ts`
- `packages/review-loop/test/pre-commit.integration.test.ts`
- `apps/agent-worker/src/vertical-slice-executor.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `apps/agent-worker/package.json`
- `pnpm-lock.yaml`
- `docs/work-units/RA-043/WORK_UNITS.md`

**Wymagane dowody:** reviewer jest nową sesją i nie ma write tools; request wiąże exact diff/tree i
EvidenceBundle, rozróżnia digest surowego patcha od server-owned actual diff digest i ponownie
obserwuje worktree pod fence przed oraz po model call; BLOCKER/HIGH/MEDIUM nie może dać PASS;
finding znika tylko po świeżym review zmienionego diffu. Dedykowany review executor raportuje realne
`modelCalls` i nie wpada w generic model stage. Correction zachowuje slice i zwiększa attempt, a
no-progress/oscillation/limit pozostają wyłącznie w istniejącym `SupervisorRuntime` — ten unit nie
tworzy drugiej pętli. Mutation RED→GREEN dla write toola, stale context/diff/bundle, PASS przy MEDIUM,
reuse sesji, zaniżenia `modelCalls` i odłączenia production review route.

**Komenda weryfikacyjna:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/review-loop/test/review.integration.test.ts \
  packages/review-loop/test/pre-commit.integration.test.ts \
  apps/agent-worker/test/vertical-slice-executor.integration.test.ts \
  apps/agent-worker/test/engineering-workflow.integration.test.ts && \
pnpm --filter @remoteagent/review-loop typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Evidence (`2026-08-26`):**

- `review-loop` ma osobny strict `PreCommitReviewOutput`: model nie może podać `finding_id`.
  Load-bearing ID jest wyliczany przez serwer wyłącznie ze stabilnej lokalizacji; modelowe summary
  i severity nie zmieniają identity. BLOCKER/HIGH/MEDIUM blokują, LOW/NIT nie blokują, a
  `lines_examined=0` jest fail-closed.
- Jednorazowa granica `executeFreshPreCommitReview` nie ma pętli ani fix callbacku. Wymaga nowego
  obiektu sesji, exact surface `sessionId/toolNames/review`, pustych `toolNames`, co najmniej jednego
  realnego model completion oraz ponownej obserwacji actual przed i po callu. Wiąże osobno digest
  surowych bytes patcha, server-owned actual diff digest, tree digest oraz oczekiwany digest
  kompletnego `EvidenceBundle`.
- `executeVerticalSliceReview` odzyskuje authoritative workspace i per-attempt baseline, wiąże exact
  case/work-unit/run/lease/fence, re-obserwuje Git/tree pod świeżym fence przed i po model call oraz
  tworzy pre-commit `ReviewDecision`. Blocking records zachowują server-derived ID, lokalizację,
  severity, summary i required fix; `SupervisorRuntime` nadal sam interpretuje `CORRECT_SLICE` i
  zwiększa attempt.
- `SLICE_REVIEW` ma jawny `reviewExecutor`; generic stage executor nie jest fallbackiem. Brak route
  daje durable `TerminalReason` z `modelCalls=0`, a connected route wiąże własne config/schema
  digests i odrzuca artefakt raportujący zero model calls. Bedrock session factory tworzy fresh ID,
  wysyła wyłącznie bieżący request i jawne `tools: []`.
- Przed dokładną bramką przebudowano publiczne `dist` `@remoteagent/review-loop`: exit code `0`.
  Dokładna komenda WU: exit code `0`; Vitest `56/56` w `4/4` plikach z realnym PostgreSQL wymaganym
  przez `RA_REQUIRE_POSTGRES=1`; typecheck `review-loop` i `agent-worker`: każdy exit code `0`.
  `pnpm format` i `git diff --check`: exit code `0`.
- Mutation tools guard `toolNames.length !== 0` → niemożliwy warunek: RED exit `1`, write tool
  przeszedł do sesji. Mutation usuwająca bounded pre/post re-observation: RED exit `1`, reviewer
  zaakceptował workspace po utracie fence. Po restore oba GREEN.
- Mutation wyłączająca porównanie actual patch/diff/tree: RED exit `1`; mutation wyłączająca
  expected `EvidenceBundle` digest: RED exit `1` na bundle z zachowanym tree/diff, ale zmienionym
  itemem. Po restore GREEN.
- Mutation usuwająca MEDIUM z blocking set: RED exit `1`; mutation wyłączająca fresh-session
  WeakSet: RED exit `1`; mutation akceptująca `modelCalls=0`: RED exit `1`; mutation kierująca
  disconnected review do generic executora: RED exit `1`. Po każdej przywrócono kod i końcowa
  bramka była GREEN.
- Mutation wyłączająca wymóg zmiany bytes patcha przed wyczyszczeniem poprzedniego blocking
  findingu: RED exit `1`; fresh clean review niezmienionego diffu został odrzucony dopiero po
  przywróceniu guardu.
- Correction Sol pre-audit: sam `WeakSet<object>` pozwalał nowemu wrapperowi ukryć reuse tej samej
  provider session. Dodano procesowy `Set<string>` consumed session IDs. Dwa różne obiekty z tym
  samym `sessionId` są odrzucane przed review. Mutation usuwająca ID guard przy zachowanym WeakSet:
  RED exit `1`; po przywróceniu final GREEN.
- Ustalenie dla WU-04: commit może konsumować tylko durable PASS review. Pole
  `ReviewDecision.reviewed_digest` jest exact digestem bytes patcha (dzięki temu correction musi
  zmienić patch), a `decision_id` pochodzi z composite digestu raw patch/actual diff/tree/evidence
  bundle. `VerticalSliceGateResult.bundleDigest` jest server-derived receipt handoffu; caller nie
  może ponownie wyliczyć go z później zmienionego bundle i nazwać tamperu PASS. Composition musi
  przekazać correction jako `previousBlockingRawPatchDigest` wyłącznie z poprzedniego durable
  `ReviewDecision.reviewed_digest`; jego brak przy zwykłym następnym slice jest prawidłowy.

## RA-043-WU-04 — Evidence-bound local commit i recovery

**Status:** DONE

**Rezultat:** `LOCAL_COMMIT` tworzy dokładnie jeden lokalny commit po finalnym PASS, wiąże go z
actual evidence i jednoznacznie reconciliuje crash bez drugiego commita.

**Allowed paths:**

- `packages/git-lifecycle/src/contracts.ts`
- `packages/git-lifecycle/src/lifecycle.ts`
- `packages/git-lifecycle/src/index.ts`
- `packages/git-lifecycle/test/lifecycle.integration.test.ts`
- `packages/contracts/src/engineering-workflow.ts`
- `packages/contracts/test/engineering-workflow.test.ts`
- `packages/contracts/test/schema-snapshot.test.ts`
- `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `apps/agent-worker/src/vertical-slice-executor.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `docs/work-units/RA-043/WORK_UNITS.md`

**Wymagane dowody:** przed `STARTED` istniejący `job_intents.descriptor` trwale wiąże exact branch,
expected parent, exact paths, deterministyczny message+operation marker, tree digest, server actual
diff digest, osobny raw-patch digest, ordered evidence/review digests oraz final-verification digest.
Exact allowed paths są staged pod świeżym fence bezpośrednio przed `git add`, a drugi fresh fence
jest bezpośrednio przed `git commit`; cached path set i patch odpowiadają descriptorowi. Receipt ma
jawny `review_digest`, zaś evidence tree/diff/review/verification zgadza się z commitem. Hooks,
fsmonitor, executable filters, GPG i global/system/local executable config są fail-closed lub
nadpisane bezpiecznymi highest-precedence values, a HOME jest poza targetem. Recovery dla
`STARTED`/brak artifactu wyłącznie obserwuje exact HEAD: matching commit syntetyzuje receipt i
naprawia completion/observation bez kolejnego `git commit`; HEAD==parent lub jakakolwiek niezgodność
pozostaje `AMBIGUOUS`. Artifact bez completion także jest idempotentnie potwierdzany przed
`RECOVERED`. Push/MR/merge są strukturalnie nieosiągalne. Mutation RED→GREEN dla stale fence przed
add/commit, repo-controlled hooks/config/filter, extra staged path, mismatched evidence/review,
powtórnego commita po crashu i poszerzenia allowlisty Git.

**Komenda weryfikacyjna:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/contracts/test/engineering-workflow.test.ts \
  packages/contracts/test/schema-snapshot.test.ts \
  packages/git-lifecycle/test/lifecycle.integration.test.ts \
  packages/database/test/engineering-control-plane.integration.test.ts \
  apps/agent-worker/test/vertical-slice-executor.integration.test.ts \
  apps/agent-worker/test/engineering-workflow.integration.test.ts && \
pnpm --filter @remoteagent/contracts typecheck && \
pnpm --filter @remoteagent/git-lifecycle typecheck && \
pnpm --filter @remoteagent/database typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Evidence (`2026-08-26`):**

- `job_intents.descriptor` jest strict `GitEvidenceBoundCommitDescriptor`, zapisanym przez istniejące
  `bindOperationIntent` przed `STARTED`. Wiąże exact operation/case/work-unit/workspace/repository/
  run/revision, branch i parent, posortowane ścieżki, deterministyczny message z operation markerem,
  tree/actual-diff/raw-patch, ordered accepted EvidenceBundle+PASS ReviewDecision pairs oraz finalny
  `VERIFIED` digest. Port sam wyprowadza te pary z ordered durable rows; executor nie może ich
  zadeklarować ani podmienić. `LocalCommitReceipt` ma wymagany `review_digest`, a normal execute i
  recovery porównują każde pole receiptu z durable deskryptorem przed append/RECOVERED.
- Correction zachowuje latest `SliceContract.slice_id`, ale accepted attempt pochodzi z exact
  wspólnego `stage_attempt` EvidenceBundle i PASS ReviewDecision. Regression przechodzi sekwencję
  SliceContract attempt 1 → correction Evidence/Review attempt 2 → LOCAL_COMMIT i dowodzi, że w
  deskryptorze jest attempt 2. To naprawia finding pre-audytu: wcześniejsze związanie attemptu z
  wierszem SliceContract odrzucałoby prawidłową correction, bo runtime nie powtarza SLICE_PLANNING.
- `GitLifecycle.commitEvidenceBound` sprawdza exact current branch/parent/status/path set, wykonuje
  fresh fence bezpośrednio przed `git add` i drugi fresh fence jako ostatni await przed `git commit`,
  a cached names/raw patch muszą odpowiadać deskryptorowi. Untracked paths są objęte przez exact add.
  Recovery tylko obserwuje branch/HEAD/parent/exact message+marker/parent delta i nigdy nie wywołuje
  commit. Matching candidate syntetyzuje receipt, appenduje artifact i naprawia completion oraz
  observation; HEAD==parent albo mismatch pozostaje `AMBIGUOUS`. Testy pokrywają STARTED/no artifact
  oraz artifact/no completion, z licznikiem zewnętrznego commita równym dokładnie `1`.
- Każde wywołanie Git ma pusty HOME, wyłączone global/system config i highest-precedence,
  server-owned `GIT_CONFIG_COUNT`: izolowany hooksPath, `core.fsmonitor=false`, signing off. Exact
  `git check-attr` odkrywa tylko filter drivers użyte przez commit paths, a ich process/clean/smudge/
  required dostają bezpieczne nadpisanie; nieobsługiwana identity filtra kończy operację fail-closed.
  `log` i `check-attr` mają exact argv guardy. Wszystkie obserwacje diff używane dla actual/cached/
  recovery evidence mają `--no-ext-diff` i `--no-textconv`. Realny canary z repo-local hooksPath,
  fsmonitor, clean/smudge/process+required, GPG, diff.external oraz `.gitattributes diff=evil` +
  `diff.evil.textconv` nie uruchomił żadnego target-controlled executabla; recovery obserwuje ten sam
  commit bez wykonania canary. Osobny canary z `filter=evil/slash` dowodzi odmowy przed diff/stage.
  Pierwsza hipoteza `GIT_CONFIG=/dev/null` została odrzucona przez RED/hang canary i nie pozostała w
  kodzie.
- Finding pre-audytu w bieżącym tasku: modelowy `SliceContract.gate_ids` mógł pominąć silniejszy
  required gate i uzyskać PASS na podzbiorze. Naprawiono przed dispatch: exact equality z wszystkimi
  code-owned required IDs, plus duplicate/extra/nonrequired refusal. Multi-required regression
  pomijający `security` odmawia przed command/engineering operation/EvidenceBundle.
- Przed finalną bramką przebudowano publiczne `dist` `contracts` i `git-lifecycle`, oba exit `0`.
  Dokładna komenda WU: exit `0`; Vitest `102/102` w `6/6` plikach, realny PostgreSQL wymagany przez
  `RA_REQUIRE_POSTGRES=1`; typecheck `contracts`, `git-lifecycle`, `database`, `agent-worker`: każdy
  exit `0`. `pnpm format` i `git diff --check`: exit `0`.
- Mutation usuwająca exact all-required gate equality: RED exit `1`, pominięty required gate
  wytworzył fałszywy PASS EvidenceBundle. Mutation hardcodująca accepted correction attempt na `1`:
  RED exit `1`, descriptor stracił attempt `2`. Po restore GREEN.
- Mutation usuwająca fresh pre-add fence: RED exit `1`, stale writer utworzył commit; osobna mutacja
  usuwająca pre-commit fence: RED exit `1`, commit powstał mimo odmowy fence. Mutation usuwająca
  highest-precedence hooksPath: RED exit `1`, target post-commit utworzył canary. Po restore GREEN.
- Mutation kierująca recovery do `execute` zamiast read-only `recover`: RED exit `1`, drugi commit
  path został wywołany po crashu. Mutation usuwająca exact `review_digest` receipt binding: RED exit
  `1`, tampered artifact został błędnie odzyskany. Mutation usuwająca wymagane pole `review_digest`
  z kontraktu: RED exit `1`. Mutation dodająca `push` do Git allowlist: RED exit `1`. Po każdej
  mutacji przywrócono kod i finalna bramka była GREEN.
- Mutation usuwająca `--no-textconv` z actual patch observation: RED exit `1`, repo-local
  `diff.evil.textconv` wykonał canary mimo `--no-ext-diff`. Mutation zmieniająca fail-closed invalid
  filter identity na ciche pominięcie: RED exit `1`, `filter=evil/slash` został zaakceptowany zamiast
  odmowy. Po restore targeted Git suite `34/34`, a pełna bramka WU `102/102` była GREEN.

## Ustalenia wejściowe dla WU-05

- Production composition ma wstrzyknąć dedykowany `EngineeringLocalCommitStageExecutor`; generic
  `executeSystemStage` nie obsługuje LOCAL_COMMIT. Jego `prepare` dostaje wyłącznie server-derived
  provenance, zwraca deskryptor z aktualnego durable vertical-slice state, `execute` deleguje do
  `executeEvidenceBoundLocalCommit`, a `recover` do `recoverEvidenceBoundLocalCommit`.
- WU-05 musi zachować `VerticalSliceActualEvidence` i accepted gate/review handoffy jako trwałe
  artifacts/odtwarzalny stan composition; `priorAgentPaths` nie może pochodzić z modelu.
- Właściwym kontraktem jest nowy strict, server-owned `SliceImplementationReceipt`: exact
  case/run/revision/slice/attempt/workspace/repository/base SHA/branch, opaque baseline ref,
  sorted unique `changed_files` i `cumulative_agent_paths` (`changed ⊆ cumulative`), tree digest,
  actual diff digest, raw-patch digest, statystyki oraz ordered durable tool receipt digests. Nie
  zawiera host path, patch bytes ani modelowego reportu. Nie wymaga migracji — istniejący artifact
  ledger przechowuje strict union JSONB.
- `SLICE_IMPLEMENTATION` ma dedykowany executor z realnym `modelCalls`; generic system executor nie
  może nadal ukrywać modelowego implementera jako `0` calls. Gate/review/commit ładują exact receipt
  tego attemptu z ordered artifact rows, bez process-memory maps.
- Baseline cleanup pozostaje dopiero po durable append gate/review handoffu. Commit nie sprząta
  baseline i nie ma żadnej osiągalnej operacji push/MR/merge.

## RA-043-WU-05 — Produkcyjny composition root i dwuslice E2E

**Status:** DONE

**Rezultat:** produkcyjny worker składa istniejący `SupervisorRuntime`, system executor, workspace,
gate runner, reviewer i GitLifecycle; real-PG/real-Git E2E przechodzi dwa slice'y i tworzy jeden
lokalny commit bez zewnętrznego publish.

**Allowed paths:**

- `apps/agent-worker/src/engineering-execution.ts`
- `apps/agent-worker/src/worker.ts`
- `apps/agent-worker/src/handlers.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/src/workspace-config.ts`
- `apps/agent-worker/src/vertical-slice-executor.ts`
- `apps/agent-worker/src/index.ts`
- `apps/agent-worker/package.json`
- `apps/agent-worker/test/engineering-execution.integration.test.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
- `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
- `apps/agent-worker/test/workspace-config.test.ts`
- `packages/contracts/src/engineering-workflow.ts`
- `packages/contracts/src/schema.ts`
- `packages/contracts/test/engineering-workflow.test.ts`
- `packages/contracts/test/schema-snapshot.test.ts`
- `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- `packages/agent-orchestrator/src/context/source-policy.ts`
- `packages/agent-orchestrator/src/engineering/registry.ts`
- `packages/agent-orchestrator/src/engineering/workflow.ts`
- `packages/agent-orchestrator/test/engineering-registry.test.ts`
- `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
- `packages/workspace-runner/src/git.ts`
- `packages/workspace-runner/src/index.ts`
- `packages/workspace-runner/test/worktree.integration.test.ts`
- `pnpm-lock.yaml`
- `docs/work-units/RA-043/WORK_UNITS.md`

**Wymagane dowody:** strict `SliceImplementationReceipt` jest jedynym trwałym handoffem
implementation→gate→review→commit i wiąże slice/attempt/workspace/repo/base/branch, opaque baseline,
actual tree/diff/raw-patch, exact changed+cumulative paths oraz durable tool receipt digests; nie
zawiera host path, raw patcha ani modelowego reportu. Każdy kolejny stage rekonstruuje stan wyłącznie
z ordered artifact rows i ponownie obserwuje repo. Dedykowany implementation executor raportuje
realne `modelCalls`; generic zero-call system route obsługuje tylko gate, a review/local commit mają
własne porty. Lease heartbeat obejmuje cały przebieg. Slice 1 przechodzi correction attempt 2 i
fresh PASS, potem slice 2 kończy implement/evidence/gates/fresh review; baseline slice'a jest
sprzątany idempotentnie dopiero po durable ReviewDecision/terminal artifact, także po recovery.
Server-owned config gate/artifact/repo jest strict, wskazany absolutną deployment path i fail-closed,
a base branch jest pinowany do exact SHA tylko przy tworzeniu workspace; resume używa durable SHA.
Final verification poprzedza dokładnie jeden commit; restart na granicach STARTED/receipt/artifact
nie replayuje efektu. Produkcyjny worker rzeczywiście wstrzykuje wszystkie executory; implementer
widzi dokładnie siedem bounded tools bez `command`, reviewer `tools: []`, wszystkie code-owned
required gates są obowiązkowe, a push/MR/merge nie jest osiągalne. Mutation RED→GREEN dla odłączenia
każdego production route, process-memory zamiast durable receipt, zaniżenia modelCalls, reportu
zamiast actual, wcześniejszego cleanup, pominięcia required gate, session reuse, command tool,
stale fence, correction związanej z attemptem SliceContract i drugiego commita po recovery.

**Komenda weryfikacyjna:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/contracts/test/engineering-workflow.test.ts \
  packages/contracts/test/schema-snapshot.test.ts \
  packages/agent-orchestrator/test/engineering-registry.test.ts \
  packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts \
  packages/workspace-runner/test/worktree.integration.test.ts \
  apps/agent-worker/test/workspace-config.test.ts \
  apps/agent-worker/test/engineering-execution.integration.test.ts \
  apps/agent-worker/test/engineering-workflow.integration.test.ts \
  apps/agent-worker/test/vertical-slice-executor.integration.test.ts \
  apps/agent-worker/test/vertical-slice-e2e.integration.test.ts && \
pnpm --filter @remoteagent/contracts typecheck && \
pnpm --filter @remoteagent/agent-orchestrator typecheck && \
pnpm --filter @remoteagent/workspace-runner typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Evidence (`2026-08-26`):**

- Dodano strict, `SERVER_OWNED` `SliceImplementationReceipt` jako jedyny trwały handoff po
  implementacji. Receipt wiąże exact case/work-unit/run/revision/slice/attempt, workspace/repo,
  pin `base_sha`, canonical branch, opaque baseline, tree/diff/raw-patch digests, sorted
  changed+cumulative paths, statystyki i ordered tool-receipt digests. Schema odrzuca host paths,
  niesortowane/obce paths i niespójne statystyki; registry oraz snapshot kontraktów obejmują nowy
  artifact i stage I/O.
- Produkcyjny `engineering-execution` składa istniejący `SupervisorRuntime` z czterema osobnymi
  routes: modelowy implementation executor, zero-model gate executor, fresh tools-disabled reviewer
  i descriptor-first local commit executor. Generic executor nie obsługuje implementation/review/
  commit. Każdy późniejszy stage odtwarza stan z ordered PostgreSQL artifact rows i świeżej
  obserwacji Git, bez map model-reportów albo process-memory handoffu.
- Deployment config jest strict i ładowany wyłącznie z absolutnego
  `RA_ENGINEERING_CONFIG_PATH`; authoritative repository `sourcePath` oraz canonical
  workspace/baseline/artifact roots są pairwise disjoint w obu kierunkach, więc żaden writable root
  nie może zawierać source clone ani leżeć w nim. Repo ID i exact single-entry work-unit allowlist są
  sprawdzane fail-closed, a gate executables muszą należeć do code-owned catalogu. `baseBranch` jest
  read-only rozwiązywany do exact SHA tylko przy create; resume używa durable SHA. Wszystkie Git
  spawny ignorują user/system config.
- Implementer dostaje dokładnie `read/search/tree/config/write/patch/mkdir`, bez `command`; reviewer
  dostaje `tools: []`. Versioned model report jest jawnie projektowany do starego strict untrusted
  `{changed_files}`, po czym porównywany z server-observed actual; nie trafia do receiptu.
- Real-PG/real-Git/scripted-transport E2E wykonał slice 1 `MEDIUM -> correction attempt 2 -> PASS`,
  następnie slice 2 (`attempt 3`) `PASS`, final `VERIFIED` i dokładnie jeden lokalny commit. Durable
  receipts mają mapowanie attempts `[1,2,3] -> [slice-1,slice-1,slice-2]`, review decisions
  `[CHANGES_REQUIRED,PASS,PASS]`; source repo pozostało wyłącznie na `main`, bez push/MR/merge.
  Fresh production port odzyskał `LOCAL_COMMIT` z artifactu bez nowego model requestu i bez drugiego
  commita; ponowny handler także nie dodał requestu ani commita.
- Recovery artifact-only dla implementation/review idempotentnie naprawia brak queue completion i
  `COMPLETION_OBSERVED`, bez executor/model replay. Cleanup baseline następuje dopiero po durable
  `ReviewDecision`; dla `TerminalReason` jest wywoływany wyłącznie na gate/review z exact
  same-attempt `SliceImplementationReceipt`. Recovered terminal bez receiptu także naprawia
  completion/observation, lecz nie woła cleanupu ani modelu. Cleanup zachowuje idempotentny
  tombstone.
- Dokładna komenda WU powyżej po restore: exit code `0`; Vitest `75/75` w `10/10` plikach z realnym
  PostgreSQL (`RA_REQUIRE_POSTGRES=1`); typecheck `contracts`, `agent-orchestrator`,
  `workspace-runner`, `agent-worker`: każdy exit code `0`. Targeted production E2E po finalnym
  recovery rozszerzeniu: exit code `0`, `1/1`. Prettier dla allowed paths i `git diff --check`:
  exit code `0`.
- Production composition mutations, każda RED exit code `1`, następnie restore: osobne odłączenie
  implementation/review/gate/local-commit route; zastąpienie durable receiptu process-state
  `EngineeringPhase`; pominięcie required gate w modelowym SliceContract; cleanup baseline przed
  durable artifact; fałszywy model report `src/claimed.ts` zamiast actual; wybór pierwszego zamiast
  najnowszego ordered SliceContract (utrata correction/slice binding); dodanie `command` do tools.
- Runtime/recovery mutations, każda RED exit code `1`, następnie restore: dopuszczenie
  implementation artifactu z `modelCalls=0` oraz pominięcie naprawy completion/observation po
  artifact-only crash. Pre-audit mutations: pominięcie `sourcePath` w pairwise disjoint guard
  pozwoliło `artifact_root` wewnątrz source clone i dało RED exit `1`; pominięcie exact-receipt guard
  wywołało cleanup dla recovered gate terminala bez receiptu i dało RED exit `1`. WU-02/WU-03/WU-04
  powyżej zachowują load-bearing RED evidence dla stale fence, session reuse i skierowania crash
  recovery do drugiego commit path; finalna bramka WU-05 ponownie uruchomiła odpowiadające im testy
  na przywróconym stanie.
- Pierwsza pełna bramka taska zatrzymała się na `pnpm lint`, exit code `1`:
  `packages/contracts/test/engineering-workflow.test.ts:303` przypisywał nieużywane `_removed` przy
  budowie fixture bez `review_digest`. Test zachowuje tę samą semantykę przez jawny `Partial` copy i
  `delete`. Po korekcie scoped ESLint dla pliku: exit code `0` (wyłącznie istniejące warningi
  migracyjne `boundaries`); targeted contracts Vitest `11/11`: exit code `0`; contracts typecheck:
  exit code `0`; `git diff --check`: exit code `0`.

## Pełna bramka taska

Po `WU-05`, przed audytem i zmianą statusu, uruchomiono:

```sh
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && \
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && \
pnpm workflow:validate && git diff --check
```

**Wynik (`2026-08-26`):** pełny łańcuch exit code `0`: lint `0` (wyłącznie znane warningi
`boundaries`), format `0`, wymuszony build `26/26` i `0 cached`, Vitest z
`RA_REQUIRE_POSTGRES=1` exit `0`, wymuszony typecheck `40/40` i `0 cached`,
`workflow:validate OK — 45 tasks`, `git diff --check` exit `0`. Niezależny rerun Vitest z krótkim
reporterem: `211/211` plików, `2697/2697` testów, exit `0`.

Audyt odczytał pełny diff od bazowego commita, rozliczył osobno każde AC i potwierdził, że ścieżka
production nie importuje publish/push/MR/merge. Nie pozostał finding BLOCKER, HIGH ani MEDIUM i nie
powstał nowy finding przekrojowy do `CROSS_TASK_FINDINGS.md`.

## Wejście dla RA-044

- Kwalifikować istniejący production composition root; nie tworzyć drugiego workflow drivera ani
  drugiego ledgeru.
- Odtworzyć pełną macierz crash/recovery oraz dwa równoległe cases z realnym PostgreSQL i Git.
- Utrzymać rozdział authority: model nie wybiera required gates, repo scope, branch, executable ani
  commit paths; wszystkie side effects pozostają exact-fenced.
- iOS/Xcode/live Bedrock pozostają RA-045. RA-044 kwalifikuje core lokalnie i nie może uzależnić PASS
  od zewnętrznego środowiska.
