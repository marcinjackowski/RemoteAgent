# RA-045 — work units

Baseline: `9d8008e56da108ac94a0496234b9df9f39edb727`.

Właściciel zaakceptował `2026-08-26` dokładny smoke MOBL-2021 bez Jira i Discorda:
opis trafia bezpośrednio jako `UNTRUSTED_DATA`, authority powstaje przez produkcyjny
`EngineeringApprovalIngressRepository`, a jedynym zewnętrznym side effectem jest jeden
lokalny commit w izolowanym worktree `sondermind-ios`. Push, MR i merge są zakazane.

## WU-00 — profil BUILD_TOOLCHAIN/Xcode

- Status: `DONE`
- Rezultat: server-owned adapter uruchamia tylko kanoniczny `xcodebuild`, z dokładnym
  destination/DerivedData/SPM cache, bounded output/timeout/cancel, redakcją sekretów i
  disposable-tree evidence. Adapter jest jawnie wpięty w produkcyjny gate executor.
- Allowed paths:
  - `packages/test-evidence/src/runner.ts`
  - `packages/test-evidence/src/engineering-gates.ts`
  - `packages/test-evidence/test/runner.test.ts`
  - `packages/bedrock-runtime/src/aws-transport.ts`
  - `packages/bedrock-runtime/test/aws-transport.test.ts`
  - `packages/agent-orchestrator/src/context/source-policy.ts`
  - `packages/agent-orchestrator/test/context-compiler.test.ts`
  - `apps/agent-worker/src/xcode-gate-adapter.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/index.ts`
  - `apps/agent-worker/test/xcode-gate-adapter.integration.test.ts`
  - `packages/test-evidence/src/disposable-workspace.ts`
  - `packages/test-evidence/test/disposable-workspace.integration.test.ts`
  - `docs/work-units/RA-045/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/test-evidence build && pnpm --filter @remoteagent/agent-worker typecheck && pnpm exec vitest run packages/test-evidence/test/runner.test.ts apps/agent-worker/test/xcode-gate-adapter.integration.test.ts`

Wynik po finalnej korekcie narzutu SwiftPM: Xcode tworzy nieśledzony katalog
`<project>.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/configuration` nawet przy
przekierowanych DerivedData i SourcePackages. Adapter obsługuje wyłącznie ten exact, kanoniczny
katalog: gdy nie istniał przed procesem, tworzy i usuwa go w obrębie disposable callbacku; gdy
istniał, pozostaje częścią chronionego drzewa. Każda inna zmiana nadal jest odrzucana.
Targeted gate: `13/13` testów, agent-worker typecheck i `git diff --check`, exit `0`. Mutacja
pomijająca exact cleanup zakończyła się exit `1` na różnym post-tree digest; po restore ponowny
przebieg zakończył się exit `0`.

## WU-01 — bezpośredni live harness bez Jira/Discorda

- Status: `DONE`
- Rezultat: opt-in harness tworzy lokalny case przez repozytoria, zapisuje opis jako
  `UNTRUSTED_DATA`, wywołuje production proposal+GRANT, claimuje dokładny job i prowadzi
  `createWorkerHandlers -> SupervisorRuntime -> createProductionEngineeringRuntimePort` z live
  Bedrock, real PostgreSQL, real `sondermind-ios` oraz Xcode gates. Harness raportuje wyłącznie
  bounded IDs/digests/exit codes/commit, bez sekretów i host paths.
- Allowed paths:
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `apps/agent-worker/test/xcode-gate-adapter.integration.test.ts`
  - `docs/work-units/RA-045/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run apps/agent-worker/test/engineering-live-ios.integration.test.ts`

Live gate `2026-08-27`: exit `0`, `1/1`, 533,36 s. Production path utworzył nowy izolowany
worktree od `6ef7ec4e7dc4a9fbe6920055ee7516283ea9fcf6`, wykonał jeden batched patch siedmiu plików,
baseline kontraktu `FAILED`/current `PASSED`, Xcode `PASSED`/exit `0` (`44` testy, `0` failures),
fresh review, final verification oraz dokładnie jeden lokalny commit
`9bf102e5f13d962d39d84e126f93b0f26c437cda`. Source checkout pozostał czysty na bazowym SHA;
nie wykonano push/MR/Jira/Discord.

Provider usage: `6` odpowiedzi, `48604` input + `6356` output = `54960` tokenów. Jest to o `40`
tokenów poniżej dolnej granicy prognozy `55k–130k`, bez warningu i bez hard stopu. Planning zużył
`3213`, implementacja kończyła się przy cumulative `37814`, review przy `43475`, memory przy
`48671`, final verification przy `54960`.

Osobny journal `engineering-207ca4118958e40883ae77d8a9d97a4fe174755ea3fb365d4eb77a2bbabca9d2.jsonl`
ma mode `0600`, `26` monotonicznych rekordów i final `SUCCEEDED` z commit SHA. Zawiera model usage,
bounded tool results, jeden siedmioplikowy patch, durable artifacts/operations i gate receipts; nie
zawiera promptu, patch bytes, model prose, request IDs, sekretów, host paths ani chain-of-thought.

## WU-00A — efektywność implementera i load-bearing planning policy

- Status: `DONE`
- Rezultat: błędne wejście bounded toola wraca do modelu jako ograniczony,
  machine-readable kod z nazwami pól, bez tekstu wyjątku, host paths ani sekretów;
  trzecie identyczne błędne wejście kończy request jako no-progress zamiast zużywać
  cały budżet. Produkcyjny worker i live harness wyprowadzają ten sam zamrożony
  `allowed_paths`/required-gates planning constraint z server-owned deployment
  configu. Prompt wymaga poprawienia wejścia po odmowie i zakazuje powtarzania
  identycznego wywołania.
- Allowed paths:
  - `packages/bedrock-runtime/src/errors.ts`
  - `packages/bedrock-runtime/src/tool-loop.ts`
  - `packages/bedrock-runtime/test/tool-loop.test.ts`
  - `packages/git-lifecycle/src/lifecycle.ts`
  - `packages/git-lifecycle/test/lifecycle.integration.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `docs/work-units/RA-045/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/bedrock-runtime build && pnpm exec vitest run packages/bedrock-runtime/test/tool-loop.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts && pnpm --filter @remoteagent/bedrock-runtime typecheck && pnpm --filter @remoteagent/agent-worker typecheck`
- Mutation checks:
  - zamiana strukturalnego błędu na ogólny string musi zaczerwienić test bezpiecznego
    feedbacku;
  - usunięcie licznika identycznego invalid input musi zaczerwienić test no-progress;
  - odłączenie constraintów w production composition musi zaczerwienić test configu.

Wynik `2026-08-26`: dokładna komenda WU zakończyła się exit `0`; `2/2` pliki i
`11/11` testów GREEN, `bedrock-runtime` oraz `agent-worker` typecheck exit `0`,
`git diff --check` exit `0`. Mutacje feedbacku, progu powtórzeń i odłączenia
deployment-derived planning constraints zakończyły się osobno exit `1` (`1` fail
każda), po czym zostały przywrócone i objęte finalnym GREEN.

## WU-02 — live smoke, mutation i raport

- Status: `DONE`
- Rezultat: wykonany dokładny MOBL-2021, baseline RED/current GREEN, review PASS i jeden local
  commit receipt; wynik porównany z niezależnie ustalonym expected change. Raport zapisuje
  Xcode/Swift/destination/base SHA/config digest, gate receipts i ograniczenia bez prywatnych
  ścieżek.
- Allowed paths:
  - `docs/evidence/RA-045/IOS_ENGINEERING_SMOKE.md`
  - `docs/work-units/RA-045/WORK_UNITS.md`
  - `docs/tasks/RA-045.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/audits/RA-045/AUDIT-01.md`
  - `docs/handoffs/RA-045/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts`
  - `packages/bedrock-runtime/test/structured-completion.test.ts`
  - `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`

Finalna pełna bramka `2026-08-27`, uruchomiona od początku po korektach pre-audytowych, zakończyła
się exit `0`: lint i format GREEN; forced build `26/26`, `Cached: 0`; Vitest z wymaganym
PostgreSQL `226` plików GREEN + `1` opt-in live skip oraz `2861` testów GREEN + `1` skip; forced
typecheck `40/40`, `Cached: 0`; `workflow:validate OK — 47 tasks`; `git diff --check` exit `0`.
Opt-in live test nie został powtórzony w tej bramce, ponieważ jego zakończony realny wynik,
receipty, usage i lokalny commit są opisane w WU-01 oraz durable evidence.

## Historia i wynik trzech live smoke — 2026-08-26

Task pozostaje `IN_PROGRESS`; nie powstał audit, handoff ani commit. Repo źródłowe
`sondermind-ios` pozostało czyste na `6ef7ec4e7dc4a9fbe6920055ee7516283ea9fcf6`.

Wykonane dowody:

- adapter Xcode: `pnpm --filter @remoteagent/test-evidence build && pnpm --filter
  @remoteagent/agent-worker typecheck && pnpm exec vitest run
  apps/agent-worker/test/xcode-gate-adapter.integration.test.ts` — exit `0`, `2/2`;
- Bedrock JSON repair history: `pnpm exec vitest run
  packages/bedrock-runtime/test/aws-transport.test.ts && pnpm --filter
  @remoteagent/bedrock-runtime typecheck && pnpm --filter @remoteagent/bedrock-runtime build` —
  exit `0`, `13/13`;
- direct CASE_MESSAGE routing: `pnpm exec vitest run
  packages/agent-orchestrator/test/context-compiler.test.ts && pnpm --filter
  @remoteagent/agent-orchestrator build` — exit `0`, `11/11`;
- live Opus 4.8/PG/Git run przyjął exact SliceContract z taskowym capem i gate IDs, utworzył
  izolowany workspace i wykonał bounded read/search/write calls, ale zakończył się exit `1` na
  `Maximum tool iterations exceeded` przed `SliceImplementationReceipt`; gate/review/commit nie
  zostały uznane za wykonane;
- manualny `mobl-2021-contract` na pozostawionym patchu — exit `1`;
- manualny exact targeted `xcodebuild` na iPhone 17 Pro — exit `65`, `0` testów; build error:
  `Type 'SondermindUrl' has no member 'termsOfService'`.

Ocena patcha modelu: zmienił cztery właściwe pliki, ale nie zmienił wymaganych lokalizacji, nie
dodał testów ani flow action, użył hard-coded copy/runtime normalization i błędnego enum case.
Nie spełnia MOBL-2021 i nie może zostać zacommitowany.

Pierwszy brudny izolowany worktree był czasowo pozostawiony do inspekcji:
`/Users/marcinjackowski/.remoteagent/workspaces/ra045_753fd608-c79d-497b-a7fd-0f745a1d7a61-case/engineering-f0afcf1c1468bd34aee2272edd83692a`.
Miał cztery tracked modifications i disposable untracked `SonderClient/.remoteagent-xcode/`; został
następnie wyczyszczony exact `reset --hard` + `clean -ffdx`, bez lokalnego commita. RemoteAgent ma
wyłącznie taskowe ścieżki wymienione w allowed paths oraz ten dokument/statusy.

Pierwszy nieudany worktree został następnie wyczyszczony exact `reset --hard` + `clean -ffdx`;
źródłowy checkout pozostał czysty. Drugi świeży smoke zakończył się przed trwałym artefaktem,
ponieważ provider zwrócił poprawny output-tool razem z companion prose. Transport został
utwardzony tak, aby przy dokładnie jednym output-tool i zerowej liczbie work-tool companion text
nie był drugim autorytatywnym outputem; mixed/multiple output nadal fail-closed. Mutation
wyłączenia tej normalizacji dała exit `1`, restore: `aws-transport` + `engineering-execution`
`17/17` GREEN, oba niecache'owane typechecki `16/16` tasks exit `0`.

Trzeci smoke z czystego case/workspace potwierdził działanie structured tool feedbacku i poprawne
znalezienie rzeczywistych ekranów/testów, lecz implementer zużył wszystkie `16` tur na read/search
oraz zgadywane nieistniejące ścieżki, nie wykonał skutecznego write/patch i zwrócił
`changed_files=[]`. Etap następnie ujawnił osobny boundary defect: `GitLifecycle.diff()` próbował
wykonać `check-attr` bez pathspecu dla pustego declared surface i odmówił kodem
`GIT_OPERATION_FORBIDDEN`. Worktree pozostał na bazowym SHA bez zmian i bez commita; gate/review
nie ruszyły. Po diagnozie najnowszy worktree został wyczyszczony exact `reset --hard` +
`clean -ffdx`; zarówno on, jak i source checkout są czyste na
`6ef7ec4e7dc4a9fbe6920055ee7516283ea9fcf6`.

## WU-00B — bounded discovery i wymuszenie decyzji przed końcem budżetu

- Status: `DONE`
- Rezultat: implementer dostaje jawny pozostały budżet i bounded, server-owned indeks nazw pod
  zaakceptowanymi roots; po kolejnych nieudanych odczytach różnych nieistniejących ścieżek dostaje
  jedną deterministyczną korektę z istniejącymi kandydatami. Nie zwiększamy ślepo limitu 16 i nie
  poszerzamy write capu. Pusta implementacja może przejść tylko wtedy, gdy objective jest już
  spełniony w actual tree; w przeciwnym razie kończy się jawnym `NO_PROGRESS`, a nie późnym błędem
  Git. `GitLifecycle.diff()` dla pustej powierzchni zwraca prawidłowy pusty read-only diff.
- Allowed paths:
  - `packages/bedrock-runtime/src/tool-loop.ts`
  - `packages/bedrock-runtime/test/tool-loop.test.ts`
  - `packages/implementation-tools/src/read-tools.ts`
  - `packages/implementation-tools/test/read-tools.test.ts`
  - `packages/repository-planner/src/read-tools.ts`
  - `packages/repository-planner/test/read-tools.test.ts`
  - `packages/git-lifecycle/src/lifecycle.ts`
  - `packages/git-lifecycle/test/lifecycle.integration.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/src/vertical-slice-executor.ts`
  - `apps/agent-worker/test/vertical-slice-executor.integration.test.ts`
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `docs/work-units/RA-045/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/bedrock-runtime build && pnpm --filter @remoteagent/repository-planner build && pnpm --filter @remoteagent/implementation-tools build && pnpm --filter @remoteagent/git-lifecycle build && pnpm exec vitest run packages/bedrock-runtime/test/tool-loop.test.ts packages/repository-planner/test/read-tools.test.ts packages/implementation-tools/test/read-tools.test.ts packages/git-lifecycle/test/lifecycle.integration.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts apps/agent-worker/test/vertical-slice-executor.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/bedrock-runtime --filter=@remoteagent/repository-planner --filter=@remoteagent/implementation-tools --filter=@remoteagent/git-lifecycle --filter=@remoteagent/agent-worker && git diff --check`
- Wymagane mutation checks:
  - usunięcie pustego-path short-circuit w Git musi zaczerwienić pusty-diff regression;
  - ukrycie remaining budget musi zaczerwienić test model-visible bounded progress;
  - wyłączenie istniejących kandydatów po serii `FILE_NOT_FOUND` musi zaczerwienić discovery test;
  - zaakceptowanie `changed_files=[]` przy niespełnionym objective musi zaczerwienić production
    implementation test.

Pierwszy mechanizm WU-00B (pusty read-only diff) został zaimplementowany od razu po trzecim smoke.
Targeted regression + `git-lifecycle` typecheck zakończyły się exit `0`; mutacja usuwająca
short-circuit dała exit `1` (`1` fail), po restore ponowny przebieg był GREEN (`1/1`, typecheck i
`git diff --check` exit `0`). Następnie implementer dostał streaming filename/text discovery,
exact replacement patch oraz jeden wspólny limit `10` wywołań read/search/tree/config na attempt;
write/patch nie resetuje limitu. Jedenaste discovery wraca jako
`DISCOVERY_BUDGET_EXHAUSTED` z code-owned next action, a rzeczywista mutacja pozostaje dostępna.
Mutacje usunięcia limitu oraz resetu po patchu zakończyły się exit `1`, po restore targeted suite
`implementation-tools` była GREEN `19/19`.

Szeroka bramka po finalnym diffie `2026-08-27` zakończyła się exit `0`: forced build `15/15`,
Vitest `14/14` plików i `195/195` testów, forced typecheck `22/22` (`Cached: 0`), Prettier oraz
`git diff --check`. Nie poszerzono write capu.

## WU-00C — rzeczywisty koszt modelu i budżet porównawczy

- Status: `DONE`
- Rezultat: każdy live smoke pokazuje provider-reported `input_tokens`, `output_tokens`,
  `total_tokens` oraz liczbę odpowiedzi, także gdy późniejszy etap kończy się wyjątkiem. Raport nie
  zawiera promptów, treści odpowiedzi, request IDs, sekretów ani host paths. Docelowo licznik ma
  także rozbicie na planning/implementation/review i osobno oznacza brak usage od providera;
  estymata kontekstu nigdy nie jest przedstawiana jako rzeczywiste billing usage.
- Allowed paths:
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `packages/bedrock-runtime/src/types.ts`
  - `packages/bedrock-runtime/src/tool-loop.ts`
  - `packages/bedrock-runtime/test/tool-loop.test.ts`
  - `docs/work-units/RA-045/WORK_UNITS.md`
- Budżet porównawczy MOBL-2021 po WU-00B:
  - planning: `1–2` odpowiedzi, `5k–15k` wszystkich provider tokens;
  - implementation: `5–8` tur narzędzi + final output, `45k–100k` input i `5k–12k` output;
  - review: `1` odpowiedź, `5k–20k` wszystkich tokenów;
  - cały task: cel `55k–130k`, warning powyżej `150k`, przerwanie/no-progress przed `250k` albo
    przed `12` turą implementation — zależnie od tego, co wystąpi pierwsze.
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-worker typecheck && pnpm exec vitest run apps/agent-worker/test/engineering-execution.integration.test.ts && git diff --check`
- Wymagane dowody:
  - fake transport sumuje kilka odpowiedzi dokładnie, w tym brakujące pojedyncze pola usage;
  - błąd po odpowiedzi nadal pozostawia widoczny ostatni cumulative total;
  - wartości promptu, outputu, request ID, host path i sekret-canary nie występują w raporcie;
  - mutation pomijająca jedną odpowiedź musi zaczerwienić test agregacji.

Live harness ma już minimalny cumulative `RA045_MODEL_USAGE` emitowany po każdej zakończonej
odpowiedzi Bedrock, więc następny smoke zachowa dokładny total również przy późniejszym failu.
Trzeci zakończony smoke nie ma retrospektywnego exact usage: konfiguracja miała limit `48` tur,
model wykonał około `16` obserwowanych partii i sam zwrócił pusty wynik. Na podstawie narastającej
historii z wieloma pełnymi odczytami ocena wynosi `250k–600k` provider tokens; to wyłącznie
estymata, nie billing measurement, i jest około `2–5×` powyżej docelowego zakresu MOBL-2021.

Pierwszy smoke z provider-reported telemetry zużył dokładnie `234022` tokeny. Pierwsza mutacja
nastąpiła przy `97734`, więc bounded discovery poprawiło zachowanie wobec wcześniejszych `16` tur
samych odczytów, ale całość pozostała w paśmie `WARNING` i zmieniła niewłaściwy podobny ekran.
Production transport zapisuje teraz cumulative usage po każdej odpowiedzi oraz exact stage
(`SLICE_IMPLEMENTATION`, `SLICE_REVIEW` lub inny server-owned stage); mutation odłączenia stage
attribution zakończyła się exit `1`. Przekroczenie `250000` jest load-bearing hard stop: mutation
usunięcia odmowy zakończyła się exit `1`, po restore testy były GREEN.

## WU-00D — per-invocation Engineering debug journal

- Status: `DONE`
- Rezultat: każde uruchomienie live Engineering tworzy osobny plik `engineering-<digest>.jsonl`
  pod server-owned `artifact_root/engineering-debug`, z prawami `0600`. Kolejne rekordy mają
  monotoniczny sequence i server timestamp. Closed schema zapisuje wyłącznie obserwowalny ślad:
  start/binding, cumulative provider usage, tool name + canonical paths/query digest, kształt outputu,
  stage errors jako digest, durable artifact/operation diagnostic i końcowy status/commit. Journal
  nigdy nie przyjmuje promptu, treści pliku, patcha, model response prose, request ID, host path,
  sekretu ani prywatnego chain-of-thought; debugujemy zachowanie i dowody, nie ukryte rozumowanie.
- Allowed paths:
  - `apps/agent-worker/src/engineering-debug-journal.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/handlers.ts`
  - `apps/agent-worker/src/index.ts`
  - `apps/agent-worker/src/vertical-slice-executor.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/test/engineering-debug-journal.test.ts`
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `apps/agent-worker/test/handlers.integration.test.ts`
  - `docs/work-units/RA-045/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm exec vitest run apps/agent-worker/test/engineering-debug-journal.test.ts && pnpm --filter @remoteagent/agent-worker typecheck && pnpm exec prettier --check apps/agent-worker/src/engineering-debug-journal.ts apps/agent-worker/test/engineering-debug-journal.test.ts apps/agent-worker/test/engineering-live-ios.integration.test.ts && git diff --check`
- Mutation checks:
  - usunięcie `wx`/unikalnego digest filename musi zaczerwienić test dwóch invocation files;
  - dopuszczenie pola `reasoning` albo surowego error message musi zaczerwienić content-free test;
  - pominięcie monotonicznego sequence musi zaczerwienić test kolejności;
  - odłączenie journalu od live transportu musi zaczerwienić test composition/source wiring przed
    następnym smoke.

Journal jest wpięty w produkcyjny `agent.implementer` handler i wspólny Bedrock transport przez
`AsyncLocalStorage`; zwykłe role bez aktywnej sesji niczego nie zapisują. Każde wejście handlera,
również ponowne na tym samym job/fence/attempt, dostaje nowy losowy invocation component i osobny
plik otwarty `wx`. Bounded tool boundary dopisuje wynik bez `output.value`, a transport zapisuje
tylko usage, server stage, tool/input shape, canonical paths i digests. Po zakończeniu runner
dopisuje metadata-only trwałe artifacts/operations i commit SHA.

Mutation checks `2026-08-27`: odłączenie handler wrappera, usunięcie async-local transport route,
usunięcie unikalnego invocation component, odłączenie stage attribution oraz wyłączenie hard stop
`250000` — każda osobno exit `1` na przypisanym teście, wszystkie przywrócone. Wcześniejsze
mutacje stałej nazwy, permissive `reasoning` i stałego sequence także były RED i przywrócone.
Targeted journal+handler gate po restore: exit `0`, `2/2` pliki i `22/22` testy, agent-worker
typecheck i `git diff --check` exit `0`. Szeroka bramka WU-00B/C/D: exit `0`, `195/195`, forced
build/typecheck bez cache jak zapisano wyżej.

Korekta pre-audit `2026-08-27`: live harness przestał emitować na stdout surowe zapytania,
komunikaty walidacji i komunikaty błędów stage/port. Journal hashuje błąd do digestu, a warning
zawiera tylko bounded `error_name`. Błąd końcowego odczytu diagnostycznego lub zamknięcia pliku nie
może nadpisać ukończonego wyniku Engineering; końcowy rekord jest best-effort i zachowuje znany
status workflow. Mutacja przywracająca propagację błędu diagnostycznego dała exit `1` (`1` fail,
`7` skipped), bo ukończony wynik został odrzucony. Po restore journal+handler gate zakończyła się
exit `0`, `2/2` pliki i `25/25` testów, agent-worker typecheck oraz `git diff --check` exit `0`.

Nie zapisujemy prywatnego chain-of-thought. Dziennik jest zaawansowanym changelogiem obserwowalnych
decyzji i efektów: co wywołano, w jakim stage, jaki był kształt odpowiedzi, ile tokenów zużyto,
które ścieżki zmieniono oraz jaki trwały wynik powstał.
