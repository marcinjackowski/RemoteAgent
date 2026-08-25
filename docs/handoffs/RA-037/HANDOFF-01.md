# RA-037 — HANDOFF-01

- Task: `RA-037` Engineering workflow contracts i granica control plane
- Data: `2026-08-25`
- Bazowy commit: `4b7dcdf567572d840ce7be5c6c268fc9276a3f52`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Rezultat

RemoteAgent ma strict, versioned domenę engineering workflow i jeden
deklaratywny graf procesu zależny od ryzyka. Nie powstał drugi orchestrator:
`SupervisorRuntime` pozostaje jedynym production driverem, a
`EngineeringPhase` jest tylko durable payload/projection.

## Co powstało

- `packages/contracts/src/engineering-workflow.ts`: Outcome/System/Program/
  Slice, ContextManifest, EvidenceBundle, MemoryUpdate, decyzje, terminal reason,
  EngineeringPhase, deterministic process minimum i canonical artifact digest.
- `packages/agent-orchestrator/src/engineering/registry.ts`: zamrożony routing
  stage→role/contracts/artifacts oraz grafy SMALL/MEDIUM/LARGE.
- Jeden `EngineeringStage` w contracts, re-eksportowany przez orchestrator.
- Publiczne JSON Schemas i snapshoty wszystkich standalone boundaries.
- 15 nowych testów: 10 kontraktów i 5 registry; schema suite została rozszerzona
  o nowe snapshoty.

## Dowód

```text
targeted final       24/24, exit 0
pełne testy          2472/2472, 192/192 pliki, exit 0
typecheck --force    38/38, 0 cached, exit 0
build --force        26/26, 0 cached, exit 0
lint / format        exit 0 / OK
workflow:validate    OK — 45 tasks
mutations            strictness RED; downgrade RED; second-driver RED; restored GREEN
type export probe    brak nowych kolizji względem CTF-002/015
```

## Decyzje, które muszą przeżyć sesję

- Model ani decyzja pojedynczego runu nie mogą zejść poniżej deterministycznego
  process minimum. Właściciel może podnieść klasę; zmiana minimum jest zmianą
  wersjonowanej policy/architektury.
- `ContextManifest`/`EvidenceBundle` są server-owned. `MemoryUpdate` jest
  niewładczą, niezaufaną projekcją i nigdy nie zastępuje raw evidence.
- Gate jest identyfikatorem katalogowym, nie raw commandem modelu.
- Jedynym writerem workspace pozostaje IMPLEMENTER, a wszystkie transitions/
  claim/enqueue/finalize należą do istniejącego `SupervisorRuntime`.
- Registry i durable phase zawsze konsumują dokładnie ten sam
  `EngineeringStage` z contracts.

## Wejście do RA-038

RA-038 implementuje operation/event journal, reconstructable projection i
recovery na PostgreSQL. Musi zachować istniejące znaczenie
`run_completions`/`case_checkpoints`/outbox i nie może tworzyć drugiego journalu.
Pierwszy krok domyka `CTF-022`: `env.sh` zakłada nieobecny PG17/5433, podczas gdy
lokalnie działa PG15/5432. Do czasu fixa używać dyskretnych:

```text
unset RA_DATABASE_URL DATABASE_URL
RA_PGHOST=127.0.0.1 RA_PGPORT=5432 RA_PGUSER=marcinjackowski
RA_PGDATABASE=postgres RA_REQUIRE_POSTGRES=1
```

Nie używać jednego `RA_DATABASE_URL` dla pełnej suite: override `database` w
dwóch testach nie neutralizuje connection stringa i łamie izolację bazy.

## Stan zewnętrzny

Nie wykonano Bedrock/Jira/Discord/GitLab write, push, MR ani merge. Zmiany są
lokalne. Po logicznych commitach RA-037 drzewo jest czyste, a zgodnie z ADR-0013
Sol od razu rozpoczyna RA-038.
