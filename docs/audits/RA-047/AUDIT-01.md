# RA-047 — AUDIT-01

- Task: `RA-047` Stage-aware cross-fence recovery i continuation
- Data: `2026-08-26`
- Bazowy commit: `2b35b3fd6c2c37ca5e92468a8a64e1ae87d991e6`
- Commit implementacji: `5465bd9`
- Audyt: pełny diff od bazowego commita, wszystkie pliki nieśledzone, migracja up/down, kod
  wywołujący i wywoływany oraz samodzielnie uruchomiona pełna bramka zgodnie z `ADR-0007`

## 1. Uruchomiona bramka audytowa

Po odczycie pełnego diffu i zamknięciu findingów uruchomiono od początku:

```text
. scripts/dev/env.sh                    Node 24.19.0; PostgreSQL 5432 reachable
pnpm lint                               exit 0; tylko znane warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        2829/2829, 224/224, exit 0
pnpm run typecheck --force              40/40, 0 cached, exit 0
pnpm workflow:validate                  OK — 47 tasks, exit 0
git diff --check                        exit 0
```

To jest osobny przebieg audytowy po pełnej bramce implementacyjnej o identycznym wyniku. Pierwsza
próba bramki implementacyjnej miała cztery deterministic fixture failures w dwóch starych plikach
RA-044 po zmianie LOCAL_COMMIT descriptoru. Po korekcie strict fixture targeted adjudication dał
`18/18`, a następnie dwie pełne komendy od początku dały `2829/2829`. Nie sklasyfikowano tego jako
flake.

## 2. Kryteria akceptacji

1. **Wyłącznie code-owned recovery:** spełnione. Generic reap/claim wyklucza exact RA-046 writer i
   case-less recovery job. Niedokończony writer trafia do `RECONCILING`, a continuation do
   niedostępnego dla generic claim `RECOVERY_PENDING`; dedicated claim nadaje nowy fence temu
   samemu jobowi.
2. **Exact retry MODEL/READ_ONLY:** spełnione. Plan wiąże immutable operation/intent/source fence,
   config/schema/scope/deadline, ContextManifest/snapshot/rendered packet i current deployment
   policy. Konserwatywna rezerwacja budżetu jest trwała przed retry. Unknown mutating effect jest
   terminalnie `AMBIGUOUS`.
3. **Receipt-only GATE:** spełnione. Outer recovery wybiera exact GATE stage i może składać bundle
   wyłącznie z kompletnego trwałego required receipt setu. Completed command zachowuje ten sam
   completion ID; missing operation albo STARTED/no receipt nie jest dispatchowane i kończy
   `AMBIGUOUS`.
4. **Observe-only LOCAL_COMMIT:** spełnione. Reconcile porównuje HEAD/parent/marker/tree/diff i
   naprawia outer durability bez `execute`; full production fault test kończy się dokładnie jednym
   Git commitem i jednym LocalCommitReceipt.
5. **Dedykowana repair boundary:** spełnione. Stary artifact/completion/observation może naprawić
   tylko current recovery lease związany z exact source operation i plan digest. Zwykły
   append/completion/observation nadal wymaga oryginalnego current lease i nie akceptuje rolloveru.
6. **Durable continuation i single writer:** spełnione. Immutable recovery chain zachowuje
   proposal/case/owner/work-unit/run/checkpoint/repo/deadline, ordered artifacts i budget. Locks,
   unique constraints, serialization index oraz dedicated claims dają jednego recovery i jednego
   continuation winnera; failure continuation tworzy child recovery bez generic retry.
7. **Fault matrix i mutations:** spełnione. Testy obejmują granice przed/po intent, STARTED,
   receipt, artifact, completion, observation i publish/claim continuation dla model/gate/commit,
   a także stale/foreign authority, cancel/deadline, dwa workery i rollback races. Każdy mechanizm
   bezpieczeństwa ma zapisany realny RED oraz restore GREEN.
8. **Pełna kwalifikacja:** spełnione. PostgreSQL był wymagany, Git/filesystem/gate processes i
   production worker/Supervisor były rzeczywiste, build/typecheck wymuszone bez cache, a pełny
   łańcuch wraz z workflow validation zakończył się exit `0`.

## 3. Trwałość, współbieżność i bezpieczeństwo

Migration 037 dodaje strict recovery binding oraz append-only event ledger, ale nie duplikuje
lease authority: owner/expiry/fence pozostają wyłącznie w `jobs`. Composite FK i triggery
uniemożliwiają złożenie recovery z obcego proposal, joba, operation lub intentu. Plan i authority
fields są immutable. Down zdobywa pełny `ACCESS EXCLUSIVE NOWAIT`, odmawia przy danych lub recovery
jobach i ma kontrolowany writer/drop race test.

Coordinator działa przed generic reap, nie dostaje writer tools i nie trzyma DB locka podczas
modelu/Git/processu. Naprawa starej operacji jest current-recovery-fenced. Dopiero atomowy publish
ustawia źródło `RECOVERY_PENDING`; dedicated claim przełącza je na `LEASED` z nowym tokenem. Case
serialization pozostaje aktywne również w stanie parked. Cancellation/deadline są czytane z
durable control state; nie mogą zamaskować unknown write.

Model nie jest źródłem recovery classification, scope, receipt ani success. Nie dodano push/MR/
merge. Provider modelu w kwalifikacji jest skryptowany, lecz PostgreSQL, queue/scheduler,
repositories, production handler/Supervisor, Git, filesystem i gate process są rzeczywiste.

## 4. Findings

W toku implementacji i pre-audytu zamknięto między innymi: przedwczesny generic reap sukces,
duplikację lease state, niepełne composite authority, recovery job dostępny dla generic queue,
brak `RECOVERY_PENDING` serialization guard, utratę deadline/parent binding, unfenced observation,
gate aggregate replay, LOCAL_COMMIT execute podczas recovery, stale source-operation selection,
continuation error kierowany do generic PENDING oraz rollback race.

Każdy finding dostał load-bearing test i mutation RED→GREEN. Po pełnym odczycie diffu i dwóch
niezależnych pełnych zielonych przebiegach nie pozostał finding klasy BLOCKER, HIGH ani MEDIUM. Nie
powstał nowy finding przekrojowy do `CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie osiem kryteriów RA-047 jest spełnionych, a pełna niecache'owana bramka audytowa
zakończyła się exit code `0`.
