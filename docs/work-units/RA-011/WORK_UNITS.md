# RA-011 — Work units

## Metadata

- Task: `RA-011`
- Plan revision: `3`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `ACTIVE`
- Base commit/tree: `a9e25dca0d29d4c96b0ad9c7d78daa258abc7647`
- Full-task verification: `pnpm vitest run packages/repository-planner/test`

## Global boundaries

- In scope: wyłącznie read-only discovery repozytorium, wersjonowany profil i
  audytowalny plan związany z base SHA oraz digestem instrukcji.
- Out of scope: edycja repozytorium, tworzenie brancha, implementacja, commit,
  push i wykonywanie zewnętrznych side effects.
- Treść plików repozytorium, w tym tekst wyglądający jak prompt, jest
  `UNTRUSTED_DATA`; authority instrukcji wynika z deterministycznej polityki
  ścieżek i precedence, nigdy z deklaracji znalezionej w treści.
- Planner otrzymuje sealed read-only capability zbudowane przez serwer nad
  zaakceptowanym RA-010 snapshot/path boundary. Nie otrzymuje `runProcess`,
  surowego host path ani konfiguracji repozytorium.
- Repository ID, exact base SHA i requirement set są server-owned inputs.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-011-WU-01` | `ACCEPTED` | wersjonowane kontrakty i sealed read-only port | RA-010 DONE |
| `RA-011-WU-02` | `RUNNING` | minimalny package scaffold | WU-01 |
| `RA-011-WU-03` | `BLOCKED` | deterministic instruction discovery i precedence | WU-02 |
| `RA-011-WU-04` | `BLOCKED` | ograniczone read-only narzędzia discovery | WU-03 |
| `RA-011-WU-05` | `BLOCKED` | RepositoryProfile związany z base SHA | WU-03, WU-04 |
| `RA-011-WU-06` | `BLOCKED` | complete requirement-to-plan mapping | WU-01, WU-05 |
| `RA-011-WU-07` | `BLOCKED` | material ambiguity do DecisionRequest | WU-06, RA-008 |
| `RA-011-WU-08` | `BLOCKED` | stale-plan invalidation | WU-05, WU-06 |
| `RA-011-WU-09` | `BLOCKED` | read-only Planner integration proof | WU-04, WU-07, WU-08 |

## `RA-011-WU-01` — Repository, plan and read-port contracts

- Result: strict, wersjonowane `RepositoryProfile`, `ImplementationPlan` i
  sealed `PlannerReadPort` mają zamknięte runtime schemas/capabilities.
- Allowed paths: `packages/contracts/src/repository-profile.ts`,
  `implementation-plan.ts`, `planner-port.ts`, `src/index.ts`,
  `test/repository-planning.test.ts`.
- Context pack: `docs/tasks/RA-011.md`, istniejące common/trust/artifact/decision
  contracts oraz accepted public identity z RA-010.
- Acceptance: profil wiąże server-owned repo/base SHA/instruction digest i
  bounded facts; plan mapuje requirement IDs na kroki, evidence i DoD.
  `PlannerReadPort` reprezentuje wyłącznie read/search/tree/symbol/config, bez
  exec/write/delete/git, credential values i raw host paths; unknown fields są
  odrzucane.
- Verification: `pnpm vitest run packages/contracts/test/repository-planning.test.ts`.
- Out of scope: filesystem discovery i generowanie planu.
- Sol gate: schema/golden snapshot nie zawiera sekretu, raw prompt authority ani
  write-capability.

## `RA-011-WU-02` — Package scaffold

- Result: minimalny `@remoteagent/repository-planner` package kompiluje się i
  eksportuje wyłącznie kontrakty potrzebne następnym units.
- Allowed paths: `packages/repository-planner/package.json`, `tsconfig.json`,
  `src/index.ts`, `pnpm-lock.yaml`.
- Context pack: WU-01 oraz package/tsconfig conventions repozytorium.
- Acceptance: package używa workspace dependencies i nie eksportuje host path,
  command runnera ani write capability; typecheck i build działają bez fixtures.
- Verification: `pnpm --filter @remoteagent/repository-planner typecheck && pnpm --filter @remoteagent/repository-planner build`.
- Out of scope: discovery behavior.
- Sol gate: publiczny export jest minimalny i model-neutralny.

## `RA-011-WU-03` — Instruction discovery and precedence

- Result: walker odkrywa root/nested `AGENTS.md` i jawne scoped variants z
  provenance, deterministic precedence oraz konfliktem zamiast zgadywania.
- Allowed paths: `packages/repository-planner/src/instructions.ts`,
  `src/errors.ts`, `src/index.ts`, `test/instructions.test.ts` oraz jawnie
  enumerowane pliki w `test/fixtures/instructions/`.
- Context pack: WU-01/02, accepted RA-010 read/path APIs, repo instruction protocol.
- Acceptance: root→nested precedence jest zależne wyłącznie od canonical relative
  path/scope; symlink/escape i duplicate ambiguous scope failują; prompt-like text
  pozostaje opisaną treścią `UNTRUSTED_DATA`, nie zmienia polityki.
- Verification: `pnpm vitest run packages/repository-planner/test/instructions.test.ts`.
- Out of scope: README/manifests i plan generation.
- Sol gate: adversarial fixtures dla nested conflict, traversal, symlink oraz
  instrukcji próbującej nadać sobie wyższy authority. Deterministyczny internal
  symlink-swap seam nie jest eksportowany z package ani przyjmowany od modelu.

## `RA-011-WU-04` — Bounded read-only discovery tools

- Result: planner otrzymuje tylko bounded tree/search/read/symbol/config
  inspection nad zweryfikowanym workspace.
- Allowed paths: `src/read-tools.ts`, `src/discovery-policy.ts`,
  `src/config-discovery.ts`, `test/read-tools.test.ts`,
  `test/config-discovery.test.ts`, `test/fixtures/discovery/**`, `src/index.ts`.
- Context pack: WU-01/03, accepted RA-010 confinement i snapshot boundary,
  typowe manifests/README/CONTRIBUTING/CI configs.
- Acceptance: limity bytes/files/depth/results są server-owned; binary, secret
  files, `.git` i path escape są odrzucone; manifest/CI/test commands są tylko
  danymi z provenance i nie są wykonywane.
- Verification: `pnpm vitest run packages/repository-planner/test/read-tools.test.ts packages/repository-planner/test/config-discovery.test.ts`.
- Out of scope: shell execution i model call.
- Sol gate: capability jest sealed przez server-owned verified workspace; tool
  manifest nie ma write/delete/exec, a oversize i symlink race failują przed
  zwróceniem treści. `runProcess` nie jest zależnością Plannera.

## `RA-011-WU-05` — RepositoryProfile builder

- Result: deterministic builder tworzy kompletny profil związany z exact base SHA
  i canonical digestem efektywnych instrukcji.
- Allowed paths: `src/profile.ts`, `src/digest.ts`, `test/profile.test.ts`,
  `test/fixtures/profile/**`, `src/index.ts`.
- Context pack: WU-01/03/04 oraz RA-010 snapshot/base identity.
- Acceptance: ta sama zawartość w innej kolejności odczytu daje identyczny profil;
  każdy fact ma source path/digest; nieczytelny obowiązkowy plik daje typed
  incomplete profile zamiast cichego pominięcia.
- Verification: `pnpm vitest run packages/repository-planner/test/profile.test.ts`.
- Out of scope: plan generation.
- Sol gate: permutation test oraz scan profilu na credentials/private host paths.

## `RA-011-WU-06` — ImplementationPlan compiler

- Result: czysty compiler waliduje plan tak, aby każdy requirement miał krok,
  test/evidence, ryzyko i Definition of Done.
- Allowed paths: `src/plan.ts`, `src/coverage.ts`, `src/plan-errors.ts`,
  `test/plan.test.ts`, `test/coverage.test.ts`, `src/index.ts`.
- Context pack: WU-01/05, server-owned requirement set i Planner role z RA-009.
- Acceptance: requirement bez kroku lub evidence failuje; kroki mają jawne
  zależności i bounded file areas; plan nie może deklarować write toola ani
  authority spoza profilu/task inputu.
- Verification: `pnpm vitest run packages/repository-planner/test/plan.test.ts packages/repository-planner/test/coverage.test.ts`.
- Out of scope: wywołanie modelu i wykonanie planu.
- Sol gate: coverage matrix z missing/duplicate/cyclic step i forged test result.

## `RA-011-WU-07` — Material ambiguity boundary

- Result: materialna niejasność kończy planowanie wersjonowanym
  `DecisionRequest`, a nie dowolnym defaultem.
- Allowed paths: `src/ambiguity.ts`, `test/ambiguity.test.ts`, `src/index.ts`.
- Context pack: WU-06 oraz accepted RA-008 decision preparation/contracts.
- Acceptance: tylko server-defined ambiguity classes otwierają decyzję; request
  wiąże case/checkpoint/profile/requirement; duplicate exact jest stabilny, a
  stale/foreign answer nie modyfikuje planu.
- Verification: `pnpm vitest run packages/repository-planner/test/ambiguity.test.ts`.
- Out of scope: Discord interaction i resume wykonania.
- Sol gate: pytanie nie kopiuje sekretów ani nie traktuje repo text jako opcji
  autoryzacyjnej.

## `RA-011-WU-08` — Stale plan invalidation

- Result: zmiana base SHA, efektywnego instruction digest albo contract version
  unieważnia plan według jawnej, czystej reguły.
- Allowed paths: `src/staleness.ts`, `test/staleness.test.ts`, `src/index.ts`.
- Context pack: WU-01/05/06 i RA-010 base/digest identity.
- Acceptance: exact replay pozostaje valid; każda authoritative zmiana daje
  typed stale reason; timestamp, kolejność odczytu i nieistotne metadata nie
  powodują fałszywej nieważności.
- Verification: `pnpm vitest run packages/repository-planner/test/staleness.test.ts`.
- Out of scope: automatyczne rebase/replan.
- Sol gate: boundary table SHA/instructions/schema oraz canonicalization test.

## `RA-011-WU-09` — Planner integration proof

- Result: fixture repo przechodzi discovery→profile→plan/decision i restart bez
  żadnego zapisu do workspace.
- Allowed paths: `test/planner.integration.test.ts`, `test/fake-planner.ts`,
  jawnie enumerowane pliki `test/fixtures/planner/`, `src/planner.ts`, `src/index.ts`.
- Context pack: wszystkie zaakceptowane RA-011 units, RA-008 decisions, RA-009
  Planner registry i RA-010 read-only workspace APIs.
- Acceptance: dwa cases dostają osobne sealed ports i server-owned repo/base/
  requirements; nested/adversarial fixture daje kompletne provenance/coverage,
  ambiguity daje DecisionRequest, a zmieniony SHA/instruction wymusza replan.
  Write/exec/delete jest niereprezentowalne, before/after snapshot identyczny,
  a deterministic symlink swap failuje zamknięcie.
- Verification: `pnpm vitest run packages/repository-planner/test/planner.integration.test.ts`.
- Out of scope: implementer dispatch i Git lifecycle.
- Sol gate: before/after tree digest, reviewed tool manifest i restart proof.

## Final task gate

Sol uruchamia full suite, sprawdza adversarial instruction precedence, bounded
read tools, requirement coverage, DecisionRequest, stale invalidation i brak
write capability. Następnie tworzy handoff oraz niezależny audyt RA-011.
