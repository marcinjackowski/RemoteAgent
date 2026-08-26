# RA-046 — engineering approval ingress evidence

- Data: `2026-08-26`
- Zakres: production Discord composition → PostgreSQL proposal/outbox → production worker
- Targeted command:
  `. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-approval-ingress/engineering-approval-ingress.integration.test.ts`
- Wynik targeted: exit code `0`; `1` plik / `3` testy.
- Pełna komenda WU-03:
  `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Wynik pełnej bramki finalnej Sol: exit code `0`; lint i Prettier GREEN; forced build `26/26` przy
  `0` cache; Vitest `220/220` plików i `2800/2800` testów na wymaganym PostgreSQL; forced typecheck
  `40/40` przy `0` cache; `workflow:validate OK — 47 tasks`; `git diff --check` bez uwag.

## Udowodniona ścieżka

Root integration suite uruchamia `createDiscordBotFromEnv` z fake'owanymi wyłącznie transportem
Discord REST/socket i providerem modelu. Raw gateway `INTERACTION_CREATE` dla `/engineering`
tworzy w realnym PostgreSQL proposal oraz committed outbox bez work unitu, runu, Approval ani
joba. Świeży bot odtwarza ten sam raw interaction ID z zachowaniem exact proposal/work-unit/run i
outbox IDs. Realny relay publikuje outbox do production Discord sink, a test przechwytuje osobne
`v1:engineering` przyciski.

Raw `GRANT` atomowo tworzy single-use Approval, prealokowany work unit/run i `agent.implementer`
job z dokładnie ośmioma kluczami payloadu. Discord snowflake występuje jako `granted_by`, podczas
gdy internal owner case pozostaje authority scope. Świeży bot replayuje identyczny raw GRANT po
symulowanej utracie odpowiedzi; proposal zachowuje approval/job/unit/run IDs, a liczności pozostają
`1/1/1/1`.

Proposal button nie jest dostarczany ręcznym wywołaniem repository relay: root suite uruchamia
production `createDiscordProcess`, który startuje `startOutboxRelay`, i czeka jednocześnie na
`outbox_dispatch=PUBLISHED` oraz dokładnie jedną wiadomość z dedykowanym przyciskiem. Osobny test
composition dowodzi, że `runFromEnv` przekazuje exact policy sparsowaną ze wspólnego execution
configu do bot factory.

`JobStore.claim` przekazuje ten job do production worker composition. Przed otwarciem workspace
worker odrzuca missing/foreign proposal, foreign job, stale fencing token i drift server-owned
policy/path bez model call, workspace row ani consumption Approval. Valid holder przechodzi realne
context/gates/review/Git adapters, zapisuje `EvidenceBundle` oraz jeden `LocalCommitReceipt`.
Źródłowa gałąź `main` pozostaje na bazowym SHA, a repo nie ma remote, więc dowód nie obejmuje i nie
autoryzuje push/MR/merge.

## Kontrole negatywne i współbieżność

- generic decision/approval IDs i foreign Discord actor nie tworzą engineering authority ani
  `external_actions`;
- foreign/stale engineering button nie terminalizuje proposal i nie tworzy Approval;
- `DENY` nie tworzy work/run/job/Approval;
- `/stop` działa z wyłączoną write policy, terminalizuje aktywny PENDING proposal jako `STOPPED` i
  case jako `CANCELLED`;
- dwa production bot instances konkurujące o proposal i później grant kończą z dokładnie jednym
  proposal, Approval, work unitem, runem i jobem; oba proposal clicks mają ACK, a oba grant clicks
  mają ACK i własny durable interaction ID;
- populated rollback migracji 036 jest fail-closed dla PENDING i GRANTED, zachowując proposal,
  interaction replay identity oraz exact Approval/work unit/run/job; `ACCESS EXCLUSIVE NOWAIT`
  przed check/drop zamyka też race z aktywnym ingress writerem;
- exact generic Approval wskazujący aktywny proposal pozostawia go `PENDING` i nie tworzy authority;
- STOP-first odrzuca późny GRANT z zerem authority; GRANT-first→STOP zostawia proposal `GRANTED`,
  ale `CANCELLED` case zatrzymuje claimowanego production workera przed modelem, workspace,
  operation/artifact i zmianą Git HEAD.

## Mutation evidence

Każda mutacja została wykonana chwilowo, potwierdziła RED i została przywrócona przed targeted
GREEN:

- production bot bez deployment policy: golden path RED przed durable proposal;
- dedicated `v1:engineering` GRANT zmieniony na generic `v1:approval`: RED przez brak grantu;
- valid worker lease bez `proposalId`: RED na strict bounded approval binding.
- generic `DecisionAnswer` routing oraz generic `ApprovalInteraction` routing: osobno RED przez
  dodatkowy engineering `respond`;
- worker uznający model option `grant` albo `deny` z durable `DecisionAnswer` za authority: RED
  `2` testy; worker uznający `external_actions` + receipt + generic Approval: RED `1` test;
- odłączenie production relay startup, zgubienie policy na `runFromEnv` handoff albo porzucenie
  prawego concurrent GRANT: każde osobno RED;
- usunięcie populated-down guarda 036: RED dla PENDING i GRANTED.
- usunięcie table locka 036: RED na kontrolowanym `drop-blocked` race;
- routing exact live-proposal generic Approval: RED przez błędny `GRANTED`;
- osłabienie terminal fence STOP-first oraz pominięcie `case=CANCELLED` dla GRANT-first: osobno RED.

## Granice dowodu

Discord API i gateway są transport fakes; test nie wykonuje operacji w live Discord. Provider modelu
jest skryptowany, natomiast routing, repositories, transactions, production outbox relay, queue
fencing, worker composition, gates/review i local Git commit są rzeczywistymi adapterami
produkcyjnymi. Granica crash jest symulowana fresh composition re-entry po committed proposal i po
committed GRANT w tym samym procesie testowym; test nie zabija procesu systemowego w środku
instrukcji PostgreSQL. Nie wykonuje push, merge ani MR.
