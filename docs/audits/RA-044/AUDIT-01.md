# RA-044 — AUDIT-01

- Task: `RA-044` Kwalifikacja core Engineering Control Plane
- Data: `2026-08-26`
- Bazowy commit: `458a0e938172655159462ea6fd33277ec10198f0`
- Commit implementacji: `772feac`
- Audyt: pełny diff od bazowego commita, wszystkie pliki nieśledzone, kod wywołujący i wywoływany
  oraz samodzielnie uruchomione bramki Sol zgodnie z `ADR-0007`

## 1. Uruchomiona bramka

Po odczycie diffu, dwóch pre-audytach i korektach uruchomiono od początku:

```text
. scripts/dev/env.sh                    Node 24.19.0; PostgreSQL 5432 reachable
pnpm lint                               exit 0; tylko istniejące warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        2757/2757, 217/217, exit 0
pnpm run typecheck --force              40/40, 0 cached, exit 0
pnpm workflow:validate                  OK — 47 tasks, exit 0
git diff --check                        exit 0
```

Wcześniejsze niezaliczone przebiegi zatrzymały się kolejno na lint (pięć nieużywanych symboli),
Prettier (sześć plików) i historycznym guardrailu composition seam (`2750/2751`). Każdy problem
naprawiono bez osłabienia kontraktu, a pełny łańcuch uruchomiono ponownie od początku. Niezależny
qualification run po finalnych korektach dał `38/38` w `6/6` plikach i exit `0`.

## 2. Kryteria akceptacji

1. **Rzeczywisty app i SupervisorRuntime:** spełnione. SMALL, MEDIUM, LARGE, control, malformed,
   stale evidence, correction, no-progress/oscillation i osiągalne fault boundaries przechodzą
   przez `createWorkerHandlers -> SupervisorRuntime -> createProductionEngineeringRuntimePort`.
   Provider, reviewer i code-owned executable są jedynymi fake boundaries.
2. **Recover-not-replay:** spełnione. Intent-only, MODEL_CALL STARTED, artifact-only, inner gate
   receipt, completion-only corruption, projection deletion i LOCAL_COMMIT HEAD reconciliation mają
   load-bearing handler tests. Potwierdzony efekt nie jest powtarzany; unknown mutating effect jest
   `AMBIGUOUS`. Cross-fence continuation po realnym reap pozostaje jawnie RA-047.
3. **High-risk authority:** spełnione. LARGE nie tworzy workspace/write bez exact durable,
   run-scoped `ApprovalRepository` grantu. `DesignDecision` wiąże exact durable ProgramDesign.
   Generic DecisionAnswer ani modelowa rekomendacja nie nadają write authority.
4. **Manifest i evidence:** spełnione. Każdy modelowy/slice stage ma complete sanitized
   `ContextManifest` w immutable intent, każdy przyjęty slice ma exact `EvidenceBundle`; obcy
   tree/config/decision digest jest odrzucany.
5. **Safety mutations:** spełnione. Risk downgrade, writer fence, approval re-check, stale evidence,
   required gate, artifact-kind/checkpoint, path cap, trace scope, retry/recovery, exact
   NO_PROGRESS catch i slice-local correction association zostały osobno zepsute do RED i
   przywrócone do GREEN.
6. **Niecache'owane bramki:** spełnione. Build i typecheck użyły `--force`, raportują odpowiednio
   `0 cached`; PostgreSQL był required i dostępny.
7. **Odtwarzalny trace:** spełnione. `listRunTrace` zwraca ordered, metadata-only exact tuple
   case/owner/run/op/stage/attempt z digestami, bez descriptorów, promptów, payloadów i receipts.
   Metrics pozostają low-cardinality i redagowane.
8. **Dokument kwalifikacji:** spełnione. Dokument rozdziela kwalifikowany core od brakującego
   approval ingressu RA-046, cross-fence recovery RA-047 i live Xcode/Bedrock RA-045. Nie deklaruje
   ręcznego DB seed ani same-current-lease re-entry jako produkcyjnego ingressu/process restartu.
9. **Reply-loop regression:** spełnione. Conversational `AgentCompletion` zachowuje baseline,
   revision, completion, outbox, Discord reply i trusted message; engineering factory i ledgers
   pozostają puste.
10. **Pełna bramka:** spełnione. Cały łańcuch powyżej zakończył się exit `0`, w tym
    `workflow:validate` i diff-check.

## 3. Trwałość, bezpieczeństwo i operacyjność

Model nie ustala repo, server write cap, wymaganych gate'ów, operation IDs ani approval scope.
Write approval jest atomowo konsumowany i ponownie dowodzony z exact immutable row; failed re-open
czyści poprzednią authority. Artifact append/read dzielą jedną code-owned mapę stage→kind oraz exact
case/run/checkpoint binding. Dynamic cancellation pochodzi z immutable ledgeru i nie maskuje
nieznanego STARTED write.

Gate recovery składa bundle tylko z trwałych exact receipts; LOCAL_COMMIT recovery wyłącznie
obserwuje HEAD. Fresh fence działa przed mutacjami i po model callu. Server-owned path cap jest
segment-aware, w config digest i egzekwowany przed mutującym STARTED oraz ponownie na actual
write/evidence/recovery boundaries. No-progress łapie tylko exact typed brak zmiany w bezpośredniej
korekcie; historyczny reject z wcześniejszego slice nie może zakończyć nowego review.

Audyt objął pełny diff i pliki nieśledzone, nie polegał na raportach implementera. Nie wykonano
push, MR/merge, zewnętrznego write, live Bedrock ani Xcode. Produkcyjny Discord approval producer i
cross-fence continuation są celowo zaplanowane w `ADR-0014` jako RA-046 i RA-047; nie są ukrywane
za wynikiami core.

## 4. Findings

Pre-audyt wykrył i zamknął: outer safety-state po stage exception, niedostępny produkcyjnie
NO_PROGRESS, historyczny review digest przenoszony między slices, niepełne full-handler crash
coverage oraz stary guardrail nazwy authority seam. Wszystkie dostały load-bearing test i mutację.

Nie pozostał finding klasy BLOCKER, HIGH ani MEDIUM. Nie powstał nowy finding przekrojowy do
`CROSS_TASK_FINDINGS.md`; dwa jawne braki operacyjne mają zaakceptowaną decyzję i taski RA-046/047.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie dziesięć kryteriów RA-044 jest spełnionych, a pełna niecache'owana bramka zakończyła się
exit code `0`.
