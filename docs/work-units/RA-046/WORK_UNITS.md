# RA-046 — work units

- Task: `RA-046`
- Bazowy commit: `45a20f16264f426091900df69e6ffa7d218b43e6`
- Status: `DONE`
- Decyzja: `ADR-0014`

## Ustalenia wejściowe

- Producer jest code-owned i owner-only: komenda `/engineering`, nie modelowy `DecisionRequest`,
  tworzy proposal. Model, tekst Discorda i button payload nie dostarczają authority fields.
- Proposal i przyciski mają osobny kontrakt/kind. Nie reuse'ujemy generic `ApprovalInteraction`,
  `DecisionAnswer` ani `external_actions` jako engineering authority.
- Raw Discord `INTERACTION_CREATE.id` przechodzi przez intake bez tokenu i jest trwałym kluczem
  replay. `custom_id` wiąże osobno proposal, checkpoint i code-owned `GRANT`/`DENY`.
- Proposal prealokuje ID work unitu i runu w swoim trwałym wierszu, ale nie tworzy jeszcze
  uruchamialnego `work_units`/`agent_runs`. Powstają dopiero po `GRANT`.
- Approval nadal jest jedynym journalem grantu. `engineering_write_proposals` jest tabelą stanu
  proposal, nie drugim authorizing journalem.
- Grant jest blanket, run-scoped write grantem w dokładnym deployment ceiling. Nie oznacza
  przeczytania ani zaakceptowania późniejszego `ProgramDesign`.
- `/stop` jest code-owned i idempotentnie terminalizuje pending proposal/case; aktywne workflow
  widzi trwały status case i odmawia następnego write.

## WU-00 — kontrakty authority i Discord interaction identity

- Status: `DONE`
- Rezultat: strict/versioned proposal i scope wiążący repo/path ceiling oraz osobny Discord
  interaction kind; raw interaction ID nie ginie między gateway a domain outcome.
- Allowed paths:
  - `packages/contracts/src/engineering-workflow.ts`
  - `packages/contracts/src/schema.ts`
  - `packages/contracts/test/engineering-workflow.test.ts`
  - `packages/contracts/test/schema-snapshot.test.ts`
  - `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
  - `packages/discord/src/custom-id.ts`
  - `packages/discord/src/intake.ts`
  - `packages/discord/src/messages.ts`
  - `packages/discord/src/dispatcher.ts`
  - `packages/discord/test/custom-id.test.ts`
  - `packages/discord/test/intake.test.ts`
  - `packages/discord/test/dispatcher.test.ts`
  - `apps/discord-bot/src/lifecycle.ts`
  - `apps/discord-bot/test/lifecycle.test.ts`
  - `docs/work-units/RA-046/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && pnpm exec vitest run packages/contracts/test/engineering-workflow.test.ts packages/contracts/test/schema-snapshot.test.ts packages/discord/test/custom-id.test.ts packages/discord/test/intake.test.ts packages/discord/test/dispatcher.test.ts apps/discord-bot/test/lifecycle.test.ts && pnpm --filter @remoteagent/contracts typecheck && pnpm --filter @remoteagent/discord typecheck && pnpm --filter @remoteagent/discord-bot typecheck`
- Wynik: `2026-08-26`, exit code `0`; `6` plików / `41` testów, build contracts i trzy
  typechecki zakończone bez błędu.
- Mutation evidence:
  - pominięcie `write_path_allowlist` w `engineeringWriteDeploymentPolicyV1Digest` dało RED
    (`1` fail / `14`), po przywróceniu GREEN;
  - pominięcie `write_path_allowlist` w `engineeringWriteAuthorizationScopeV2Digest` dało RED
    (`1` fail / `14`), po przywróceniu GREEN;
  - zakodowanie engineering proposal jako generic `approval` dało RED (`2` fail / `9`), po
    przywróceniu osobnego kind GREEN;
  - dopuszczenie brakującego raw Discord interaction ID dało RED (`1` fail / `8`), po
    przywróceniu fail-closed GREEN.
  - usunięcie equality `deployment_policy_digest` z code-owned projection repo/path dało RED
    (`1` fail / `14`), po przywróceniu guardu GREEN;
  - dopuszczenie jednoczesnych sekcji `decision` + `approval` + `engineering_proposal` dało RED
    (`1` fail / `2`), po przywróceniu fail-closed union GREEN.

## WU-01 — durable proposal i atomowy grant/deny/stop

- Status: `DONE`
- Zależy od: WU-00
- Rezultat: migracja i repozytorium tworzą proposal+Discord outbox oraz atomowo materializują exact
  Approval/work unit/run/job po GRANT; deny, expiry, stale scope i replay nie tworzą authority.
- Allowed paths:
  - `packages/database/migrations/036_engineering_write_proposals.up.sql`
  - `packages/database/migrations/036_engineering_write_proposals.down.sql`
  - `packages/database/src/repositories/engineering-approval-ingress.ts`
  - `packages/database/src/repositories/index.ts`
  - `packages/database/src/index.ts`
  - `packages/database/test/engineering-approval-ingress.integration.test.ts`
  - `packages/database/test/migrations.integration.test.ts`
  - `docs/work-units/RA-046/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/migrations.integration.test.ts packages/database/test/engineering-approval-ingress.integration.test.ts && pnpm --filter @remoteagent/database typecheck`
- Wynik: `2026-08-26`, exit code `0`; `2` pliki / `26` testów (`8` migration + `18`
  ingress), build contracts i database typecheck zakończone bez błędu. Sol niezależnie powtórzył
  dokładnie tę samą bramkę z exit code `0`; `git diff --check` także exit code `0`.
- Mutation evidence:
  - pominięcie exact ośmiu kluczy job payloadu pozwoliło na dodatkowe caller authority i dało RED;
  - użycie Discord `actorId` jako wewnętrznego `owner_id` dało RED przy różnych tożsamościach;
  - usunięcie append-only globalnego interaction ledgeru, re-derywacji policy/action digest,
    approval `consumed` fence, case locka albo STOP replay guardu dawało RED;
  - podstawienie policy digestu za action digest oraz pominięcie exact EXPIRED replay branchu dawało
    RED; każdą mutację przywrócono przed końcowym GREEN.
- Wynik: `2026-08-26`, exit code `0`; `2` pliki / `26` testów, build kontraktów i typecheck
  database zakończone bez błędu. Real PostgreSQL potwierdził proposal+Discord outbox bez pracy,
  atomowy exact Approval/work unit/run/job i replay, deny/expiry/stale/foreign/policy drift,
  duplicate/concurrent grant i proposal, grant-vs-stop bez deadlocka, idempotentny stop oraz
  bezpośrednie DB guardy dla proposal, globalnej identity interakcji i materializacji GRANTED.
- Findings naprawione przed bramką:
  - ujednolicono lock order `case -> proposal`; wcześniejsze `proposal -> case` w `respond` kontra
    `case -> proposal` w `stop` tworzyło cykl deadlocka;
  - trigger GRANTED wiąże exact świeży, niezużyty Approval i bieżący nieterminalny case, a nie samo
    istnienie approval/work/run/job;
  - globalny append-only ledger provider interaction ID zamknął replay trigger-vs-terminal między
    cases, a exact STOP replay zachowuje pierwotny proposal ID;
  - terminalny exact replay rozpoznaje trwałe `DENIED`/`EXPIRED`; wcześniej retry tego samego
    wygasłego grant-clicka błędnie reinterpretował `EXPIRE` jako nowy `GRANT` i kolidował sam ze
    sobą w globalnym ledgerze;
  - kontrola ośmiu kluczy job payload używa wspieranego przez PostgreSQL 15
    `jsonb_object_keys`; wcześniejsze `jsonb_object_length` blokowało każdy realny GRANT;
  - durable owner jest wyprowadzany z case/binding, podczas gdy Discord actor pozostaje wyłącznie
    faktem audytowym `granted_by`/`terminal_actor_id`.
- Mutation evidence (każda chwilowa zmiana source/migracji została przywrócona przed finalną
  bramką):
  - usunięcie exact ośmiokluczowego fence job payload dało RED (`1` fail / `17` skipped), bo
    `extra-job-key` direct grant przestał być odrzucany;
  - zastąpienie internal `case.owner_id` przez Discord `actorId` dało RED (`1` fail / `17`
    skipped) na distinct internal owner/Discord actor;
  - usunięcie append-only triggera globalnego interaction ledgeru dało RED (`1` fail / `17`
    skipped);
  - usunięcie server re-derivation policy/action digest dało RED (`1` fail / `17` skipped), bo
    drifted deployment ceiling uzyskał grant;
  - usunięcie `consumed=false` i `consumed_at IS NULL` z GRANTED triggera dało RED (`1` fail /
    `17` skipped), bo preconsumed Approval przeszedł materializację;
  - usunięcie exact STOP replay read dało RED (`1` fail / `17` skipped) przez collision tego
    samego provider interaction ID;
  - usunięcie exact terminalnego `EXPIRED` replay dało RED (`1` fail / `17` skipped) przez
    reinterpretację trwałego `EXPIRE` jako `GRANT`;
  - usunięcie `FOR UPDATE` z case locka dało RED (`1` fail / `17` skipped) przez concurrent
    proposal unique violation zamiast deterministycznego jednego winnera;
  - zastąpienie scope action digest przez deployment-policy digest dało RED (`1` fail / `17`
    skipped) w kontrakcie/proposal grant path.

## WU-02 — production composition Discord i consumer exact ceiling

- Status: `DONE`
- Zależy od: WU-01
- Rezultat: `/engineering`, engineering `GRANT`/`DENY` i `/stop` trafiają z produkcyjnego bota do
  repozytorium; worker ponownie wyprowadza ten sam scope+path ceiling z server-owned config.
- Ustalenia:
  - jeden strict projector w `contracts` wyprowadza V1 deployment policy z execution config v2;
    Discord nie importuje agent-worker i nie kopiuje normalizacji;
  - `/stop` ma policy-independent port i działa także bez/po odrzuceniu konfiguracji engineering;
  - production worker konsumuje wyłącznie V2 action digest i wymaga exact granted proposal/job
    materialization z `proposalId`; generic Approval/DecisionAnswer ani sam approval ID nie wystarcza;
  - Discord snowflake pozostaje audit actor, a internal owner zawsze pochodzi z case/binding.
- Allowed paths:
  - `apps/discord-bot/src/env.ts`
  - `apps/discord-bot/src/lifecycle.ts`
  - `apps/discord-bot/src/discord.ts`
  - `apps/discord-bot/test/env.test.ts`
  - `apps/discord-bot/test/lifecycle.test.ts`
  - `apps/discord-bot/package.json`
  - `packages/contracts/src/engineering-workflow.ts`
  - `packages/contracts/test/engineering-workflow.test.ts`
  - `packages/database/src/repositories/engineering-approval-ingress.ts`
  - `packages/database/src/queue/job-store.ts`
  - `packages/database/test/engineering-approval-ingress.integration.test.ts`
  - `packages/database/test/queue-concurrency.integration.test.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/engineering-qualification-risk.integration.test.ts`
  - `pnpm-lock.yaml`
  - `docs/work-units/RA-046/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm --filter @remoteagent/contracts build && pnpm --filter @remoteagent/database build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/contracts/test/engineering-workflow.test.ts packages/database/test/engineering-approval-ingress.integration.test.ts packages/database/test/queue-concurrency.integration.test.ts apps/discord-bot/test/env.test.ts apps/discord-bot/test/lifecycle.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts apps/agent-worker/test/engineering-qualification-risk.integration.test.ts apps/agent-worker/test/vertical-slice-e2e.integration.test.ts && pnpm --filter @remoteagent/discord-bot typecheck && pnpm --filter @remoteagent/agent-worker typecheck`
- Wynik: `2026-08-26`, exit code `0`; `9` plików / `90` testów, build contracts/database
  oraz typecheck discord-bot/agent-worker zakończone bez błędu. Real PostgreSQL objął proposal,
  policy-independent STOP, queue lease lock, production qualification SMALL/MEDIUM/LARGE oraz
  pełny vertical-slice E2E z correction i evidence-bound local commit recovery.
- Mutation evidence (każda chwilowa zmiana została przywrócona przed finalnym GREEN):
  - usunięcie strict execution-config projector pozwoliło na caller-supplied digest i dało RED
    (`1` fail / `14` skipped);
  - usunięcie `proposalId` z candidate extractora dało RED (`1` fail / `24` skipped);
  - pominięcie exact granted proposal/job verifiera zmieniło foreign materialization na późny
    `DIGEST_MISMATCH` i dało RED (`1` fail / `24` skipped);
  - drift deployment-policy digest/path w worker scope dał RED przed otwarciem high-risk portu
    (`1` fail / `24` skipped);
  - pominięcie current lease assertion pozwoliło stale fencing holderowi zużyć grant i dało RED
    (`1` fail / `24` skipped);
  - usunięcie `FOR SHARE` pozwoliło konkurencyjnemu UPDATE joba przejść przed commitem authority tx
    i dało RED (`1` fail / `9` skipped); dowód używa PG `lock_timeout`, nie timera JS;
  - odwrócenie durable-sink-before-ACK dało RED (`1` fail / `9` skipped), a unexpected DB failure
    pozostaje bez ACK; deterministyczny typed refusal jest terminalnym zero-side-effect wynikiem;
  - wyłączenie lazy terminalizacji expired PENDING proposal zablokowało successor i dało RED
    (`1` fail / `19` skipped).
- Findings naprawione przed bramką:
  - Discord actor/snowflake pozostaje tylko faktem audytowym; worker i repo zawsze ponownie czytają
    internal owner z case/run;
  - `assertCurrentLease` trzyma row lock przez całe verifier+Approval.consume transaction, więc
    reclaimed/stale holder nie może zużyć single-use grantu przed winnerem;
  - unattended expired PENDING proposal jest atomowo terminalizowany code-owned `EXPIRE` przed
    utworzeniem następcy, bez nowego authority journalu;
  - porównanie PostgreSQL JSONB w materialization verifier używa canonical digest zamiast
    order-sensitive `JSON.stringify`;
  - authority-affecting accepted Discord outcome jest zapisany przed ACK; typed refusal/disabled
    pozostaje zamierzonym terminalnym zero-side-effect wynikiem, a unexpected persistence failure
    propaguje bez false-success ACK.
  - ręczny production `EngineeringExecutionConfig` w vertical-slice E2E dostał jawny deployment
    policy fixture; nie dodano runtime fallbacku dla brakującej server-owned policy.

## WU-03 — realny ingress E2E, adversarial matrix i pełna bramka

- Status: `DONE`
- Zależy od: WU-02
- Rezultat: real PostgreSQL + production Discord composition + worker consumer dowodzą ścieżki
  proposal→outbox/button→grant→jeden writer; concurrency, crash boundary, stale/foreign/scope
  drift i wszystkie authority bypassy mają load-bearing RED→GREEN mutations.
- Allowed paths:
  - `test/engineering-approval-ingress/engineering-approval-ingress.integration.test.ts`
  - `apps/discord-bot/src/discord.ts`
  - `apps/discord-bot/src/env.ts`
  - `apps/discord-bot/test/env.test.ts`
  - `apps/discord-bot/test/engineering-approval-ingress.integration.test.ts`
  - `packages/database/migrations/036_engineering_write_proposals.down.sql`
  - `packages/database/test/migrations.integration.test.ts`
  - `packages/database/test/engineering-control-plane.integration.test.ts`
  - `packages/database/test/engineering-approval-ingress.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-control.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/engineering-qualification-risk.integration.test.ts`
  - `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
  - `docs/evidence/RA-046/ENGINEERING_APPROVAL_INGRESS.md`
  - `docs/work-units/RA-046/WORK_UNITS.md`
- Weryfikacja:
  `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Targeted evidence: `2026-08-26`,
  `. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-approval-ingress/engineering-approval-ingress.integration.test.ts`,
  exit code `0`; `1` plik / `3` testy. Real PostgreSQL i production composition objęły raw
  `/engineering`, committed outbox + dedicated button, replay po świeżym bocie, raw `GRANT`, exact
  Approval/work unit/run/job, claim i production engineering handler do reviewed local commit bez
  push, a także `DENY`, policy-independent `STOP`, generic/foreign/stale refusals i concurrent
  proposal/grant single writer.
- Mutation evidence (każda chwilowa zmiana testowego production wiring została przywrócona):
  - brak deployment policy w production bot golden path dał RED przed utworzeniem proposal;
  - zamiana dedicated engineering custom ID na generic approval ID dała RED przez brak grantu;
  - usunięcie `proposalId` z lease przekazanego valid production workerowi dało RED na strict
    approval binding; po przywróceniu targeted suite wrócił do `3/3` GREEN.
  - skierowanie generic `DecisionAnswer` do engineering ingress dało RED (`1` fail / `5` pass),
    bo exact-call router test zobaczył dodatkowe `respond`; po przywróceniu `6/6` GREEN;
  - skierowanie generic `ApprovalInteraction` do engineering ingress dało RED (`1` fail / `5`
    pass); po przywróceniu `6/6` GREEN;
  - workerowe uznanie durable `DecisionAnswer` i jego modelowego option `grant` albo `deny` za
    write authority dało RED (`2` fail / `4` skipped), bo oba `port.open()` błędnie przeszły;
  - workerowe uznanie zakończonego `external_actions` + receiptu + generic Approval za write
    authority dało RED (`1` fail / `3` skipped), bo `port.open()` błędnie przeszedł;
  - odłączenie production `createDiscordProcess` relay startup dało RED przez timeout przed
    `outbox_dispatch=PUBLISHED`; przekazanie `deploymentPolicy=null` przez `runFromEnv` dało RED na
    exact factory boundary; porzucenie prawego concurrent GRANT dało RED przez brak drugiego ACK i
    durable interaction ID;
  - usunięcie guarda populated rollback migracji 036 dało RED (`2` fail / `8` skipped), bo PENDING
    i GRANTED provenance zostały usunięte; guard przywrócono.
  - usunięcie `ACCESS EXCLUSIVE NOWAIT` przed check/drop dało RED (`1` fail / `10` skipped):
    kontrolowany writer PID utrzymał `ROW EXCLUSIVE`, a `pg_blocking_pids` dowiódł starego boundary
    `drop-blocked`; po restore down odmawia przed checkiem i writer zachowuje trwałą interakcję;
  - skierowanie generic approval z ID exact aktywnego proposal do engineering ingress dało RED,
    bo proposal przeszedł do `GRANTED` zamiast pozostać `PENDING`;
  - osłabienie terminal fence dla późnego GRANT po STOP dało RED; usunięcie `case=CANCELLED` z
    `readRunControlState` dało RED, bo worker po GRANT-first→STOP przekroczył granicę przed modelem,
    workspace i write; obie mutacje przywrócono.
- Findings naprawione po niezależnym pre-audycie:
  - down migration 036 odmawia rollbacku, gdy istnieje proposal lub interaction, więc nie osieroca
    Approval/work unit/run/job ani provider replay identity; PENDING i GRANTED zachowują exact
    snapshot authority po odrzuconym down; table locks `ACCESS EXCLUSIVE NOWAIT` zamykają również
    race writer-between-check-and-drop;
  - root E2E używa produkcyjnego `createDiscordProcess -> startOutboxRelay`, a test `runFromEnv`
    wiąże exact parsed deployment policy z bot factory; nie ma ręcznego `relayOnce`;
  - concurrency czeka na ACK obu proposal contenders oraz ACK i durable interaction IDs obu GRANT
    contenders, zachowując dokładnie jednego writera;
  - AC5 ma osobne durable fixtures i mutacje dla modelowych opcji `grant`/`deny`, generic
    Decision/Approval i zakończonego `external_actions` z receiptem, wszystkie przed modelem,
    operacją, workspace i consumption Approval.
  - exact live-proposal generic Approval pozostawia `PENDING` i zero authority; STOP-first blokuje
    późny GRANT z zerem authority, a GRANT-first→STOP zachowuje durable grant, lecz `CANCELLED` case
    zatrzymuje claimowanego production workera przed modelem/workspace/operation/artifact/Git.
- Skonsolidowana bramka korekt Sol: `. scripts/dev/env.sh && pnpm --filter
  @remoteagent/contracts build && pnpm --filter @remoteagent/database build && pnpm --filter
  @remoteagent/discord build && pnpm --filter @remoteagent/discord-bot build && pnpm --filter
  @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
  packages/database/test/migrations.integration.test.ts apps/discord-bot/test/env.test.ts
  apps/agent-worker/test/engineering-qualification-risk.integration.test.ts
  test/engineering-approval-ingress/engineering-approval-ingress.integration.test.ts && pnpm
  --filter @remoteagent/database typecheck && pnpm --filter @remoteagent/discord-bot typecheck &&
  pnpm --filter @remoteagent/agent-worker typecheck && git diff --check`, exit code `0`; `4` pliki /
  `25` testów, wszystkie buildy i typechecki GREEN.
- Finalne targeted korekty po re-audycie: migration suite exit code `0`, `11/11`; root+database
  ingress exit code `0`, `2` pliki / `25` testów; forced typecheck database/discord-bot/agent-worker
  `17/17`, cache `0`; Prettier i diff-check exit code `0`.
- Pełna bramka finalna Sol: `2026-08-26`, dokładna komenda WU-03 powyżej, exit code `0`; lint i
  Prettier GREEN, forced build `26/26` (`0` cache), real-PG Vitest `220/220` plików i `2800/2800`
  testów, forced typecheck `40/40` (`0` cache), `workflow:validate OK — 47 tasks`,
  `git diff --check` bez uwag. Wcześniejsze pełne przebiegi uczciwie ujawniły cross-gate fixtures,
  niepełne bypass evidence, relay reachability i rollback TOCTOU; wszystkie naprawiono, poddano
  mutacji RED→GREEN i dopiero potem uruchomiono ten łańcuch od początku.
