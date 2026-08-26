# RA-040 — HANDOFF-01

- Task: `RA-040` Context compiler i trzywarstwowa pamięć
- Data: `2026-08-26`
- Bazowy commit: `8d69796dc45c9bf117403adc4167d875fe11586c`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Rezultat

Reply-loop nie replayuje już stałego `listRecent(20)`. Jeden context compiler składa świeży,
stage-specific packet z authority-pinned snapshotu PostgreSQL, trzech rozłącznych warstw pamięci,
closed source/selection policy i zaakceptowanego manifestu. `MemoryUpdate` jest niewładczą,
wersjonowaną projekcją; raw evidence pozostaje trwałe i referencjonowane.

## Inwarianty do zachowania

- DB snapshot: exact run/work-unit/case/owner/checkpoint/scope, jedna transakcja
  `REPEATABLE READ READ ONLY`, cutoff `run.created_at`.
- Dobór: `MANDATORY -> LATEST_OWNER -> LEXICAL_RELEVANCE -> PRIORITY -> RECENCY`; source type,
  warstwa i selection class są server-owned.
- Packet używa wyłącznie sanitized compiled fragments + compiled manifest, nigdy raw snapshotu.
- External/model/working content pozostaje `UNTRUSTED_DATA` i nie ustala policy/tools/process/gates.
- Diff/log jest redagowany przed code-point-safe clipem; marker zawiera opaque ref i pełny digest.
- Provider actual tokens, estimate i cache `HIT/MISS/NOT_OBSERVED` pozostają osobnymi metrykami.
- Wspólny redactor chroni packet, projection, log i telemetry; sensitive refs failują zamknięcie.

## Dowód

```text
pełna bramka PostgreSQL       2583/2583, 201 plików, exit 0
build --force                 26/26, 0 cached, exit 0
typecheck --force             38/38, 0 cached, exit 0
lint / format / diff-check    exit 0
workflow:validate             OK — 45 tasks
baseline                      4053 B full; 2935 B legacy20; 2764 B compiled
mutations                     9 klas mechanizmów RED→GREEN
```

## Wejście do RA-041

RA-041 ma spiąć istniejący `SupervisorRuntime` z rejestrem etapów, artifact/run-store RA-038,
schema-owned Bedrock RA-039 i compilerem RA-040. Stage, expected schema digest, prompt version,
authority i source policy pozostają server-owned. Model `approved=true` ani artifact content nie
może przejść bramki approval; side-effect stage nie dostaje repair/replay modelu.

## Stan zewnętrzny

Nie wykonano AWS/Bedrock call, zewnętrznego write, push, MR ani merge. Task zamyka się logicznym
commitem implementacji oraz commitem docs/status; po czystym drzewie przebieg przechodzi do RA-041.
