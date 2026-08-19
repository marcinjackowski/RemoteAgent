# RA-008 — Work units

## Metadata

- Task: `RA-008`
- Plan revision: `08`
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
| `RA-008-WU-04B` | `READY` | atomic completion persistence | WU-04A |
| `RA-008-WU-05` | `BLOCKED` | waiting/answer binding i stale rejection | WU-01, WU-04B |
| `RA-008-WU-06` | `BLOCKED` | Markdown/pinned-status projection | WU-03 |
| `RA-008-WU-07` | `BLOCKED` | bounded compaction bez utraty decyzji | WU-02, WU-03 |
| `RA-008-WU-08` | `BLOCKED` | crash recovery i end-to-end resume | WU-04B, WU-05, WU-06, WU-07 |

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

- Status: `READY`
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

## `RA-008-WU-05` — Waiting and answer resume

- Result: `WAITING_FOR_USER` zwalnia run/lease, a ważna odpowiedź tworzy nowy resume intent.
- Allowed paths: `packages/agent-orchestrator/src/decisions/service.ts`,
  `decisions/errors.ts`, `test/decisions.test.ts`,
  `packages/database/test/decision-resume.integration.test.ts`, `src/index.ts`.
- Context pack: WU-01/WU-04B, DecisionRequest contracts, queue/outbox APIs.
- Acceptance: stale/foreign answer odrzucony; replay nie tworzy drugiego resume;
  waiting nie utrzymuje aktywnego lease.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/decision-resume.integration.test.ts`.
- Out of scope: Discord interaction parsing z RA-006.
- Sol gate: receipt/idempotency test dla podwójnej odpowiedzi.

## `RA-008-WU-06` — Checkpoint projections

- Result: deterministyczny Markdown i pinned status są read-only projections JSON.
- Allowed paths: `packages/agent-orchestrator/src/checkpoint/render.ts`,
  `test/checkpoint-render.test.ts`, `packages/discord/src/status.ts`,
  `packages/discord/test/status.test.ts`, `src/index.ts`.
- Context pack: CaseCheckpoint, RA-006 status gateway, WU-03 output.
- Acceptance: renderer nie mutuje checkpointu; output jest bounded/redacted;
  starsza projekcja nie nadpisuje nowszej.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/checkpoint-render.test.ts packages/discord/test/status.test.ts`.
- Out of scope: Discord gateway lifecycle.
- Sol gate: snapshot diff reviewed manualnie.

## `RA-008-WU-07` — Safe compaction

- Result: derived summary redukuje kontekst bez usuwania decyzji i provenance.
- Allowed paths: `packages/agent-orchestrator/src/context/compaction.ts`,
  `context/builder.ts`, `test/compaction.test.ts`, `src/index.ts`.
- Context pack: WU-02/WU-03, checkpoint required fields, trust contracts.
- Acceptance: decisions/open questions/receipts pozostają verbatim refs;
  compaction jest odtwarzalna; utrata derived data nie uszkadza source of truth.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/compaction.test.ts`.
- Out of scope: wywołanie modelu do semantycznego summary bez osobnej decyzji Sol.
- Sol gate: adversarial test, który nie pozwala zgubić DecisionRequest.

## `RA-008-WU-08` — Recovery and resume integration

- Result: nowy proces odtwarza context/checkpoint/decision po crashu model call.
- Allowed paths: `packages/agent-orchestrator/src/recovery.ts`,
  `test/recovery.integration.test.ts`, `packages/database/test/checkpoint-recovery.integration.test.ts`,
  `src/index.ts`.
- Context pack: zaakceptowane RA-008 units, RA-004 reconciliation, RA-007 call result.
- Acceptance: intent bez completion jest reconciled, nie replayed w ciemno;
  materialne decyzje wracają bez starej sesji; status jest jednoznaczny.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test/recovery.integration.test.ts packages/database/test/checkpoint-recovery.integration.test.ts`.
- Out of scope: multi-role scheduling.
- Sol gate: pełne crash-before/after matrix.

## Final task gate

Sol uruchamia pełną macierz real-PG, sprawdza optimistic concurrency, provenance,
cross-scope isolation i wznowienie bez poprzedniej sesji. Następnie tworzy handoff
i niezależny audyt RA-008.
