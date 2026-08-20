# RA-015 — Work units

## Metadata

- Task: `RA-015`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES` (RA-009 `DONE`,
  RA-011 `DONE`, RA-012 `IN_PROGRESS`, RA-013/RA-014 `BLOCKED_BY_DEPENDENCIES`).
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/review-loop/test`

## Global boundaries

- In scope: niezależny, bounded review/fix loop przed publikacją zmian.
- Out of scope: GitLab review comments, push/MR (RA-017) i security penetration
  testing (RA-024).
- **Reviewer jest read-only** i działa w świeżym model context. Nie modyfikuje kodu
  ani checkpoint authority fields.
- **Reviewer nie ufa opisowi Implementera** — ocenia rzeczywisty diff.
- Poprawki wracają wyłącznie przez single writera (Implementer).

## Ustalenia z kodu przed planowaniem (2026-08-20)

Sprawdzone w repozytorium, nie założone. RA-015 w dużej mierze **komponuje
istniejące, zaakceptowane mechanizmy** — nie buduje ich od zera:

1. **`REVIEWER` nie ma prawa zapisu — już zadekretowane w kontrakcie.**
   `packages/contracts/src/work-unit.ts` definiuje `ROLE_CAN_WRITE_WORKSPACE` z
   `REVIEWER: false` (tylko `IMPLEMENTER: true`) oraz dyskryminowany `workUnit` po
   `role`. AC1 opiera się na tym; unit ma to **wykorzystać i udowodnić testem
   capability**, nie tworzyć drugiego źródła prawdy.
2. **Budżet i limit iteracji już istnieją:**
   `packages/agent-orchestrator/src/supervisor/budget.ts` z `BudgetKind`
   (`ITERATION | FIX`), `BudgetLimits`, `BudgetLedger`, `InvalidBudgetError`.
   AC4 (bounded loop) buduje na `BudgetLedger`, nie na nowym liczniku.
3. **Deterministyczny merge równoległych read-only wyników już istnieje:**
   `supervisor/merge.ts` z `mergeReadOnlyResults`, `ReadOnlyMerge`,
   `ReadOnlyMergeValidationError`. Punkt scope „równoległe review z
   deterministycznym merge" ma tego użyć.
4. **Single-writer jest wymuszany leasem:** `supervisor/writer-lease.ts` z
   `WriterLeaseGuard`, `WRITER_JOB_TYPE = "agent.implementer"`, `WorkspaceFence`.
   Routing findingów do Implementera musi przechodzić przez ten lease.
5. **Kontrakt zakończenia agenta już istnieje:**
   `packages/contracts/src/agent-completion.ts` z wariantami `CONTINUE`,
   `WAITING_FOR_USER`, `BLOCKED`, `COMPLETED`, `FAILED`, `CANCELLED` i
   `TERMINAL_COMPLETION_STATUSES`. Eskalacja do właściciela i wyczerpany budżet
   powinny mapować się na istniejące warianty (`BLOCKED`/`WAITING_FOR_USER`), nie
   wprowadzać równoległej taksonomii.
6. **Nie ma jeszcze kontraktu `ReviewReport`** w `packages/contracts/src/` — trzeba
   go stworzyć.
7. Numer migracji: `026` zajęte, `027` bierze RA-012, RA-013/RA-014 wezmą kolejne.
   RA-015 musi wziąć następny wolny **po ponownym sprawdzeniu**.

## Decyzje architektoniczne do potwierdzenia przy starcie

1. **Nowy pakiet `@remoteagent/review-loop`**, konsumujący `agent-orchestrator`.
   Nie rozszerzamy `agent-orchestrator` o kontrakty review, bo jest zaakceptowany
   w RA-009 i używany przez scheduler/supervisor.
2. **Durable review/loop persistence w PostgreSQL, nie `JobStore`.** Ten sam
   argument co w RA-012: `JobStore` jest kolejką, nie authority stanu loopa.
   Preflight z handoffu transferowego zawierał to samo ostrzeżenie.
3. **Uwaga na kolizję nazw eksportów** — patrz finding w
   `docs/work-units/RA-012/WORK_UNITS.md`. Nowy pakiet nie może eksportować nazwy
   już eksportowanej przez `@remoteagent/contracts` ani przez
   `@remoteagent/agent-orchestrator`; ESM cicho usuwa niejednoznaczne nazwy z
   `export *`. Sprawdzić sondą przecięcia eksportów.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-015-WU-01` | `DRAFT` | strict `ReviewReport` contracts + severity policy | RA-014 DONE |
| `RA-015-WU-02` | `DRAFT` | read-only reviewer runtime (capability proof) | WU-01 |
| `RA-015-WU-03` | `DRAFT` | durable review/loop persistence | WU-01 |
| `RA-015-WU-04` | `DRAFT` | supervisor verdict + fix routing przez writer lease | WU-02, WU-03 |
| `RA-015-WU-05` | `DRAFT` | final bounded-loop proof + budget exhaustion | WU-04 |

## Wymagania do rozdzielenia na units

- **AC1 (Reviewer nie modyfikuje kodu ani checkpoint authority fields)** → `WU-02`;
  oparte na `ROLE_CAN_WRITE_WORKSPACE.REVIEWER === false`; test capability
  dowodzący braku write/exec tools w manifeście reviewera (wzór: sealed manifest
  Plannera z RA-011).
- **AC2 (PASS wymaga braku unresolved BLOCKER/HIGH/MEDIUM)** → `WU-01` (severity
  policy w kontrakcie) + `WU-04` (verdict). LOW i nit nie blokują.
- **AC3 (finding bez lokalizacji/evidence nie blokuje automatycznie)** → `WU-01`;
  kontrakt wymaga lokalizacji i evidence dla findingu blokującego; „to mogłoby być
  lepsze" nie jest blokerem. To zabezpieczenie przed odwrotnym rubber-stampingiem.
- **AC4 (jawny maksymalny limit, brak nieskończonego loopa)** → `WU-03` + `WU-05`;
  oparte na `BudgetLedger`; wyczerpany limit daje **trwały blocker** mapowany na
  istniejący wariant `agentCompletion`, nie cichy retry.
- **AC5 (każdy resolved finding wskazuje diff/test evidence poprawki)** → `WU-01` +
  `WU-04`; wymaga referencji do `TestRun` z RA-013 — stąd zależność od RA-013.
- **AC6 (Reviewer nie ufa opisowi Implementera)** → `WU-02` + `WU-05`; input
  reviewera to diff, plan, decisions, repo instructions i evidence; test
  adwersarialny: opis Implementera twierdzący „naprawiono", przy diffie który tego
  nie robi, musi dać finding, nie PASS.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, sondę przecięcia eksportów, oraz osobno weryfikuje sześć
kryteriów akceptacji — w szczególności próbę zapisu przez reviewera, PASS przy
otwartym MEDIUM, finding bez evidence, wyczerpanie budżetu i rozbieżność
opis-vs-diff. Następnie handoff i niezależny audyt.
