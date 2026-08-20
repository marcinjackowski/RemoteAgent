# Task Index

Ten plik jest operacyjną kolejką makro-tasków. Statusy zmienia wyłącznie Sol
jako `COORDINATOR_AUDITOR`, zgodnie z `AGENTS.md`. Lokalny implementer nie edytuje
tej kolejki. Nie zmieniaj kolejności bez ADR albo decyzji właściciela. Sol
przydziela według niej do trzech równoległych strumieni, pomijając taski z
niespełnionymi zależnościami albo kolidującym zakresem zapisu.

Każdy rozpoczynany task jest dzielony just-in-time na małe jednostki w
`docs/work-units/<TASK_ID>/WORK_UNITS.md`. Gotowe plany najbliższych tasków nie
zmieniają ich statusu ani nie omijają zależności z poniższej tabeli.

## Status legend

- `BLOCKED_BY_DEPENDENCIES`
- `READY`
- `IN_PROGRESS`
- `AWAITING_AUDIT`
- `CHANGES_REQUESTED`
- `AUDIT_PASSED`
- `DONE`
- `BLOCKED`

## Queue

| Order | Task | Status | Depends on | Milestone |
|---:|---|---|---|---|
| 1 | [RA-001](RA-001.md) Repo foundation | DONE | — | M0 |
| 2 | [RA-002](RA-002.md) Domain contracts and state machines | DONE | RA-001 | M0 |
| 3 | [RA-003](RA-003.md) PostgreSQL persistence | DONE | RA-001, RA-002 | M0 |
| 4 | [RA-004](RA-004.md) Durable jobs, outbox and leases | DONE | RA-003 | M0 |
| 5 | [RA-005](RA-005.md) Connections, secrets and scope isolation | DONE | RA-003 | M0 |
| 6 | [RA-006](RA-006.md) Discord case interface | DONE | RA-002, RA-003, RA-004, RA-005 | M1 |
| 7 | [RA-007](RA-007.md) Bedrock Converse runtime | DONE | RA-001, RA-002, RA-005 | M1 |
| 8 | [RA-008](RA-008.md) Checkpoints, context and decisions | DONE | RA-002, RA-003, RA-004, RA-007 | M1 |
| 9 | [RA-009](RA-009.md) Multi-agent orchestrator | IN_PROGRESS | RA-004, RA-006, RA-007, RA-008 | M1 |
| 10 | [RA-010](RA-010.md) Isolated workspace runner | IN_PROGRESS | RA-001, RA-003, RA-004, RA-005 | M2 |
| 11 | [RA-011](RA-011.md) Repository discovery and planning | BLOCKED_BY_DEPENDENCIES | RA-008, RA-010 | M2 |
| 12 | [RA-012](RA-012.md) Implementation toolset | BLOCKED_BY_DEPENDENCIES | RA-007, RA-009, RA-010, RA-011 | M2 |
| 13 | [RA-013](RA-013.md) Tests, artifacts and snapshots | BLOCKED_BY_DEPENDENCIES | RA-010, RA-012 | M2 |
| 14 | [RA-014](RA-014.md) Local Git lifecycle | BLOCKED_BY_DEPENDENCIES | RA-010, RA-012, RA-013 | M2 |
| 15 | [RA-015](RA-015.md) Independent review and fix loop | BLOCKED_BY_DEPENDENCIES | RA-009, RA-012, RA-013, RA-014 | M2 |
| 16 | [RA-016](RA-016.md) Jira connector | IN_PROGRESS | RA-002, RA-003, RA-004, RA-005, RA-006 | M3 |
| 17 | [RA-017](RA-017.md) GitLab connector and Merge Requests | BLOCKED_BY_DEPENDENCIES | RA-002, RA-003, RA-004, RA-005, RA-006, RA-014 | M3 |
| 18 | [RA-018](RA-018.md) Golden path and concurrency proof | BLOCKED_BY_DEPENDENCIES | RA-009, RA-010, RA-011, RA-012, RA-013, RA-014, RA-015, RA-016, RA-017 | M3 |
| 19 | [RA-019](RA-019.md) Gmail two-account connector | BLOCKED_BY_DEPENDENCIES | RA-002, RA-003, RA-004, RA-005, RA-006, RA-018 | M4 |
| 20 | [RA-020](RA-020.md) Calendar two-account connector | BLOCKED_BY_DEPENDENCIES | RA-002, RA-003, RA-004, RA-005, RA-006, RA-018 | M4 |
| 21 | [RA-021](RA-021.md) MCP Tool Broker | BLOCKED_BY_DEPENDENCIES | RA-005, RA-007, RA-009, RA-017, RA-019, RA-020 | M5 |
| 22 | [RA-022](RA-022.md) Policy, approvals and action executor | BLOCKED_BY_DEPENDENCIES | RA-003, RA-004, RA-005, RA-006, RA-021 | M5 |
| 23 | [RA-023](RA-023.md) AgentCore Gateway and official MCP targets | BLOCKED_BY_DEPENDENCIES | RA-021, RA-022 | M5 |
| 24 | [RA-024](RA-024.md) Security, privacy and observability hardening | BLOCKED_BY_DEPENDENCIES | RA-018, RA-019, RA-020, RA-021, RA-022, RA-023 | M6 |
| 25 | [RA-025](RA-025.md) AWS deployment and disaster recovery | BLOCKED_BY_DEPENDENCIES | RA-024 | M6 |
| 26 | [RA-026](RA-026.md) Final acceptance and production readiness | BLOCKED_BY_DEPENDENCIES | RA-025 | M6 |

## Milestone gates

- **M0 Foundation:** trwały event/case/job core, bez modelu i integracji.
- **M1 Conversation:** Discord + Bedrock + trwałe decyzje + role.
- **M2 Coding engine:** izolowana implementacja, testy, Git i review.
- **M3 Golden path:** Jira do GitLab MR, dwa równoległe taski i recovery.
- **M4 Google:** dwa konta Gmail i Calendar bez cross-account leakage.
- **M5 Tools/actions:** MCP, policy, approval i external writes.
- **M6 Production:** hardening, AWS, restore drill i final audit.

## Prepared execution plans

- [RA-007 work units](../work-units/RA-007/WORK_UNITS.md)
- [RA-008 work units](../work-units/RA-008/WORK_UNITS.md)
- [RA-009 work units](../work-units/RA-009/WORK_UNITS.md)
- [RA-010 work units](../work-units/RA-010/WORK_UNITS.md)
- [RA-016 work units](../work-units/RA-016/WORK_UNITS.md)

Plan może mieć status `DRAFT` przed odblokowaniem taska. Sol sprawdza go ponownie
przy starcie i dopiero wtedy oznacza pierwszy unit jako gotowy do wykonania.
