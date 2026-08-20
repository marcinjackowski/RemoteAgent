# RA-013 — Work units

## Metadata

- Task: `RA-013`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES` (RA-010 `DONE`,
  RA-012 `IN_PROGRESS`). Plan nie zmienia statusu taska ani nie omija zależności;
  koordynator sprawdzi go ponownie z aktualnym kodem przy starcie.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/test-evidence/test`

## Global boundaries

- In scope: deterministyczne uruchamianie weryfikacji i przechowywanie dowodów
  niezależnych od deklaracji modelu.
- Out of scope: independent code review (RA-015), Git commit (RA-014), provider CI.
- **Model nie może zapisać `PASS`.** Verdict jest wyprowadzany deterministycznie z
  trwałego `TestRun` receipt; rola Verification interpretuje wyniki, ale nie może
  ich sfałszować.
- Każdy wynik jest związany z konkretnym workspace oraz commit/tree digest.
- Output testów jest `UNTRUSTED_DATA`; sekrety redagowane w excerptach **i** w
  pełnych przechowywanych logach.

## Ustalenia z kodu przed planowaniem (2026-08-20)

Sprawdzone w repozytorium, nie założone:

1. **Nie ma jeszcze żadnych kontraktów `TestRun`/`ArtifactReference`.**
   `packages/contracts/src/` nie zawiera modułu artefaktów — trzeba je stworzyć.
2. **Redakcja sekretów już istnieje:** `packages/observability/src/redaction.ts`
   udostępnia `SecretRedactor` z `redactString` i `RedactionOptions`. RA-013 musi
   go **użyć**, nie pisać drugiego mechanizmu. Duplikat redaktora byłby findingiem.
3. **Uruchamianie procesów już istnieje:** `runProcess` z
   `packages/workspace-runner/src/process-runner.ts` ma `ProcessLimits`
   (`timeoutMs`, `outputBytes`), `timedOut`, `outputTruncated`, env allowlistę
   (`LANG`/`LC_ALL`/`LC_CTYPE`/`TZ`) i `NetworkMode`. RA-013 buduje **na nim**,
   nie tworzy drugiego runnera. Uwaga: `cpuTimeMs`/`memoryBytes` są odrzucane
   kodem `NOT_ENFORCEABLE` na tym adapterze — kryterium „OOM różni się od failed
   assertion" musi to uwzględnić i nie może udawać, że OOM jest wykrywalny przez
   limit pamięci.
4. **Tree digest już istnieje:** `computeTreeDigest` i `inspectWorkspace` w
   `workspace-runner/src/digest.ts` — binding wyniku do stanu drzewa opiera się na
   nich.
5. Najwyższa migracja to `026`; RA-012 zajmuje `027`. RA-013 musi wziąć **następny
   wolny numer po ponownym sprawdzeniu** — nie rezerwować teraz.

## Decyzje architektoniczne do potwierdzenia przy starcie

1. **Nowy pakiet `@remoteagent/test-evidence`**, nie rozszerzanie
   `workspace-runner` ani `implementation-tools`. Uzasadnienie: evidence boundary
   jest konsumowany przez RA-015, RA-017 i RA-021, więc musi być samodzielnym,
   stabilnym kontacktem, a nie doczepką do warstwy wykonawczej.
2. **Artifact store jako port z adapterem lokalnym.** Interfejs musi dopuszczać
   przyszły adapter S3 bez zmiany kontraktu (RA-025).
3. **Uwaga na kolizję nazw eksportów** — patrz finding w
   `docs/work-units/RA-012/WORK_UNITS.md`. Nowy pakiet nie może eksportować nazwy
   już eksportowanej przez `@remoteagent/contracts` (ESM cicho usuwa niejednoznaczne
   nazwy z `export *`). Sprawdzić sondą przecięcia eksportów przed zamknięciem taska.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-013-WU-01` | `DRAFT` | strict `TestRun` + `ArtifactReference` contracts | RA-012 DONE |
| `RA-013-WU-02` | `DRAFT` | local artifact store z integralnością i digestem | WU-01 |
| `RA-013-WU-03` | `DRAFT` | test runner nad `runProcess` z klasyfikacją błędów | WU-01, WU-02 |
| `RA-013-WU-04` | `DRAFT` | snapshot evidence i klasyfikacja diffów | WU-01, WU-02 |
| `RA-013-WU-05` | `DRAFT` | evidence composition + Verification role | WU-03, WU-04 |
| `RA-013-WU-06` | `DRAFT` | final integration/evidence proof | WU-05 |

## Wymagania do rozdzielenia na units

Mapowanie kryteriów akceptacji taska na units — do uszczegółowienia przy starcie:

- **AC1 (model nie zapisze `PASS` bez receiptu)** → `WU-01` (kontrakt nie pozwala
  wyrazić verdictu bez referencji do `TestRun`) + `WU-05` (Verification role) +
  `WU-06` (dowód adwersarialny: próba sfałszowania `PASS` jest odrzucana).
- **AC2 (binding do workspace i commit/tree digest)** → `WU-01` + `WU-03`, oparte
  na `computeTreeDigest`.
- **AC3 (snapshot update z diffem i uzasadnieniem)** → `WU-04`; brak uzasadnienia
  musi blokować akceptację snapshotu (anty-rubber-stamping).
- **AC4 (timeout/cancel/OOM ≠ failed assertion)** → `WU-03`; wykorzystać
  `timedOut` z `runProcess`; **OOM traktować ostrożnie** — adapter nie wymusza
  limitu pamięci, więc OOM rozpoznawać po sygnale procesu, nie po limicie.
- **AC5 (redakcja w excerptach i pełnych logach)** → `WU-02` + `WU-03`, przez
  `SecretRedactor`; test z canary secret w obu miejscach.
- **AC6 (retention/size limits nie usuwają metadanych audytowych)** → `WU-02`;
  test dowodzący, że po przycięciu artefaktu metadane i digest zostają.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, sondę przecięcia eksportów, oraz osobno weryfikuje sześć
kryteriów akceptacji — w szczególności próbę sfałszowania `PASS` bez receiptu i
redakcję canary secret w pełnym artefakcie. Następnie handoff i niezależny audyt.
