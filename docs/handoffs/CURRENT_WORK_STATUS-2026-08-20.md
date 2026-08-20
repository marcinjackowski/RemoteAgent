# RemoteAgent — current work status for model transfer

## Purpose

Ten dokument jest punktem wejścia dla modelu przejmującego pracę po wyczerpaniu
limitu bieżącego koordynatora. Opisuje stan na `2026-08-20`, ale nie zastępuje
`AGENTS.md`, tasków, work-unit plans, handoffów ani audytów. Przed zmianą kodu
nowy koordynator musi przeczytać obowiązkowe dokumenty wskazane w `AGENTS.md`.

Nie wolno zakładać, że dirty working tree jest przypadkowy. Zawiera dwa
niezaakceptowane, odseparowane strumienie WIP: `RA-011` i `RA-016`.

## Przekazanie ról modeli

- Nowy model planujący, sprawdzający i audytujący: **Claude Opus 5**.
- Model implementujący: jeszcze nieustalony; rozważany jest **Opus 4.8** albo
  **Sonnet**.
- Do czasu jawnego wyboru implementera nie uruchamiać nowych write units i nie
  wpisywać ostatecznej nazwy implementera do wszystkich kontraktów workflow.
- Semantyka ról pozostaje bez zmian: koordynator/audytor planuje, tworzy małe
  units i niezależnie sprawdza wynik; implementer wykonuje dokładnie jeden unit,
  nie planuje, nie audytuje, nie zmienia dokumentacji workflow i nie commitował.
- Aktualne dokumenty nadal wymieniają `Sol` i `GPT-5.6 Luna`. To historyczny
  model identity, który trzeba zaktualizować dopiero po wyborze implementera.
  Najnowsza decyzja właściciela o Opus 5 ma pierwszeństwo dla roli audytora.
- Nadal obowiązuje maksymalnie trzy równoległe strumienie, najwyżej jeden writer
  na task/case i rozłączne allowed paths.

## Snapshot repozytorium

- Repo: `/Users/marcinjackowski/Private/RemoteAgent`
- Branch: `main`
- HEAD: `b4cd436` — `docs(workflow): block planner binding retry`
- Poprzednie istotne commity:
  - `50a6200` — zapis blokady Jira runtime;
  - `e3495bd` — zaakceptowane stale-plan invalidation RA-011;
  - `ce5ec5e` — blokada retry Jira;
  - `0a178dd` — zaakceptowane DecisionRequest binding RA-011;
  - `a9f78bb` — zaakceptowany compiler planu RA-011;
  - `0de5fc6` — zaakceptowany durable Jira correlation replay.
- `workflow:validate`: PASS, `26 tasks`.
- Nie wykonano push, MR, merge, ticket transition ani live external write.
- W chwili zapisu nie działa żaden implementer; wcześniejsze sub-agenty
  zakończyły lub zostały zatrzymane.

## Dirty working tree — nie usuwać i nie mieszać

```text
 M packages/connector-jira/src/index.ts
 M packages/repository-planner/src/index.ts
?? packages/connector-jira/src/runtime.ts
?? packages/connector-jira/test/runtime.integration.test.ts
?? packages/repository-planner/src/planner.ts
?? packages/repository-planner/test/fake-planner.ts
?? packages/repository-planner/test/planner.integration.test.ts
```

### RA-016 WIP

| Plik | Linie | SHA-256 |
|---|---:|---|
| `packages/connector-jira/src/runtime.ts` | 294 | `867ea0bbc27a73ebdd672f981feee747421ff73f08a34f1a1b87618e79c9d917` |
| `packages/connector-jira/test/runtime.integration.test.ts` | 480 | `dc9d4d0c8e1f857d94a531ce5f8aa76ecdd999b1497035cf9b796609ba94ffbf` |
| `packages/connector-jira/src/index.ts` | tracked +1 export | eksport `./runtime.js` |

### RA-011 WIP

| Plik | Linie | SHA-256 |
|---|---:|---|
| `packages/repository-planner/src/planner.ts` | 383 | `71fdea853bab0b554cf79fe4aed49aedd0faca59b5fb8d7821e634923a5c38ff` |
| `packages/repository-planner/test/fake-planner.ts` | 46 | `2abfd05d6ed09179865350ee0892454055701510b1aebd2673b2947834cafcf7` |
| `packages/repository-planner/test/planner.integration.test.ts` | 369 | `49892affb68dffd9439c51bd384ace422af87c5074ce99faafc9a6ab7ed61ab4` |
| `packages/repository-planner/src/index.ts` | tracked +14 lines | publiczne Planner integration exports |

Nie stage'ować ani commitować jednego strumienia razem z drugim. Nie używać
`git reset --hard`, `git checkout --` ani czyszczenia untracked files.

## Stan kolejki

- `RA-001`–`RA-010`: `DONE`, audyty `PASS` istnieją w `docs/audits/`.
- `RA-011`: `BLOCKED`, ma niezaakceptowany WIP i Decision Request.
- `RA-016`: `BLOCKED`, ma niezaakceptowany WIP i Decision Request.
- Wszystkie pozostałe taski `RA-012`–`RA-026` są
  `BLOCKED_BY_DEPENDENCIES`.
- Nie istnieje obecnie task `READY`; realna implementacja nie może ruszyć bez
  jawnej decyzji właściciela dotyczącej resetu limitów retry.

Źródło prawdy: `docs/tasks/TASK_INDEX.md`.

## Wątek 1 — RA-011 Repository discovery and planning

### Stan

- Status taska: `BLOCKED`.
- Plan: `docs/work-units/RA-011/WORK_UNITS.md`, revision `13`, `BLOCKED`.
- `WU-01`–`WU-08`: `ACCEPTED` i commitowane.
- `WU-09`, `WU-09F`: `CHANGES_REQUESTED`.
- `WU-09G`: `BLOCKED` po wyczerpaniu dwóch automatycznych poprawek.
- Szczegółowy handoff: `docs/handoffs/RA-011/HANDOFF-01.md`.

### Co działa

- Mapping-backed, sealed i read-only Planner composition.
- Instruction/config discovery, provenance i `UNTRUSTED_DATA`.
- Complete requirement coverage, plan compiler i DecisionRequest.
- Post-draft workspace/mapping digest check.
- Strict, unique, frozen requirements przed draft call.
- Stale detection dla base SHA, instruction digest i contract version.
- Brak write/exec/delete capability w tool manifest.

### Ostatnie dowody

- Planner integration: `6/6` PASS.
- Contracts + cały repository-planner: `42/42` PASS.
- Typecheck/build: PASS.
- Scoped ESLint: PASS z istniejącymi warnings pluginu boundaries.
- Scoped Prettier: FAIL dla `planner.ts` i `planner.integration.test.ts`.
- Niezależny audyt: `CHANGES_REQUIRED`.

### Nierozwiązane findingi

1. **HIGH:** `checkPlannerStaleness()` ufa polom serializowanego
   `RepositoryProfileBuildResult`. Nie waliduje strict keys i nie przelicza
   canonical `bindingDigest` z `profileDigest + snapshotBinding.identity +
   treeDigest`. Forged foreign case/workspace/tree może przejść jako `VALID`.
2. **HIGH, wykryte przez koordynatora:** plan ma `task_id` wyprowadzony z
   binding digest, ale staleness nie sprawdza, że `plan.task_id` odpowiada
   baseline bindingowi. Plan z obcego bindingu i tym samym profilem może zostać
   uznany za valid.
3. **MEDIUM:** brak exact restart proof dla `decision_id` i decision binding.
4. Brak jawnych testów mutation-during-draft dla obu `PLAN` i `DECISION`, forged
   serialized binding, foreign identity/tree oraz pełnej macierzy strict
   requirements.
5. Dwa pliki wymagają mechanicznego formatowania.

### Minimalny następny fix unit po zgodzie właściciela

Allowed paths pozostają tylko:

- `packages/repository-planner/src/planner.ts`
- `packages/repository-planner/test/planner.integration.test.ts`

Wymagany rezultat:

1. Runtime-parse `RepositoryProfileBuildResult`: exact keys, poprawny profile,
   snapshot identity/tree digest oraz ponownie policzony canonical
   `bindingDigest`.
2. Sprawdzenie `plan.task_id === task_<baseline binding hex>` przed zwrotem
   `VALID`; foreign plan/binding ma dać typed mismatch/stale.
3. Testy forged serialized binding, foreign case/workspace/tree, PLAN i DECISION
   mutation oraz świeży restart exact `plan_id`, `decision_id` i binding.
4. Prettier dla dwóch allowed files.

Po fixie Opus 5 musi ponownie uruchomić cały gate, wykonać niezależny audyt,
zaakceptować/commitować WIP dopiero przy `PASS`, utworzyć właściwy końcowy
handoff/audit i ustawić `RA-011` na `DONE`.

### Decision Request

Właściciel nie zresetował jeszcze limitu. Rekomendowana odpowiedź:

```text
Resetuję limit dla RA-011 zgodnie z opcją A dla jednego finalnego fix unitu.
```

## Wątek 2 — RA-016 Jira connector

### Stan

- Status taska: `BLOCKED`.
- Plan: `docs/work-units/RA-016/WORK_UNITS.md`, revision `24`.
- `WU-01`–`WU-08D`: `ACCEPTED`.
- `WU-08E`: `BLOCKED`; `WU-08F`: `BLOCKED`.
- Szczegółowy handoff: `docs/handoffs/RA-016/HANDOFF-01.md`.

### Co działa

- Verified durable payload read, trusted ingress context i parser.
- Read-only Jira REST, normalization, snapshots, correlation i Discord outbox.
- Event/snapshot/case/entity/binding/outbox/receipt transaction boundary.
- Primary-key race usunięty przez transaction advisory lock.
- REST failures redagowane do `JiraRuntimeError("rest_failure")` bez cause.
- Scope, stale, delete, fault i restart paths pokryte testami.

### Ostatnie dowody

- Target runtime real-PG: `11/11` PASS, powtórzone trzy razy.
- Cały connector Jira: `97/97` PASS.
- Typecheck/build/scoped ESLint/Prettier/diff-check: PASS.
- Audyt: `CHANGES_REQUIRED` mimo zielonych testów.

### Nierozwiązany finding

Concurrent exact duplicate może wykonać `getIssue` kilka razy. Replay check i
REST call są przed transaction advisory lockiem; lock serializuje dopiero zapis.
To łamie literalne AC: exact replay ma zostać wykryty przed ponownym REST.

### Minimalny następny fix unit po zgodzie właściciela

- Objąć replay check, Jira REST i transakcję jednym server-owned per-event
  `Database.withAdvisoryLock`.
- Dodać deferred concurrency test, który dowodzi dokładnie jednego `getIssue`.
- Zachować zero writes i brak `cause` po REST failure.
- Allowed WIP scope: `runtime.ts`, `runtime.integration.test.ts`, a `index.ts`
  wyłącznie jeśli export nadal jest wymagany.

Po fixie: target real-PG wielokrotnie, cały connector, typecheck/build/format,
potem `WU-08F`, końcowy handoff i niezależny audyt Opus 5.

### Decision Request

Właściciel nie zresetował jeszcze limitu. Rekomendowana odpowiedź:

```text
Resetuję limit dla RA-016 zgodnie z opcją A dla jednego finalnego fix unitu.
```

## Zalecane wznowienie dwóch zablokowanych strumieni

Po wyborze implementera i jawnej zgodzie właściciela:

1. Opus 5 aktualizuje model identity w `AGENTS.md`, workflow docs i ADR-0004,
   zachowując dotychczasową semantykę ról.
2. Uruchamia dwa świeże, rozłączne implementery równolegle:
   - implementer A: finalny fix RA-011;
   - implementer B: finalny fix RA-016.
3. Trzeci slot jest read-only: niezależny preflight albo review; nie może
   audytować własnej implementacji.
4. Opus 5 sprawdza allowlisty i odtwarza bramki niezależnie.
5. `PASS` RA-011 odblokowuje RA-012. `PASS` RA-016 nie wystarcza sam do RA-018,
   ale usuwa kluczową blokadę Jira.
6. Nie rozpoczynać RA-012 przed formalnym `DONE` RA-011.

## Przygotowanie kolejnych tasków — wyniki preflightów

Poniższe plany nie są jeszcze formalnymi `WORK_UNITS.md`. Trzeba je ponownie
sprawdzić z aktualnym kodem i zapisać dopiero po odblokowaniu zależności.

### RA-012 Implementation toolset

Rekomendowany nowy package: `@remoteagent/implementation-tools`, nie rozszerzanie
`workspace-runner` o cały model-facing toolset.

Sekwencja:

1. strict contracts/package;
2. osobny durable operation ledger w PostgreSQL — nie używać `JobStore` ani
   JSONL workspace ledger jako cross-process authority;
3. bounded read/search/tree/config tools;
4. journaled multi-file patch z staging/digest/recovery; filesystem nie daje
   prawdziwej transakcji, więc partial state musi być jawny/`AMBIGUOUS`;
5. server-owned command policy i temporary output/artifact sink;
6. mkdir/diagnostics;
7. composition + fault/restart matrix.

Migracja musi użyć następnego wolnego numeru po ponownym sprawdzeniu. Aktualny
najwyższy numer to `026`; niczego nie rezerwować równolegle bez koordynatora.

### RA-013 Tests, artifacts and snapshots

1. strict `TestRun` + `ArtifactReference` contracts;
2. local artifact store;
3. snapshot evidence/diff classification;
4. test runner i evidence composition;
5. final integration/evidence proof.

Artifact boundary musi być gotowy przed RA-015, RA-017 i RA-021.

### RA-014 Local Git lifecycle

1. Git lifecycle contracts;
2. branch create/resume;
3. status/diff/stage allowlisted paths;
4. local commit związany z evidence;
5. conflict-safe fetch/rebase;
6. final proof.

Zakaz push, force-push, merge i broad destructive Git. Remote write należy do
RA-017.

### RA-015 Independent review and fix loop

1. strict `ReviewReport` contracts;
2. independent read-only reviewer runtime;
3. durable review/loop persistence — nie `JobStore` jako substytut;
4. supervisor verdict i fix routing;
5. final bounded-loop proof.

PASS wymaga braku BLOCKER/HIGH/MEDIUM. Limit iteracji musi dawać trwały blocker,
nie nieskończony retry.

### RA-017 GitLab connector

1. contracts/config/allowlist;
2. read-only REST client;
3. signed webhook ingress;
4. normalize/enrichment/correlation;
5. sandbox push + idempotent draft MR executor;
6. final integration proof.

Każdy push/MR: durable ExternalAction intent/receipt, sandbox only, bez merge i
force-push. Live write wymaga jawnej zgody właściciela.

### RA-018 Golden path

1. golden path harness;
2. two-case concurrency harness z realnym overlap proof;
3. fault/reconciliation matrix;
4. manual Discord acceptance/runbook — każdy send dopiero po jawnej zgodzie;
5. final evidence bundle.

### RA-019 Gmail two-account connector

Skorygowana sekwencja po red-team:

1. contracts/config dla `private` i `sondermind`;
2. durable Gmail state/repository: watch, cursor, generation, dedupe;
3. watch + verified Pub/Sub ingress/renewal;
4. strict thread/message parser i privacy boundary;
5. history reconciliation/full resync + read-only Discord routing;
6. final two-account integration proof.

Najważniejsze: `historyId` jako opaque string, cursor advancement + event receipt
w jednej transakcji, body/attachments sparse by default, channel z trusted
config, zero Gmail/Discord write w tym tasku.

### RA-020 Calendar two-account connector

Skorygowana sekwencja po red-team:

1. contracts + privacy boundary;
2. durable schema/repositories;
3. read-only Calendar OAuth client;
4. verified bodyless notification ingress;
5. watch lifecycle/renewal;
6. pure recurrence/timezone/cancellation normalization;
7. atomic incremental/full sync, staged resync po HTTP 410;
8. read-only Discord routing przez outbox;
9. final two-account E2E/recovery proof.

Cursor jest per owner/connection/account/calendar. `syncToken` i `pageToken` mają
różne lifecycle. Channel token i sync token nie mogą być model-facing.

### RA-021 MCP Tool Broker

Skorygowana sekwencja po red-team:

1. strict broker contracts;
2. server-owned registry/manifest/scope resolution;
3. durable tool-call ledger, provider rate/circuit state i artifact binding;
4. bounded transport executor;
5. sealed credential-use + explicit fallback adapters;
6. malicious protocol/conformance proof;
7. final Jira/Gmail/Calendar/GitLab read-only provider integration.

`tools/list` jest `UNTRUSTED_DATA`, nie authority. Provider packages wystawiają
ports/adapters; nie mogą importować brokera w sposób tworzący dependency cycle.
Timeout po możliwym callu daje `AMBIGUOUS`, nigdy blind replay.

### RA-022 Policy, approvals and action executor

Robocza sekwencja:

1. risk/policy/approval contracts związane z checkpoint/decision/policy/scope;
2. durable approval grant/use ledger z atomic single-use;
3. pure deterministic R0–R4 evaluator + kill-switch snapshot;
4. authenticated Discord approval ingestion/resume trigger;
5. provider-neutral ExternalAction intent/receipt/reconciliation boundary;
6. final fake-provider integration proof.

Istniejące `approvals` i migracja `008` nie mają wszystkich wymaganych revision
i digest fields. Nie tworzyć migracji `026`; numer jest zajęty przez Jira.
Trzeba rozstrzygnąć rozszerzenie istniejącej tabeli versus nowy ledger.

### RA-023 AgentCore Gateway and official MCP targets

Robocza sekwencja:

1. target contracts/config/capability registry;
2. health/conformance discovery + deterministic fallback;
3. opaque OAuth/credential session boundary oparta na istniejącym refresh
   lifecycle, bez drugiego silnika tokenów;
4. one-shot AgentCore runtime/session handoff — Postgres/checkpoint pozostaje
   authority, session tylko transport/cache;
5. final fake Gateway conformance proof.

Werdykty `ADOPT/DEFER/REJECT`, maturity i aktualne capabilities wymagają świeżej
weryfikacji oficjalnej dokumentacji. Bez live contract tests i deploymentu bez
jawnej autoryzacji właściciela.

### RA-024–RA-026

Nie wykonano wiążącego preflightu. Nie planować ich szczegółowo przed
ukończeniem odpowiednich zależności i świeżym przeglądem Master Planu.

## Komendy weryfikacyjne

Repo korzysta z przypiętego runtime:

```sh
PATH=/Users/marcinjackowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
npx --yes --package=node@24.19.0 --package=pnpm@10.26.1 --call '<pnpm command>'
```

Real PostgreSQL:

```sh
RA_REQUIRE_POSTGRES=1 \
PGPORT=5433 \
PGUSER=remoteagent \
PGPASSWORD=remoteagent-local-dev \
PGDATABASE=remoteagent
```

RA-011 final gate:

```sh
pnpm vitest run packages/contracts/test/repository-planning.test.ts packages/repository-planner/test
pnpm --filter @remoteagent/repository-planner typecheck
pnpm --filter @remoteagent/repository-planner build
pnpm exec eslint packages/repository-planner/src packages/repository-planner/test
pnpm exec prettier --check packages/repository-planner/src packages/repository-planner/test
pnpm workflow:validate
git diff --check
```

RA-016 final gate:

```sh
RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test
pnpm --filter @remoteagent/connector-jira typecheck
pnpm --filter @remoteagent/connector-jira build
pnpm exec eslint packages/connector-jira/src packages/connector-jira/test
pnpm exec prettier --check packages/connector-jira/src packages/connector-jira/test
pnpm workflow:validate
git diff --check
```

Docker jest niedostępny. Pełny repo ESLint emituje niezwiązane warnings
`boundaries`; używać scoped lint. Nie uruchamiać Prettiera na SQL migrations.

## Pierwsza odpowiedź nowego koordynatora

Nowy koordynator powinien:

1. potwierdzić, że przeczytał obowiązkowe dokumenty i ten handoff;
2. powiedzieć, że Opus 5 przejmuje plan/audyt;
3. poprosić o jedną decyzję dotyczącą implementera: Opus 4.8 albo Sonnet;
4. poprosić o jawne potwierdzenie resetu limitu dla RA-011 i RA-016, najlepiej:

```text
Resetuję limit dla RA-011 i RA-016 zgodnie z opcją A. Implementer: <model>.
```

Nie traktować samego `continue` jako odpowiedzi na te Decision Requesty.

