# RA-016 — Handoff 01

## Metadata

- Task: `RA-016`
- Status proponowany: `BLOCKED`
- Autor/rola: `Sol / COORDINATOR_AUDITOR`
- Implementer model/transport: `GPT-5.6 Luna / medium / local sub-agent`
- Work-units plan: `docs/work-units/RA-016/WORK_UNITS.md`, revision 24
- Zaakceptowane units: `WU-01`–`WU-08D`
- Zablokowany unit: `WU-08E`
- Data: `2026-08-20`
- Bazowy commit: `0de5fc6`
- Końcowy stan: commit `ce5ec5e` plus niezaakceptowany diff WU-08E w working tree

## Wynik

Atomiczny Jira runtime jest zaimplementowany i jego testy są zielone, ale unit
nie został zaakceptowany. Równoległe exact delivery serializuje zapis dopiero po
REST, więc kilka workerów może wykonać ten sam `getIssue` przed rozpoznaniem
replay. To narusza literalne kryterium „exact replay przed ponownym REST”.

## Zrealizowany zakres

- Verified payload, normalize, scoped REST snapshot i correlation są złożone w
  runtime.
- Normalized event, snapshot, case/entity/binding/outbox/receipt zapisują się w
  jednej transakcji.
- Primary-key race został usunięty przez per-event transaction advisory lock.
- Błędy REST są mapowane do bounded `JiraRuntimeError("rest_failure")` bez cause.
- Fault matrix, stale, delete, sześć event types, scope i redaction są pokryte.

## Wykonanie work units

| Unit | Raport implementera | Sol gate | Wynik |
|---|---|---|---|
| `WU-08E` initial | runtime + 9 real-PG tests | luki w fault evidence i identity/redaction tests | FAILED |
| `WU-08E` fix 1 | 10 real-PG tests | niezależny audyt odtworzył `events_pkey` race i REST leak boundary | FAILED |
| `WU-08E` fix 2 | 11 real-PG tests, primary-key lock i REST redaction | zapis bezpieczny, ale concurrent replay nadal po REST | FAILED / BLOCKED |

## Zmiany w niezaakceptowanym diffie

| Ścieżka/moduł | Co zmieniono | Stan |
|---|---|---|
| `packages/connector-jira/src/runtime.ts` | atomic processing runtime | WIP, nie commitować jako accepted |
| `packages/connector-jira/test/runtime.integration.test.ts` | real-PG runtime/fault/concurrency tests | WIP, brak `getIssue` call-count proof |
| `packages/connector-jira/src/index.ts` | runtime export | WIP |

## Kryteria akceptacji WU-08E

| Kryterium | Status | Dowód |
|---|---|---|
| Exact sequential replay przed REST, write-free | PASS | sequential replay test, REST call count 1 |
| Exact concurrent replay przed ponownym REST | FAIL | replay i `getIssue` są przed transaction advisory lockiem |
| Atomic event/snapshot/projection/receipt | PASS | full fault matrix i filtrowany Discord outbox |
| Stale bez projekcji, delete bez GET, scope isolation | PASS | target real-PG tests |
| Bounded REST errors | PASS | `rest_failure` redaction test |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| runtime target real-PG, 3 powtórzenia | 0 | 11/11 za każdym razem |
| pełny `packages/connector-jira/test` | 0 | 97/97 |
| connector typecheck/build | 0 | PASS |
| scoped ESLint/Prettier, `git diff --check` | 0 | PASS; tylko istniejące warnings boundaries |
| niezależny code/concurrency audit | n/a | `CHANGES_REQUIRED` |

## Bezpieczeństwo i dane

- REST/payload errors nie zawierają plaintextu, payload ref/digest, tokenu ani
  sekretu w `String`/JSON.
- Owner/connection/project/issue scope pozostaje server-owned i exact.
- External Jira content pozostaje `UNTRUSTED_DATA`.
- Nie wykonano live Jira, push, MR ani innych remote writes.

## Blokada i wymagane wznowienie

Workflow zatrzymuje automatyczne ponawianie po dwóch nieudanych poprawkach tego
samego celu. Wznowienie wymaga jawnego resetu limitu przez właściciela. Minimalna
następna poprawka musi objąć replay check, REST i zapis jednym server-owned
per-event `Database.withAdvisoryLock`, a test musi wymusić deferred concurrency,
potwierdzić dokładnie jeden `getIssue`, brak `cause` oraz zero zapisów po REST
failure.

`WU-08F` oraz końcowy audyt RA-016 pozostają zablokowane.

## Decision Request

- Decyzja: czy właściciel resetuje limit automatycznych prób dla jednego,
  precyzyjnego fix unitu RA-016-WU-08E?
- Dlaczego teraz: bez decyzji workflow zabrania trzeciego automatycznego retry,
  a RA-016 blokuje później RA-018, RA-021 i RA-023.
- Rekomendacja Sol: **Opcja A**.
- Opcja A — zresetować limit dla jednego fix unitu: objąć replay check, REST i
  transakcję jednym per-event `Database.withAdvisoryLock`; wymagany deferred
  concurrency test z dokładnie jednym `getIssue`.
- Opcja B — zaakceptować wiele concurrent REST GET i złagodzić kryterium taska;
  zapis pozostaje idempotentny, ale rośnie koszt/rate-limit risk i zmienia się
  zatwierdzony kontrakt.
- Opcja C — pozostawić RA-016 zablokowane; kontynuować niezależny coding-engine
  stream, ale nie odblokowywać zależności Jira.
- Zablokowany zakres: `RA-016-WU-08E`, `WU-08F` i końcowy audyt RA-016.
