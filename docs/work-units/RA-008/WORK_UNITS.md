# RA-008 — Work units

## Metadata

- Task: `RA-008`
- Plan revision: `20`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `ACTIVE`
- Base commit/tree: `171d3c679dafd95cd0cdb1b52552a8594a5534b8`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test packages/database/test`

## Global boundaries

- In scope: checkpoint/context/decision services w `agent-orchestrator`, konieczne
  repozytoria database i projekcja statusu Discord.
- Out of scope: role scheduler z RA-009 i coding workspace.
- Sol przed aktywacją aktualizuje ścieżki po rzeczywistym API RA-007.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-008-WU-01` | `ACCEPTED` | trwałe repozytorium decyzji i odpowiedzi | — |
| `RA-008-WU-02` | `ACCEPTED` | deterministyczny context builder i provenance | WU-01 |
| `RA-008-WU-03` | `ACCEPTED` | czysta aplikacja checkpoint patch | WU-02 |
| `RA-008-WU-04A` | `ACCEPTED` | czyste przygotowanie completion do zapisu | WU-03 |
| `RA-008-WU-04B` | `ACCEPTED` | atomic completion persistence | WU-04A |
| `RA-008-WU-05A` | `ACCEPTED` | czyste przygotowanie request/answer | WU-01, WU-04B |
| `RA-008-WU-05B` | `ACCEPTED` | trwała materializacja waiting | WU-05A |
| `RA-008-WU-05C` | `ACCEPTED` | atomic answer i resume job | WU-05B |
| `RA-008-WU-06` | `ACCEPTED` | Markdown/pinned-status projection | WU-03 |
| `RA-008-WU-07A` | `ACCEPTED` | deterministyczny derived compaction manifest | WU-02, WU-03 |
| `RA-008-WU-07B` | `ACCEPTED` | bezpieczna integracja compaction z builderem | WU-07A |
| `RA-008-WU-08A` | `FIX_REQUIRED` | spójny trwały snapshot recovery | WU-04B, WU-05C |
| `RA-008-WU-08A-F1` | `READY` | fail-closed mapping i pełny gate snapshotu | WU-08A |
| `RA-008-WU-08B` | `BLOCKED` | deterministyczny recovery plan i odbudowa contextu | WU-08A-F1, WU-07B |
| `RA-008-WU-08C` | `BLOCKED` | end-to-end crash/resume matrix | WU-08B, WU-06 |

## `RA-008-WU-01` — Decision repository

- Status: `ACCEPTED`
- Result: typed repository zapisuje request i jedną związaną odpowiedź.
- Allowed paths: `packages/database/src/repositories/decision.ts`,
  `repositories/index.ts`, `test/decision.integration.test.ts`,
  `packages/database/src/errors.ts`, `packages/database/src/index.ts`.
- Context pack: `decision.ts` contract, migracje `005`/`010`, repository patterns.
- Acceptance: request jest walidowany kontraktem i append-only; replay dokładnie
  identycznego `{answerId, answer}` zwraca istniejący rekord bez drugiego insertu,
  a kolizja o innej semantyce failuje typed error; obcy case, revision i option
  są odrzucone przed zapisem odpowiedzi.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/decision.integration.test.ts`.
- Out of scope: porównanie z bieżącą rewizją case (WU-05), checkpoint apply i
  Discord.
- Sol gate: realny PostgreSQL oraz cross-case negative test.

## `RA-008-WU-02` — Context builder

- Status: `ACCEPTED`
- Result: czysty builder wybiera materiały według budżetu, priorytetu i scope.
- Allowed paths: `packages/agent-orchestrator/src/context/types.ts`,
  `context/builder.ts`, `context/budget.ts`, `test/context-builder.test.ts`,
  `src/index.ts`, `packages/agent-orchestrator/package.json`, `pnpm-lock.yaml`.
- Context pack: RA-008 scope, checkpoint/event/entity/tool contracts, scope guards.
- Acceptance:
  - wejście zawiera autorytatywne `caseId`, `ownerId`, allowlistę powiązanych par
    `{provider, connectionId}` i dozwolone nazwy tools; fragment nie może tego
    scope poszerzyć ani połączyć providera z connection innego providera;
  - obsługiwane rodzaje to task, thread excerpt, checkpoint, entity, receipt,
    plan, repo state i tool; priorytet wynika wyłącznie z rodzaju w kolejności
    `task > checkpoint > plan > receipt > repo_state > entity > thread_excerpt > tool`,
    a remis rozstrzyga stabilny `provenance.reference` porównywany po code units,
    bez zależnego od locale sortowania;
  - task i checkpoint są wymagane dokładnie raz; ich brak, duplikat albo budżet
    zbyt mały na oba kończy się typed error zamiast niepełnego kontekstu;
  - budżet jest dodatnim limitem bajtów UTF-8 treści fragmentów; fragmenty nie są
    obcinane, a opcjonalny fragment, który się nie mieści, jest raportowany jako
    pominięty; dopasowanie dokładnie do granicy jest dozwolone;
  - każdy wybrany i pominięty fragment zachowuje jawne provenance i trust;
    treść z eventów/providers oraz model-derived checkpointu jest
    `UNTRUSTED_DATA` i caller nie może oznaczyć jej jako trusted;
  - fragmenty entity/thread/receipt muszą odpowiadać case, ownerowi i jednej
    dozwolonej parze provider/connection; tool musi pochodzić z systemu, być na
    systemowej allowliście i nie może nieść scope zaproponowanego przez model;
    każde naruszenie failuje typed scope error zamiast cichego odfiltrowania;
  - wynik i kolejność pominięć są identyczne niezależnie od kolejności wejścia,
    a zduplikowany `provenance.reference` jest odrzucany.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/context-builder.test.ts`.
- Out of scope: persistence i model invocation.
- Sol gate: golden order przy granicznych budżetach; missing/duplicate mandatory;
  cross-case, cross-owner, cross-provider, cross-connection i disallowed-tool
  fixtures; wejście nie jest mutowane.

## `RA-008-WU-03` — Checkpoint patch application

- Status: `ACCEPTED`
- Result: czysta funkcja tworzy następną pełną rewizję z validated patch.
- Allowed paths: `packages/agent-orchestrator/src/checkpoint/apply-patch.ts`,
  `checkpoint/errors.ts`, `test/checkpoint-patch.test.ts`, `src/index.ts`.
- Context pack: `checkpoint.ts`, `agent-completion.ts`, WU-02 provenance rules.
- Acceptance:
  - funkcja przyjmuje bieżący checkpoint i proponowany patch jako runtime input,
    waliduje je odpowiednio przez `caseCheckpoint` i `checkpointPatch`, a błędy
    current/patch/result rozróżnia typed error codes;
  - `case_id` i wszystkie pola nieobecne w `CheckpointPatch` są zachowane,
    `revision` zawsze wynosi `current.revision + 1`, a `updated_at` pochodzi z
    jawnego system input; patch z dodatkowymi polami autorytatywnymi failuje;
  - pola `*_append` dopisują elementy w kolejności bez deduplikacji i bez utraty
    historii; `summary`, `current_phase`, `open_questions`, `next_actions` oraz
    `blockers` zastępują stare wartości tylko gdy są obecne w patchu;
  - wynik ponownie przechodzi pełny kontrakt `caseCheckpoint`, więc przekroczenie
    limitów po append nie zwraca częściowego checkpointu;
  - current i patch nie są mutowane, a identyczne dane wejściowe oraz systemowy
    timestamp dają strukturalnie identyczny wynik.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/checkpoint-patch.test.ts`.
- Out of scope: transakcja DB i compaction.
- Sol gate: table/property-style fixtures zachowujące decisions, evidence i
  wszystkie pola autorytatywne; strict rejection prób nadpisania revision/case;
  combined-array overflow oraz invalid timestamp.

## `RA-008-WU-04A` — Completion preparation

- Status: `ACCEPTED`
- Result: czysta funkcja wiąże runtime-validated completion z autorytatywnym
  run/case/revision i przygotowuje następny checkpoint oraz bezpieczny outbox event.
- Allowed paths: `packages/agent-orchestrator/src/checkpoint/apply-completion.ts`,
  `checkpoint/completion-errors.ts`, `test/completion-preparation.test.ts`, `src/index.ts`.
- Context pack: `AgentCompletion`, `RunSafetyState`, WU-03 oraz zasada, że model
  nie ustala run/case/revision ani czasu zakończenia.
- Acceptance:
  - completion jest parsowany runtime kontraktem i musi odpowiadać systemowym
    `runId`/`caseId`; bieżący checkpoint musi mieć ten case i expected revision;
  - `applyCheckpointPatch` tworzy checkpoint, a `last_run_id` jest ustawiany
    deterministycznie na autorytatywny run dopiero po aplikacji model patcha;
  - `completionId` i `finishedAt` są wymaganym system input; wynik zawiera
    zredagowany outbox payload wyłącznie z IDs, statusem i nową rewizją;
  - potwierdzone `FAILED`/`CANCELLED` mapują run na `FAILED`, pozostałe statusy na
    `SUCCEEDED`; model nie przekazuje `safety_state`;
  - input nie jest mutowany, a mismatch/invalid input daje typed error bez zapisu.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/completion-preparation.test.ts`.
- Out of scope: baza danych, publikacja outbox i answer handling.
- Sol gate: wszystkie statusy completion, cross-run/case/revision, invalid
  completion/time oraz dowód braku raw summary/decision text w outbox payload.

## `RA-008-WU-04B` — Atomic completion persistence

- Status: `ACCEPTED`
- Result: jedna publiczna operacja i jedna transakcja zapisują completion,
  checkpoint revision, terminalny run state, zwolnienie `active_run_id` i outbox.
- Allowed paths: `packages/database/src/repositories/run-completion.ts`,
  `repositories/index.ts`, `test/completion-apply.integration.test.ts`,
  `packages/database/src/errors.ts`, `packages/database/src/index.ts`,
  `packages/database/package.json`, `pnpm-lock.yaml`.
- Context pack: output WU-04A, checkpoint repository, branded transaction,
  `OutboxRepository` i run/case constraints.
- Acceptance:
  - repository posiada `Database` i sam otwiera dokładnie jedną transakcję;
    lockuje autorytatywny run/case przed odczytem i wymaga run `STARTED`, zgodnych
    case/revision oraz `active_run_id` wskazującego ten run;
  - publiczna granica ponownie waliduje completion/checkpoint i wszystkie relacje
    przygotowanego wyniku (case/run/revision/last_run/time/state/outbox); caller
    nie może podmienić prepared payloadu samym typem TypeScript;
  - commit zapisuje append-only `run_completions`, checkpoint przez istniejący
    CAS, terminalny run state/time, czyści aktywny run i enqueue'uje zredagowany
    event w istniejącym transactional outbox;
  - identyczny replay po commicie zwraca istniejący rezultat bez drugiego
    checkpointu/outbox i porównuje JSON semantycznie jako `jsonb`, nie przez
    kolejność kluczy; inna semantyka dla tego run/completionId daje typed conflict
    i zero nowych zapisów;
  - konkurencyjne runy tej samej sprawy na tej samej rewizji: dokładnie jeden
    może wygrać; rollback/fault na dowolnym późniejszym kroku nie pozostawia
    completion, checkpointu, terminalnego run state ani outbox.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/completion-apply.integration.test.ts`.
- Out of scope: materializacja DecisionRequest/answer resume i rendering.
- Sol gate: real-PG exact/conflicting replay, two-run revision race oraz fault
  matrix po completion/checkpoint/run/active-run/outbox writes.

## `RA-008-WU-05A` — Decision preparation

- Status: `ACCEPTED`
- Result: czyste funkcje normalizują modelowy `DecisionRequest` do rewizji
  zatwierdzonego checkpointu oraz budują systemowo związany `DecisionAnswer`.
- Allowed paths: `packages/agent-orchestrator/src/decisions/prepare.ts`,
  `decisions/errors.ts`, `test/decision-preparation.test.ts`, `src/index.ts`.
- Context pack: Decision contracts, WU-04A/B output i case state machine.
- Acceptance:
  - request powstaje wyłącznie z runtime-valid `WAITING_FOR_USER` completion oraz
    zatwierdzonego checkpointu tego samego case/run; `case_id` i
    `checkpoint_revision` są nadpisywane autorytatywnie z checkpointu, nigdy
    przyjmowane z modelowej rewizji;
  - answer przyjmuje nieufną selekcję `{decisionId, selectedOptionId, note?}` i
    systemowe `{caseId, currentRevision, answeredBy, answeredAt}`; wynik przechodzi
    pełny kontrakt i wybór musi istnieć w request;
  - obcy decision/case, zmieniona bieżąca rewizja, wygasły request, nieznana opcja
    albo wadliwy system time/identity dają rozróżnialny typed error;
  - input nie jest mutowany, a identyczne inputy dają identyczny output.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/decision-preparation.test.ts`.
- Out of scope: DB, Discord parsing i utworzenie resume job.
- Sol gate: modelowa dowolna rewizja zostaje zastąpiona committed revision;
  exhaustive mismatch/stale/expiry/option matrix oraz trust-safe error messages.

## `RA-008-WU-05B` — Durable waiting materialization

- Status: `ACCEPTED`
- Result: committed `WAITING_FOR_USER` completion jest materializowane
  idempotentnie jako request, case state i zredagowany outbox event.
- Allowed paths: `packages/database/src/repositories/decision-waiting.ts`,
  `repositories/index.ts`, `src/errors.ts`, `src/index.ts`,
  `test/decision-waiting.integration.test.ts`.
- Context pack: WU-01, WU-04B, WU-05A, checkpoint repository i OutboxRepository.
- Acceptance:
  - operacja przyjmuje `sourceRunId` i runtime-valid prepared DecisionRequest,
    posiada Database i sama otwiera jedną transakcję; lockuje source run
    completion i case oraz advisory-lockuje decision ID;
  - source musi być `WAITING_FOR_USER`, run terminalny `SUCCEEDED`, committed
    checkpoint bieżącej rewizji musi wskazywać source run, case nie ma active run,
    a prepared request jest semantycznie równy requestowi ze source po
    autorytatywnej normalizacji case/revision;
  - commit zapisuje DecisionRequest, przełącza do `WAITING_FOR_USER` wyłącznie z
    dozwolonego `PLANNING`/`IMPLEMENTING` i enqueue'uje `decision.requested` z
    payload `{decisionId, caseId, checkpointRevision, sourceRunId}`;
  - exact replay jest write-free i wymaga kompletnego request/case/outbox/dispatch
    state; kolizja decision ID/source o innej semantyce daje typed conflict;
    completion bez materializacji pozostaje wykrywalny dla WU-08.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/decision-waiting.integration.test.ts`.
- Out of scope: odpowiedź, resume job, Discord parsing i recovery skan.
- Sol gate: real-PG exact/conflicting/concurrent replay; cross-run/case/revision;
  fault rollback po decision insert, case transition oraz obu outbox writes.

## `RA-008-WU-05C` — Atomic answer and resume

- Status: `ACCEPTED`
- Result: ważna odpowiedź i dokładnie jeden per-case resume job commitują się atomowo.
- Allowed paths: `packages/database/src/repositories/decision-resume.ts`,
  `repositories/index.ts`, `src/errors.ts`, `src/index.ts`,
  `test/decision-resume.integration.test.ts`.
- Context pack: WU-01, WU-05A/B, `JobStore` i case state machine.
- Acceptance:
  - operacja runtime-waliduje `{answerId, answer}`, advisory-lockuje decision i
    lockuje decision/case; nowy zapis wymaga `WAITING_FOR_USER`, exact bieżącej
    rewizji, braku active run, niewygasłego requestu i zgodnej opcji/case;
  - jedna transakcja zapisuje answer przez WU-01, przełącza case do `PLANNING` i
    enqueue'uje PENDING `case.resume` job z redacted IDs, wymuszając per-case
    serialization istniejącym JobStore;
  - exact replay sprawdzany przed wymaganiem starego case statusu zwraca istniejący
    answer/job bez writes; inna odpowiedź daje typed conflict, a stale/foreign/
    expired zapisuje zero;
  - concurrent exact double answer tworzy jeden answer i jeden job; fault po
    answer/case/job write cofa całość.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/decision-resume.integration.test.ts`.
- Out of scope: Discord interaction parsing i wykonanie nowego model call.
- Sol gate: real-PG replay/conflict/stale/expiry/concurrency, job payload redaction,
  PENDING status/serialization key i trzyetapowa fault matrix.

## `RA-008-WU-06` — Checkpoint projections

- Status: `ACCEPTED`
- Result: deterministyczny Markdown i pinned status są read-only projections JSON.
- Allowed paths: `packages/agent-orchestrator/src/checkpoint/render.ts`,
  `test/checkpoint-render.test.ts`, `packages/discord/src/status.ts`,
  `packages/discord/test/status.test.ts`, oba `src/index.ts`,
  `packages/agent-orchestrator/package.json`, `pnpm-lock.yaml`.
- Context pack: CaseCheckpoint, RA-006 status gateway, WU-03 output.
- Acceptance: renderer nie mutuje checkpointu; output jest bounded/redacted;
  oba renderery korzystają ze wspólnego `@remoteagent/observability` redaktora;
  starsza projekcja nie nadpisuje nowszej.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/checkpoint-render.test.ts packages/discord/test/status.test.ts`.
- Out of scope: Discord gateway lifecycle.
- Sol gate: snapshot diff reviewed manualnie.

## `RA-008-WU-07A` — Derived compaction manifest

- Status: `ACCEPTED`
- Result: czysty algorytm tworzy bounded derived manifest bez mutacji źródeł i
  zachowuje pełny indeks provenance.
- Allowed paths: `packages/agent-orchestrator/src/context/compaction.ts`,
  `context/types.ts`, minimalna rejestracja kind w `context/builder.ts`,
  `test/compaction.test.ts`, `src/index.ts`.
- Context pack: WU-02/WU-03, ContextFragment i trust contracts.
- Acceptance:
  - wynik jest jawnie `derived`, deterministyczny dla kolejności wejścia i ma
    stabilną provenance identity z treści źródeł;
  - manifest zawiera verbatim `kind`, `origin`, `provenance.reference` i `trust`
    każdego źródła; dopiero pozostały budżet może zawierać bounded excerpt;
  - `task`, `checkpoint` i nowy kind `decision` są chronione i nie mogą wejść do
    compaction; receipt content może być skrócony, lecz jego reference nie;
  - zbyt mały budżet na pełny indeks failuje typed error zamiast zgubić referencję;
    input pozostaje nietknięty i jest wystarczający do ponownego odtworzenia.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/compaction.test.ts`.
- Out of scope: wywołanie modelu do semantycznego summary bez osobnej decyzji Sol.
- Sol gate: Unicode byte-boundaries, collisions, order invariance i adversarial
  próba kompaktowania DecisionRequest/checkpoint.

## `RA-008-WU-07B` — Builder compaction integration

- Status: `ACCEPTED`
- Result: builder opcjonalnie dołącza derived manifest dla omissions, zachowując
  autorytatywne fragmenty i pełny ślad odtworzenia.
- Allowed paths: `packages/agent-orchestrator/src/context/builder.ts`,
  `context/types.ts`, `test/compaction-builder.test.ts`, `src/index.ts`.
- Context pack: WU-02 i zaakceptowany WU-07A.
- Acceptance:
  - istniejące zachowanie bez opcji compaction nie zmienia się;
  - dokładnie jeden task/checkpoint oraz każdy `decision` pozostają verbatim i
    over-budget protected fragment failuje zamiast zostać pominięty;
  - omissions pozostają oryginalnymi fragmentami w wyniku, a manifest jest tylko
    dodatkową derived selection i nigdy source of truth;
  - receipt provenance refs i trust pozostają w manifeście; scope/trust/tool
    validation zachodzi przed compaction, więc derived content nie poszerza scope;
  - wynik mieści się w byte budget i jest identyczny dla permutacji inputu.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/compaction-builder.test.ts packages/agent-orchestrator/test/context-builder.test.ts`.
- Out of scope: trwałe usuwanie fragmentów i modelowy semantic summary.
- Sol gate: adversarial DecisionRequest + cross-scope + utrata derived fragmentu
  nadal pozostawia wszystkie oryginalne omissions do rekonstrukcji.

## `RA-008-WU-08A` — Durable recovery snapshot

- Status: `FIX_REQUIRED`
- Result: jedna read-only operacja zwraca spójny, runtime-validated snapshot
  autorytatywnego stanu case potrzebnego po restarcie.
- Allowed paths: `packages/database/src/repositories/case-recovery.ts`,
  `repositories/index.ts`, `src/errors.ts`, `src/index.ts`,
  `test/case-recovery.integration.test.ts`.
- Context pack: migracje runs/checkpoints/decisions/jobs, WU-04B i WU-05B/C.
- Acceptance:
  - repository posiada `Database`, otwiera jedną transakcję, lockuje case i
    zwraca bieżący checkpoint, autorytatywne provider/connection bindings,
    active run z intentami/completion, completion wskazane przez checkpoint,
    wszystkie decyzje z odpowiedziami oraz związane `case.resume` jobs;
  - persisted JSON przechodzi kontrakty runtime, rekordy są kanonicznie
    uporządkowane, a brak lub niespójność case/revision/run/decision/job daje
    typed recovery error zamiast częściowego snapshotu;
  - operacja nie zapisuje danych i nie może zwrócić rekordu innego case/owner;
    snapshot rozróżnia brak completion od potwierdzonego completion.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/case-recovery.integration.test.ts`.
- Out of scope: interpretacja następnej akcji, zmiana run/case i scheduler RA-009.
- Sol gate: real-PG consistent lock snapshot, invalid persisted JSON, cross-case
  isolation i read-only proof.

## `RA-008-WU-08A-F1` — Recovery snapshot gate fixes

- Status: `READY`
- Result: snapshot nie maskuje niespójnych persisted fields i posiada pełny
  dowód real-PG dla uzgodnionego kontraktu WU-08A.
- Allowed paths: takie same jak WU-08A.
- Context pack: diff pierwszej próby WU-08A i findingi Sol z gate'u.
- Acceptance:
  - mapper odpowiedzi waliduje zapisane aliasy decision/case/revision zamiast
    zastępować je polami requestu; IDs, provider i job status/payload przechodzą
    jawne runtime schemas, a kod nie używa `any`;
  - testy obejmują pełny happy snapshot, active intent bez completion,
    confirmed active/checkpoint completion, decyzję+answer+resume job, brakujący
    lub wadliwy stan, cross-case isolation, stabilny order i brak writes;
  - target test, database typecheck, scoped lint, format i diff-check przechodzą.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/case-recovery.integration.test.ts`.
- Out of scope: zmiana kontraktu akcji WU-08B i scheduler RA-009.
- Sol gate: niezależne uruchomienie wszystkich kontroli z pinned runtime.

## `RA-008-WU-08B` — Recovery plan and context reconstruction

- Status: `BLOCKED`
- Result: czysta funkcja wybiera jedną bezpieczną akcję recovery i odbudowuje
  bounded context bez poprzedniej sesji modelu.
- Allowed paths: `packages/agent-orchestrator/src/recovery.ts`,
  `test/recovery.test.ts`, `src/index.ts`.
- Context pack: publiczny snapshot WU-08A, WU-02/05A/07B i run safety state.
- Acceptance:
  - active run z intentem bez potwierdzonego completion daje wyłącznie
    `RECONCILIATION_REQUIRED` i `automaticAction: NONE`; planner nigdy nie
    proponuje replay model call ani resume job;
  - committed `WAITING_FOR_USER` completion bez requestu daje
    `MATERIALIZE_DECISION` z requestem związanym do committed checkpointu,
    request bez answer daje `WAITING_FOR_USER`, a answer z jednym zgodnym jobem
    daje `RESUME_QUEUED`; sprzeczne kombinacje failują typed error;
  - wynikowy context powstaje przez istniejący builder z autorytatywnego scope,
    checkpointu i wszystkich decyzji/odpowiedzi jako chronionych, untrusted
    fragmentów; jest bounded, deterministyczny i nie mutuje snapshotu.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/recovery.test.ts`.
- Out of scope: DB writes, wykonanie akcji i multi-role scheduling.
- Sol gate: exhaustive state table, permutations, over-budget decisions,
  cross-scope fixture oraz deep-freeze inputs.

## `RA-008-WU-08C` — End-to-end crash and resume matrix

- Status: `BLOCKED`
- Result: publiczne API RA-008 odtwarza stan i bezpieczną akcję na każdym
  boundary completion/decision/answer po utracie procesu.
- Allowed paths: `packages/database/test/checkpoint-recovery.integration.test.ts`,
  `packages/agent-orchestrator/test/recovery.integration.test.ts`.
- Context pack: zaakceptowane WU-04B, WU-05B/C, WU-08A/B i RA-004 recovery rules.
- Acceptance:
  - crash przed completion pozostaje `RECONCILIATION_REQUIRED` bez nowych writes;
    crash po atomic completion wykrywa dokładnie brakującą materializację i
    idempotentnie przechodzi do `WAITING_FOR_USER` przez istniejące API;
  - po answer/restart jeden `case.resume` job i nowy context zawierają pełny
    request oraz answer bez danych starej sesji, a exact replay nie duplikuje
    checkpointu, decision, answer, job ani outbox;
  - macierz sprawdza crash przed/po każdym atomic boundary i obcy case nie może
    wejść do contextu ani zmienić statusu recovery.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test/recovery.integration.test.ts packages/database/test/checkpoint-recovery.integration.test.ts`.
- Out of scope: wykonanie nowego model call i scheduler RA-009.
- Sol gate: pełna real-PG crash-before/after matrix oraz liczności wszystkich
  trwałych ledgerów.

## Final task gate

Sol uruchamia pełną macierz real-PG, sprawdza optimistic concurrency, provenance,
cross-scope isolation i wznowienie bez poprzedniej sesji. Następnie tworzy handoff
i niezależny audyt RA-008.
