# RA-010 — Audit 01

## Metadata

- Task: `RA-010`
- Audytowany handoff: `docs/handoffs/RA-010/HANDOFF-01.md`
- Audytor: Sol, rola `COORDINATOR_AUDITOR`
- Implementer model/transport: `GPT-5.6 Luna / medium`
- Work-units plan: `docs/work-units/RA-010/WORK_UNITS.md`, revision `19`
- Data: 2026-08-20
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Izolacja worktrees, path confinement, writer fencing, recovery oraz destrukcyjny
cleanup są dobrze pokryte i przeszły niezależną regresję. Task nie może jednak
otrzymać `PASS`, ponieważ publiczny `WorkspaceRunner` deklaruje kontrolowany
lifecycle `snapshot`, a lokalny adapter nie implementuje tej operacji.

## Zakres audytu

- Przeczytane: task RA-010, plan revision 19, handoff 01, workflow i audit checklist.
- Sprawdzony kod kontraktów, path policy, Git/worktree, command/network policy,
  digest/ledger, fencing, recovery, cleanup oraz PostgreSQL workspace mapping.
- Sprawdzone niezależnie commity WU-01…WU-09 i testy zachowania.
- Równoległe zmiany `connector-jira` wyłączono z zakresu.
- Audyt nie edytował ocenianej implementacji.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| Rozłączne worktrees dwóch cases | PASS | real Git + real-PG isolation test |
| Brak filesystem escape | PASS | traversal, prefix, cwd i symlink matrix |
| Stale writer bez mutacji | PASS | real-PG revoke/reclaim dla create i destroy |
| Restart rozpoznaje clean/dirty/ambiguous | PASS | trwały mapping, strict ledger i kill-point tests |
| Bezpieczny destrukcyjny cleanup | PASS | exact target, inode continuity i no-follow ledger |
| Brak credentiali/host path w modelowym kontrakcie | PASS | publiczny `WorkspaceRunner` przyjmuje wyłącznie identity i repository ID |
| Kontrolowany lifecycle `create/resume/snapshot/destroy` | FAIL | `LocalWorkspaceAdapter.snapshot()` zawsze rzuca `INVALID_LIFECYCLE` |

## Findingi

### MEDIUM — RA010-A01-F01: lokalny adapter nie implementuje snapshot lifecycle

- Lokalizacja: `packages/workspace-runner/src/local-adapter.ts`, metoda `snapshot`.
- Dowód: każda próba snapshotu kończy się stałym `WorkspaceLifecycleError`; nie
  powstaje `WorkspaceSnapshotResult`, tree digest ani dirty state.
- Wpływ: zakres taska deklaruje kontrolowany `snapshot`, a kolejny planner/test
  evidence nie może uzyskać stabilnego, read-only obrazu workspace przez publiczny
  kontrakt runnera.
- Wymagana zmiana: zaimplementować read-only snapshot exact mapped workspace,
  wymagający server-owned mappingu i zgodnego `caseId/workspaceId`; zwracać
  deterministyczny digest i clean/dirty bez fence, zapisu, resetu ani odtwarzania.
  Brak/mismatch mappingu oraz symlink/escape/corrupt target mają failować zamknięcie.
  Dodać testy real filesystem/real-PG dla clean, dirty, restart, obcego case,
  missing mapping i symlink target oraz dowód, że snapshot nie zmienia ledgera,
  mappingu ani drzewa.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| real-PG `packages/workspace-runner/test` | 0 | 12/12 plików, 46/46 testów PASS |
| focused WU-09 integration | 0 | 2/2 pliki, 4/4 testy PASS |
| `workspace-runner` typecheck i build | 0 | PASS |
| scoped ESLint i Prettier | 0 | PASS; jedynie zastane warningi boundaries |
| `git diff --check` dla ocenianych commitów | 0 | clean |
| `pnpm workflow:validate` przed audytem | 0 | 26 tasków, PASS |

Raport implementera ani wcześniejsze unit gates nie zastąpiły samodzielnej
weryfikacji Sol.

## Ryzyka przekrojowe

- Network/CPU/RAM enforcement failuje jawnie jako `NOT_ENFORCEABLE`, gdy lokalna
  platforma nie potrafi egzekwować limitu; nie następuje ciche uruchomienie.
- Recovery nie resetuje dirty tree i nie replayuje niepotwierdzonej mutacji.
- Cleanup ma silniejsze zabezpieczenia inode/no-follow niż zwykła walidacja path.
- Publiczne exporty adaptera zawierają host config, lecz model-neutralny
  `WorkspaceRunner` nie przyjmuje host path ani credential values.

## Uzasadnienie werdyktu

Pozostał jeden finding klasy MEDIUM, więc `PASS` jest niedozwolony. Zakres fixu
jest mały i mieści się w RA-010, dlatego właściwy werdykt to `CHANGES_REQUIRED`.
