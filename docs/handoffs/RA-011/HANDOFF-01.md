# RA-011 — Handoff 01

## Metadata

- Task: `RA-011`
- Status proponowany: `BLOCKED`
- Autor/rola: `Sol / COORDINATOR_AUDITOR`
- Implementer model/transport: `GPT-5.6 Luna / medium / sub-agent`
- Work-units plan: `docs/work-units/RA-011/WORK_UNITS.md`, revision 13
- Zaakceptowane units: `WU-01`–`WU-08`
- Zablokowany unit: `WU-09G`
- Data: `2026-08-20`
- Bazowy commit: `e3495bd`
- Końcowy stan: niezaakceptowany diff WU-09/WU-09F/WU-09G w working tree

## Wynik

Read-only Planner integration jest w większości zaimplementowana i wszystkie
testy funkcjonalne przechodzą, ale unit nie może zostać zaakceptowany. Publiczny
staleness check ufa serializowanemu `bindingDigest` bez jego ponownego
przeliczenia i nie dowodzi, że `plan.task_id` odpowiada baseline bindingowi.
Foreign case/workspace/tree może więc zostać przedstawiony jako `VALID`.

## Zrealizowany zakres

- Planner używa server-owned `WorkspaceMappingStore` zamiast publicznego rootu.
- Discovery, profil, plan i DecisionRequest pozostają read-only i sealed.
- Workspace i durable mapping są ponownie sprawdzane po odpowiedzi draft portu.
- Requirements są strict, bounded, unikalne i zamrożone przed draft call.
- Plan `task_id` jest deterministycznie wyprowadzany z profile binding digest.
- Zmiana base SHA, instruction digest i contract version daje stale result.

## Wykonanie work units

| Unit | Raport implementera | Sol gate | Wynik |
|---|---|---|---|
| `WU-09` | integration proof, 41 zielonych testów | audyt wykrył cztery binding/TOCTOU luki | FAILED |
| `WU-09F` | mapping store, post-draft digest, requirements | pozostał legacy overload i nietrwały WeakMap binding | FAILED |
| `WU-09G` | usunięty overload/WeakMap, binding w task ID | audyt wykrył niezweryfikowany serializowany binding | FAILED / BLOCKED |

## Zmiany w niezaakceptowanym diffie

| Ścieżka/moduł | Co zmieniono | Stan |
|---|---|---|
| `packages/repository-planner/src/planner.ts` | mapping-backed Planner composition i staleness wrapper | WIP, nie commitować jako accepted |
| `packages/repository-planner/src/index.ts` | publiczne exporty integration API | WIP |
| `packages/repository-planner/test/planner.integration.test.ts` | integration/security/restart tests | WIP, brak wymaganych adversarial proofs |
| `packages/repository-planner/test/fake-planner.ts` | deterministyczny fake draft port | WIP |

## Kryteria akceptacji RA-011

| Kryterium | Status | Dowód |
|---|---|---|
| Instructions z provenance | PASS | instruction/profile suites |
| Requirement → step/test/evidence | PASS | plan/coverage suites |
| Prompt-like repo text pozostaje danymi | PASS | adversarial instruction/integration tests |
| SHA/instructions/contracts unieważniają plan | PASS | staleness + integration tests |
| Materialna niejasność daje DecisionRequest | PASS | ambiguity + integration tests |
| Planner nie ma write/exec tools | PASS | sealed manifest i unchanged-tree tests |
| Exact case/workspace/tree binding po restarcie | FAIL | serialized binding nie jest przeliczany; task ID nie jest sprawdzany względem baseline |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| targeted Planner integration | 0 | 6/6 |
| contracts + pełny repository-planner | 0 | 42/42 |
| repository-planner typecheck/build | 0 | PASS |
| scoped ESLint | 0 | PASS; tylko istniejące warnings boundaries |
| scoped Prettier check | 1 | dwa pliki WU-09 wymagają formatowania |
| niezależny audyt WU-09G | n/a | `CHANGES_REQUIRED`: HIGH + MEDIUM |

## Bezpieczeństwo i dane

- Planner nie otrzymuje write/exec/delete capability ani raw host pathu.
- Repo content pozostaje `UNTRUSTED_DATA`; sekret canary jest odrzucany.
- Repo/case/workspace/base są rozwiązywane z durable mapping store.
- Nie wykonano push, MR ani external writes.

## Blokada i wymagane wznowienie

Workflow zatrzymuje automatyczne ponawianie po dwóch nieudanych poprawkach tego
samego celu. Minimalna następna poprawka musi runtime-zweryfikować cały
`RepositoryProfileBuildResult`: strict keys, snapshot identity/tree digest,
ponownie policzony canonical `bindingDigest`, oraz zgodność `plan.task_id` z
baseline bindingiem. Testy muszą objąć forged serialized binding, foreign
case/workspace/tree, mutation dla `PLAN` i `DECISION`, oraz exact restart
`plan_id`, `decision_id` i decision binding. Na końcu wymagane jest formatowanie.

`RA-012`, `RA-015` i dalszy coding-engine stream pozostają zablokowane przez
RA-011.

## Decision Request

- Decyzja: czy właściciel resetuje limit prób dla jednego finalnego fix unitu
  RA-011-WU-09G?
- Dlaczego teraz: dwie automatyczne poprawki nie spełniły trwałego bindingu, a
  workflow zabrania trzeciego cichego retry.
- Rekomendacja Sol: **Opcja A**.
- Opcja A — zresetować limit dla jednego finalnego fix unitu: przeliczyć binding,
  sprawdzić `task_id`, dodać cztery brakujące adversarial/restart proofs i
  sformatować dwa pliki.
- Opcja B — usunąć Planner integration z RA-011 i wrócić do osobnego taska;
  zmniejsza bieżący zakres, ale zmienia zaakceptowane kryteria i zależności.
- Opcja C — pozostawić RA-011 zablokowane; wtedy RA-012, RA-015 i większość
  dalszej kolejki nie może rozpocząć implementacji.
- Zablokowany zakres: `RA-011-WU-09G`, końcowy handoff/audyt RA-011 oraz taski
  zależne.
