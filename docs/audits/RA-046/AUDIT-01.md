# RA-046 — AUDIT-01

- Task: `RA-046` Engineering approval ingress: Discord → grant → writer job
- Data: `2026-08-26`
- Bazowy commit: `45a20f16264f426091900df69e6ffa7d218b43e6`
- Commit implementacji: `eee843d`
- Audyt: pełny diff od bazowego commita, wszystkie pliki nieśledzone, kod wywołujący i
  wywoływany oraz samodzielnie uruchomione bramki Sol zgodnie z `ADR-0007`

## 1. Uruchomiona bramka

Po odczycie diffu, niezależnych pre-audytach, mutation checks i korektach uruchomiono od początku:

```text
. scripts/dev/env.sh                    Node 24.19.0; PostgreSQL 5432 reachable
pnpm lint                               exit 0; tylko istniejące warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        2800/2800, 220/220, exit 0
pnpm run typecheck --force              40/40, 0 cached, exit 0
pnpm workflow:validate                  OK — 47 tasks, exit 0
git diff --check                        exit 0
```

Skonsolidowana bramka korekt przed pełnym przebiegiem dała `25/25` w `4/4` plikach na realnym
PostgreSQL oraz zielone buildy/typechecki. Wcześniejszy pełny przebieg miał `2791/2791`, lecz nie
został użyty jako końcowy dowód: pre-audyt ujawnił brakujące load-bearing mutations, production
relay reachability i rollback TOCTOU. Po ich korekcie cały łańcuch uruchomiono ponownie.

## 2. Kryteria akceptacji

1. **Strict proposal i authority scope:** spełnione. Versioned proposal wiąże exact
   case/owner/revision, prealokowane work-unit/run IDs, process class, repo, normalized path ceiling,
   deployment-policy digest i canonical V2 action digest. Authority jest wyprowadzana z case i
   server config; Discord actor pozostaje wyłącznie faktem audytowym.
2. **Production Discord routing:** spełnione. `/engineering`, dedykowane
   `v1:engineering:<proposal>:<revision>:grant|deny` i `/stop` przechodzą przez production intake,
   durable-before-ACK sink i osobne ingress repositories. Generic decision/approval outcomes nie
   wchodzą do engineering route. `runFromEnv` przekazuje exact parsed policy, a
   `createDiscordProcess` uruchamia production outbox relay.
3. **Atomowy GRANT:** spełnione. Jedna transakcja pod case/proposal locks ponownie wyprowadza scope,
   zapisuje single-use Approval, tworzy prealokowany IMPLEMENTER work unit/run, enqueue'uje dokładnie
   jeden ośmiokluczowy `agent.implementer` job i utrwala replay identity. Powtórzenie provider
   interaction zwraca te same IDs bez duplikatów.
4. **Negatywne i crash/concurrency boundaries:** spełnione. DENY, expiry, stale/foreign binding,
   policy drift, double click, STOP-first, GRANT-first→STOP, lost response/fresh composition re-entry
   i dwa boty pozostają fail-closed. Populated migration down zachowuje durable authority; exclusive
   NOWAIT locks zamykają writer-between-check-and-drop race.
5. **Authority bypass mutations:** spełnione. Osobno zepsuto generic Decision routing, generic
   Approval routing z ID aktywnego proposal, DecisionAnswer z modelowym `grant` i `deny`, zakończony
   `external_actions` z receiptem/generic Approval oraz brak proposal materialization. Każdy test
   przeszedł na RED, po czym produkcyjny guard przywrócono i potwierdzono GREEN.
6. **Realny Discord→worker E2E:** spełnione. Root test używa raw gateway events,
   `createDiscordBotFromEnv`, production process relay, PostgreSQL proposal/outbox, przechwyconego
   dedykowanego buttona, realnego GRANT, `JobStore.claim` i production engineering handlera do
   `EvidenceBundle` oraz jednego `LocalCommitReceipt`. Happy path nie wywołuje testowo
   `ApprovalRepository.grant` ani `jobs.enqueue`; nie ma remote/push.
7. **Pełna weryfikacja:** spełnione. PostgreSQL był required, build/typecheck były wymuszone bez
   cache, a pełna komenda powyżej wraz z `workflow:validate` i diff-check zakończyła się exit `0`.

## 3. Trwałość, bezpieczeństwo i operacyjność

`engineering_write_proposals` jest tabelą stanu, nie drugim journalem authority; Approval pozostaje
jedynym grant carrierem. Globalny append-only ingress interaction ledger daje provider replay
identity. Proposal+outbox oraz GRANT+Approval+work/run/job są atomowe. Migration 036 down najpierw
zdobywa `ACCESS EXCLUSIVE NOWAIT`, potem sprawdza emptiness i dopiero usuwa schema; populated albo
aktywny-writer rollback odmawia bez utraty danych.

Worker rozpoczyna authority transaction od current lease `FOR SHARE`, następnie dowodzi exact
GRANTED proposal/job materialization i ponownie liczy V2 scope/digest przed `Approval.consume`.
Model, generic DecisionAnswer, generic Approval, external action, job payload i Discord custom ID
nie mogą poszerzyć repo/path scope. STOP działa także bez engineering deployment policy. Po
GRANT-first→STOP trwały job może istnieć, ale cancelled case zatrzymuje production worker przed
modelem, workspace, operation, artifact i Git write.

Audyt objął pełny diff i pliki nieśledzone, a nie raport implementera. Nie wykonano live Discord,
Bedrock, Xcode, push, MR ani merge. Fresh composition re-entry w tym samym procesie testowym nie jest
deklarowany jako OS process crash; cross-fence continuation pozostaje zakresem RA-047.

## 4. Findings

Pre-audyt wykrył i zamknął: Discord actor mylony z internal owner, niespójny lock order,
PostgreSQL-15-incompatible JSONB key count, niepełne GRANTED trigger fences, utratę EXPIRED replay,
current-lease consume TOCTOU, brak production relay/policy handoff coverage, niepełne AC5 bypass
mutations, niedeterministyczny GRANT/STOP proof oraz dwa rollback defects — populated data loss i
writer-between-check-and-drop.

Każdy finding dostał load-bearing test i mutation RED→GREEN. Finalny read-only re-audyt potwierdził
zamknięcie wcześniejszych HIGH/MEDIUM. Nie pozostał finding klasy BLOCKER, HIGH ani MEDIUM i nie
powstał nowy finding przekrojowy do `CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie siedem kryteriów RA-046 jest spełnionych, a pełna niecache'owana bramka zakończyła się
exit code `0`.
