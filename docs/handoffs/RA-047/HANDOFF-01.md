# RA-047 — HANDOFF-01

- Task: `RA-047` Stage-aware cross-fence recovery i continuation
- Data: `2026-08-26`
- Bazowy commit: `2b35b3fd6c2c37ca5e92468a8a64e1ae87d991e6`
- Commit implementacji: `5465bd9`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

Expired partial engineering writer jest teraz podejmowany przez code-owned recovery lane, nie
przez generic retry. Recovery job ma wyłącznie read/repair authority. Po exact klasyfikacji ten sam
źródłowy implementer job dostaje dedicated continuation fence i wraca do istniejącego
`createWorkerHandlers -> SupervisorRuntime`, zachowując case/work unit/run i ordered evidence.

MODEL/READ_ONLY retry wymaga exact descriptoru, renderowanego context packetu, aktualnej policy i
trwałej rezerwacji budżetu. GATE jest receipt-only; STARTED/no receipt pozostaje `AMBIGUOUS`.
LOCAL_COMMIT recovery jest observe-only i nie tworzy drugiego commita. Old-operation durability
naprawia wyłącznie osobna current-recovery-fenced granica.

## Inwarianty do zachowania

- Generic `JobStore.claim/reap/reconcile`, append, completion i observation nie przyjmują recovery
  fence ani `RECOVERY_PENDING` jako zwykłego retry.
- `jobs` jest jedynym lease owner/expiry/fence authority; recovery row nie może dublować zegara.
- Recovery job pozostaje case-less, bez provider/write scope i bez generic dispatch handlera.
- Source proposal/job/case/owner/work-unit/run/checkpoint/repo, operation/intent/source fence,
  deadline i recovery predecessor chain pozostają relationally exact i immutable.
- Retry MODEL/READ_ONLY wiąże ContextManifest, snapshot i bytes/digest renderowanego packetu oraz
  rezerwuje budżet przed dispatch. Nie resetować budgetu przy child recovery.
- GATE recovery nigdy nie tworzy brakującej inner operation ani nie ponawia completed commandu.
- LOCAL_COMMIT recovery wywołuje wyłącznie `recover`/obserwację exact Git state.
- Continuation error wraca do `RECONCILING` i child recovery; nigdy do generic `PENDING`.
- Migration 037 down musi odmówić przy danych/jobach i przed check/drop utrzymać pełny
  `ACCESS EXCLUSIVE NOWAIT` lock set.

## Dowód

```text
cross-fence stage classifier       7/7, exit 0
production coordinator             3/3, exit 0
production gate/commit faults      4/4, exit 0
database recovery authority        real-PG GREEN
migration lifecycle/races          13/13, exit 0
pełna bramka PostgreSQL             2829/2829, 224/224, exit 0
build --force                       26/26, 0 cached, exit 0
typecheck --force                   40/40, 0 cached, exit 0
lint / format / diff-check          exit 0
workflow:validate                   OK — 47 tasks
audit                               AUDIT-01 PASS
```

## Wejście dalej

RA-045 jest odblokowany, ale zgodnie z jego warunkiem startu wymaga potwierdzonego małego zadania w
`sondermind-ios` oraz gotowego lokalnego Xcode/AWS. Ma użyć production approval ingressu RA-046 i
cross-fence recovery RA-047; ręczne inserty DB nie są dowodem live composition.

RA-045 nie może interpretować receipt-only recovery jako zgodę na replay commandu. Push, MR i merge
pozostają poza zakresem i nadal wymagają osobnej decyzji właściciela.

## Granice zewnętrzne

Nie wykonano live Bedrock, Discord, Xcode ani pracy na `sondermind-ios`. Crash boundaries są
fault-injection/fresh composition w tym samym procesie testowym, z realnym PostgreSQL/Git/process,
nie OS kill w połowie instrukcji. Nie wykonano push, MR ani merge.
