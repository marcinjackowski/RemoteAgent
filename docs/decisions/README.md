# Decision log

Materialne decyzje architektoniczne zapisujemy jako:

```text
docs/decisions/ADR-<NNNN>-<slug>.md
```

ADR zawiera: kontekst, decyzję, alternatywy, konsekwencje, sposób migracji i
rollback. Zmiana zaakceptowanej decyzji wymaga nowego ADR zastępującego poprzedni.

Aktualne decyzje:

- `ADR-0001` — foundation tooling i przypięte wersje;
- `ADR-0002` — SQL i migracje trwałego stanu;
- `ADR-0003` — historyczny workflow lokalnego implementera; zastąpiony przez ADR-0004.
- `ADR-0004` — Sol high koordynuje/audytuje, GPT-5.6 Luna medium implementuje;
  model identity zastąpione przez ADR-0005.
- `ADR-0005` — Claude Opus 5 koordynuje/audytuje i implementuje przez izolowane,
  ephemeryczne sesje per work unit; model identity zastąpione przez ADR-0006.
- `ADR-0006` — Claude Opus 5 koordynuje/audytuje, Claude Opus 4.8 implementuje w
  ephemerycznych sesjach per work unit z allowlistą ścieżek egzekwowaną przez
  permissions harnessu.
- `ADR-0007` — verification-first; uruchomiona, niecache'owana bramka i mutation
  checks są dowodem, a protokół handoffów/audytów per work unit jest historyczny.
- `ADR-0011` — jeden human-steered Engineering Control Plane: risk-proportional
  product/system/program design, vertical slices, durable recovery, context
  compiler i deterministyczne gates w istniejącym `SupervisorRuntime`.
- `ADR-0012` — GPT-5.6 Sol planuje i wykonuje finalny audyt, a projektowe agenty
  GPT-5.6 Luna eksplorują i implementują pod single-writer oraz bramką ADR-0007.
- `ADR-0013` — Sol/Luna wykonują sekwencję RA-037..RA-045 ciągle; audyt, commit,
  `/clear` i granica taska nie są pauzą, a uprawnienia zewnętrzne pozostają bez
  zmian.
- `ADR-0014` — bezpieczny core dostaje brakujący produkcyjny approval ingress i stage-aware
  cross-fence reconciliation (`RA-046`, `RA-047`) przed live smoke RA-045; generic decisions,
  external actions i swobodny fence rollover nie zastępują tych granic.
