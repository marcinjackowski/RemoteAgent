# RA-041 — HANDOFF-01

- Task: `RA-041` Workflow stages w istniejącym SupervisorRuntime
- Data: `2026-08-26`
- Bazowy commit: `0328bcbbe598c4d12ac7dad283560bb9bf1f98a9`
- Status po tym handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

Istniejący `SupervisorRuntime` prowadzi teraz risk-proportional workflow
discovery/design/approval/slice/review/memory/verification przez pojedynczy durable stage port.
Production worker wiąże exact claimed writer run, RA-038 ledger, schema-owned Bedrock i RA-040
context compiler bez alternatywnego drivera.

## Inwarianty do zachowania

- Unit, run i writer job powstają/wiążą się atomowo; payload nie tworzy authority.
- Tylko `SupervisorRuntime` interpretuje registry graph; adapter wykonuje jeden stage.
- `STARTED` jest trwałe przed effect; artifact recovery nie replayuje modelu/efektu.
- High-risk approval wymaga exact artifacts, revision/digests, zero findings, gates/evidence i
  durable owner/policy grant. Model disposition jest wyłącznie informacyjne.
- Workflow deadline pochodzi z `agent_runs.created_at`; job lease jest odnawiany heartbeatem przez
  cały model call.
- Stage calls i actual model completions są osobne; restart liczy structured artifacts
  konserwatywnie jako initial+repair.
- Causal 8-field resume payload dotyczy tylko `IMPLEMENTER`; inne role zachowują 4-field
  `case.resume`.
- Telemetry pozostaje bounded `kind/outcome`, bez scope/content identifiers.

## Dowód

```text
pełna bramka PostgreSQL       2608/2608, 203 pliki, exit 0
build --force                 26/26, 0 cached, exit 0
typecheck --force             38/38, 0 cached, exit 0
lint / format / diff-check    exit 0
workflow:validate             OK — 45 tasks
audyt targeted                120/120, 11 plików, exit 0
mutations                     10 klas mechanizmów RED->GREEN
```

## Wejście dalej

RA-042 jest `READY` i ma dostarczyć deterministyczny gate runner/evidence binding bez zmiany
workflow drivera. RA-043 pozostaje zablokowany do `DONE` RA-042; wtedy spina system-owned
`SLICE_IMPLEMENTATION` i `GATE_EXECUTION` z GitLifecycle/review loop. Obecne test-only
`executeSystemStage` jest wyłącznie seamem i nie może stać się równoległą ścieżką produkcyjną.

## Stan zewnętrzny

Nie wykonano AWS/Bedrock call, workspace write, push, MR ani merge. Task zamyka się logicznym
commitem implementacji i osobnym commitem dokumentacji/statusu; po czystym drzewie przebieg
automatycznie przechodzi do RA-042.
