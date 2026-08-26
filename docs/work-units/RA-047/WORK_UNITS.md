# RA-047 — work units

- Task: `RA-047`
- Bazowy commit: `2b35b3fd6c2c37ca5e92468a8a64e1ae87d991e6`
- Status: `DONE`
- Decyzja: `ADR-0014`

## Ustalenia wejściowe

- Generic `JobStore.claim`, intent, completion i artifact APIs pozostają fail-closed. Żadne z nich
  nie przyjmuje recovery tokenu ani swobodnego rolloveru fencing tokenu.
- Pierwotny `agent.implementer` job pozostaje związany z exact RA-046 proposal/Approval. Nie
  zastępujemy go nowym writer jobem, bo zmieniłoby to durable authority chain.
- Code-owned coordinator przed generic reap parkuje expired, niedokończony engineering job w
  `RECONCILING` i tworzy dokładnie jeden case-less recovery job. Recovery job nie ma workspace
  write authority, nie uruchamia commandu ani `git commit`.
- Po bezpiecznej klasyfikacji/naprawie źródłowy implementer job przechodzi atomowo do
  `RECOVERY_PENDING`. Zwykły claim nie widzi tego stanu; dedykowany continuation claim nadaje nowy
  fence i uruchamia istniejący handler na tym samym case/work unit/run/job.
- `READ_ONLY`/`MODEL_CALL` bez wyniku może zostać ponowiony dopiero przez zweryfikowany continuation
  fence, przy exact descriptor/config/schema/scope/deadline oraz digestach manifestu, snapshotu i
  renderowanego context packetu. Retry rezerwuje durable, konserwatywny budżet przed dispatch.
- GATE recovery składa outer artifact wyłącznie z kompletnego exact zestawu durable receipts.
  LOCAL_COMMIT recovery wyłącznie obserwuje HEAD/parent/marker/tree/diff. Unknown
  `COMMAND`/`MUTATING_SIDE_EFFECT` pozostaje `AMBIGUOUS`/`RECONCILING`.
- Recovery potwierdzonego efektu ma pierwszeństwo przed cancellation/deadline; nowe wykonanie lub
  następny stage już nie. Absolutny deadline pochodzi z immutable operation descriptoru.
- Crash po zakończeniu stage, lecz przed następnym intentem, nie oznacza końca joba. Dopiero exact
  outer `run_completion` pozwala terminalnie odtworzyć sukces implementera.

## WU-00 — durable recovery authority i continuation queue state

- Status: `DONE`
- Rezultat: migracja i repozytorium tworzą strict recovery binding/event ledger, case-less recovery
  job oraz niedostępny dla generic claim stan `RECOVERY_PENDING`; dwa workery nie mogą wygrać tej
  samej recovery/continuation.
- Allowed paths:
  - `packages/database/migrations/037_engineering_cross_fence_recovery.up.sql`
  - `packages/database/migrations/037_engineering_cross_fence_recovery.down.sql`
  - `packages/database/src/repositories/engineering-recovery.ts`
  - `packages/database/src/repositories/index.ts`
  - `packages/database/src/index.ts`
  - `packages/database/src/queue/job-store.ts`
  - `packages/database/src/queue/dispatch.ts`
  - `packages/database/test/engineering-recovery.integration.test.ts`
  - `packages/database/test/queue.integration.test.ts`
  - `packages/database/test/queue-adversarial.integration.test.ts`
  - `packages/database/test/queue-concurrency.integration.test.ts`
  - `packages/database/test/migrations.integration.test.ts`
  - `packages/database/test/dispatch.test.ts`
  - `docs/work-units/RA-047/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && pnpm --filter @remoteagent/database build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/migrations.integration.test.ts packages/database/test/engineering-recovery.integration.test.ts packages/database/test/queue.integration.test.ts packages/database/test/queue-adversarial.integration.test.ts packages/database/test/queue-concurrency.integration.test.ts packages/database/test/dispatch.test.ts && pnpm --filter @remoteagent/database typecheck`
- Evidence:
  - finalna dokładna komenda WU po wszystkich restore: exit `0`; build contracts i database exit
    `0`; Vitest `6/6` plików, `94/94` testów z `RA_REQUIRE_POSTGRES=1`; database source i
    test typecheck exit `0`;
  - `jobs` jest jedynym lease clock/owner/fence. Recovery binding przechowuje immutable exact
    proposal/job/case/owner/work-unit/run/checkpoint/repository oraz opcjonalny exact operation
    tuple, stały deadline i łańcuch root/parent; event niesie typowany authority job/fence;
  - code-owned `materializeExpired` ma pierwszeństwo przed generic reap: outer run completion
    rekonstruuje sukces, a brak completion (także bez intentu lub z wszystkimi bieżącymi receiptami
    `SUCCEEDED`) atomowo parkuje źródło i tworzy dokładnie jeden case-less recovery job;
  - recovery job nie jest dostępny dla generic claim/reap, a źródłowy `RECOVERY_PENDING` nie jest
    dostępny dla generic claim i nadal blokuje serialization key. Stale recovery nie może
    opublikować continuation; dedicated claim nadaje temu samemu implementer jobowi nowy fence;
  - rollback 037 ma population guard oraz pełny `ACCESS EXCLUSIVE ... NOWAIT` lock set; realny
    controlled race kończy się odmową bez utraty schematu lub authority.
- Mutation RED -> GREEN (każda mutacja chwilowa, natychmiast przywrócona):
  - usunięcie engineering exclusion z generic reap: exit `1`, `2/2` targeted fail — no-intent
    wrócił do `PENDING`, a częściowy all-receipts job został przedwcześnie `SUCCEEDED`;
  - dopuszczenie recovery joba do generic claim oraz osobno generic reap: każde exit `1`, po jednym
    failu (obcy lease albo requeue recovery joba);
  - pominięcie `RECOVERY_PENDING` w claim-time serialization guard: exit `1` na unique violation;
    usunięcie go z partial unique index: exit `1`, bezpośredni drugi writer został przyjęty;
  - osłabienie strict recovery-job serialization shape, payload immutability, source-fence insert
    guard, proposal composite FK, operation composite FK i event authority trigger: każde exit `1`,
    po jednym load-bearing failu;
  - wyłączenie recovery binding guard w generic reconciliation: exit `1`, generic CONFIRMED
    bezprawnie zakończył źródło; zaakceptowanie sukcesu bez outer run completion: exit `1`, `2/2`
    targeted fail;
  - usunięcie lease-expiry guardów: exit `1`, expired recovery opublikowało continuation;
    zerwanie root/parent predecessor binding: exit `1`, drugi recovery fence utracił łańcuch;
  - usunięcie rollback population guard: exit `1`, migracja 037 została destrukcyjnie cofnięta;
    usunięcie pełnego NOWAIT locka: exit `1` na kontrolowanym `drop-blocked` race.

## WU-01 — dedicated cross-fence repair boundary

- Status: `DONE`
- Zależy od: WU-00
- Rezultat: current recovery/continuation lease może idempotentnie naprawić tylko exact stary
  artifact/completion/observation lub zapisać terminalną klasyfikację; zwykłe control-plane i
  JobStore APIs nadal odrzucają obcy fence.
- Allowed paths:
  - `packages/contracts/src/engineering-workflow.ts`
  - `packages/contracts/src/schema.ts`
  - `packages/contracts/test/engineering-workflow.test.ts`
  - `packages/contracts/test/schema-snapshot.test.ts`
  - `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
  - `packages/database/migrations/037_engineering_cross_fence_recovery.up.sql`
  - `packages/database/src/repositories/engineering-control-plane.ts`
  - `packages/database/src/repositories/engineering-recovery.ts`
  - `packages/database/test/engineering-control-plane.integration.test.ts`
  - `packages/database/test/engineering-recovery.integration.test.ts`
  - `packages/database/test/migrations.integration.test.ts`
  - `packages/test-evidence/src/engineering-gates.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `docs/work-units/RA-047/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && pnpm --filter @remoteagent/database build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/contracts/test/engineering-workflow.test.ts packages/contracts/test/schema-snapshot.test.ts packages/database/test/migrations.integration.test.ts packages/database/test/engineering-control-plane.integration.test.ts packages/database/test/engineering-recovery.integration.test.ts && pnpm --filter @remoteagent/contracts typecheck && pnpm --filter @remoteagent/database typecheck && pnpm --filter @remoteagent/test-evidence typecheck && pnpm --filter @remoteagent/agent-worker typecheck`
- Evidence:
  - dokładna komenda WU zwróciła exit `0`: `5/5` plików, `80/80` testów z
    `RA_REQUIRE_POSTGRES=1`; build contracts/database oraz typecheck
    contracts/database/test-evidence/agent-worker zwróciły exit `0`;
  - strict `EngineeringRecoveryPlan` wiąże exact recovery/source/job/run/operation, pełny
    rendered context packet, evidence digest i konserwatywną rezerwację budżetu; JSON plan i jego
    digest są trwałe oraz niezmienne w obrębie recovery fence;
  - zwykłe `observeOperationCompletion` wymaga nadal aktualnego oryginalnego lease; osobna
    recovery-fenced transakcja idempotentnie konwerguje exact artifact, standardowy SUCCEEDED
    receipt i observation, bez dispatchu modelu/commandu/Git;
  - terminalna klasyfikacja dopuszcza tylko `AMBIGUOUS|BLOCKED|CANCELLED` i pozostawia source
    job w kwarantannie `RECONCILING`;
  - mutation RED→GREEN: unfenced observation — `1/1` RED; optional context packet — `1/1` RED;
    retry bez operation oraz gate recovery na obcym stage — po `1/1` RED; digest pomijający
    context/budżet — `1/1` RED; trust caller plan digest, obcy operation i obcy artifact case — po
    `1/1` RED; pominięcie exact completion receipt — `1/1` RED; non-terminal plan accepted —
    `1/1` RED; zmiana już związanego planu przez API i bezpośrednio w DB — po `1/1` RED;
    nieidempotentny repair-event replay — `1/1` RED. Każdą mutację przywrócono przed finalną
    bramką.

## WU-02 — stage-aware runtime recovery

- Status: `DONE`
- Zależy od: WU-01
- Rezultat: production port klasyfikuje MODEL/READ_ONLY, GATE i LOCAL_COMMIT na podstawie exact
  recovery authority; model retry ma exact context-packet binding i durable budget reservation,
  gate nie powtarza commandów, a commit jest observe-only.
- Allowed paths:
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-recovery.ts`
  - `apps/agent-worker/src/context.ts`
  - `apps/agent-worker/src/vertical-slice-executor.ts`
  - `apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts`
  - `packages/database/migrations/037_engineering_cross_fence_recovery.up.sql`
  - `packages/database/src/queue/job-store.ts`
  - `packages/database/src/repositories/engineering-recovery.ts`
  - `packages/test-evidence/src/engineering-gates.ts`
  - `packages/test-evidence/test/engineering-gates.integration.test.ts`
  - `docs/work-units/RA-047/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && pnpm --filter @remoteagent/database build && pnpm --filter @remoteagent/test-evidence build && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/migrations.integration.test.ts packages/database/test/engineering-recovery.integration.test.ts packages/database/test/queue.integration.test.ts packages/test-evidence/test/engineering-gates.integration.test.ts apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts && pnpm --filter @remoteagent/database typecheck && pnpm --filter @remoteagent/test-evidence typecheck && pnpm --filter @remoteagent/agent-worker typecheck`
- Evidence:
  - finalna dokładna bramka po całym diffie i restore wszystkich mutacji: exit `0`; build
    contracts/database/test-evidence/agent-worker exit `0`; Vitest `8/8` plików, `95/95` testów z
    `RA_REQUIRE_POSTGRES=1` (w tym migracja 037 `13/13`); typecheck
    database/test-evidence/agent-worker oraz `git diff --check` exit `0`;
  - strict stage classifier wiąże recovery z immutable descriptorem, config/schema/scope,
    aktualnym GRANTED proposal, deployment write policy, deadline, ContextManifest/snapshot i
    dokładnym renderowanym packetem. Retry MODEL/READ_ONLY tylko rezerwuje trwały konserwatywny
    budżet; nie wywołuje modelu przed continuation fence;
  - GATE wybiera wyłącznie outer `engineering.stage.*` operation, odzyskuje istniejące inner
    receipts w trybie receipt-only, naprawia brakujące observations osobną recovery-fenced granicą
    i nie binduje ani nie dispatchuje brakującego commandu. LOCAL_COMMIT wywołuje wyłącznie
    `recover`/obserwację, nigdy `execute`/drugi commit;
  - clean cancellation/deadline przed nowym wykonaniem terminalizują recovery; niepotwierdzony
    `MUTATING_SIDE_EFFECT` pozostaje `AMBIGUOUS`. Potwierdzony artifact/receipt jest naprawiany
    przed tym rozstrzygnięciem. Znaleziony SQL NULL defect w legacy generic reap naprawiono przez
    `IS DISTINCT FROM`, zachowując specjalne RA-046 jobs i wcześniejsze joby bez `reason`;
  - mutation RED→GREEN (każda chwilowa i przywrócona): pominięcie packet digest, config digest,
    deployment-policy digest, cancellation, durable budget reservation, outer-stage filter,
    gate `recovery_only`, recovery observation callback, LOCAL_COMMIT observe-only, mutating
    ambiguity i SQL NULL-safe legacy predicate — każde exit `1` z jednym load-bearing failem.
    Pierwszy run mutation callback po zmianie DB source został odrzucony jako stale-dist
    (`CTF-011`); po rebuildzie database ten sam mechanizm dał właściwy RED, a finalne źródła i
    dist przywrócono przed bramką.

## WU-03 — production coordinator, scheduler i continuation claim

- Status: `DONE`
- Zależy od: WU-02
- Rezultat: realny worker przed generic reap uruchamia code-owned recovery coordinator, recovery
  handler nie dostaje writer tools, a dedicated continuation claim wraca do istniejącego
  `createWorkerHandlers -> SupervisorRuntime` bez drugiego writera ani zwykłego retry po błędzie.
- Allowed paths:
  - `packages/database/src/queue/scheduler.ts`
  - `packages/database/src/repositories/engineering-recovery.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-recovery.ts`
  - `apps/agent-worker/test/engineering-cross-fence-coordinator.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts`
  - `apps/agent-worker/test/relay-scope.integration.test.ts`
  - `packages/database/test/engineering-recovery.integration.test.ts`
  - `docs/work-units/RA-047/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/database build && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/engineering-recovery.integration.test.ts apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts apps/agent-worker/test/engineering-cross-fence-coordinator.integration.test.ts apps/agent-worker/test/relay-scope.integration.test.ts apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts && pnpm --filter @remoteagent/database typecheck && pnpm --filter @remoteagent/agent-worker typecheck && pnpm exec prettier --check packages/database/src/queue/scheduler.ts packages/database/src/repositories/engineering-recovery.ts apps/agent-worker/src/engineering-workflow.ts apps/agent-worker/src/engineering-execution.ts apps/agent-worker/src/engineering-recovery.ts apps/agent-worker/src/worker.ts apps/agent-worker/test/engineering-cross-fence-coordinator.integration.test.ts apps/agent-worker/test/relay-scope.integration.test.ts && git diff --check`
- Evidence:
  - komenda WU po finalnym restore: exit `0`; build database i agent-worker exit `0`; real-PG
    Vitest `5/5` plików, `36/36` testów; oba typechecki, Prettier i `git diff --check`
    exit `0`;
  - production `Scheduler` uruchamia coordinator przed generic reap, a dedicated claim oddaje ten
    sam `job_id/case/work_unit/run` z nowym fence do istniejącego
    `createWorkerHandlers -> SupervisorRuntime`; load-bearing test zaczyna od `STARTED READ_ONLY`
    na starym fence i kończy pełny workflow, dokładnie jeden `LocalCommitReceipt` i outer
    `run_completion`;
  - retry `MODEL_CALL/READ_ONLY` dostaje deterministyczny recovery-bound operation ID. Pozostałe
    klasyfikacje zachowują normalną tożsamość, bo ich poprzedni efekt jest najpierw trwale
    naprawiony albo terminalizowany;
  - błąd continuation nie trafia do generic bounded retry: exact lease jest wygaszony, źródło
    wraca do `RECONCILING`, powstaje jeden child recovery, a `PENDING` pozostaje niedostępny dla
    zwykłego claimu. Latest source operation jest wybierane tylko z intentu bieżącego fence;
    failure przed nowym intentem nie kopiuje operation poprzednika;
  - mutation RED -> GREEN, każda przywrócona: normalny/stary operation ID przy retry (`1` fail),
    usunięcie current-fence filtra source operation (`1` fail), skierowanie continuation error do
    `jobs.fail/PENDING` (`1` fail), odłączenie continuation lane w `createWorkerProcess` (`1` fail)
    oraz pominięcie `publishContinuation` (`1` fail). Finalna bramka powyżej była uruchomiona po
    wszystkich restore.

## WU-04 — fault matrix, adversarial proof i task gate

- Status: `DONE`
- Zależy od: WU-03
- Rezultat: pełna production composition przechodzi expiry/reap/recovery/continuation dla
  MODEL/GATE/LOCAL_COMMIT oraz wszystkich crash boundaries, a unsafe, stale, foreign,
  cancellation/deadline i two-worker cases pozostają fail-closed z load-bearing mutations.
- Allowed paths:
  - `apps/agent-worker/test/engineering-cross-fence-recovery.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-coordinator.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-risk.integration.test.ts`
  - `packages/database/test/engineering-recovery.integration.test.ts`
  - `packages/database/test/migrations.integration.test.ts`
  - `docs/evidence/RA-047/CROSS_FENCE_RECOVERY_QUALIFICATION.md`
  - `docs/work-units/RA-047/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Evidence:
  - pełna komenda po wszystkich restore zwróciła exit `0`: lint/format/diff-check exit `0`; forced
    build `26/26`, cache `0`; real-PG Vitest `224/224` plików i `2829/2829` testów; forced
    typecheck `40/40`, cache `0`; `workflow:validate OK — 47 tasks`;
  - full production fault suite odtwarza outer GATE crash po trwałym inner receipt, zachowuje exact
    inner `completion_id`, składa jeden `EvidenceBundle`, kończy workflow jednym
    `LocalCommitReceipt` i nie powtarza commandu. Inner STARTED/no receipt oraz brak wymaganej inner
    operacji kończą się `AMBIGUOUS` bez replacement dispatch;
  - LOCAL_COMMIT fault po rzeczywistym Git commit jest odzyskiwany przez exact observe-only
    HEAD/parent/marker/tree/diff; świeży coordinator kończy run z łączną liczbą commitów `1` i bez
    dodatkowego model call;
  - matrix WU-00..03 obejmuje pre/post intent, STARTED, receipt, artifact, completion, observation,
    publish i continuation claim, dwa workery, stale/foreign bindings, cancellation/deadline oraz
    child recovery po błędzie continuation. Dokument kwalifikacyjny:
    `docs/evidence/RA-047/CROSS_FENCE_RECOVERY_QUALIFICATION.md`;
  - pierwszy pełny run miał exit `1`: `222` pliki GREEN, `2` pliki / `4` fail przez stare fixture’y
    RA-044 oczekujące płaskiego LOCAL_COMMIT descriptoru. Po strict fixture correction targeted
    adjudication dał `18/18`; pełną bramkę uruchomiono ponownie od początku. To deterministic
    cascade, nie flake;
  - mutation RED -> GREEN WU-04: LOCAL_COMMIT `recover` zmieniony na `execute` — `1` fail;
    GATE recovery z wyłączonym receipt-only przy missing required inner operation — `1` fail;
    obie mutacje przywrócono przed finalnym pełnym przebiegiem. Pozostałe wymagane safety mutations
    są load-bearing i zapisane przy WU-00..03.

## Obowiązkowa macierz mutation RED -> GREEN

- generic reap przed code-owned engineering classifier oraz premature `SUCCEEDED` bez outer
  `run_completion`;
- zwykły claim przyjmujący `RECONCILING`/`RECOVERY_PENDING` albo scheduler kierujący błąd
  continuation do `PENDING`;
- pominięcie source fence, current recovery/continuation fence, expiry, case/owner/work unit/run,
  checkpoint, operation, descriptor/config/schema/scope/deadline albo context packet digest;
- drugi recovery worker lub replay enqueue tworzący drugi recovery/continuation;
- stale recovery writer naprawiający artifact/completion/observation albo uruchamiający model;
- MODEL/READ_ONLY retry bez durable budget reservation lub po deadline/cancellation;
- retry `COMMAND`/`MUTATING_SIDE_EFFECT` bez exact receipt;
- GATE ponownie dispatchujący completed command, akceptujący missing/foreign/stale receipt albo
  składający niepełny bundle;
- LOCAL_COMMIT wywołujący commit zamiast observe-only albo pomijający HEAD/parent/marker/tree/diff;
- completion-only uznany za success, generic observe/append/completion przyjmujący rollover albo
  nowy stage przed durable repair+continuation;
- cancellation/deadline maskujące unknown write, recompute deadline, reset budżetów lub utrata
  ordered artifacts/case/work unit/run;
- destructive rollback migracji 037 przy istniejącym recovery/event/job oraz race bez
  `ACCESS EXCLUSIVE ... NOWAIT`.
