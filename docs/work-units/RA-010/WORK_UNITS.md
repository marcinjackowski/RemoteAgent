# RA-010 — Work units

## Metadata

- Task: `RA-010`
- Plan revision: `14`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `ACTIVE`
- Base commit/tree: `d17bd06cce77e693ca300a7d9959b0e5ed070e10`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/workspace-runner/test`

## Global boundaries

- In scope: lokalny, izolowany i odzyskiwalny workspace runner.
- Out of scope: model file tools, semantyka testów, commit/push i AgentCore.
- Każda destrukcyjna operacja wymaga wcześniejszej walidacji kanonicznego rootu.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-010-WU-01` | `ACCEPTED` | model-neutralne kontrakty workspace | — |
| `RA-010-WU-02` | `ACCEPTED` | bezpieczna walidacja root/path | WU-01 |
| `RA-010-WU-03` | `ACCEPTED` | repository mirror i create worktree | WU-02 |
| `RA-010-WU-04` | `ACCEPTED` | confined command runner i limity | WU-02 |
| `RA-010-WU-05` | `ACCEPTED` | operation log, digest i dirty state | WU-03, WU-04 |
| `RA-010-WU-06` | `ACCEPTED` | writer fencing | WU-03, RA-009-WU-05 |
| `RA-010-WU-07` | `READY` | resume i ambiguous recovery | WU-05, WU-06 |
| `RA-010-WU-08` | `BLOCKED` | bezpieczny cleanup | WU-02, WU-07 |
| `RA-010-WU-09` | `BLOCKED` | dwa izolowane worktrees end-to-end | WU-04, WU-08 |

## `RA-010-WU-01` — Workspace contracts

- Result: publiczny `WorkspaceRunner` interface i typed lifecycle results/errors.
- Allowed paths: `packages/workspace-runner/src/types.ts`, `errors.ts`, `runner.ts`,
  `test/contracts.test.ts`, `src/index.ts`.
- Context pack: `docs/tasks/RA-010.md`,
  `packages/contracts/src/{case,checkpoint,agent-run,work-unit}.ts` oraz publiczne
  `JobLease`/fencing semantics w `packages/database/src/queue/job-store.ts`.
- Acceptance: interface nie zależy od Docker/AgentCore/ECS; każda operacja ma
  case/workspace identity; destructive target nie jest surowym path stringiem.
- Verification: `pnpm vitest run packages/workspace-runner/test/contracts.test.ts`.
- Out of scope: filesystem i Git.
- Sol gate: compile-time boundary nie ujawnia host path modelowi.

## `RA-010-WU-02` — Root and path confinement

- Result: canonical path policy odrzuca traversal, escape, symlink i szeroki root.
- Allowed paths: `src/path-policy.ts`, `src/errors.ts`, `test/path-policy.test.ts`,
  `src/index.ts`.
- Context pack: WU-01, filesystem threat model, destructive-action rules.
- Acceptance: root/home/parent są odrzucone; symlink escape fail-closed;
  walidacja odbywa się przed create/delete/command.
- Verification: `pnpm vitest run packages/workspace-runner/test/path-policy.test.ts`.
- Out of scope: rzeczywiste usuwanie i Git.
- Sol gate: adversarial table dla `..`, prefix collision i symlink swap.

## `RA-010-WU-03` — Mirror and worktree creation

- Result: lokalny adapter tworzy dedykowany worktree z mirror/base SHA/branch intent.
- Allowed paths: `src/git.ts`, `src/local-adapter.ts`,
  `test/worktree.integration.test.ts`, `src/index.ts`,
  `packages/workspace-runner/package.json`.
- Context pack: WU-01/02, repo allowlist contracts, Git lifecycle constraints.
- Acceptance: base SHA jest jawny; case ma unikalny root; repo spoza allowlisty
  odrzucone przed Git command.
- Verification: `pnpm vitest run packages/workspace-runner/test/worktree.integration.test.ts`.
- Out of scope: command execution i cleanup.
- Sol gate: dwa worktrees tego samego fixture repo nie współdzielą zmian.

## `RA-010-WU-04` — Confined command runner

- Result: command execution ma stały cwd, timeout/resource limits i network policy.
- Allowed paths: `src/process-runner.ts`, `src/network-policy.ts`,
  `test/process-runner.test.ts`, `test/network-policy.test.ts`, `src/index.ts`.
- Context pack: WU-01/02, platform capabilities, no-secret environment policy.
- Acceptance: cwd nie wychodzi z rootu; timeout zabija proces tree; env nie zawiera
  repo credentials; network domyślnie deny albo jawnie `NOT_ENFORCEABLE` fail-closed.
- Verification: `pnpm vitest run packages/workspace-runner/test/process-runner.test.ts packages/workspace-runner/test/network-policy.test.ts`.
- Out of scope: semantyka konkretnych narzędzi build/test.
- Sol gate: potwierdzenie faktycznego enforcement, nie samej flagi konfiguracyjnej.

## `RA-010-WU-05` — Digest and operation ledger

- Result: immutable operation log oraz deterministyczny tree digest/dirty state.
- Allowed paths: `src/digest.ts`, `src/operation-log.ts`, `src/local-adapter.ts`,
  `test/digest.test.ts`, `test/operation-log.integration.test.ts`.
- Context pack: WU-03/04, persistence/audit patterns, run-safety states.
- Acceptance: before/after digest na każdą mutację; log append-only;
  untracked/modified files dają jawny dirty state.
- Verification: `pnpm vitest run packages/workspace-runner/test/digest.test.ts packages/workspace-runner/test/operation-log.integration.test.ts`.
- Out of scope: checkpoint integration.
- Sol gate: digest stabilny dla kolejności odczytu i zmienia się po mutacji.

## `RA-010-WU-06` — Writer fencing

- Result: każda mutacja workspace wymaga aktualnego fencing tokenu.
- Allowed paths: `src/fencing.ts`, `src/local-adapter.ts`, `src/types.ts`,
  `test/fencing.integration.test.ts`, `test/worktree.integration.test.ts`,
  `src/index.ts`.
- Context pack: WU-03, zaakceptowany RA-009-WU-05 `WorkspaceFence` i
  `JobStore.assertCurrentLease`, workspace identity.
- Acceptance: stale writer nie tworzy ani nie modyfikuje pliku; validation następuje
  bezpośrednio przed każdą mutacją. Runner przyjmuje wyłącznie server-owned,
  wstrzyknięty validator authority; nie ufa samym polom owner/token z inputu.
  Validator wiąże workspace case z dokładnym RA-009 writer fence i wywołuje jego
  durable `assertCurrent` przy użyciu query poza modelem. Brak validatora,
  mismatch case/owner/token i wygasły/reclaimed lease failują przed `mkdir`, Git
  i ledger append; operacje odczytu nie wymagają writer lease i nie mutują.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/workspace-runner/test/fencing.integration.test.ts`.
- Out of scope: orchestrator scheduler.
- Sol gate: real-PG race revoke/reclaim-token vs create/write, drugi writer i
  forged fields; po odmowie brak pliku, worktree i operation receipt.

## `RA-010-WU-07` — Resume and recovery

- Result: restart odtwarza mapping i klasyfikuje workspace jako clean/dirty/ambiguous.
- Allowed paths: `src/recovery.ts`, `src/local-adapter.ts`,
  `test/recovery.integration.test.ts`, `src/index.ts`.
- Context pack: WU-05/06, DB workspace schema, run-safety AMBIGUOUS semantics.
- Acceptance: brak mapowania nie jest zgadywany; dirty tree nie jest resetowany;
  przerwany write nie jest automatycznie replayed.
- Verification: `pnpm vitest run packages/workspace-runner/test/recovery.integration.test.ts`.
- Out of scope: automatyczna naprawa Git.
- Sol gate: kill points przed i po operation-log receipt.

## `RA-010-WU-08` — Safe cleanup

- Result: cleanup usuwa wyłącznie zweryfikowany workspace i jest idempotentny.
- Allowed paths: `src/cleanup.ts`, `src/path-policy.ts`,
  `test/cleanup.test.ts`, `src/local-adapter.ts`, `src/index.ts`.
- Context pack: WU-02/07, worktree metadata, destructive action policy.
- Acceptance: root/parent/symlink target odrzucony; ponowienie po receipt jest
  bezpieczne; niejednoznaczny wynik nie usuwa szerszej ścieżki.
- Verification: `pnpm vitest run packages/workspace-runner/test/cleanup.test.ts`.
- Out of scope: global garbage collector.
- Sol gate: testy działają wyłącznie w dedykowanym `mktemp` root.

## `RA-010-WU-09` — End-to-end isolation

- Result: dwa cases tego samego repo wykonują rozłączne mutacje i recovery.
- Allowed paths: `test/isolation.integration.test.ts`,
  `test/runner-lifecycle.integration.test.ts`, `src/local-adapter.ts`, `src/index.ts`.
- Context pack: wszystkie zaakceptowane RA-010 public APIs i kryteria taska.
- Acceptance: brak cross-worktree zmian; stale writer i escape odrzucone;
  restart zachowuje poprawny digest/dirty state obu cases.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/workspace-runner/test/isolation.integration.test.ts packages/workspace-runner/test/runner-lifecycle.integration.test.ts`.
- Out of scope: commit/push i model file tools.
- Sol gate: pełna macierz kryteriów RA-010, w tym realne filesystem boundaries.

## Final task gate

Sol uruchamia full suite w izolowanym temp root, sprawdza symlink/path traversal,
stale fencing, kill/restart i network enforcement. Następnie tworzy handoff oraz
niezależny audyt RA-010.
