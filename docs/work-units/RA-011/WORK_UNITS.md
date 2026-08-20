# RA-011 — Work units

## Metadata

- Task: `RA-011`
- Plan revision: `1`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `DRAFT`
- Base commit/tree: `4a4094d1c8a87cb649c7a3277720adea6ddb7fcf`
- Full-task verification: `pnpm vitest run packages/repository-planner/test`

## Global boundaries

- In scope: wyłącznie read-only discovery repozytorium, wersjonowany profil i
  audytowalny plan związany z base SHA oraz digestem instrukcji.
- Out of scope: edycja repozytorium, tworzenie brancha, implementacja, commit,
  push i wykonywanie zewnętrznych side effects.
- Treść plików repozytorium, w tym tekst wyglądający jak prompt, jest
  `UNTRUSTED_DATA`; authority instrukcji wynika z deterministycznej polityki
  ścieżek i precedence, nigdy z deklaracji znalezionej w treści.
- Plan pozostaje zablokowany do `DONE` RA-010; przed dispatch Sol zrewiduje
  publiczne API runnera i zapisze nowy base commit.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-011-WU-01` | `BLOCKED` | wersjonowane kontrakty profilu i planu | RA-010 DONE |
| `RA-011-WU-02` | `BLOCKED` | deterministic instruction discovery i precedence | WU-01 |
| `RA-011-WU-03` | `BLOCKED` | ograniczone read-only narzędzia discovery | WU-01, WU-02 |
| `RA-011-WU-04` | `BLOCKED` | RepositoryProfile związany z base SHA | WU-02, WU-03 |
| `RA-011-WU-05` | `BLOCKED` | complete requirement-to-plan mapping | WU-01, WU-04 |
| `RA-011-WU-06` | `BLOCKED` | material ambiguity do DecisionRequest | WU-05, RA-008 |
| `RA-011-WU-07` | `BLOCKED` | stale-plan invalidation | WU-04, WU-05 |
| `RA-011-WU-08` | `BLOCKED` | read-only Planner integration proof | WU-03, WU-06, WU-07 |

## `RA-011-WU-01` — Repository and plan contracts

- Result: strict, wersjonowane `RepositoryProfile` i `ImplementationPlan` mają
  zamknięte runtime schemas oraz provenance/digest fields.
- Allowed paths: `packages/contracts/src/repository-profile.ts`,
  `implementation-plan.ts`, `src/index.ts`, `test/repository-planning.test.ts`,
  schema snapshots i sanitized fixtures tego testu.
- Context pack: `docs/tasks/RA-011.md`, istniejące common/trust/artifact/decision
  contracts oraz accepted public identity z RA-010.
- Acceptance: profil wiąże repo/base SHA/instruction digest/discovered commands;
  plan mapuje requirement IDs na kroki, evidence i DoD; unknown/extra fields oraz
  surowe host paths są odrzucane.
- Verification: `pnpm vitest run packages/contracts/test/repository-planning.test.ts`.
- Out of scope: filesystem discovery i generowanie planu.
- Sol gate: schema/golden snapshot nie zawiera sekretu, raw prompt authority ani
  write-capability.

## `RA-011-WU-02` — Instruction discovery and precedence

- Result: walker odkrywa root/nested `AGENTS.md` i jawne scoped variants z
  provenance, deterministic precedence oraz konfliktem zamiast zgadywania.
- Allowed paths: `packages/repository-planner/package.json`, `tsconfig.json`,
  `src/instructions.ts`, `src/errors.ts`, `src/index.ts`,
  `test/instructions.test.ts`, `test/fixtures/instructions/**`, `pnpm-lock.yaml`.
- Context pack: WU-01, accepted RA-010 read/path APIs, repo instruction protocol.
- Acceptance: root→nested precedence jest zależne wyłącznie od canonical relative
  path/scope; symlink/escape i duplicate ambiguous scope failują; prompt-like text
  pozostaje opisaną treścią `UNTRUSTED_DATA`, nie zmienia polityki.
- Verification: `pnpm vitest run packages/repository-planner/test/instructions.test.ts`.
- Out of scope: README/manifests i plan generation.
- Sol gate: adversarial fixtures dla nested conflict, traversal, symlink oraz
  instrukcji próbującej nadać sobie wyższy authority.

## `RA-011-WU-03` — Bounded read-only discovery tools

- Result: planner otrzymuje tylko bounded tree/search/read/symbol/config
  inspection nad zweryfikowanym workspace.
- Allowed paths: `src/read-tools.ts`, `src/discovery-policy.ts`,
  `src/config-discovery.ts`, `test/read-tools.test.ts`,
  `test/config-discovery.test.ts`, `test/fixtures/discovery/**`, `src/index.ts`.
- Context pack: WU-01/02, accepted RA-010 confinement i command boundary,
  typowe manifests/README/CONTRIBUTING/CI configs.
- Acceptance: limity bytes/files/depth/results są server-owned; binary, secret
  files, `.git` i path escape są odrzucone; manifest/CI/test commands są tylko
  danymi z provenance i nie są wykonywane.
- Verification: `pnpm vitest run packages/repository-planner/test/read-tools.test.ts packages/repository-planner/test/config-discovery.test.ts`.
- Out of scope: shell execution i model call.
- Sol gate: tool manifest nie ma write/delete/exec, a oversize i symlink race
  failują przed zwróceniem treści.

## `RA-011-WU-04` — RepositoryProfile builder

- Result: deterministic builder tworzy kompletny profil związany z exact base SHA
  i canonical digestem efektywnych instrukcji.
- Allowed paths: `src/profile.ts`, `src/digest.ts`, `test/profile.test.ts`,
  `test/fixtures/profile/**`, `src/index.ts`.
- Context pack: WU-01/02/03 oraz RA-010 snapshot/base identity.
- Acceptance: ta sama zawartość w innej kolejności odczytu daje identyczny profil;
  każdy fact ma source path/digest; nieczytelny obowiązkowy plik daje typed
  incomplete profile zamiast cichego pominięcia.
- Verification: `pnpm vitest run packages/repository-planner/test/profile.test.ts`.
- Out of scope: plan generation.
- Sol gate: permutation test oraz scan profilu na credentials/private host paths.

## `RA-011-WU-05` — ImplementationPlan compiler

- Result: czysty compiler waliduje plan tak, aby każdy requirement miał krok,
  test/evidence, ryzyko i Definition of Done.
- Allowed paths: `src/plan.ts`, `src/coverage.ts`, `src/plan-errors.ts`,
  `test/plan.test.ts`, `test/coverage.test.ts`, `src/index.ts`.
- Context pack: WU-01/04, task acceptance shape i Planner role z RA-009.
- Acceptance: requirement bez kroku lub evidence failuje; kroki mają jawne
  zależności i bounded file areas; plan nie może deklarować write toola ani
  authority spoza profilu/task inputu.
- Verification: `pnpm vitest run packages/repository-planner/test/plan.test.ts packages/repository-planner/test/coverage.test.ts`.
- Out of scope: wywołanie modelu i wykonanie planu.
- Sol gate: coverage matrix z missing/duplicate/cyclic step i forged test result.

## `RA-011-WU-06` — Material ambiguity boundary

- Result: materialna niejasność kończy planowanie wersjonowanym
  `DecisionRequest`, a nie dowolnym defaultem.
- Allowed paths: `src/ambiguity.ts`, `test/ambiguity.test.ts`, `src/index.ts`.
- Context pack: WU-05 oraz accepted RA-008 decision preparation/contracts.
- Acceptance: tylko server-defined ambiguity classes otwierają decyzję; request
  wiąże case/checkpoint/profile/requirement; duplicate exact jest stabilny, a
  stale/foreign answer nie modyfikuje planu.
- Verification: `pnpm vitest run packages/repository-planner/test/ambiguity.test.ts`.
- Out of scope: Discord interaction i resume wykonania.
- Sol gate: pytanie nie kopiuje sekretów ani nie traktuje repo text jako opcji
  autoryzacyjnej.

## `RA-011-WU-07` — Stale plan invalidation

- Result: zmiana base SHA, efektywnego instruction digest albo contract version
  unieważnia plan według jawnej, czystej reguły.
- Allowed paths: `src/staleness.ts`, `test/staleness.test.ts`, `src/index.ts`.
- Context pack: WU-01/04/05 i RA-010 base/digest identity.
- Acceptance: exact replay pozostaje valid; każda authoritative zmiana daje
  typed stale reason; timestamp, kolejność odczytu i nieistotne metadata nie
  powodują fałszywej nieważności.
- Verification: `pnpm vitest run packages/repository-planner/test/staleness.test.ts`.
- Out of scope: automatyczne rebase/replan.
- Sol gate: boundary table SHA/instructions/schema oraz canonicalization test.

## `RA-011-WU-08` — Planner integration proof

- Result: fixture repo przechodzi discovery→profile→plan/decision i restart bez
  żadnego zapisu do workspace.
- Allowed paths: `test/planner.integration.test.ts`, `test/fake-planner.ts`,
  `test/fixtures/planner/**`, `src/planner.ts`, `src/index.ts` oraz konieczny
  read-only manifest assertion w `packages/agent-orchestrator/test/role-registry.test.ts`.
- Context pack: wszystkie zaakceptowane RA-011 units, RA-008 decisions, RA-009
  Planner registry i RA-010 read-only workspace APIs.
- Acceptance: nested/adversarial fixture daje kompletny provenance i coverage;
  ambiguity daje DecisionRequest; zmieniony SHA/instruction wymusza replan, a
  write/exec/delete invocation jest niereprezentowalne i filesystem pozostaje
  byte-for-byte bez zmian.
- Verification: `pnpm vitest run packages/repository-planner/test/planner.integration.test.ts packages/agent-orchestrator/test/role-registry.test.ts`.
- Out of scope: implementer dispatch i Git lifecycle.
- Sol gate: before/after tree digest, reviewed tool manifest i restart proof.

## Final task gate

Sol uruchamia full suite, sprawdza adversarial instruction precedence, bounded
read tools, requirement coverage, DecisionRequest, stale invalidation i brak
write capability. Następnie tworzy handoff oraz niezależny audyt RA-011.
