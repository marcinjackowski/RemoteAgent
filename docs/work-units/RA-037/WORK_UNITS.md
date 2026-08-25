# RA-037 — WORK_UNITS

- Task: `RA-037` Engineering workflow contracts i granica control plane
- Bazowy commit: `4b7dcdf567572d840ce7be5c6c268fc9276a3f52`
- Status: `DONE`
- ADR: `ADR-0011`, `ADR-0013`

## Stan wejściowy

- Drzewo jest celowo dirty przez zaakceptowane, niezacommitowane plany M8/M9 i
  konfigurację Sol/Luna; żadna zmiana produkcyjna RA-037 jeszcze nie istnieje.
- Jedyny production driver to
  `packages/agent-orchestrator/src/supervisor/runtime.ts::SupervisorRuntime`.
- `SupervisorStatus`, `WorkUnitStatus` i `RunSafetyState` pozostają bez zmian.
- Czyste kontrakty należą do `packages/contracts`; `agent-orchestrator` może
  dostać wyłącznie deklaratywny registry konsumowany później przez runtime.
- `canonicalJsonStringify`/`canonicalDigest` są jednym istniejącym źródłem
  kanonizacji i SHA-256; nie powstaje drugi algorytm.

## RA-037-WU-00 — Formalny start i zamrożenie granicy

**Status:** DONE

**Rezultat:** kolejka i task wskazują `IN_PROGRESS`, a ten plan przechowuje
rzeczywiste granice i następne kroki.

**Allowed paths:**

- `docs/tasks/TASK_INDEX.md`
- `docs/tasks/RA-037.md`
- `docs/work-units/RA-037/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm workflow:validate
```

Wynik: exit code `0`; `workflow:validate OK — 45 tasks`. PostgreSQL był `DOWN`,
ale ta bramka nie zawiera integracji DB.

## RA-037-WU-01 — Strict engineering artifacts i process-class policy

**Status:** DONE

**Rezultat:** versioned, strict kontrakty `OutcomeContract`, `SystemDesign`,
`ProgramDesign`, `SliceContract`, `ContextManifest`, `EvidenceBundle`,
`MemoryUpdate` oraz design/review/verification decisions; deterministyczna
server-owned policy odrzuca downgrade klasy procesu.

**Decyzje implementacyjne:**

- nowe kontrakty są prefiksowane `engineering*`, aby nie pogłębiać CTF-002;
- każdy standalone artifact ma `schema_version`, `artifact_kind`, binding
  `case_id/run_id`, revision i source/context digest tam, gdzie jest wymagany;
- `ProgramDesign` wymusza call-flow, file-tree delta, key types/signatures,
  uncertainty review, expected tests i kolejność slices;
- `SliceContract.observable_result` jest pojedynczym skalarem, gate IDs mają
  bezspacjowy format identyfikatora, a raw command jest odrzucany przez strict;
- `engineeringArtifactDigest` najpierw strict-parse'uje union, potem reużywa
  `canonicalDigest`; `schema_version` jest częścią hashowanego payloadu;
- policy input jest server-owned. Security/policy, migracja, nieodwracalny side
  effect lub szeroka zmiana publicznego kontraktu wymusza
  `LARGE_OR_HIGH_RISK`; wielomodułowość/nowy wzorzec/brak oracle wymusza co
  najmniej `MEDIUM`.

**Allowed paths:**

- `packages/contracts/src/engineering-workflow.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/schema.ts`
- `packages/contracts/test/engineering-workflow.test.ts`
- `packages/contracts/test/types.test-d.ts`
- `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm exec vitest run packages/contracts/test/engineering-workflow.test.ts packages/contracts/test/schema-snapshot.test.ts && pnpm --filter @remoteagent/contracts typecheck
```

Wynik: exit code `0`; `12/12` testów oraz typecheck kontraktów. Dodatkowy build
`@remoteagent/contracts` zakończył się exit code `0`, aby odświeżyć publiczne
typy konsumowane przez orchestrator.

## RA-037-WU-02 — Deklaratywny stage registry i no-second-driver guard

**Status:** DONE

**Rezultat:** rejestr stage→contract/role/artifacts i risk-dependent stage
sequences jest czystymi danymi. `SMALL` pomija product/system/program approval,
`MEDIUM` wymaga system+program design, `LARGE_OR_HIGH_RISK` wymaga outcome,
system, program i approval; każda ścieżka zachowuje slice→gate→review→final
verification. Guard dowodzi, że moduł nie ma claim/enqueue/transition/finalize i
że `agent-orchestrator` nadal nie zależy od `database`.

**Allowed paths:**

- `packages/agent-orchestrator/src/engineering/registry.ts`
- `packages/agent-orchestrator/src/index.ts`
- `packages/agent-orchestrator/test/engineering-registry.test.ts`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm exec vitest run packages/agent-orchestrator/test/engineering-registry.test.ts packages/agent-orchestrator/test/supervisor-machine.test.ts && pnpm --filter @remoteagent/agent-orchestrator typecheck
```

Wynik: exit code `0`; `12/12` testów oraz typecheck orchestratora. Registry
rozróżnia modelowy `completion_contract` od server-owned `output_artifacts`,
więc gate nie przekazuje modelowi kontraktu `EvidenceBundle` z autorytetem
serwera.

## RA-037-WU-03 — Mutation evidence i pełna bramka taska

**Status:** DONE

**Rezultat:** zapisany dowód, że testy czerwienią się po celowym zepsuciu
strictness, process-class downgrade guard oraz no-second-driver boundary; po
przywróceniu pełna bramka jest zielona i niecache'owana.

**Allowed paths:**

- tymczasowo ścieżki WU-01/WU-02 wyłącznie do kontrolowanych mutacji i
  natychmiastowego przywrócenia;
- `docs/tasks/RA-037.md`
- `docs/work-units/RA-037/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm test && pnpm turbo run typecheck --force && pnpm turbo run build --force && pnpm workflow:validate
```

**Mutation evidence (RED, następnie przywrócone):**

- strictness: `engineeringProgramDesign` tymczasowo zmieniony z
  `versionedContract` na zwykłe `z.object`; targeted suite exit code `1`,
  `3` testy RED (unknown fields zostały zaakceptowane);
- process downgrade: guard tymczasowo zwracał zaniżoną klasę zamiast rzucać;
  targeted suite exit code `1`, test downgrade RED;
- no-second-driver: registry tymczasowo eksportował `claim()`; test
  architektoniczny exit code `1` przez niedozwolony publiczny export.

Po przywróceniu wspólny targeted przebieg kontraktów, snapshotu, registry i
Supervisor machine: exit code `0`, `21/21` testów; oba typechecki i build
kontraktów: exit code `0`.

Sol wykrył następnie rozjazd dwóch słowników stage (7 wartości w durable phase,
11 w registry). Po correction wspólnym runtime/type source of truth jest
`@remoteagent/contracts::EngineeringStage`; registry wyłącznie go re-eksportuje.
Ponowiona celowana bramka: exit code `0`, `24/24` testy oraz typecheck obu
pakietów i build kontraktów.

Pełna bramka Sol po ostatniej zmianie produkcyjnej: exit code `0`; lint i format
zielone, `2472/2472` testy w `192/192` plikach, typecheck `38/38` i build `26/26`
z `0 cached`, `workflow:validate OK — 45 tasks`. Integracje wymuszone przez
`RA_REQUIRE_POSTGRES=1` na działającym lokalnym PG15/5432 z dyskretnymi
`RA_PG*`; PG17/5433 opisany przez `env.sh` nie jest na tej maszynie dostępny.

Sonda type-level `ts.Program`/`checker.getExportsOfModule` po buildzie przeskanowała
19 pakietów i nie znalazła nowej kolizji. Wynik zawiera wyłącznie siedem znanych
nazw zaakceptowanych w `CTF-002`/`CTF-015`; legalny re-eksport
`EngineeringStage` rozwinął się do tej samej deklaracji.

## Następny task

Po audycie `PASS`, handoffie, statusie `DONE`, `workflow:validate` i logicznych
commitach Sol automatycznie przechodzi do `RA-038` zgodnie z ADR-0013.

Wejście środowiskowe RA-038: `env.sh` nadal zakłada nieistniejący PG17/5433.
Do czasu domknięcia `CTF-022` bramki DB wymagają wyczyszczenia URL-i i jawnych
`RA_PGHOST=127.0.0.1 RA_PGPORT=5432 RA_PGUSER=marcinjackowski
RA_PGDATABASE=postgres RA_REQUIRE_POSTGRES=1`.
