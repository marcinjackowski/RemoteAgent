# RA-011 — Handoff 02

## Metadata

- Task: `RA-011`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Implementer model/transport: `Claude Opus 5 / wysoki effort / IMPLEMENTER`,
  osobny subagent w świeżej ephemerycznej sesji, zamknięty context pack
  (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Work-units plan: `docs/work-units/RA-011/WORK_UNITS.md`, revision `14`
- Zaakceptowane units: `WU-01`–`WU-08` (commitowane), `WU-09H` (ten handoff)
- Data: `2026-08-20`
- Bazowy commit lub stan początkowy: `b2d6631`; WIP planner z
  `HANDOFF-01.md` (`planner.ts` sha256 `71fdea85…`, 383 linie)
- Końcowy commit lub stan working tree: `b2d6631` + niecommitowany WIP;
  `planner.ts` sha256 `18eaed9a…` (516 linii),
  `planner.integration.test.ts` sha256 `b7d2ccda…` (563 linie)

## Wynik

Planner składa read-only discovery, wersjonowany `RepositoryProfile` i
audytowalny `ImplementationPlan` nad durable RA-010 mappingiem. Domknięta została
ostatnia luka bezpieczeństwa z `HANDOFF-01`: `checkPlannerStaleness()` nie ufa już
polom serializowanego `RepositoryProfileBuildResult`, lecz przelicza je
kanonicznie, i wiąże `plan.task_id` z baseline snapshot bindingiem. Forged
serialized binding oraz plan z obcego case/workspace/tree nie mogą już otrzymać
werdyktu `VALID`.

## Zrealizowany zakres

- Runtime-parse całego `RepositoryProfileBuildResult` po obu stronach porównania
  (baseline i current): exact key set na trzech poziomach, `repositoryProfile`,
  `sha256Digest`, `idString`.
- Przeliczenie kanonicznego `profileDigest` z samego `RepositoryProfile`.
- Przeliczenie kanonicznego `bindingDigest` z `{profileDigest, identity,
  treeDigest}` — dokładnie tą samą formułą, którą stosuje `buildRepositoryProfile`.
- Downstream porównania i zwracany rezultat korzystają z **przeliczonych**
  wartości, nigdy z pól dostarczonych przez wołającego.
- Task-ID gate: `plan.task_id === "task_" + <przeliczony baseline bindingDigest>`.
- Cztery brakujące klasy dowodów z `HANDOFF-01`: forged serialized binding,
  foreign case/workspace/tree, mutation-during-draft dla `PLAN` **i** `DECISION`,
  exact restart `plan_id`/`decision_id`/decision binding.
- Formatowanie dwóch plików, które w `HANDOFF-01` failowały Prettiera.

## Wykonanie work units

| Unit | Raport implementera | Coordinator gate | Wynik |
|---|---|---|---|
| `WU-09H` | `COMPLETED`, 45/45, opisane trzy helpery i trzy nowe testy | diff w dwóch dozwolonych plikach; ponowione testy; **mutation testing obu fixów**; typecheck/build/lint/format/diff-check | ACCEPTED |

Fix units `WU-09`, `WU-09F`, `WU-09G` pozostają `CHANGES_REQUESTED` jako zapis
historyczny; ich findingi domyka `WU-09H`.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/repository-planner/src/planner.ts` | `recomputeProfileDigest`, `exactStalenessKeys`, `verifiedBuildResult`; przepisany `checkPlannerStaleness` z task-ID gate | serializowany binding był authority; forged digest i obcy binding przechodziły jako `VALID` |
| `packages/repository-planner/test/planner.integration.test.ts` | trzy nowe testy (forged/foreign binding, foreign-binding plan, mutation PLAN+DECISION + restart) | cztery klasy dowodów wymagane przez `HANDOFF-01` nie istniały |
| `packages/repository-planner/src/index.ts` | publiczne Planner integration exports | WIP z `WU-09`, bez zmian w tym unicie |

`src/staleness.ts` i `src/profile.ts` pozostały nietknięte — warstwa snapshot
bindingu żyje wyłącznie w `planner.ts`, więc zaakceptowane kontrakty się nie
zmieniły.

## Decyzje i uzasadnienie

- Walidacja bindingu trafiła do `planner.ts`, nie do `staleness.ts`. `checkPlanStaleness`
  jest zaakceptowanym, przetestowanym kontraktem operującym na `RepositoryProfile`;
  snapshot binding (identity + treeDigest) jest pojęciem warstwy Plannera. Dzięki
  temu unit nie musiał modyfikować zaakceptowanego API ani jego testów.
- `verifiedBuildResult` zwraca zamrożony klon zbudowany z przeliczonych wartości.
  To celowe: gdyby zwracał obiekt wejściowy, dalszy kod nadal mógłby czytać pola
  atakującego.
- Rozróżnienie kodów błędu jest zamierzone: zły *kształt* → `INVALID_INPUT`,
  poprawny kształt z niezgodnym digestem → `PROFILE_BINDING_MISMATCH`. Pozwala
  wołającemu odróżnić błąd programistyczny od próby podmiany bindingu.
- Rozważana alternatywa: rozszerzyć `checkPlanStaleness` o binding. Odrzucona —
  zmieniałaby zaakceptowany kontrakt i zakres unitu poza dwa pliki.

## Kryteria akceptacji RA-011

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Instructions wykryte z provenance | PASS | instruction/profile suites |
| 2. Requirement → krok i test/evidence | PASS | plan/coverage suites |
| 3. Prompt-injection-like tekst pozostaje danymi | PASS | adversarial instruction + integration tests |
| 4. Zmiana instrukcji/base SHA unieważnia plan | PASS | staleness suite + integration; teraz również forged/foreign binding |
| 5. Materialna niejasność → decyzja | PASS | ambiguity suite + `DECISION` integration tests |
| 6. Planner nie ma narzędzi zapisujących | PASS | sealed manifest, unchanged-tree assertions |
| Exact case/workspace/tree binding po restarcie | PASS | forged binding + foreign binding + restart tests; `HANDOFF-01` miał tu FAIL |

## Testy i kontrole

Wszystkie uruchomione niezależnie przez koordynatora, nie przepisane z raportu
implementera.

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm vitest run packages/contracts/test/repository-planning.test.ts packages/repository-planner/test` | 0 | 45/45 (10 plików); baseline `HANDOFF-01` był 42/42 |
| `pnpm vitest run` (całe repo, real PG) | 0 | 1088/1088, 110 plików — brak regresji poza pakietem |
| `pnpm --filter @remoteagent/repository-planner typecheck` | 0 | PASS |
| `pnpm --filter @remoteagent/repository-planner build` | 0 | PASS |
| `pnpm exec eslint packages/repository-planner/src packages/repository-planner/test` | 0 | PASS; tylko preexistujące warnings pluginu `boundaries` |
| `pnpm exec prettier --check packages/repository-planner/src packages/repository-planner/test` | 0 | PASS — naprawia FAIL z `HANDOFF-01` |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| `git diff --check` | 0 | PASS |

### Mutation testing koordynatora

Zielone testy nie dowodzą, że nowy kod jest load-bearing — w `HANDOFF-01` cała
luka RA-016 była zielona. Dlatego koordynator celowo zepsuł każdy z dwóch fixów
osobno i sprawdził, czy testy to łapią:

| Mutacja | Wynik | Komunikat |
|---|---|---|
| usunięty task-ID gate | wykryta | `rejects a plan compiled against a foreign snapshot binding` → FAIL |
| `bindingDigest` czytany zamiast przeliczany (dokładnie oryginalny finding HIGH) | wykryta | `recomputes serialized snapshot bindings instead of trusting them` → FAIL |

Po każdej mutacji plik przywrócono z kopii; końcowy `planner.ts` ma sha256
`18eaed9a…`, identyczny jak po pracy implementera, i suite ponownie 45/45.

## Snapshoty i artefakty

- Brak snapshot artifacts w tym tasku.
- Żaden snapshot nie został zmieniony.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; Planner nie otrzymuje credentials ani raw host path.
- Izolacja kont/scope: case/workspace/repo/base rozwiązywane wyłącznie z durable
  `WorkspaceMappingStore`; forged i foreign binding fail-closed.
- Side effecty i idempotencja: Planner jest read-only; manifest bez
  write/exec/delete; testy potwierdzają niezmieniony tree.
- Dane zewnętrzne: treść repozytorium pozostaje `UNTRUSTED_DATA`; secret canary
  jest odrzucany; authority instrukcji wynika z polityki ścieżek, nie z treści.
- Nie wykonano push, MR, commitu ani żadnego external write.

## Znane ograniczenia i ryzyka

- Publiczna sygnatura `checkPlannerStaleness` nadal deklaruje
  `PlannerStalenessInput`, mimo że runtime przyjmuje i waliduje `unknown`. Testy
  forged input muszą rzutować przez lokalny helper. Rozszerzenie parametru do
  `unknown` (jak w `checkPlanStaleness`) byłoby czystsze, ale dotyka
  eksportowanego type surface w `src/index.ts` — poza allowlistą tego unitu.
  Zgłoszone przez implementera do decyzji koordynatora, nie rozstrzygnięte
  samodzielnie. Ocena: kosmetyczne, nie wpływa na bezpieczeństwo runtime.
- Kolizja sha256 na `profileDigest`/`bindingDigest` pozostaje teoretycznym
  założeniem kryptograficznym, jak w całym repo.

## Otwarte pytania

- Brak. Reset limitu prób został udzielony przez właściciela `2026-08-20`
  (opcja A, ADR-0005) i wykorzystany na jeden fix unit.

## Stan po tym handoffie

- Co jest gotowe: wszystkie unity RA-011; pełna suite, typecheck, build, lint,
  format, diff-check i walidator kolejki zielone; mutation testing potwierdza, że
  oba fixy są load-bearing.
- Czego nie robić przed audytem: nie commitować WIP, nie mieszać go ze strumieniem
  RA-016, nie startować RA-012 (wymaga `DONE` po audycie `PASS`).
- Jakie fix units utworzyć po `CHANGES_REQUIRED`: zależnie od findingów;
  kandydatem najniższego ryzyka jest ujednolicenie typu parametru
  `checkPlannerStaleness` do `unknown` wraz z `src/index.ts`.
