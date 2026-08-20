# RA-010 — Handoff 01

## Metadata

- Task: `RA-010`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: Sol, `COORDINATOR_AUDITOR`, na podstawie raportów implementera i niezależnych unit gates
- Implementer model/transport: `GPT-5.6 Luna / medium`
- Work-units plan: `docs/work-units/RA-010/WORK_UNITS.md`, revision `19`
- Zaakceptowane units: `WU-01`…`WU-09`
- Data: 2026-08-20
- Bazowy commit lub stan początkowy: `d17bd06cce77e693ca300a7d9959b0e5ed070e10`
- Końcowy commit ocenianej implementacji: `965300c`

## Wynik

Powstał lokalny, izolowany i odzyskiwalny workspace runner. Każdy case otrzymuje
osobny Git worktree pod kanonicznie zweryfikowanym rootem, każda mutacja wymaga
aktualnego writer fence, a trwały mapping i ścisły operation ledger pozwalają po
restarcie rozróżnić stan clean, dirty i ambiguous bez resetu ani zgadywania.

## Zrealizowany zakres

- model-neutralne kontrakty lifecycle bez ujawniania host path modelowi;
- canonical path confinement z ochroną traversal, prefix collision i symlink;
- allowlistowany repository mirror i dedykowane worktrees;
- confined command runner z timeoutem, ograniczonym env i fail-closed network policy;
- deterministyczny tree digest, dirty state i append-only operation ledger;
- trwały RA-009 writer fencing sprawdzany przed mutacją;
- recovery z server-owned PostgreSQL mappingiem i bez automatycznego replay/reset;
- idempotentny cleanup wyłącznie dokładnie zweryfikowanego targetu;
- dwa niezależne cases tego samego repo oraz pełny restart/lifecycle end-to-end.

## Wykonanie work units

| Unit | Commit | Dowód | Wynik |
|---|---|---|---|
| WU-01 | `55b1041` | `contracts.test.ts` | ACCEPTED |
| WU-02 | `4e0adf3` | `path-policy.test.ts` | ACCEPTED |
| WU-03 | `5462697` | `worktree.integration.test.ts` | ACCEPTED |
| WU-04 | `e3f03c2` | process/network policy tests | ACCEPTED |
| WU-05 | `074fc27` | digest i operation-log tests | ACCEPTED |
| WU-06 | `1192ee9` | real-PG fencing integration | ACCEPTED |
| WU-07 | `83a3853` | recovery/fault integration | ACCEPTED |
| WU-08 | `6982420` | adversarial cleanup tests | ACCEPTED |
| WU-09 | `965300c` | isolation i lifecycle real-PG | ACCEPTED |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Dwa cases tego samego repo mają rozłączne worktrees | PASS | dwa realne worktrees, rozłączne pliki/digesty i niezmienione source repo |
| Brak odczytu/zapisu poza rootem | PASS | traversal, prefix, cwd i symlink escape failują przed Git/mutacją |
| Stary writer nie zmienia workspace | PASS | real-PG revoke/reclaim; create i destroy kończą się `INVALID_FENCE` bez side effectu |
| Restart wykrywa clean/dirty/ambiguous | PASS | świeży registry/adapter, trwały exact mapping, fault i corrupt-ledger matrix |
| Cleanup odrzuca root, parent i symlink escape | PASS | canonical target, inode continuity, pinned no-follow ledger i adversarial tests |
| Model nie otrzymuje credentiali ani host paths | PASS | publiczne kontrakty używają identity/repository ID; env jest jawnie ograniczony |

## Testy i kontrole Sol

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| real-PG `packages/workspace-runner/test` | 0 | 12 plików, 46 testów PASS |
| focused WU-09 integration | 0 | 2 pliki, 4 testy PASS |
| `workspace-runner` typecheck i build | 0 | PASS |
| scoped ESLint | 0 | PASS; tylko zastane ostrzeżenia konfiguracji boundaries |
| scoped Prettier | 0 | PASS |
| `git diff --check` | 0 | clean |

## Bezpieczeństwo, współbieżność i recovery

- Destrukcyjny target powstaje z server-owned identity i jest walidowany przed użyciem.
- Writer authority pochodzi z trwałego lease/fencing tokenu, nie z deklaracji modelu.
- Intent mapping poprzedza mutację, a receipt/digest zamykają operację warunkowo.
- Brak, uszkodzenie albo przerwanie ledgera daje `AMBIGUOUS`, nigdy cichy replay.
- Cleanup chroni exact target przed zamianą ścieżki/inode i jest idempotentny po receipt.
- Testy restartu zachowują dirty tree bez resetu i nie zmieniają sąsiedniego case.

## Znane ograniczenia i ryzyka

- Lokalny adapter nie udaje twardej izolacji sieciowej, gdy platforma jej nie
  egzekwuje; taka konfiguracja failuje jawnie jako `NOT_ENFORCEABLE`.
- Produkcyjny AgentCore/ECS adapter, model file tools oraz Git commit/push należą
  do kolejnych tasków.

## Otwarte pytania

- Brak decyzji właściciela wymaganych do audytu.

## Stan dla audytora

- Oceniany zakres kończy się na commit `965300c`.
- Audyt ma niezależnie sprawdzić pełny diff od bazowego commita, real-PG tests,
  sandbox escape, writer fencing, recovery dirty/ambiguous oraz cleanup safety.
- Równoległych zmian `connector-jira` nie przypisywać do RA-010.
- Nie zmieniać implementacji RA-010 podczas audytu.
