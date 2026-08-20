# RA-009 — Handoff 01

## Metadata

- Task: `RA-009`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: Sol, `COORDINATOR_AUDITOR`, na podstawie raportów implementera i niezależnych unit gates
- Implementer model/transport: `GPT-5.6 Luna / medium`
- Work-units plan: `docs/work-units/RA-009/WORK_UNITS.md`, revision `18`
- Zaakceptowane units: `WU-01`…`WU-08`
- Data: 2026-08-20
- Bazowy commit lub stan początkowy: `55b1041a78d08d7f73867ffcb0875c90aab8efbc`
- Końcowy commit ocenianej implementacji: `f69473e`

## Wynik

Powstał trwały, bounded i model-neutralny Case Supervisor. Role mają wersjonowane
manifesty, work units i runs są zapisane w PostgreSQL, scheduler egzekwuje
fairness i limity, implementer ma pojedynczy writer fence per case, a restart nie
odtwarza potwierdzonej pracy ani nie replayuje niejednoznacznego runu.

## Zrealizowany zakres

- registry ról, promptów, modeli i tool manifestów;
- deterministyczna state machine Supervisora;
- trwałe work units, run binding i completion;
- per-case mailbox, global/provider semaphores i fairness;
- pojedynczy writer z trwałym fencing tokenem;
- równoległe read-only role i kanoniczny merge provenance/evidence;
- bounded budgets, pause, cancel i `WAITING_FOR_USER` resume;
- bounded runtime oraz real-PG recovery/fault/concurrency proof.

## Wykonanie work units

| Unit | Commit | Dowód | Wynik |
|---|---|---|---|
| WU-01 | `cee0499` | `role-registry.test.ts` | ACCEPTED |
| WU-02 | `b2b907d` | `supervisor-machine.test.ts` | ACCEPTED |
| WU-03 | `97c9e6e` | `work-unit.integration.test.ts` | ACCEPTED |
| WU-04 | `42eace7` | `scheduler.test.ts` | ACCEPTED |
| WU-05 | `664d065` | writer lease i queue concurrency | ACCEPTED |
| WU-06 | `3341d32` | `parallel-merge.test.ts` | ACCEPTED |
| WU-07 | `7c06e59` | `supervisor-control.test.ts` | ACCEPTED |
| WU-08 | `f69473e` | runtime concurrency i recovery integration | ACCEPTED |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Dwa cases działają równolegle pod globalnym limitem | PASS | real-PG two-case test, global/provider peak assertions |
| Jeden case nie ma dwóch aktywnych writerów | PASS | DB partial unique guard, JobStore serialization, deferred/ambiguous writer tests |
| Reviewer i Verification działają równolegle tylko read-only | PASS | barrier concurrency test i write-scope negative tests |
| Restart nie powtarza completed work unit | PASS | durable completion-before-ack fault i invocation counters |
| `WAITING_FOR_USER` tworzy nowy run po answer | PASS | source run terminalny, fresh unbound PENDING resume unit |
| Wyczerpanie budżetu daje trwały checkpoint | PASS | boundary/race matrix `supervisor-control.test.ts` |

## Testy i kontrole Sol

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| real-PG `agent-orchestrator/test` + work-unit/queue regression | 0 | 19 plików, 159 testów PASS |
| focused WU-08 integration | 0 | 2 pliki, 9 testów PASS |
| `agent-orchestrator` typecheck i build | 0 | PASS |
| scoped ESLint | 0 | PASS; tylko zastane ostrzeżenia konfiguracji boundaries |
| scoped Prettier | 0 | PASS |
| `git diff --check` | 0 | clean |

## Bezpieczeństwo, współbieżność i recovery

- Model nie ustala roli, scope, limitu ani writer authority.
- Partial unique index na aktywnym write-enabled work unit i JobStore case
  serialization są trwałym backstopem dla pojedynczego writera.
- Fence jest sprawdzany przed invoke oraz przed trwałym completion.
- RUNNING bez potwierdzonego completion staje się jawnie ambiguous i blokuje
  późniejszych writerów; completed run jest tylko finalizowany, bez role replay.
- Read-only merge sprawdza exact case/work-unit/run binding i zachowuje provenance
  bez prywatnego chain-of-thought.
- Prompt/tool snapshots i source scan nie wykazały sekretów.

## Znane ograniczenia i ryzyka

- `RuntimeSnapshot.writerBlocked` jest opcjonalnym polem adaptera; brak pola nie
  znosi ochrony DB ani wykrycia aktywnego RUNNING/DISPATCHED writera, ale adapter
  produkcyjny powinien je materializować dla natychmiastowego raportowania.
- Prawdziwe coding tools i workspace execution należą do RA-010/RA-012; WU-08
  używa deterministycznych fake roles zgodnie z zakresem.

## Otwarte pytania

- Brak decyzji właściciela wymaganych do audytu.

## Stan dla audytora

- Oceniany zakres kończy się na commit `f69473e`.
- Audyt ma ponownie sprawdzić pełny diff od bazowego commita, real-PG tests,
  fairness, writer fencing, bounded recovery i prompt authority.
- Nie zmieniać implementacji RA-009 podczas audytu.
