# ADR-0014 — Operacyjny ingress i cross-fence recovery Engineering Control Plane

- Status: `ACCEPTED`
- Data: `2026-08-26`
- Uzupełnia: `ADR-0011`, `ADR-0013`
- Taski: `RA-046`, `RA-047`; oba poprzedzają live smoke `RA-045`

## Kontekst

Kwalifikacja `RA-044` potwierdziła dwie granice, których nie wolno ukryć za zielonym testem
consumera:

1. produkcyjny worker przy konserwatywnym profilu zawsze wybiera
   `LARGE_OR_HIGH_RISK` i wymaga durable `engineering_approval`, lecz żaden composition root nie
   tworzy takiego grantu ani odpowiadającego mu joba; istnieje wyłącznie bezpieczny consumer i
   testowe zasianie DB;
2. po wygaśnięciu lease'a wieloetapowego implementer joba częściowo potwierdzony ledger poprawnie
   przechodzi do `RECONCILING`. Generic claim nie może go przejąć, a poluzowanie fencing pozwoliłoby
   powtórzyć nieznany write. Jednocześnie stage-specific dowody (gate receipts albo obserwacja Git
   HEAD) mogą w części przypadków deterministycznie potwierdzić efekt bez replayu.

Bez pierwszej granicy M8 jest bezpieczny, ale nieosiągalny z produkcyjnego wejścia. Bez drugiej
przeżywa restart procesu w ramach ważnego lease'a, lecz nie potrafi automatycznie kontynuować po
reap/reclaim. `RA-045` nie może uczciwie nazywać się live smoke bez obu ścieżek.

## Decyzja

### 1. Dedykowany producer write approval (`RA-046`)

Powstaje osobny, server-owned protokół propozycji engineering write. Nie używa modelowego
`DecisionRequest` jako autoryzacji i nie podszywa się pod `external_actions`.

- proposal trwale wiąże case/owner/checkpoint, prealokowane work unit/run, process class,
  repo/write scope i canonical scope digest;
- code-owned Discord interaction pokazuje `GRANT`/`DENY`; interaction id jest kluczem
  idempotencji;
- `GRANT` w jednej transakcji ponownie wyprowadza scope, tworzy `ApprovalRepository` grant,
  claimuje prealokowany work unit/run i enqueue'uje dokładny payload
  `reason=engineering_approval`;
- `DENY`, stale/foreign/double-click i crash/outbox replay nie tworzą grantu ani writera;
- grant pozostaje **blanket, run-scoped write grantem w server-owned ceiling**. Nie jest dowodem,
  że owner przeczytał konkretny `ProgramDesign`; exact design nadal przechodzi osobny,
  digest-bound review. Zmiana na human approval konkretnego ProgramDesign wymaga kolejnego ADR.

### 2. Stage-aware cross-fence reconciliation (`RA-047`)

Nie zmieniamy generic JobStore w fail-open replayer. Reconciliation jest osobną ścieżką:

- expired engineering job może zostać podjęty wyłącznie przez code-owned recovery mode;
- nowy fence nigdy nie wywołuje ponownie nieznanego `COMMAND`/`MUTATING_SIDE_EFFECT`;
- retry-safe `READ_ONLY`/`MODEL_CALL` może dostać nową próbę tylko po exact descriptor/config/schema
  binding;
- GATE może złożyć artifact wyłącznie z kompletnego zestawu exact durable receipts; started gate
  bez receipt pozostaje `AMBIGUOUS`;
- LOCAL_COMMIT może jedynie obserwować i porównać HEAD/parent/message/tree/diff z immutable
  descriptor; nie wykonuje drugiego commit;
- każda naprawa starej operacji ma dedykowany, current-lease-fenced DB boundary. Nie rozszerzamy
  generic `recordIntent`, `appendArtifactRevision` ani `recordCompletion` o swobodny fence rollover;
- continuation zachowuje ten sam case/work unit/run i ordered artifacts, a nowy stage zaczyna się
  dopiero po trwałym domknięciu poprzedniego.

### 3. Kolejność

Ciągły cel `ADR-0013` staje się:

```text
RA-044 DONE -> RA-046 DONE -> RA-047 DONE -> RA-045 DONE
```

`RA-045` nadal wymaga jawnego, lokalnego zadania iOS oraz dostępnego Xcode/AWS, ale nie może
omijać ingressu ani recovery przez ręczne inserty testowe.

## Odrzucone alternatywy

- **Generic DecisionAnswer jako grant:** model kształtuje pytanie/opcje; literal `grant` nie wiąże
  server-owned scope.
- **Fake external action:** approval ingestion autoryzuje digest istniejącej zewnętrznej akcji,
  nie engineering run; mieszanie domen ukrywałoby authority gap.
- **Requeue każdego partial joba i poluzowanie fencing:** nowy worker mógłby powtórzyć efekt bez
  receiptu.
- **Ręczne DB seeding jako runbook:** przydatne diagnostycznie, ale nie jest produkcyjnym
  composition rootem ani dowodem operacyjności.

## Migracja i rollback

- `RA-046` i `RA-047` dostarczą własne migracje z fail-closed down scripts, jeżeli schema okaże się
  konieczna. Nie modyfikują historycznych ledgerów w miejscu.
- Do ich ukończenia RA-044 kwalifikuje core consumer i jawnie raportuje ograniczenie; M8 nie jest
  deklarowany jako operacyjnie human-steered.
- Rollback wyłącza producer/reconciler composition roots. Bezpieczny consumer nadal odmawia write
  bez durable grantu, a niejednoznaczne operacje pozostają `RECONCILING`.
