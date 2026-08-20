# RA-014 — Work units

## Metadata

- Task: `RA-014`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES` (RA-010 `DONE`,
  RA-012 `IN_PROGRESS`, RA-013 `BLOCKED_BY_DEPENDENCIES`). Plan nie zmienia statusu
  taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `pnpm vitest run packages/git-lifecycle/test`

## Global boundaries

- In scope: bezpieczne, idempotentne operacje branch/status/diff/stage/commit oraz
  kontrolowany fetch/rebase w obrębie jednego case workspace.
- Out of scope: remote push, GitLab MR i automatyczny merge — należą do RA-017.
- **Zakaz destrukcyjnych operacji:** `push --force`, `reset --hard`, broad
  `checkout`, zmiany protected branches. Każdy zakaz musi mieć test negatywny.
- Dirty user changes muszą być wykryte i nigdy cicho nadpisane.

## Ustalenia z kodu przed planowaniem (2026-08-20)

Sprawdzone w `packages/workspace-runner/src/git.ts`, nie założone:

1. **Istnieje wąska, bezpieczna warstwa Git** używająca `execFile` (tablica
   argumentów, nie shell — brak ryzyka wstrzyknięcia przez metaznaki):
   `ensureMirror`, `verifyCommit`, `addWorktree`, `worktreeHead`. RA-014 buduje na
   niej; nie tworzy drugiego wrappera i nie przechodzi na shell.
2. **Walidacja nazwy brancha już istnieje** w `addWorktree`:
   `/^[A-Za-z0-9][A-Za-z0-9._/-]*$/` z jawnym odrzuceniem `..`. Konwencja
   `agent/<task>-<slug>` musi się w niej mieścić — mieści się (`/` jest dozwolony).
   Nie osłabiać tego wzorca.
3. **`verifyCommit` wymaga exact 40-hex SHA** i sprawdza, że rozwiązuje się do
   żądanego commita. Binding base SHA opiera się na nim.
4. **Model architektoniczny to mirror + worktree**, nie zwykły clone. To istotne
   dla idempotencji: `addWorktree` z `-b` **failuje**, jeśli branch już istnieje,
   więc AC1 („resume nie tworzy drugiego brancha") wymaga jawnej ścieżki resume,
   a nie ponownego `addWorktree`. To najbardziej prawdopodobne miejsce błędu w tym
   tasku.
5. **`runGit` ma `maxBuffer: 1024 * 1024`.** Duży `git diff` może przekroczyć 1 MB
   i wywalić się błędem `ENOBUFS`, a nie zwrócić obciętego wyniku. Tool `diff`
   musi to obsłużyć jawnie (bounded output + jawna informacja o obcięciu), nie
   pozwolić na nieczytelny crash.
6. **Brak jakiegokolwiek kontraktu Git w `packages/contracts/src/`** — trzeba go
   stworzyć.
7. Numer migracji: `026` zajęte, `027` bierze RA-012. RA-014 (jeśli będzie
   potrzebował trwałego stanu) musi wziąć następny wolny po ponownym sprawdzeniu.

## Decyzje architektoniczne do potwierdzenia przy starcie

1. **Nowy pakiet `@remoteagent/git-lifecycle`.** `workspace-runner` pozostaje
   warstwą niższą (mirror/worktree/path policy); lifecycle brancha, commit policy i
   evidence binding to warstwa wyżej, konsumowana przez RA-015 i RA-017.
2. **Commit evidence binding zależy od RA-013.** AC3 wymaga powiązania commita z
   test evidence albo jawnego oznaczenia `unverified`, więc kontrakt musi
   referencować `TestRun` z RA-013 — dlatego RA-014 zależy od RA-013, nie odwrotnie.
3. **Uwaga na kolizję nazw eksportów** — patrz finding w
   `docs/work-units/RA-012/WORK_UNITS.md`. Nowy pakiet nie może eksportować nazwy
   już eksportowanej przez `@remoteagent/contracts`.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-014-WU-01` | `DRAFT` | strict Git lifecycle contracts | RA-013 DONE |
| `RA-014-WU-02` | `DRAFT` | idempotentny branch create + resume | WU-01 |
| `RA-014-WU-03` | `DRAFT` | status/diff z bounded output i dirty detection | WU-01 |
| `RA-014-WU-04` | `DRAFT` | stage allowlisted paths + commit z evidence binding | WU-02, WU-03 |
| `RA-014-WU-05` | `DRAFT` | conflict-safe fetch/rebase → durable blocker | WU-04 |
| `RA-014-WU-06` | `DRAFT` | final proof + macierz zakazów destrukcyjnych | WU-05 |

## Wymagania do rozdzielenia na units

- **AC1 (resume nie tworzy drugiego brancha)** → `WU-02`. Krytyczne: `addWorktree`
  używa `-b`, które failuje na istniejącym branchu; resume musi być osobną,
  jawną ścieżką. Test: dwa kolejne wywołania dla tego samego case dają jeden
  branch i ten sam head.
- **AC2 (brak stage/commit spoza workspace/scope)** → `WU-04`; wykorzystać
  `WorkspacePathPolicy` z `workspace-runner`; testy symlink i submodule boundary.
- **AC3 (commit związany z test evidence albo jawnie `unverified`)** → `WU-01`
  (kontrakt nie pozwala pominąć tego pola) + `WU-04`.
- **AC4 (rebase conflict bez automatycznego rozwiązania)** → `WU-05`; konflikt daje
  trwały decision/blocker, nigdy `-X ours/theirs` ani automatycznego `rerere`.
- **AC5 (dirty user changes nigdy cicho nadpisane)** → `WU-03` + `WU-05`;
  wykorzystać `WorkspaceDirtyState` (`CLEAN | DIRTY | AMBIGUOUS`) z
  `workspace-runner/src/types.ts` — `AMBIGUOUS` już istnieje w kontrakcie i musi
  być respektowany, nie sprowadzany do `DIRTY`.
- **AC6 (zakazane komendy mają testy negatywne)** → `WU-06`; jawna macierz:
  `push --force`, `reset --hard`, `checkout .`, `clean -fdx`, operacje na protected
  branches.

## Final task gate

Koordynator uruchamia pełną suite pakietu, całe repo bez regresji,
typecheck/build/scoped lint/format, `pnpm workflow:validate`, `git diff --check`,
sondę przecięcia eksportów, oraz osobno weryfikuje sześć kryteriów akceptacji — w
szczególności podwójny resume, stage poza scope, konflikt rebase i pełną macierz
zakazów destrukcyjnych. Następnie handoff i niezależny audyt.
