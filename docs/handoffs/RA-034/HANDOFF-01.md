# RA-034 — HANDOFF-01

- Task: `RA-034` Agent DZIAŁA: IMPLEMENTER → realny lokalny commit
- Data: `2026-08-25`
- Bazowy commit: `7aa6ccb`
- Status po tym handoffie: `BLOCKED` (superseded — Decision Request niżej)

## Decision Request — supersedowanie przez milestone M8

RA-034 zostaje **wstrzymany i zastąpiony** przez milestone **M8 „Engineering Loop"**
(`ADR-0011`, core RA-037..RA-044, kwalifikacja iOS RA-045). Decyzja właściciela
`2026-08-25`: write-loop budujemy jako jeden human-steered, durable Engineering Control Plane
w istniejącym `SupervisorRuntime`, z program design i vertical slices, a nie jako ad-hoc
IMPLEMENTER ani drugi orchestrator. RA-034 w obecnym kształcie
(pojedynczy IMPLEMENTER → worktree → write-tools → commit) jest podzbiorem tego, co M8 robi
lepiej i z recovery/pamięcią.

Dlatego RA-034 przechodzi w `BLOCKED` (nie DONE, nie porzucony): jego zakres wchłania M8.

## Co zostaje użyteczne (wejście do M8)

Zaczątki RA-034 (zacommitowane `2cf73b6`) NIE są odpadem — zasilają M8:

- `packages/database/src/repositories/implementer-work.ts` — single-writer guard + materializacja
  IMPLEMENTERa. Wejście do **RA-041** (workflow stages) i **RA-043** (slice/git/review pod fence).
  UWAGA: payload writer-joba wymaga przeróbki na `{workUnitId, runId}` na *claimed* unicie
  (finding WU-01 w `docs/work-units/RA-034/WORK_UNITS.md`) — rozstrzygane w RA-041.
- `apps/agent-worker/src/workspace-config.ts` + test — fail-closed parser `RA_WORKSPACE_*`.
  Wejście do **RA-043/RA-045** (provisioning worktree + iOS config). Owner config gotowy:
  `~/.remoteagent-workspace.env` (repo `sondermind-ios` → lokalna ścieżka, base `main`).

Szczegóły w `docs/work-units/RA-034/WORK_UNITS.md` (WU-00 CTF-020 już DONE/zacommitowany,
WU-01 finding, WU-02 config parser) — czytać przy RA-041/RA-043/RA-045.

## Stan drzewa

Czyste (RA-034 scaffolding zacommitowany `2cf73b6`, CTF-020 `3a0c5ed`). `push`/MR — osobna zgoda.
Odblokowanie: gdyby M8 został porzucony, RA-034 wraca jako READY (zależność RA-033 DONE).
