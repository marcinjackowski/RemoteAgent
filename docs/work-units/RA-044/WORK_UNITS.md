# RA-044 — Work Units

- Task: `RA-044` Kwalifikacja core Engineering Control Plane
- Bazowy commit: `458a0e938172655159462ea6fd33277ec10198f0`
- Status taska: `IN_PROGRESS`
- Proces: `ADR-0007`; Sol planuje/audytuje i uruchamia pełną bramkę, Luna implementuje wyłącznie
  jawnie przydzielony unit. Raport implementera nie zastępuje bramki.

## Ustalenia wejściowe

- Kwalifikujemy wyłącznie istniejącą ścieżkę produkcyjną
  `worker -> createWorkerHandlers -> SupervisorRuntime -> createProductionEngineeringRuntimePort`.
  Fake może zastąpić transport modelu, reviewer session i code-owned gate executable; nie może
  zastąpić drivera, Postgresa, Git/worktree, control plane ani stage routing.
- RA-044 nie tworzy drugiego orchestratora, journala, workspace layer, gate runnera ani review loopu.
- Dwa znalezione przed implementacją punkty muszą dostać najpierw load-bearing RED:
  1. durable cancellation istnieje w ledgerze, lecz production session ma dziś stałe
     `cancelled: false` i nie odświeża jej pomiędzy etapami;
  2. production no-progress/oscillation musi zostać dowiedzione na rzeczywistych ordered artifacts,
     ponieważ unitowe fakes nie dowodzą poprawnej tożsamości structural fingerprint.
- Każdy scenariusz PostgreSQL ma `RA_REQUIRE_POSTGRES=1`. Fixture używa throwaway repo i katalogów
  tymczasowych, nie repozytorium źródłowego RemoteAgent.
- `AMBIGUOUS` ma pierwszeństwo przed cancellation/deadline/lease loss, jeżeli rozpoczęty mutujący
  efekt nie ma pewnego receiptu.
- iOS/Xcode/live Bedrock, push, MR i merge pozostają poza zakresem (RA-045 lub osobna zgoda).

## WU-00 — Dynamic control state i produkcyjna tożsamość postępu

**Status:** DONE

**Rezultat:** `SupervisorRuntime` odczytuje durable cancellation przed każdym kolejnym etapem i
kończy czysty przebieg jako `CANCELLED`, ale zachowuje `AMBIGUOUS` dla rozpoczętego niepotwierdzonego
write. Structural fingerprints liczą wyłącznie rzeczywisty stan projektu/evidence/findings i
production path rzeczywiście osiąga `NO_PROGRESS`/`OSCILLATION` bez sztucznego postępu od ledgerowych
attempt/revision. Wspólny real-composition qualification harness powstaje w `WU-01`, gdzie jest
pierwszym konsumentem wszystkich stage routes.

**Allowed paths:**

- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `packages/agent-orchestrator/src/engineering/workflow.ts`
- `packages/agent-orchestrator/src/supervisor/runtime.ts`
- `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `docs/work-units/RA-044/WORK_UNITS.md`

**Weryfikacja:**

```sh
. scripts/dev/env.sh && pnpm --filter @remoteagent/database build && \
pnpm --filter @remoteagent/agent-orchestrator build && \
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/database/test/engineering-control-plane.integration.test.ts \
  packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts \
  apps/agent-worker/test/engineering-workflow.integration.test.ts && \
pnpm --filter @remoteagent/database typecheck && \
pnpm --filter @remoteagent/agent-orchestrator typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Wymagane mutacje RED→GREEN:** static `cancelled:false`; brak re-checku między stages;
cancellation wygrywająca z unknown write; monotonic attempt/revision w fingerprint; usunięcie
no-progress oraz oscillation guard.

**Evidence (`2026-08-26`):**

- `EngineeringRuntimePort.readControlState()` jest required i odczytywany przed każdym nowym stage,
  ale dopiero po `recoverStage`: STARTED unknown write pozostaje `AMBIGUOUS` przed cancellation.
- `readRunControlState` wiąże exact run/case/owner/checkpoint i czyta cancellation z immutable event
  ledger oraz authoritative case, nie z odbudowywalnej projekcji. Test usuwa
  `engineering_run_projections`, nadal widzi cancellation i blokuje następny STARTED run-wide.
- Structural history jest próbkowana na granicy durable `SLICE_REVIEW`; reconstruction po restarcie
  używa tych samych granic. `designRevisions` zawiera wyłącznie Outcome/System/Program, a
  `sliceRevision` pochodzi z ostatniego SliceContract zamiast bieżącego monotonic attempt.
- Exact gate po restore: exit `0`; Vitest `75/75` w `3/3` plikach z realnym PostgreSQL; build
  database+orchestrator, typecheck database+orchestrator+worker, scoped ESLint, repo format i
  `git diff --check`: exit `0` (tylko znane warningi `boundaries`).
- Mutation RED→GREEN, każda po przywróceniu: wyłączenie dynamic cancellation (`1/21` RED); control
  przed recovery (`1/21` RED, unknown write błędnie nie był AMBIGUOUS); immutable cancellation
  zwracające false po skasowaniu projekcji (`1/37` RED); sampling każdego stage zamiast review
  (`1/21` RED, OSCILLATION zmienione w NO_PROGRESS); monotonic current attempt jako slice revision
  (`2/17` RED, production NO_PROGRESS/OSCILLATION oba CONTINUE); wyłączenie NO_PROGRESS i osobno
  OSCILLATION (`1/21` RED każde). Wszystkie mutacje zostały przywrócone przed finalną bramką.

## WU-01 — SMALL/MEDIUM/LARGE i owner approval przez production composition

**Status:** DONE

**Rezultat:** wspólny harness uruchamia trzy klasy procesu przez realny production port. SMALL ma
baseline-red/current-green; MEDIUM ma co najmniej dwa slices; LARGE_OR_HIGH_RISK wykonuje product,
system i program design oraz nie uruchamia implementation/write przed exact durable, run-scoped
`ApprovalRepository` write grant związanym z pełnym server-derived scope. Każdy modelowy/slice stage ma kompletny sanitizowany `ContextManifest`
w immutable intent descriptor, a każdy zaakceptowany slice exact `EvidenceBundle`.

**Allowed paths:**

- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/src/engineering-execution.ts`
- `apps/agent-worker/src/worker.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `apps/agent-worker/test/engineering-qualification-fixture.ts`
- `apps/agent-worker/test/engineering-qualification-control.integration.test.ts`
- `apps/agent-worker/test/engineering-qualification-risk.integration.test.ts`
- `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
- `packages/database/src/repositories/engineering-context.ts`
- `packages/database/test/engineering-context.integration.test.ts`
- `packages/contracts/src/engineering-workflow.ts`
- `packages/contracts/test/engineering-workflow.test.ts`
- `docs/work-units/RA-044/WORK_UNITS.md`

**Weryfikacja:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  apps/agent-worker/test/engineering-qualification-risk.integration.test.ts \
  apps/agent-worker/test/vertical-slice-e2e.integration.test.ts && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Wymagane mutacje RED→GREEN:** risk downgrade; pominięcie product design; approval z obcego scope;
generic DecisionAnswer/model prose zamiast durable Approval; arbitralny `DesignDecision.artifact_digest` zamiast exact
ProgramDesign; write przed approval; baseline-green zaakceptowany jako test-first PASS; brak
`context_manifest`/manifest digest w intent; snapshot digest zamiast manifest digest w bundle; brak
owner decision ID lub EvidenceBundle.

**Evidence (`2026-08-26`):**

- Shared fixture używa real PostgreSQL, `createEngineeringRoleContextReader`, production runtime
  port, Git workspace/baseline/commit, process gate i pre-commit review; tylko zewnętrzny transport
  modelu jest skryptowany na granicy providera. Worker main i fixture korzystają z jednego factory,
  który zawsze wyprowadza bounded approval candidate z exact durable lease payload.
- SMALL ma exact graph bez System/Program/Approval, baseline `FAILED`, current `PASSED` i complete
  `test_first_evidence`; osobny baseline-green kończy się bez `EvidenceBundle`. MEDIUM ma exact
  System+Program, dwa slices, bundles i fresh PASS reviews. LARGE ma Outcome+System+Program+
  DesignDecision przed pierwszym write; zero model calls/operations/workspace przy braku procesowej
  odpowiedzi albo scoped write grantu, pełny przebieg dopiero po exact durable process answer i
  atomowo skonsumowanym Approval.
- Każdy non-LOCAL stage intent zawiera complete sanitized `context_manifest` i server-derived
  digest; bundle wiąże ten digest i unique+sorted exact verified process decision/Approval IDs.
  LOCAL_COMMIT celowo zachowuje odrębny strict evidence-bound descriptor dla crash reconciliation.
- `DesignDecision.artifact_digest` dostaje w prompt exact latest durable ProgramDesign digest z tej
  samej case/run/checkpoint revision i jest sprawdzany przed append oraz na recovery. Failed re-open
  atomowo unieważnia całą poprzednią sesję i authority. Answered decision z obcej case albo
  checkpoint revision pozostaje odrzucona.
- Approval jest blanket, run-scoped WRITE grantem, a nie dowodem, że owner reviewed konkretny
  ProgramDesign. Live owner review exact ProgramDesign oraz proposal/Discord grant producer nie są
  zaimplementowane w WU-01; kwalifikowany jest consumer/recovery i nie zastępuje ich generic
  DecisionAnswer.
- Snapshot jawnie pomija wyłącznie exact DISCOVERY `ContextManifest` i exact
  SLICE_IMPLEMENTATION receipt jako stage-local provenance; foreign stage/attempt/work unit albo
  checkpoint revision oraz unknown kind pozostają fail-closed.
- Exact WU gate po wszystkich restore: Vitest `4/4` w `2/2` plikach i agent-worker typecheck,
  exit `0`. Dodatkowa regresja po buildach contracts/database/test-evidence: Vitest `46/46` w
  `5/5` plikach; contracts/database/agent-worker typecheck i `git diff --check`, exit `0`.
- Mutation RED→GREEN po każdorazowym restore: risk downgrade (`1/3` RED), cross-stage manifest
  (`1/20`), failed-open session reuse (`1/20`), arbitrary DesignDecision digest (`1/20`), brak
  ContextManifest skip (`1/7`), brak receipt skip (`1/7`), brak checkpoint binding (`1/8`), brak
  work-unit binding receiptu (`1/8`), brak complete manifest (`1/3`), snapshot zamiast manifest
  digest w bundle (`1/3`), usunięte decision IDs (`1/3`) oraz baseline-green zaakceptowany po
  chwilowej mutacji test-evidence (`1/3`).
- Approval mutations po restore: ponowne rozpoznanie `decision_answer` (`1/3` RED), zaufanie
  spoofowanemu payload digest (`1/3`), read-only approval lookup zamiast atomowego consume (`1/3`),
  brak candidate wiring we wspólnym production factory (`1/3`), brak verified Approval ID w bundle
  (`1/3`), brak `POLICY_GRANT` w deterministic design gate (`1/3`), brak current-revision recheck dla
  `ALREADY_CONSUMED` (`1/22`) i brak pełnego resetu failed re-open (`1/22`). Usunięcie każdego z 12
  pól scope digest osobno dawało RED w contract teście (`1/12` każde); wszystkie mutacje przywrócono.

## WU-02 — Macierz crash/restart, deadline, lease loss i recover-not-replay

**Status:** DONE

**Rezultat:** fault-injection matrix obejmuje intent-only, STARTED, efekt/receipt, artifact-only,
completion-only/unobserved oraz projection/restart dla retry-safe model stage, gate command i
LOCAL_COMMIT. Potwierdzone skutki są odzyskiwane bez replay; rozpoczęty mutujący efekt bez pewnego
receiptu pozostaje `AMBIGUOUS`. Deadline, cancellation i lease loss są rozróżnione, a dwa cases mogą
działać równolegle bez drugiego writera w jednym case.

**Allowed paths:**

- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/src/engineering-execution.ts`
- `apps/agent-worker/test/engineering-qualification-fixture.ts`
- `apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `packages/agent-orchestrator/src/supervisor/runtime.ts`
- `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `docs/work-units/RA-044/WORK_UNITS.md`

**Weryfikacja:**

```sh
. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-orchestrator build && \
pnpm --filter @remoteagent/database build && \
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts \
  apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts \
  apps/agent-worker/test/engineering-workflow.integration.test.ts \
  packages/database/test/engineering-control-plane.integration.test.ts && \
pnpm --filter @remoteagent/agent-orchestrator typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Wymagane mutacje RED→GREEN:** replay model/gate/commit po recovered receipt; STARTED/no receipt jako
success; artifact bez completion bez repair; cancellation/deadline maskujące ambiguity; stale lease
przechodzący fresh fence; drugi writer dla tego samego case.

**Evidence (`2026-08-26`):**

- Production composition ma dedykowany `gateExecutor.execute/recover`; exact immutable outer intent
  wiąże pełny `ContextManifest` i self-digest, unique+sorted durable decision IDs z jawnym
  `DURABLE_VERIFIED_ANSWERS`, process class oraz jeden absolutny `deadline_at`. Execute i recovery
  używają tego samego deadline; recovery nie czyta świeżego context packetu.
- Fault injection po durable inner gate receipt, ale przed outer EvidenceBundle append: fresh
  production port odzyskuje bundle, inner operation count pozostaje `1`, a exact inner
  `completion_id` jest identyczny przed/po recovery. Fault injection między inner STARTED i receipt
  pozostawia outer bez artifact i zwraca `AMBIGUOUS`, także po backdate deadline.
- Completion-only bez STARTED/artifact jest `AMBIGUOUS`. Artifact-only naprawia exact completion i
  observation; stale lease bez istniejącego exact completion nie jest połykany. Existing i freshly
  recovered EvidenceBundle są sprawdzane względem pełnego immutable descriptoru, w tym exact
  context digest i decision IDs. TerminalReason pozostaje osobną ścieżką.
- Matrix mapping: retry-safe intent-only i STARTED/no-result — `replays a retry-safe STARTED model
  intent without recording a second STARTED` (exact descriptor collision, 1 STARTED, 1 real model
  invoke); COMMAND STARTED/no receipt — `keeps the outer gate AMBIGUOUS...`; inner receipt/outer
  crash — `recovers durable inner gate receipts...`; artifact-only/completion-only — odpowiednio
  `repairs artifact-only stage completion...` i `does not recover a completion-only gate...`;
  projection deletion — database `rebuilds an identical projection after deletion`; LOCAL_COMMIT
  exactly-one — `binds correction attempt evidence and reconciles a crash without a second commit`.
- Cancellation+deadline priority przechodzi przez realny Supervisor handler: unknown inner write
  pozostaje `AMBIGUOUS` po durable cancel, skasowaniu projekcji i backdate deadline; nowy stage po
  wcześniejszym deadline ma 0 STARTED/0 transport. Dwa realne production handlers różnych cases
  stoją jednocześnie na provider barrier, podczas gdy drugi same-case claim jest `null`.
- Lease matrix: clean loss przed intent jest requeue/reclaim, stale writer nie binduje, fresh writer
  kończy DISCOVERY. Lease loss po model invoke oraz partial inner-success/outer-missing gate idą
  fail-closed do `RECONCILING`; claim jest `null`, stale writer nie appenduje artifact/completion,
  a exact inner completion ID pozostaje trwały. Automatyczne cross-fence continuation jest celowo
  poza WU-02 i wymaga osobnego operational-ingress/recovery taska (RA-047), nie osłabienia JobStore.
- Mutation RED→GREEN po restore: wyłączenie outer gate recovery (`2/2` RED); akceptacja inner
  STARTED/no receipt (`1/1` RED); broad completion catch (`1/1` RED); completion-only replay
  (`1/1` RED); pominięcie EvidenceBundle authority (`1/1` RED); pominięcie full descriptor
  validatora dla GATE TerminalReason (`1/1` RED); usunięcie retry-safe effect-class guard (`1/1`
  RED); wyłączenie LOCAL_COMMIT recovery (`1/1` RED). Wymagane fence/cancel/single-writer mutacje są
  też load-bearing w reużytych database/Supervisor testach tej samej exact bramki. Wszystkie mutacje
  przywrócono.
- Ostatnia dokładna bramka WU: exit `0`; database build, Vitest `71/71` w `3/3` plikach z realnym
  PostgreSQL oraz agent-worker typecheck.
- Niezależna bramka Sol po odczycie diffu: ta sama dokładna komenda, exit `0`; database build,
  Vitest `71/71` w `3/3` plikach z realnym PostgreSQL oraz agent-worker typecheck. Wynik nie pochodzi
  z raportu implementera.
- Korekta pre-audit AC2 usuwa catch-all w `runStage`: wyjątek engineering stage wraca do
  `process()`, który dla skonfigurowanego IMPLEMENTER pozostawia outer run `STARTED` i raportuje
  handlerowi unresolved bez legacy `markAmbiguous`. Dopiero durable `recoverStage = AMBIGUOUS`
  ustawia outer run na `AMBIGUOUS`.
- Load-bearing production handler re-entry po inner gate receipt/outer artifact exception:
  pierwszy pełny handler failuje z outer run nadal `STARTED`; drugi świeży pełny handler/runtime/
  port pod **tym samym nadal ważnym lease** kończy run jako `SUCCEEDED`. Inner gate operation i
  completion pozostają dokładnie po jednym, a exact `completion_id` nie zmienia się. Wariant
  STARTED/no inner receipt pozostawia pierwszy outer run `STARTED`; drugi fresh handler pod tym
  samym lease klasyfikuje go jako `AMBIGUOUS` bez implementation replay, dodatkowej operacji ani
  completion. To dowód naprawy outer safety-state i same-lease re-entry, nie process crash,
  Scheduler fail/reclaim ani cross-fence continuation; te ostatnie pozostają zakresem RA-047.
- Dodatkowe mutation RED→GREEN po obowiązkowym rebuildzie orchestratora: przywrócenie catch-all
  `invokeAndRecord -> AMBIGUOUS` (`2/2` RED) oraz usunięcie engineering exception branch i powrót do
  legacy `markAmbiguous` (`2/2` RED). Pierwszy, świadomie odrzucony przebieg mutacji użył starego
  `dist` i nie jest liczony jako dowód (`CTF-011`). Po restore runtime+recovery suite: `30/30` w
  `2/2`, exit `0`.
- Powtórzona bramka implementera po korekcie: exit `0`; database build, Vitest `73/73` w `3/3`
  plikach z realnym PostgreSQL oraz agent-worker typecheck.
- Niezależna rozszerzona bramka Sol po finalnym diffie obejmowała również świeży build i testy
  `agent-orchestrator`: exit `0`; Vitest `94/94` w `4/4` plikach z realnym PostgreSQL, buildy
  `agent-orchestrator` i `database` oraz typechecki `agent-orchestrator` i `agent-worker` exit `0`.
- Korekta finalnego pre-audytu przeniosła na pełny handler także osiągalne granice intent-only,
  artifact-only, inner gate receipt/outer artifact, LOCAL_COMMIT HEAD reconciliation,
  projection-deleted unknown write i post-invoke lease loss. Dodatkowy synthetic outer
  completion-only/no STARTED/no artifact seed kończy się trwale jako `AMBIGUOUS`, z zerem model,
  gate, workspace, commit i run-completion writes. Mutacje wyłączające artifact recovery,
  completion-only guard, inner receipt recovery, LOCAL_COMMIT reconciliation i retry-safe
  intent-only recovery każda dała RED i została przywrócona.

## WU-03 — Adwersarialna izolacja, policy i odtwarzalny trace

**Status:** DONE

**Rezultat:** malformed/mismatched output, foreign case/owner/integration, stale tree/config evidence,
failed/missing required gate i prompt injection próbująca poszerzyć repo/path/tool/gate policy są
odrzucane fail-closed. Z durable tabel można odtworzyć ordered trace po
`case_id/run_id/op_id/stage/attempt` bez chain-of-thought; telemetry nie zawiera treści promptu,
host paths ani sekretów.

Ten unit domyka trzy load-bearing granice jednym źródłem prawdy, bez nowej migracji ani drugiego
journala:

1. wspólna, zamknięta mapa `stage -> artifact_kind` należy do `contracts`; database append i read
   oraz worker używają tej samej mapy. Artifact musi mieć exact case/run/checkpoint revision i kind
   dozwolony dla stage; bezpośrednio skorumpowany historyczny row jest odrzucany przy odczycie;
2. deployment config przechodzi na `schema_version: 2` i wymaga server-owned, nieprzekazywanego
   modelowi `repository.write_path_allowlist`. Każdy modelowy `SliceContract.allowed_paths` musi być
   jego właściwym podzbiorem po segmentach ścieżki, przed bindem mutującego intentu i ponownie na
   write/evidence/recovery boundary;
3. `EngineeringControlPlaneRepository.listRunTrace` zwraca wyłącznie metadata/digest exact-bound po
   case/owner/run/checkpoint, w kolejności `event_sequence`; nie czyta descriptorów, payloadów,
   receiptów, promptów, patchy ani host paths. Low-cardinality metrics pozostają bez tych ID.

**Allowed paths:**

- `apps/agent-worker/src/engineering-execution.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/src/vertical-slice-executor.ts`
- `apps/agent-worker/test/engineering-execution.integration.test.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `apps/agent-worker/test/engineering-qualification-control.integration.test.ts`
- `apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts`
- `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
- `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
- `apps/agent-worker/test/engineering-qualification-fixture.ts`
- `apps/agent-worker/test/engineering-qualification-adversarial.integration.test.ts`
- `packages/contracts/src/engineering-workflow.ts`
- `packages/contracts/test/engineering-workflow.test.ts`
- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `packages/observability/test/context-metrics.test.ts`
- `docs/work-units/RA-044/WORK_UNITS.md`

**Weryfikacja:**

```sh
. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && \
pnpm --filter @remoteagent/database build && \
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  apps/agent-worker/test/engineering-qualification-adversarial.integration.test.ts \
  apps/agent-worker/test/engineering-execution.integration.test.ts \
  apps/agent-worker/test/engineering-workflow.integration.test.ts \
  apps/agent-worker/test/engineering-qualification-control.integration.test.ts \
  apps/agent-worker/test/vertical-slice-executor.integration.test.ts \
  packages/contracts/test/engineering-workflow.test.ts \
  packages/database/test/engineering-control-plane.integration.test.ts \
  packages/observability/test/context-metrics.test.ts && \
pnpm --filter @remoteagent/contracts typecheck && \
pnpm --filter @remoteagent/database typecheck && \
pnpm --filter @remoteagent/agent-worker typecheck && \
pnpm --filter @remoteagent/observability typecheck
```

**Wymagane mutacje RED→GREEN:** wrong stage/kind i checkpoint revision artifact; read-side corruption
guard; path-cap pominięty w config digest/factory/pre-STARTED/write boundary; segmentowy prefix
`src` vs `src2`; writer fence bypass; approval re-check bypass; stale evidence binding; missing
required gate; foreign scope guard; model-selected command/repo/path; brak case/owner/run/checkpoint
w exact trace; sort trace po timestamp zamiast `event_sequence`; payload/receipt albo high-cardinality
ID ujawnione w trace/telemetry.

**Dowód:** dokładna komenda WU powyżej uruchomiona `2026-08-26` z
`RA_REQUIRE_POSTGRES=1` zakończyła się exit `0`: Vitest `99/99` w `8/8` plikach, build
`@remoteagent/contracts` i `@remoteagent/database` oraz typecheck `contracts`, `database`,
`agent-worker`, `observability`. Realne mutacje RED objęły: zmianę code-owned stage/kind (`3`
fail), usunięcie checkpoint guard (`1` fail), usunięcie read-side kind guard (odczyt rozwiązał się
zamiast odrzucić), pominięcie capu w config digest (`1` fail), pominięcie capu w production factory
(`1` fail), pominięcie pre-STARTED cap check (`1` fail), pominięcie direct write-boundary cap check
(`1` fail), usunięcie owner filter trace (`1` fail), sort trace po timestamp (`1` fail), wyciek
payloadu do trace (`1` fail), usunięcie fresh writer fence przed stagingiem (`1` fail), pominięcie
required gate (`1` fail), pominięcie approval re-check (`1` fail) oraz poluzowanie strict model
authority fields (suite odmówił inicjalizacji kontraktu). Wszystkie mutacje przywrócono przed
końcowym zielonym przebiegiem. Korekta pre-audit dodała production-composition dowód podwójnie
malformed `SliceContract` (initial + jedyna repair), bez artefaktu, mutującego STARTED ani workspace,
oraz telemetry z realnego adversarial run bez promptu, host path, opaque canary i high-cardinality
IDs. Poluzowanie `gate_ids` zaakceptowało wadliwą repair i dało RED (`1` fail), a dodanie `caseId`
do labela engineering metric dało RED (`1` fail); obie mutacje przywrócono przed przebiegiem
`99/99`.

Niezależna weryfikacja Sol po odczycie diffu uruchomiła tę samą dokładną komendę WU:
exit `0`, Vitest `99/99` w `8/8` plikach, oba buildy i wszystkie cztery typechecki exit `0`.

Korekta pre-audit AC1 dodała jeden load-bearing zestaw przechodzący przez pełny
`createWorkerHandlers -> SupervisorRuntime -> createProductionEngineeringRuntimePort`. Dowodzi on:

- deterministyczny brak zmiany po odrzuconym patchu kończy się trwałym `TerminalReason`
  (`EXHAUSTED`, detail `NO_PROGRESS:*`) i terminalnym `BLOCKED`, bez drugiego wywołania review;
- sześć naprzemiennych, świeżych review boundaries kończy run jako `OSCILLATION`;
- `CHANGES_REQUIRED` prowadzi do świeżej poprawki i PASS tego samego slice, a finalny commit wiąże
  wyłącznie zaakceptowany attempt;
- retry-safe `MODEL_CALL` po STARTED/no artifact wznawia się pod tym samym nadal ważnym lease bez
  drugiego STARTED i wykonuje dokładnie jedno wywołanie modelu; nie jest to dowód cross-fence;
- stale tree/config evidence, brak albo fail required gate oraz foreign owner/integration scope są
  odrzucane przez pełny handler bez niedozwolonego write.

Exact qualification gate po restore: exit `0`; Vitest `22/22` w `4/4` plikach, agent-worker
typecheck, Prettier i `git diff --check` exit `0`. Mutation RED→GREEN objęły: usunięcie exact
`PRE_COMMIT_REVIEW_NO_CHANGE` mapping; rozszerzenie catch na dowolny `ReviewContractError`;
retry-safe MODEL_CALL zmieniony na AMBIGUOUS; usunięcie review-boundary sampling albo evaluatora
OSCILLATION; potraktowanie `CHANGES_REQUIRED` jak PASS; pominięcie stale-tree guard, gate config
digest, missing-required-gate i failed-gate mapping oraz foreign owner/integration binding. Każda
mutacja dała RED i została przywrócona przed końcową bramką.

Niezależna rozszerzona weryfikacja Sol zbudowała świeże `contracts`, `database`,
`agent-orchestrator` i `review-loop`, następnie uruchomiła wszystkie sześć
`engineering-qualification-*.integration.test.ts`: exit `0`, Vitest `38/38` w `6/6` plikach oraz
agent-worker typecheck exit `0`.

Finalny pre-audit wykrył i zamknął przeniesienie historycznego `CHANGES_REQUIRED` pomiędzy slices.
`previousCorrectionRawPatchDigest` bierze wyłącznie ostatni review po exact bieżącym
`SliceContract`, dla tego samego bindingu i `stage_attempt === currentAttempt - 1`. Full-handler
regresja wykonuje slice 1 reject→correction PASS, następnie slice 2 z patchem równym dawnemu
odrzuconemu patchowi i wymaga trzeciej fresh review/PASS zamiast fałszywego NO_PROGRESS. Mutacja do
historycznego wyszukiwania dała RED (`2` zamiast `3` review calls), po czym została przywrócona.
Wspólna finalna bramka recovery+boundaries po wszystkich restore: exit `0`, Vitest `26/26` w `2/2`
plikach, agent-worker typecheck, Prettier i diff-check exit `0`.

## WU-04 — Reply-loop regression, dokument kwalifikacji i pełna bramka

**Status:** DONE

**Rezultat:** stary conversational `AgentCompletion` zachowuje baseline checkpoint, revision advance,
`RunCompletionRepository`, outbox i Discord reply, bez wejścia w równoległy engineering path.
`docs/evidence/RA-044/CORE_ENGINEERING_QUALIFICATION.md` zapisuje uruchomione scenariusze, wyniki,
ograniczenia core oraz jawne wymagania macOS/Xcode/sondermind-ios dla RA-045, bez deklarowania live
Xcode. Sol uruchamia pełną bramkę i wykonuje audyt całego diffu.

**Allowed paths:**

- `apps/agent-worker/test/engineering-qualification-reply.integration.test.ts`
- `apps/agent-worker/test/baseline-checkpoint-gap.integration.test.ts`
- `apps/agent-worker/test/completion-reply.integration.test.ts`
- `apps/agent-worker/test/handlers.integration.test.ts`
- `test/guardrails/guardrails.test.ts`
- `docs/evidence/RA-044/CORE_ENGINEERING_QUALIFICATION.md`
- `docs/work-units/RA-044/WORK_UNITS.md`

**Weryfikacja WU:**

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  apps/agent-worker/test/engineering-qualification-reply.integration.test.ts \
  apps/agent-worker/test/baseline-checkpoint-gap.integration.test.ts \
  apps/agent-worker/test/completion-reply.integration.test.ts \
  apps/agent-worker/test/handlers.integration.test.ts && \
pnpm --filter @remoteagent/agent-worker typecheck
```

**Evidence (`2026-08-26`):**

- Nowy production-composition regression uruchamia realne
  `createWorkerHandlers -> SupervisorRuntime` dla świeżego checkpoint-less conversational case'a
  z Discord bindingiem. Potwierdza exact `AgentCompletion`, system baseline `0`, advance do `1`,
  `RunCompletionRepository`, completion outbox, typing + thread reply i trusted `AGENT` message.
  Jawnie wstrzyknięty engineering factory ma zero wywołań, a durable engineering operations,
  artifacts i events pozostają puste.
- Mutation RED→GREEN po każdorazowym restore: `case.resume` przekazany jako writer/engineering
  route (`1/1` RED), usunięty lazy baseline (`1/1` RED), usunięta Discord reply projection
  (`1/1` RED). Po restore test kwalifikacyjny `1/1` GREEN.
- Dokładna komenda WU powyżej uruchomiona po restore zakończyła się exit `0`: Vitest `20/20` w
  `4/4` plikach z realnym PostgreSQL oraz `@remoteagent/agent-worker` typecheck exit `0`.
- Niezależna weryfikacja Sol po odczycie finalnego diffu WU uruchomiła tę samą komendę: exit `0`,
  Vitest `20/20` w `4/4` plikach oraz typecheck `agent-worker` exit `0`.
- `docs/evidence/RA-044/CORE_ENGINEERING_QUALIFICATION.md` mapuje uruchomione scenariusze WU-00..
  WU-04, ograniczenia core i jawne preconditions RA-045. Nie deklaruje live Bedrock/Xcode ani
  `sondermind-ios`; pełna bramka taska i audyt pozostają obowiązkiem Sol.

## Pełna bramka taska

```sh
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && \
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && \
pnpm workflow:validate && git diff --check
```

**Final evidence (`2026-08-26`):** pełny łańcuch uruchomiony od początku po wszystkich korektach
zakończył się exit `0`: lint i Prettier exit `0`; build `26/26`, `0 cached`; Vitest `2757/2757`
w `217/217` plikach z `RA_REQUIRE_POSTGRES=1`; typecheck `40/40`, `0 cached`;
`workflow:validate OK — 47 tasks`; `git diff --check` exit `0`.

Trzy wcześniejsze przebiegi nie są liczone jako bramka końcowa: pierwszy zatrzymał lint na pięciu
nieużywanych symbolach; drugi zatrzymał Prettier na sześciu plikach; trzeci wykonał `2750/2751`,
ale guardrail oczekiwał historycznej nazwy `engineeringAuthorizationFromLease`. Poprawiono go tak,
by wiązał jedyny production factory z `engineeringApprovalCandidateFromLease`, a targeted guardrail
wrócił `3/3` GREEN. Po każdej korekcie pełny łańcuch zaczynano od nowa.

Po pełnej bramce Sol odczytuje pełny diff od bazowego commita, rozlicza każde z dziesięciu AC,
zapisuje dokładnie jeden audyt i handoff, ustawia RA-044 `DONE` i RA-046 `READY`, wykonuje logiczne
commity implementacji+dokumentacji i zostawia czyste drzewo. RA-047 oraz RA-045 pozostają
`BLOCKED_BY_DEPENDENCIES` zgodnie z `ADR-0014`.
