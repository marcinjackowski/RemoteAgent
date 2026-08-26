# RA-041 — AUDIT-01

- Task: `RA-041` Workflow stages w istniejącym SupervisorRuntime
- Data: `2026-08-26`
- Bazowy commit: `0328bcbbe598c4d12ac7dad283560bb9bf1f98a9`
- Audyt: pełny diff od bazowego commita, kod wywołujący/wywoływany i własne uruchomione bramki tej
  sesji zgodnie z `ADR-0007`

## 1. Uruchomiona bramka

Po odczycie pełnego diffu i korektach audytowych uruchomiono od początku:

```text
. scripts/dev/env.sh                    Node 24.19.0; PG15/5432 reachable
pnpm lint                               exit 0; tylko istniejące warnings boundaries
pnpm format                             exit 0
pnpm build --force                      26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm test         2608/2608, 203/203 plików, exit 0
pnpm typecheck --force                  38/38, 0 cached, exit 0
pnpm workflow:validate                  OK — 45 tasks, exit 0
git diff --check                        exit 0
```

Pierwszy ponowiony pełny przebieg miał `1/2606` RED: adversarialny test stub usuwał wraz z approval
także nowe pole `modelCalls`, więc runtime prawidłowo zwracał `AMBIGUOUS`. Fixture zawężono do
mutowania wyłącznie approval i całą bramkę uruchomiono ponownie. To rozstrzygnięty defekt testu,
nie przemilczany flake. Finalny przebieg nie miał faila ani PostgreSQL skipu.

Po pełnej bramce audyt niezależnie ponowił 11 load-bearing plików: `120/120`, exit `0`, wraz z
typecheck `database`, `agent-orchestrator`, `agent-worker`, `workflow:validate` i diff-check.

## 2. Kryteria akceptacji

1. **Trzy happy paths:** spełnione. Jeden `SupervisorRuntime` interpretuje dokładnie graph registry
   dla `SMALL`, `MEDIUM` i `LARGE_OR_HIGH_RISK`; fake durable port dowodzi dozwolonych pominięć.
2. **High-risk approval:** spełnione. Brak `OutcomeContract`, `SystemDesign`, `ProgramDesign` albo
   exact durable owner/policy authorization zatrzymuje przebieg przed `SLICE_IMPLEMENTATION`.
3. **Model nie autoryzuje:** spełnione. Revision, wymagane artifact names/digests, findings,
   gates/evidence oraz authorization są oceniane deterministycznie. Production grant pochodzi z
   causal lease i jest ponownie sprawdzany wobec exact answered decision w PostgreSQL.
4. **Durable question/resume:** spełnione. `WAITING_FOR_USER` terminalizuje stary run. Odpowiedź dla
   writer parent tworzy w jednej transakcji fresh unit, claimed run i job z
   `decisionId/parentRunId/checkpointRevision`; inne role zachowują strict legacy `case.resume`.
5. **Crash recovery:** spełnione. Potwierdzony immutable artifact jest odzyskany bez context/model
   replay; committed `STARTED` bez artifactu pozostaje `AMBIGUOUS`.
6. **Structural progress:** spełnione. Fingerprint obejmuje tree/design/slice/gates/findings, ignoruje
   narrative i stabilizuje kolejność; no-progress oraz oscillation są rozróżnione.
7. **Terminal reasons i limity:** spełnione. Cancellation, workflow deadline, stage limit, model-call
   limit, no-progress i oscillation mają osobne codes/metrics. Deadline pochodzi z trwałego
   `agent_runs.created_at`; heartbeat odnawia job lease przez całe wywołanie modelu.
8. **Jeden driver:** spełnione. Guardrail dowodzi jedynej konstrukcji `SupervisorRuntime` w
   `handlers.ts`; adapter nie posiada alternatywnej pętli, a worker wiąże exact leased port.
9. **Exact writer identity:** spełnione. Unit jest claimed przed enqueue w tej samej transakcji.
   Unclaimed, foreign-run, other-case i stale fence failują przed modelem/write authority.
10. **Bramki:** spełnione; pełna i audytowa komenda oraz `workflow:validate` mają exit `0`.

## 3. Architektura, trwałość i bezpieczeństwo

Nie powstała druga kolejka, maszyna workflow ani journal. `SupervisorRuntime` pozostaje jedynym
driverem; app adapter wykonuje najwyżej jeden stage i zapisuje go przez RA-038 jako
`INTENT_BOUND -> STARTED -> ARTIFACT_RECORDED -> COMPLETION_OBSERVED`. Intent/claim/enqueue oraz
writer decision resume mają transakcyjne rollback tests. Efekt po `STARTED` bez trwałego artefaktu
nie jest automatycznie replayowany.

Stage context jest kompilowany świeżo przez RA-040, structured outputs są schema-owned przez RA-039,
a artifact case/run/revision/kind/digest i owner decision są sprawdzane poza modelem. Approval
booleans są wyprowadzone z strict, digest-verified durable rows. Stage/model counters są rozłączne;
restart odbudowuje stage count z artifacts i konserwatywnie nalicza initial+repair dla structured
artifactu bez drugiego usage journalu.

Telemetry ma wyłącznie bounded `kind/outcome`; test i canary wykluczają case/owner/unit/run/content.
Nie uruchomiono AWS/Bedrock, workspace write, command gate, push, MR ani merge — zgodnie z zakresem.

## 4. Mutation evidence

Każda mutacja dała RED, została przywrócona i zakończona ponownym GREEN:

| Mechanizm | Mutacja | Dowód RED |
|---|---|---|
| exact target/transaction | foreign run albo brak atomic preclaim | real-PG test |
| decision causality | brak parent/revision albo causal payload dla non-writer | real-PG test |
| risk/approval | downgrade, model-only approval, brak gates/evidence re-check | unit test |
| structural progress | narrative w fingerprint albo błędne limity | unit test |
| recovery | replay confirmed artifact albo kontynuacja po STARTED/no artifact | runtime test |
| stage ledger/driver | brak STARTED albo odpięty production port | real-PG/guardrail |
| lease/deadline | brak in-flight heartbeat albo reset deadline od `Date.now()` | real-PG test |
| call accounting | zastąpienie actual `result.modelCalls` stałą | runtime test |
| owner authorization | pominięcie durable answer albo production wiring | real-PG/guardrail |
| telemetry | dodanie `caseId` do labela | canary test |

## 5. Findings i zakres

Audyt zamknął pięć findingów w zakresie: lease krótszy od model timeoutu, deadline resetowany po
restarcie, złączony stage/model counter, niekompatybilne poszerzenie non-writer `case.resume` oraz
brak przeniesienia causal owner grant do production portu. Wszystkie mają test i mutation evidence;
nie pozostał finding BLOCKER, HIGH ani MEDIUM i nie dodano cross-task findingu.

Plan i allowed paths powstały przed implementacją. Zmiany obejmują wyłącznie zatwierdzone granice
WU-00..04 oraz korekty znalezione podczas audytu zgodnie z `ADR-0007`/AGENTS.md.

## 6. Werdykt

- Werdykt: `PASS`

Wszystkie dziesięć kryteriów RA-041 jest spełnionych, mechanizmy bezpieczeństwa mają RED→GREEN,
pełna bramka i niezależna bramka audytowa zakończyły się exit code `0`.
