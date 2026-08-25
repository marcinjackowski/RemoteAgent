# RA-034 — Work units

Bazowy commit: `7aa6ccb` (po RA-033).

Duży task, budowany przyrostowo z bramką na każdym kroku. AC5 (live smoke) czeka na konfigurację
właściciela; WU-01..WU-04 są config-free i testowalne na throwaway repo git.

## WU-00 — Bazowy checkpoint case'a (CTF-020) — PREREQUISITE

- Problem: żaden kod produkcyjny nie tworzy bazowego checkpointu, więc PIERWSZY completion każdego
  runu rzuca „has no checkpoint to advance". Blokuje pętlę odpowiedzi (RA-031/032) **i** RA-034.
  Reprodukcja: `apps/agent-worker/test/baseline-checkpoint-gap.integration.test.ts` (zielona:
  `latestCheckpoint(freshCase) === null`).
- Rezultat: deterministyczne „ensure baseline checkpoint" przy tworzeniu case'a (lub leniwie przed
  pierwszym completion), idempotentne. Odwrócenie testu reprodukcji po fixie.
- Uwaga: dotyka kontraktu checkpointów (RA-008) — miejsce/numeracja baseline'u do potwierdzenia z
  właścicielem (zmiana zachowania zaakceptowanego kontraktu + korekta „DONE" RA-032).
- Status: `DONE` (2026-08-25). Wybór właściciela: baseline leniwie w ścieżce completion.
  Impl: `CheckpointRepository.ensureBaseline` (revision-0, idempotentne, BEZ bumpu
  `cases.checkpoint_revision`) → `WorkerPersistence.ensureBaselineCheckpoint` → `handlers.ts`
  (null checkpoint → ensureBaseline zamiast throw). Testy: `checkpoint-baseline.integration` (direct,
  idempotencja+no-bump) + `baseline-checkpoint-gap.integration` (E2E: świeży case → completion
  persystuje, checkpoints [0,1]). Mutation: revert do `throw` → RED, przywrócone GREEN. **Naprawia
  też pętlę odpowiedzi RA-031/032** (nie tylko RA-034). NIEZACOMMITOWANE.

## WU-01 — Materializacja IMPLEMENTERa + enqueue writer joba

- Rezultat: produkcyjne repo (`packages/database/src/repositories/implementer-work.ts`)
  `ImplementerWorkRepository.enqueueImplementerWork({caseId, repoId, objective})` — w jednej `tx`:
  lock case'a `FOR UPDATE`, guard (terminal case → `ignored`; istniejący nie-terminalny IMPLEMENTER
  dla case'a → `ignored: writer_active`), insert unit `role: IMPLEMENTER`,
  `authoritativeScope { can_write_workspace:true, connection_ids:[], repo_allowlist:[repoId] }`,
  enqueue `agent.implementer` z payloadem `{reason, caseId, workUnitId, repoId}`. Zwraca
  `accepted|ignored`. Idempotencja przez wygenerowany `work_unit_id` + guard single-writer.
- Allowed paths: `packages/database/src/repositories/implementer-work.ts`,
  `packages/database/src/repositories/index.ts` (export), `packages/database/test/implementer-work.integration.test.ts`.
- Weryfikacja: `RA_REQUIRE_POSTGRES=1 vitest run packages/database/test/implementer-work.integration.test.ts`
  → **4/4** (PG15/5432 override). Mutation: wyłączenie guardu single-writer → RED (1 failed),
  przywrócone GREEN.
- Status: `IN_PROGRESS` — **wymaga przeróbki** (finding niżej). Kod: `implementer-work.ts` + export +
  test (4/4, mutation OK), ale payload/stan unitu NIE pasuje jeszcze do kontraktu writer-lease.
  NIEZACOMMITOWANE.

### FINDING WU-01 (2026-08-25) — payload writer joba musi być `{workUnitId, runId}` na *claimed* unicie

`WriterLeaseGuard.acquire` (`writer-lease.ts:117` `hasWriterBinding`) wymaga, by payload joba
`agent.implementer` miał **dokładnie dwa klucze** `{workUnitId, runId}` i zgadzał się z
`unit.work_unit_id` + `unit.run_id`. Fence dopasowuje się w teście `handlers.integration` tylko
dlatego, że deterministyczny `makeRunId` mintuje `run-1` = ten sam, który wpisano w payload. W
PRODUKCJI `makeRunId` (`persistence.nextRunId`) jest nieprzewidywalny, więc twórca nie zgadnie
runId. Poprawny przepływ (jedna tx):
1. upewnić się, że case ma **bazowy checkpoint** (bez niego `persistThroughAuditedPath` →
   `latestCheckpoint` rzuca; `CheckpointRepository.append` tylko *advance*, więc baseline to osobny
   krok — do rozstrzygnięcia);
2. insert unit IMPLEMENTER (PENDING);
3. **claim** unitu (`WorkUnitRepository.claim`) → run R (DISPATCHED), z checkpointRevision case'a;
4. enqueue `agent.implementer` z payloadem **dokładnie** `{workUnitId, runId: R}`.
Runtime na resume widzi unit DISPATCHED → `start()` na istniejącym runie R (NIE mintuje nowego),
fence pasuje. Obecny `enqueueImplementerWork` (PENDING + `{reason,caseId,workUnitId,repoId}`) trzeba
przepisać na ten kształt (i rozwiązać baseline checkpoint). Test integracyjny musi dojść aż do
`WriterLeaseGuard.acquire`, nie tylko sprawdzić insert unitu+joba.

## WU-02 — Provisioning workspace w workerze (config + fence bridge)

- Rezultat: worker buduje `LocalWorkspaceAdapter` z env (`WORKSPACE_ROOT` + allowlist repo), i na
  starcie IMPLEMENTERa provisionuje worktree (`create({identity, repositoryId, baseSha, branchName,
  fence})`) pod `WorkspaceFenceValidator` opakowującym writer lease. `WorkspaceRegistry` = adapter
  nad istniejącym `WorkspaceRepository` albo minimalny impl.
- Weryfikacja: test na throwaway repo git (temp dir jako `sourcePath`), worktree powstaje na baseSha.
- Status: `IN_PROGRESS` — **config parser DONE**: `apps/agent-worker/src/workspace-config.ts`
  (`workspaceConfigFromEnv`, fail-closed) + test **7/7** (`test/workspace-config.test.ts`).
  Pozostaje: budowa `LocalWorkspaceAdapter` w workerze + bridge fence (`bindWorkspaceFence` z
  `WriterLeaseGuard` fence) + registry (`adaptWorkspaceRepository` nad `WorkspaceRepository`) +
  provisioning na starcie IMPLEMENTERa. Owner config gotowy: `~/.remoteagent-workspace.env`
  (repo `sondermind-ios` → `/Users/marcinjackowski/Sondermind/sondermind-client-native-ios`, base
  `main`). NIEZACOMMITOWANE.

### Znane bridge'e (dla dalszej budowy WU-02)

- Fence: `bindWorkspaceFence(identity, db, durableFence)` (`fencing.ts:25`), gdzie `durableFence` to
  `WriterLeaseGuard` `WorkspaceFence` (ma `caseId/leaseOwner/fencingToken/assertCurrent(query)`).
  `WorkspaceFence` dla `create` = `{leaseOwner, fencingToken}` z lease'a joba.
- Registry: `adaptWorkspaceRepository(new WorkspaceRepository(), db, workspaceRoot)`
  (`recovery.ts:26`) → `WorkspaceRegistry`. `workspaces` ma UNIQUE(case_id) = single-writer.
- `LocalWorkspaceAdapter.create` waliduje `caseId/workspaceId/repoId` przez `/^[A-Za-z0-9._-]+$/`,
  wymaga ledgerRoot POZA workspaceRoot; mirror ~2.9G przy pierwszym `ensureMirror` (repo iOS).

## WU-03 — Toolset implementation-tools w roli IMPLEMENTER

- Rezultat: adapter `implementation-tools` → `RuntimeToolDefinition[]` + `ToolExecutor`
  (`execute(name,input,signal)` mapuje na metody toolsetu, zwraca `implementationToolResult` jako
  `RuntimeJsonValue`), wpięty w `createRole` per-invoke **tylko** dla IMPLEMENTERa gdy jest fence;
  `runStructuredCompletion({messages, tools, execute})`. Read-only role bez zmian.
- Weryfikacja: FakeTransport emituje tool-use → executor wykonuje na worktree → completion. Mutation:
  brak fence → brak write-tooli.
- Status: `TODO`.

## WU-04 — baseSha/branch policy

- Rezultat: deterministyczny branch per case (`git-lifecycle.branchNameFor`), base z konfigurowalnej
  gałęzi; commit lokalny przez `git-lifecycle` (push NIE w allowliście subkomend).
- Weryfikacja: test — branch nazwany per case, commit lokalny powstaje.
- Status: `TODO`.

## WU-05 — Live smoke (config właściciela)

- Rezultat: realny model edytuje plik i robi lokalny commit; owner podaje `WORKSPACE_ROOT` + repo.
- Weryfikacja: commit na branchu case'a w worktree, pod fence.
- Status: `BLOCKED` (czeka na config właściciela).

## Bramka taska

`typecheck --force`, `build --force`, `lint`, `format`, pełny `vitest run` (dwa przebiegi, Node 24).
Środowisko DB: PG15/5432 przez `RA_PG*` override (PG17/5433 zniknął — zob. handoff RA-033).
