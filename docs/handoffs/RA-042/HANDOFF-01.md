# RA-042 — HANDOFF-01

- Task: `RA-042` Deterministyczny gate runner i evidence binding
- Data: `2026-08-26`
- Bazowy commit: `40c81dbdae91fcbb3a4a97a2a89e3ab7e415794d`
- Commit implementacji: `3e1637f`
- Status po tym handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

RemoteAgent ma code-owned gate catalog, disposable verification workspaces,
durable per-command receipts na ledgerze RA-038, fail-closed aggregate oraz
`EngineeringEvidenceBundle` z niewakuowym test-first evidence.

## Inwarianty do zachowania

- Każdy required gate/target ma osobną operation i exact durable completion ID.
- `STARTED` jest commitowane bezpośrednio przed dispatch; brak completion oznacza
  `AMBIGUOUS` i zakazuje automatycznego replay.
- Gate nigdy nie działa na authoritative root; `.git`, protected paths i mutable
  symlink-swap są blokowane, authority digest pozostaje niezmieniony.
- Katalog/executable/argv/profiles są server-owned. Model nie poszerza policy.
- PASS wymaga durable redacted logu i exact tree/config/command binding.
- Test-first wymaga baseline `FAILED` i current `PASSED`; baseline green jest vacuous.
- Generic adapter nie udaje wsparcia Xcode: tylko `HERMETIC`+`DENY`; inne profile
  wymagają jawnego platform adaptera.

## Dowód

```text
pełna bramka PostgreSQL       2652/2652, 206 plików, exit 0
ponowienie JSON               2652/2652, 639 suites, exit 0
build --force                 26/26, 0 cached, exit 0
typecheck --force             38/38, 0 cached, exit 0
lint / format / diff-check    exit 0
workflow:validate             OK — 45 tasks
mutations                     wszystkie mechanizmy WU-00..03 RED->GREEN
```

## Wejście dalej

RA-043 jest `READY`. Ma wpiąć `executeVerificationGateBatch` w istniejący
`SupervisorRuntime` stage `GATE_EXECUTION`, utrzymywać heartbeat job lease przez
długie gates, persistować zaakceptowany `EngineeringEvidenceBundle` i następnie
spiąć vertical-slice implementation z istniejącymi GitLifecycle/review-loop.
Nie tworzy drugiego workflow drivera, process runnera ani journala. Brak świeżego
fence ma pozostać `AMBIGUOUS`. Konkretne Xcode commands/profile pozostają RA-045.

## Stan zewnętrzny

Nie wykonano push, MR/merge, zewnętrznego write ani live Xcode. Task zamyka się
logicznym commitem implementacji i osobnym commitem dokumentacji/statusu.
