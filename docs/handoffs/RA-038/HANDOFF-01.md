# RA-038 — HANDOFF-01

- Task: `RA-038` Trwałe operacje, eventy i recovery Engineering Control Plane
- Data: `2026-08-26`
- Bazowy commit: `8c9708e3a2fcc2fc633c5897e8cb0184d779f663`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Rezultat

RemoteAgent ma trwałą, fail-closed warstwę operacji Engineering Control Plane na
PostgreSQL, bez drugiego journalu i bez filesystem run-store. Intent, `STARTED`,
receipt/reconciliation, strict artifacts, stage/operator events oraz usuwalna
projekcja mają jednoznaczne case/run/job/fence provenance i bezpieczny recovery.

## Najważniejsze kontrakty

- `STARTED` commituj bezpośrednio przed dispatch i nigdy nie traktuj replayu
  istniejącego eventu jako pozwolenia na ponowne wykonanie.
- Unknown mutating `STARTED` bez pewnego receiptu pozostaje `AMBIGUOUS`; cancel
  nie może go obniżyć. Dopiero `ABSENT` zezwala na retry z nowym operation ID.
- `job_intents`/completions/reconciliations są jedynym effect ledgerem. Nowe
  tabele tylko wiążą engineering provenance, artifacts i events.
- Projection jest cache'em; authority i resume wynikają z append-only ledgerów.
- Operator podaje action ID i decyzję, lecz nie owner/scope/outcome/receipt.
  Repository wyprowadza authority z DB i deleguje reconcile do `JobStore`.
- Obowiązująca kolejność blokad: `jobs→agent_runs→projection/event`. Test
  adwersarialny celowo czerwieni się dla `run→job`.
- `env.sh` szanuje jawny config, używa realnego bounded `SELECT 1` i bez configu
  wybiera osiągalne 5433 albo 5432 przez dyskretne `RA_PG*`.

## Dowód

```text
engineering repository final targeted  34/34, exit 0
pełne testy                           2515/2515, 194/194 pliki, exit 0
typecheck --force                     38/38, 0 cached, exit 0
build --force                         26/26, 0 cached, exit 0
lint / format                         exit 0 / exit 0
workflow:validate                     OK — 45 tasks
mutations                             10 mechanizmów RED→GREEN
```

## Wejście do RA-039

RA-039 nie zależy od RA-038 i pozostaje pierwszym `READY` po kolejce. Buduje
generyczne schema-owned structured output nad istniejącym Bedrock tool-loopem;
nie dotyka context selection ani orchestration stages. Ma zachować istniejący
reply-loop `AgentCompletion`, rozróżnić abort/timeout od invalid JSON oraz nie
uruchamiać implementera ponownie w celu naprawy jego raportu.

RA-040 po domknięciu RA-038 staje się `READY`. Będzie konsumował trwałe artifact
revisions i projection, lecz authority nadal musi pochodzić z raw durable
sources, nie z model-authored memory.

## Stan zewnętrzny

Nie wykonano zewnętrznych write'ów, push, MR ani merge. Domknięcie ma dwa
logiczne commity (implementacja, następnie docs/status), po których drzewo jest
czyste. Zgodnie z ADR-0013 kolejny task zaczyna się bez pauzy.
