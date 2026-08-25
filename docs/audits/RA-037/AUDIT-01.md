# RA-037 — AUDIT-01

- Task: `RA-037` Engineering workflow contracts i granica control plane
- Data: `2026-08-25`
- Bazowy commit: `4b7dcdf567572d840ce7be5c6c268fc9276a3f52`
- Role: Sol — plan, niezależna weryfikacja i finalny audyt; Luna — bounded implementation

Werdykt w §8.

## 1. Uruchomione bramki

Celowana bramka po finalnej correction jednego słownika stage:

```text
vitest engineering-workflow + schema-snapshot + engineering-registry + supervisor-machine
  24/24, 4/4 pliki, exit 0
contracts typecheck       exit 0
contracts build           exit 0
agent-orchestrator typecheck exit 0
```

Pełna bramka, uruchomiona przez Sol po ostatniej zmianie produkcyjnej:

```text
lint                                      exit 0
prettier --check                          exit 0
RA_REQUIRE_POSTGRES=1 vitest run          2472/2472, 192/192 pliki, exit 0
turbo run typecheck --force               38/38, 0 cached, exit 0
turbo run build --force                   26/26, 0 cached, exit 0
workflow:validate                         OK — 45 tasks, exit 0
```

Integracje korzystały z rzeczywiście dostępnego PG15/5432 przez dyskretne
`RA_PG*`; brak PG17/5433 w istniejącym `env.sh` zapisano jako LOW `CTF-022`, z
ownerem `RA-038-WU-00`. Brak skipów: `RA_REQUIRE_POSTGRES=1` był ustawiony.

## 2. Kryteria akceptacji — każde osobno

1. **Strict contracts:** spełnione. Wszystkie standalone boundary contracts są
   `versionedContract`/strict; testy odrzucają unknown field, koercję rewizji,
   błędny discriminant i semantycznie sprzeczne decyzje. Mutation zastępująca
   strict `ProgramDesign` zwykłym `z.object` dała exit `1` i trzy RED.
2. **ProgramDesign:** spełnione. Wymagane są call-flow, file-tree delta, kluczowe
   typy/sygnatury, uncertainty review, expected tests i slice order; puste lub
   brakujące load-bearing pola są odrzucane.
3. **SliceContract:** spełnione. Jeden skalarny `observable_result`, bounded
   relative `allowed_paths`, gate IDs zamiast komend, inspection method i stop
   condition. Raw `pnpm test` jako gate/metoda jest odrzucany.
4. **Risk minimum:** spełnione. Server-owned facts obejmują security/policy,
   migration, irreversible/external side effects, broad public contract, user
   data i concurrency jako high-risk; multi-module/new architecture/brak oracle
   jako minimum MEDIUM. Modelowy downgrade rzuca typed error. Mutation zwracająca
   zaniżoną klasę dała RED. ADR i Master Plan skorygowano: nawet decyzja
   operacyjna właściciela nie schodzi poniżej deterministycznego minimum.
5. **Graf procesu:** spełnione. SMALL pomija osobne design documents, MEDIUM ma
   system+program, LARGE ma outcome+system+program+approval; każda klasa zachowuje
   slice planning, jedynego writera, gate, review, memory projection i final
   verification. Test przepływu artefaktów dowodzi, że żadna ścieżka nie wymaga
   artefaktu, którego nie mogła wcześniej wytworzyć.
6. **Brak drugiego drivera:** spełnione. Registry jest zamrożonymi danymi;
   publicznie wystawia tylko wspólny `EngineeringStage`, registry i grafy. Nie ma
   claim/enqueue/transition/finalize ani zależności na database. Mutation
   eksportująca `claim()` dała RED w teście architektonicznym.
7. **EngineeringPhase:** spełnione. Strict durable payload ma binding
   case/run/revision, checkpoint revision, attempt, process class, context i
   artifact digests. Etap pochodzi z tego samego runtime/type source of truth co
   registry. To projekcja konsumowana przez istniejący `SupervisorRuntime`, bez
   samodzielnej maszyny stanów.
8. **Canonical digest:** spełnione. `engineeringArtifactDigest` najpierw strict-
   parse'uje versioned union, następnie używa istniejącego `canonicalDigest`.
   Test dowodzi niezależności od kolejności kluczy oraz odrzucenia innej schema
   version i nadmiarowego pola.
9. **Bramka/workflow:** spełnione — §1.

## 3. Diff i granice architektury

Sol przeczytał pełny diff od bazowego commita oraz istotny kod istniejących
`SupervisorRuntime`, state/work-unit/run-safety contracts, schema registry i
canonical hashing. Implementacja dodaje:

- `packages/contracts/src/engineering-workflow.ts` — czyste kontrakty, policy i
  digest;
- rejestrację standalone JSON schemas i publiczny prefiksowany export;
- `packages/agent-orchestrator/src/engineering/registry.ts` — wyłącznie routing
  stage→role/contracts/artifacts i risk-dependent grafy;
- table-driven testy kontraktów, schema snapshot oraz architecture/graph guard.

Nie zmieniono `SupervisorStatus`, `WorkUnitStatus`, `RunSafetyState`, runtime
persistence ani production composition root. `agent-orchestrator` nadal nie
zależy od `database`.

## 4. Security, trust i evidence

- `ContextManifest` i `EvidenceBundle` są `SERVER_OWNED`; working projection
  musi pozostać `UNTRUSTED_DATA`.
- `MemoryUpdate` jest jawnie `MODEL_PROJECTION`/`UNTRUSTED_DATA`, bez pól
  autoryzacji, policy, gate completion lub transition.
- Model nie wybiera komendy gate i nie może nadać evidence statusu przez
  model-owned boolean; receipts/digests są strukturą serwerową.
- Policy risk facts są strict i `SERVER_OWNED`; nie ma cichego defaultu ani
  modelowego poszerzenia/obniżenia scope.
- Task nie wykonuje side effectów, migracji ani operacji workspace, więc
  crash/replay/fencing pozostają świadomie zakresem RA-038+.

## 5. Mutation evidence

Trzy load-bearing mutacje wykonano na rzeczywistym kodzie, każdą przywrócono i
ponowiono GREEN:

| Mechanizm | Mutacja | Dowód RED |
|---|---|---|
| strict boundary | `ProgramDesign`: `versionedContract` → zwykłe `z.object` | exit 1, 3 testy RED |
| process minimum | guard zwraca klasę poniżej minimum | exit 1, downgrade test RED |
| no-second-driver | publiczny export `claim()` w registry | exit 1, architecture test RED |

Po przywróceniu celowana bramka miała 24/24, a pełna 2472/2472.

## 6. Public API collision probe

Wymagana przez `CTF-002`/`CTF-015` sonda type-level użyła TypeScript Program,
`checker.getExportsOfModule` i rozwijania aliasów dla 19 `dist/index.d.ts`.
Nie ma nowej kolizji. Wynik to wyłącznie wcześniej zaakceptowane:
`ModelIdentity`, `OperationRecord`, `RetryPolicy`, `RuntimeOptions`,
`ToolManifest`, `WorkspaceFence` i `packageName`. Re-eksport
`EngineeringStage` z orchestratora rozwiązuje się do tej samej deklaracji w
contracts, więc nie jest kolizją.

## 7. Findings i operacyjność

- Finding audytowy **MEDIUM** usunięty przed werdyktem: dwa niezależne słowniki
  stage (7 vs 11 wartości) zastąpiono jednym źródłem w contracts i ponowiono
  bramki.
- Niespójność dokumentacji pozwalająca właścicielowi obniżyć klasę poniżej
  policy minimum została usunięta; downgrade wymaga zmiany wersjonowanej policy,
  nie per-run override.
- Nowy przekrojowy finding `CTF-022` ma severity LOW i decyzję `fix` w RA-038;
  nie ma otwartych findingów BLOCKER/HIGH/MEDIUM.
- Raport Luny nie był dowodem: Sol sam odczytał diff, uruchomił targeted/full
  gates, mutation evidence i sondę exportów.

## 8. Werdykt

- Werdykt: `PASS`

Wszystkie kryteria RA-037 są spełnione, trzy mechanizmy load-bearing mają RED→
GREEN mutation evidence, pełna bramka ma exit code `0`, a po audycie nie pozostał
finding BLOCKER, HIGH ani MEDIUM.
