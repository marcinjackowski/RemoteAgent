# RA-011 — Audit 02

> Rewizja `02`, a nie `01`: `workflow:validate` wymaga, aby najnowszy audyt nie
> był starszy od handoffu, który ocenia (`HANDOFF-02`). Audyt `01` nie istnieje —
> `CHANGES_REQUIRED` dla `HANDOFF-01` powstał w sesji poprzedniego koordynatora i
> nie został zapisany jako dokument przed wyczerpaniem jego limitu.

## Metadata

- Task: `RA-011`
- Audytowany handoff: `docs/handoffs/RA-011/HANDOFF-02.md`
- Audytor: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Implementer model/transport: `Claude Opus 5 / wysoki effort / IMPLEMENTER`,
  osobny subagent, świeża ephemeryczna sesja, zamknięty context pack
  (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Work-units plan: `docs/work-units/RA-011/WORK_UNITS.md`, revision `14`
- Data: `2026-08-20`
- Werdykt: `PASS`

## Podsumowanie

Wszystkie sześć kryteriów akceptacji RA-011 jest spełnionych, a siódmy wymóg
z `HANDOFF-01` (exact case/workspace/tree binding po restarcie), który wcześniej
miał status FAIL, jest teraz spełniony i udowodniony. Obie luki HIGH z poprzedniego
audytu są domknięte i — co istotniejsze — potwierdzone jako load-bearing przez
mutation testing audytora, a nie tylko przez zielone testy.

Pozostaje jeden finding klasy LOW: gate `task_id` czyta pole ponownie z surowego
wejścia zamiast z obiektu zwalidowanego przez `checkPlanStaleness`. Nie jest
osiągalny przez żadną udokumentowaną ścieżkę danych (restart/deserializacja JSON
nie potrafi wytworzyć gettera), więc nie blokuje `PASS`, ale jest niespójnością
w kodzie napisanym właśnie po to, by nie ufać wejściu.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`, `docs/workflow/AUDIT_CHECKLIST.md`,
  `docs/tasks/TASK_INDEX.md`, `docs/tasks/RA-011.md`,
  `docs/work-units/RA-011/WORK_UNITS.md`, `docs/handoffs/RA-011/HANDOFF-01.md`,
  `docs/handoffs/RA-011/HANDOFF-02.md`,
  `docs/handoffs/CURRENT_WORK_STATUS-2026-08-20.md`.
- Sprawdzony diff/commity: pełny WIP względem `b2d6631`. Przeczytane w całości:
  `src/planner.ts` (516 linii), `test/planner.integration.test.ts` (563 linie),
  diff `src/index.ts`. Przeczytane dla kontekstu, niezmienione: `src/profile.ts`,
  `src/staleness.ts`, `src/digest.ts`, `src/plan.ts`,
  `packages/contracts/src/repository-profile.ts`.
- Potwierdzona allowlista: zmieniono wyłącznie dwa dozwolone pliki. Strumień
  RA-016 (`packages/connector-jira/`) nietknięty — potwierdzone przez `git status`
  i sha256 plików planner WIP przed/po.
- Uruchomione kontrole: pełna suite pakietu, cała suite repo na real PostgreSQL,
  typecheck, build, scoped ESLint, scoped Prettier `--check`,
  `pnpm workflow:validate`, `git diff --check`, mutation testing dwóch fixów oraz
  własna sonda TOCTOU w Node dla gate'u `task_id`.
- Potwierdzenie, że audytor nie implementował ocenianego kodu: kod
  `src/planner.ts` i `test/planner.integration.test.ts` napisał subagent
  `IMPLEMENTER` w osobnej sesji z zamkniętym context packiem. Audytor nie edytował
  tych plików. Ponieważ od ADR-0005 obie role dzieli tożsamość modelu, werdykt
  opiera się wyłącznie na odczycie rzeczywistego diffu i własnym uruchomieniu
  bramek — nie na raporcie implementera. Tymczasowe mutacje wykonane w celu
  weryfikacji zostały przywrócone z kopii i potwierdzone hashem
  `18eaed9aa98c6171455c222320b5fee88113ae7817f24737dd3e41811c090670`.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Wszystkie repo instructions wykryte z provenance | PASS | `instructions.test.ts`, `profile.test.ts`; provenance z `relative_path` + `digest` + `trust` wymuszone schematem |
| 2. Plan mapuje każdy wymóg na krok i test/evidence | PASS | `coverage.test.ts`, `plan.test.ts`; `compileImplementationPlan` odrzuca niepełne pokrycie |
| 3. Prompt-injection-like tekst pozostaje danymi | PASS | `content.trust` to `z.literal(UNTRUSTED_DATA)` w kontrakcie — nie da się podnieść do authority; test integracyjny potwierdza `UNTRUSTED_DATA` w profilu; secret canary (`Bearer …`) odrzucony przez `assertSafeValues` |
| 4. Zmiana instrukcji/base SHA unieważnia stale plan | PASS | `staleness.test.ts` + integracja: `BASE_SHA_CHANGED`, `INSTRUCTION_DIGEST_CHANGED`, `CONTRACT_VERSION_CHANGED`, `PROFILE_DIGEST_CHANGED` |
| 5. Materialna niejasność → decyzja, nie dowolny wybór | PASS | `ambiguity.test.ts`; `runPlanner` dla `kind: "DECISION"` zwraca `PlanningDecisionResult` i `plan: null` |
| 6. Planner nie ma narzędzi zapisujących | PASS | `profileManifest()` ma `can_write_workspace: false`, `can_execute_commands: false`, tylko pięć read tools; testy potwierdzają niezmieniony tree digest |
| Exact case/workspace/tree binding po restarcie (FAIL w `HANDOFF-01`) | PASS | `bindingDigest` przeliczany kanonicznie z `{profileDigest, identity, treeDigest}`; forged digest, foreign case/workspace/tree fail-closed; restart odtwarza exact `plan_id`, `task_id`, `decision_id` i binding |

## Findingi

### LOW — gate `task_id` czyta niezwalidowane wejście po walidacji

- Lokalizacja: `packages/repository-planner/src/planner.ts:494`
  (`if (input.plan.task_id !== \`task_${baseline.bindingDigest.slice(...)}\`)`).
- Dowód: `checkPlanStaleness` waliduje plan przez `implementationPlan.parse`, co
  w zod zwraca **nowy obiekt**; zwalidowana kopia nie jest jednak zwracana do
  `checkPlannerStaleness`. Gate sięga więc po `input.plan.task_id` ponownie, do
  oryginalnego obiektu. Audytor napisał sondę w Node na zbudowanym `dist/`:
  plan skompilowany dla bindingu `case-foreign/workspace-foreign`, przekazany jako
  obiekt z akcesorem `get task_id()` zwracającym prawdziwą wartość przy pierwszym
  odczycie i wartość lokalną przy drugim. Licznik odczytów: `2`. Wynik:
  `{"status":"VALID", …}` — plan z obcego bindingu przeszedł jako `VALID`,
  dokładnie ten skutek, któremu unit miał zapobiegać.
- Wpływ: **ograniczony i nieosiągalny przez udokumentowane ingressy.** Plan wraca
  z trwałego stanu przez deserializację JSON, a `JSON.parse` nie potrafi wytworzyć
  gettera ani proxy; dla każdego zwykłego obiektu drugi odczyt zwraca tę samą
  wartość, więc gate działa poprawnie. Wykorzystanie wymaga kontroli nad żywym
  obiektem JS w tym samym procesie, co implikuje już posiadane wykonanie kodu —
  to poza modelem zagrożeń `UNTRUSTED_DATA` tego repozytorium. Dlatego LOW, nie
  HIGH: kryterium restartu jest realnie spełnione.
  Niespójność jest jednak realna: `verifiedBuildResult` celowo zwraca przeliczony,
  zamrożony klon właśnie po to, by dalszy kod nie czytał pól wołającego —
  strona planu tej dyscypliny nie zachowuje.
- Wymagana zmiana: gate ma porównywać `task_id` z obiektu, który przeszedł
  walidację, a nie z `input.plan`. Najmniejsza poprawka: w
  `checkPlannerStaleness` wykonać lokalnie `implementationPlan.parse(input.plan)`
  i użyć wyniku w gate (`src/staleness.ts` pozostaje nietknięty). Alternatywa
  szersza: rozszerzyć `PlanStalenessResult` o `taskId` z już sparsowanego planu —
  dotyka jednak zaakceptowanego kontraktu i wymaga osobnej decyzji.

Findingów klasy BLOCKER, HIGH i MEDIUM nie ma.

## Testy audytora

Wszystkie poniższe uruchomił audytor samodzielnie. Raport implementera i unit
gate nie są tu dowodem.

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm vitest run packages/contracts/test/repository-planning.test.ts packages/repository-planner/test` | 0 | 45/45, 10 plików |
| `pnpm vitest run` (całe repo, `RA_REQUIRE_POSTGRES=1`, real PG) | 0 | 1088/1088, 110 plików — brak regresji |
| `pnpm --filter @remoteagent/repository-planner typecheck` | 0 | PASS |
| `pnpm --filter @remoteagent/repository-planner build` | 0 | PASS |
| `pnpm exec eslint packages/repository-planner/src packages/repository-planner/test` | 0 | PASS; tylko preexistujące warnings pluginu `boundaries` |
| `pnpm exec prettier --check packages/repository-planner/src packages/repository-planner/test` | 0 | PASS (`HANDOFF-01` miał tu FAIL) |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| `git diff --check` | 0 | PASS |
| mutation: usunięty gate `task_id` | 1 | test `rejects a plan compiled against a foreign snapshot binding` FAIL — fix load-bearing |
| mutation: `bindingDigest` czytany zamiast przeliczany | 1 | test `recomputes serialized snapshot bindings…` FAIL — fix load-bearing |
| sonda TOCTOU `task_id` (Node, `dist/`) | n/a | 2 odczyty pola; `VALID` dla obcego bindingu — źródło findingu LOW |

## Ryzyka przekrojowe

- Security/privacy: Planner nie ma write/exec/delete capability ani raw host
  pathu. `assertSafeValues` odrzuca host paths, klucze prywatne, `Bearer`, JWT,
  `glpat-`/`gh*_`/`AKIA`. Treść repozytorium jest przypięta do
  `UNTRUSTED_DATA` na poziomie schematu (`z.literal`), więc nie da się jej
  awansować do authority przez samą treść.
- Idempotencja/recovery: `runPlanner` jest read-only i deterministyczny; restart
  z tego samego mappingu odtwarza identyczne `plan_id`, `task_id`, `decision_id`
  i decision binding — udowodnione testem.
- Współbieżność: mutacja workspace w trakcie draftu daje typed `SNAPSHOT_CHANGED`
  zarówno dla `PLAN`, jak i `DECISION`; `assertContextCurrent` sprawdza też, czy
  durable mapping nie zmienił się w trakcie. Deterministyczny root symlink swap
  fail-closed.
- Observability: błędy są typed (`PlannerContextError`, `PlanStalenessError`,
  `RepositoryProfileBuildError`) z kodami rozróżniającymi zły kształt wejścia od
  próby podmiany bindingu — operator potrafi odróżnić bug od ataku.
- Kompatybilność: `src/staleness.ts`, `src/profile.ts` i kontrakty niezmienione;
  warstwa snapshot bindingu żyje wyłącznie w `planner.ts`, więc zaakceptowane API
  pozostaje stabilne. Publiczna sygnatura `checkPlannerStaleness` deklaruje
  `PlannerStalenessInput`, choć runtime waliduje `unknown` — kosmetyczna
  niespójność type surface, odnotowana w `HANDOFF-02`.

## Kolejny makro-task po `PASS`

`RA-011` przechodzi na `DONE`. Odblokowuje to `RA-012` (Implementation toolset),
którego pozostałe zależności — RA-005, RA-007, RA-009, RA-010 — są `DONE`.
`RA-015` nadal czeka na RA-012, RA-013 i RA-014.

Rekomendowany, opcjonalny hardening unit przed dalszym rozwojem Plannera
(nie blokuje `DONE`, wynika z findingu LOW):

1. `RA-011-WU-09J` — w `checkPlannerStaleness` porównywać `task_id` z planu
   sparsowanego lokalnie przez `implementationPlan.parse`, plus test z akcesorem
   dowodzący, że drugi odczyt nie może zmienić werdyktu. Allowed paths: te same
   dwa pliki.

## Uzasadnienie werdyktu

`PASS` jest dozwolony, ponieważ wszystkie sześć kryteriów akceptacji taska jest
spełnionych i udowodnionych niezależnie uruchomionymi testami, a wcześniej
failujący wymóg trwałego bindingu jest teraz spełniony. Nie pozostał żaden finding
klasy BLOCKER, HIGH ani MEDIUM: jedyny finding jest klasy LOW i nieosiągalny przez
udokumentowane ścieżki danych (restart przez deserializację JSON nie może wytworzyć
gettera), więc nie narusza kryterium, którego dotyczy.

Werdykt nie opiera się na raporcie implementera. Oba fixy zostały niezależnie
zweryfikowane jako load-bearing przez celowe wprowadzenie regresji i sprawdzenie,
że testy ją łapią — kontrola dodana właśnie dlatego, że w `HANDOFF-01` cała luka
współbieżności RA-016 była zielona pod istniejącymi testami.
