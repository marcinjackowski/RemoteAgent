# Task Index

Ten plik jest operacyjną kolejką makro-tasków i jedynym źródłem statusów. Nie
zmieniaj kolejności bez ADR albo decyzji właściciela. Task zaczynasz tylko wtedy,
gdy wszystkie jego zależności są `DONE`.

Każdy rozpoczynany task jest dzielony just-in-time na kroki w
`docs/work-units/<TASK_ID>/WORK_UNITS.md`. Gotowe plany najbliższych tasków nie
zmieniają ich statusu ani nie omijają zależności z poniższej tabeli.

Status zmienia się na `DONE` wyłącznie po uruchomionej bramce i audycie `PASS` —
zob. [ADR-0007](../decisions/ADR-0007-verification-first-delivery.md). Po każdej
zmianie statusu uruchom `pnpm workflow:validate`.

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
| 9 | [RA-009](RA-009.md) Multi-agent orchestrator | DONE | RA-004, RA-006, RA-007, RA-008 | M1 |
| 10 | [RA-010](RA-010.md) Isolated workspace runner | DONE | RA-001, RA-003, RA-004, RA-005 | M2 |
| 11 | [RA-011](RA-011.md) Repository discovery and planning | DONE | RA-008, RA-010 | M2 |
| 12 | [RA-012](RA-012.md) Implementation toolset | DONE | RA-005, RA-007, RA-009, RA-010, RA-011 | M2 |
| 13 | [RA-013](RA-013.md) Tests, artifacts and snapshots | DONE | RA-010, RA-012 | M2 |
| 14 | [RA-014](RA-014.md) Local Git lifecycle | DONE | RA-010, RA-012, RA-013 | M2 |
| 15 | [RA-015](RA-015.md) Independent review and fix loop | DONE | RA-009, RA-011, RA-012, RA-013, RA-014 | M2 |
| 16 | [RA-016](RA-016.md) Jira connector | DONE | RA-002, RA-003, RA-004, RA-005, RA-006 | M3 |
| 17 | [RA-017](RA-017.md) GitLab connector and Merge Requests | DONE | RA-002, RA-003, RA-004, RA-005, RA-006, RA-013, RA-014, RA-015 | M3 |
| 18 | [RA-018](RA-018.md) Golden path and concurrency proof | DONE | RA-009, RA-010, RA-011, RA-012, RA-013, RA-014, RA-015, RA-016, RA-017 | M3 |
| 19 | [RA-019](RA-019.md) Gmail two-account connector | DONE | RA-002, RA-003, RA-004, RA-005, RA-006, RA-018 | M4 |
| 20 | [RA-020](RA-020.md) Calendar two-account connector | DONE | RA-002, RA-003, RA-004, RA-005, RA-006, RA-018 | M4 |
| 21 | [RA-021](RA-021.md) MCP Tool Broker | DONE | RA-005, RA-007, RA-009, RA-013, RA-016, RA-017, RA-019, RA-020 | M5 |
| 22 | [RA-022](RA-022.md) Policy, approvals and action executor | DONE | RA-003, RA-004, RA-005, RA-006, RA-008, RA-021 | M5 |
| 23 | [RA-023](RA-023.md) AgentCore Gateway and official MCP targets | DONE | RA-010, RA-016, RA-021, RA-022 | M5 |
| 24 | [RA-024](RA-024.md) Security, privacy and observability hardening | DONE | RA-018, RA-019, RA-020, RA-021, RA-022, RA-023 | M6 |
| 25 | [RA-025](RA-025.md) AWS deployment and disaster recovery | DONE | RA-024 | M6 |
| 26 | [RA-026](RA-026.md) Final acceptance and production readiness | DONE | RA-025 | M6 |
| 27 | [RA-027](RA-027.md) Composition roots: uruchamialne procesy | DONE | RA-026 | M7 |
| 28 | [RA-028](RA-028.md) Handlery workera: system wykonuje pracę | DONE | RA-027 | M7 |
| 29 | [RA-029](RA-029.md) Okablowanie pętli Jira → Discord (routing outboxu + reconciler) | DONE | RA-028 | M7 |
| 30 | [RA-030](RA-030.md) Produkcyjne wpięcie reconcile Jiry (single-owner API token) | DONE | RA-029 | M7 |
| 31 | [RA-031](RA-031.md) Inbound conversation loop (wiadomość → praca agenta) | DONE | RA-030 | M7 |
| 32 | [RA-032](RA-032.md) Model runtime: agent myśli i odpisuje (Bedrock + config w DB) | DONE | RA-031 | M7 |
| 33 | [RA-033](RA-033.md) Kontekst zadania dla agenta: issue Jiry w transkrypcie case'a | DONE | RA-032 | M7 |
| 34 | [RA-034](RA-034.md) Agent DZIAŁA: IMPLEMENTER → realny lokalny commit | BLOCKED | RA-033 | M7 |
| 35 | [RA-035](RA-035.md) Discord UX: natywny wskaźnik „Bot pisze…" w wątku | DONE | RA-032 | M7 |
| 36 | [RA-036](RA-036.md) Discord UX: informacja o błędzie agenta w wątku | DONE | RA-032 | M7 |
| 37 | [RA-037](RA-037.md) Engineering workflow contracts i granica control plane | DONE | — | M8 |
| 38 | [RA-038](RA-038.md) Trwałe operacje, eventy i recovery control plane | DONE | RA-037 | M8 |
| 39 | [RA-039](RA-039.md) Generyczne structured output dla etapów Bedrock | DONE | RA-037 | M8 |
| 40 | [RA-040](RA-040.md) Context compiler i trzywarstwowa pamięć | DONE | RA-037, RA-038 | M8 |
| 41 | [RA-041](RA-041.md) Workflow stages w istniejącym SupervisorRuntime | READY | RA-037, RA-038, RA-039, RA-040 | M8 |
| 42 | [RA-042](RA-042.md) Deterministyczny gate runner i evidence binding | READY | RA-037, RA-038 | M8 |
| 43 | [RA-043](RA-043.md) Vertical-slice executor, GitLifecycle i review loop | BLOCKED_BY_DEPENDENCIES | RA-041, RA-042 | M8 |
| 44 | [RA-044](RA-044.md) Kwalifikacja core Engineering Control Plane | BLOCKED_BY_DEPENDENCIES | RA-043 | M8 |
| 45 | [RA-045](RA-045.md) Kwalifikacja iOS/Xcode na sondermind-ios | BLOCKED_BY_DEPENDENCIES | RA-044 | M9 |

## Milestone gates

- **M0 Foundation:** trwały event/case/job core, bez modelu i integracji.
- **M1 Conversation:** Discord + Bedrock + trwałe decyzje + role.
- **M2 Coding engine:** izolowana implementacja, testy, Git i review.
- **M3 Golden path:** Jira do GitLab MR, dwa równoległe taski i recovery.
- **M4 Google:** dwa konta Gmail i Calendar bez cross-account leakage.
- **M5 Tools/actions:** MCP, policy, approval i external writes.
- **M6 Production:** hardening, AWS, restore drill i final audit.
- **M7 Runnable:** composition roots — procesy, health, Dockerfile.
- **M8 Engineering Control Plane:** jeden human-steered control plane rozszerzający istniejący
  `SupervisorRuntime`: risk-proportional product/system/program design, fresh context, vertical
  slices, durable recovery, deterministyczne gates i review (`ADR-0011`); zastępuje RA-034.
- **M9 iOS Qualification:** jawnie uruchamiany live smoke M8 na macOS/Xcode i `sondermind-ios`;
  brak środowiska live nie blokuje kwalifikacji core.

## Prepared execution plans

- [RA-007 work units](../work-units/RA-007/WORK_UNITS.md)
- [RA-008 work units](../work-units/RA-008/WORK_UNITS.md)
- [RA-009 work units](../work-units/RA-009/WORK_UNITS.md)
- [RA-010 work units](../work-units/RA-010/WORK_UNITS.md)
- [RA-011 work units](../work-units/RA-011/WORK_UNITS.md)
- [RA-012 work units](../work-units/RA-012/WORK_UNITS.md)
- [RA-013 work units](../work-units/RA-013/WORK_UNITS.md)
- [RA-014 work units](../work-units/RA-014/WORK_UNITS.md)
- [RA-015 work units](../work-units/RA-015/WORK_UNITS.md)
- [RA-017 work units](../work-units/RA-017/WORK_UNITS.md)
- [RA-018 work units](../work-units/RA-018/WORK_UNITS.md)
- [RA-019 work units](../work-units/RA-019/WORK_UNITS.md)
- [RA-020 work units](../work-units/RA-020/WORK_UNITS.md)
- [RA-021 work units](../work-units/RA-021/WORK_UNITS.md)
- [RA-022 work units](../work-units/RA-022/WORK_UNITS.md)
- [RA-023 work units](../work-units/RA-023/WORK_UNITS.md) — `DRAFT`
- [RA-024 work units](../work-units/RA-024/WORK_UNITS.md)
- [RA-025 work units](../work-units/RA-025/WORK_UNITS.md)
- [RA-026 work units](../work-units/RA-026/WORK_UNITS.md)
- [RA-027 work units](../work-units/RA-027/WORK_UNITS.md)
- [RA-028 work units](../work-units/RA-028/WORK_UNITS.md)
- [RA-029 work units](../work-units/RA-029/WORK_UNITS.md)
- [RA-030 work units](../work-units/RA-030/WORK_UNITS.md)
- [RA-031 work units](../work-units/RA-031/WORK_UNITS.md)
- [RA-032 work units](../work-units/RA-032/WORK_UNITS.md)
- [RA-033 work units](../work-units/RA-033/WORK_UNITS.md)
- [RA-034 work units](../work-units/RA-034/WORK_UNITS.md)
- [RA-035 work units](../work-units/RA-035/WORK_UNITS.md)
- [RA-036 work units](../work-units/RA-036/WORK_UNITS.md)
- [RA-016 work units](../work-units/RA-016/WORK_UNITS.md)

Plan może mieć status `DRAFT` przed odblokowaniem taska. Sol sprawdza go ponownie
przy starcie i dopiero wtedy oznacza pierwszy unit jako gotowy do wykonania.

## Dependency rationale — 2026-08-20

- RA-012 jawnie zależy od zaakceptowanego secret/network boundary RA-005.
- RA-015 konsumuje wersjonowany plan i profile RA-011.
- RA-017 nie tworzy draft MR bez prawdziwego test evidence RA-013 i review
  evidence RA-015.
- RA-021 wymaga artifact boundary RA-013 i zaakceptowanych Jira read APIs RA-016.
- RA-022 wiąże approval z checkpoint/decision revision RA-008.
- RA-023 korzysta z workspace/runtime RA-010 i targetu Jira RA-016.

RA-019 i RA-020 pozostają semantycznie niezależne. Ich units dotykające migracji
i `repositories/index.ts` są serializowane przez Sol jako konflikt allowed paths;
tymczasowy migration lane nie jest kodowany jako fałszywa zależność domenowa.

## Dependency rationale — M8/M9, 2026-08-25

- RA-037 najpierw definiuje kontrakty i dowodzi, że nie powstaje drugi orchestrator.
- RA-038 (durability) i RA-039 (generic structured output) mogą powstać niezależnie po RA-037.
- RA-040 wymaga trwałych source revisions/manifestów z RA-038.
- RA-041 spina kontrakty, store, transport i context w istniejącym `SupervisorRuntime`.
- RA-042 może rozwijać bezpieczne command/evidence boundary po RA-038, równolegle do model flow.
- RA-043 łączy gotowy workflow i gates z jedynym writerem, `GitLifecycle` i `review-loop`.
- RA-044 kwalifikuje core na deterministycznych boundary fakes; RA-045 osobno kwalifikuje Xcode/live.
