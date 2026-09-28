# Decision log

Materialne decyzje architektoniczne zapisujemy jako:

```text
docs/decisions/ADR-<NNNN>-<slug>.md
```

ADR zawiera: kontekst, decyzję, alternatywy, konsekwencje, sposób migracji i
rollback. Zmiana zaakceptowanej decyzji wymaga nowego ADR zastępującego poprzedni.

Aktualne decyzje:

- [ADR-0030 — kontrolowany pilot Engineering](ADR-0030-controlled-engineering-pilot.md)
- `ADR-0029` — właściciel zawęża MOBL-2023 do alertu tekstowego; osobny profil
  dziewięciu testów modelu i czterech UI bez zmiany historycznej kwalifikacji voice.
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
- `ADR-0015` — bounded progressive Engineering execution: strict małe slice blueprints,
  test-first chronology, code-owned generator receipts, round/token reserves, working-context
  compaction, destructive-change guard i content-free progress journal.
- `ADR-0016` — provider-neutral Engineering przez oficjalne klienty Codex CLI i Claude Code
  uwierzytelnione subskrypcją; role są wybierane konfiguracją, a Bedrock i OpenCode nie należą
  do aktywnej ścieżki.
- `ADR-0017` — server-owned identity findingów rozróżnia niezależne wymagane
  poprawki na tej samej linii, a outcome handlera, zadania Engineering i
  kompletność diagnostyki są raportowane oddzielnie.
- `ADR-0018` — nowe `GateFailure` v2 wiąże kryteria, klasy awarii, evidence i
  code-owned target IDs; legacy v1 nie może tworzyć write authority przez prose.
- `ADR-0019` — Xcode TEST może otrzymać PASS tylko z niepustym, bounded i
  digest-bound `.xcresult`; exit code i tekst logu nie są dowodem wykonania testów.
- `ADR-0020` — manifest kwalifikacyjny wiąże exact ordered slice IDs z plannerem,
  a brakujący read context jest dozwolony wyłącznie jako planned output targetu
  mutacji należącego do tego samego slice'a.
- `ADR-0021` — `GateFailure` zachowuje szerokie typed observations, ale modelowa
  korekta gate dostaje wyłącznie katalogowy candidate set i musi substantively
  zmienić co najmniej jeden path przed obowiązkowym rerunem; review pozostaje ALL.
- `ADR-0022` — pre-commit review rozdziela changed-line anchor od dokładnych
  typed target paths; tylko server-validated targety aktywnego slice'a mogą
  zasilić correction prefetch i wymagane mutation receipts.
- `ADR-0023` — failed-mutation recovery zachowuje dokładne server-owned targety
  przez compact epoch; sibling mutation nie zeruje bounded no-progress guardu.
- `ADR-0024` — zmierzony kontekst korekty kompilacji ma wersjonowany limit
  48000 bytes / 12000 estimated tokens, związany z config digest etapu;
  globalny budżet invocation i wymóg kompletnego evidence pozostają bez zmian.
- `ADR-0025` — static precheck i synthetic trace nie zastępują wykonania;
  parser Xcode odrzuca skip/expected failure oraz niezgodny target testu.
- `ADR-0026` — niezmienne evaluator-owned test inputs są instalowane przed
  protected baseline disposable copy; source i evaluated tree mają oddzielne
  związane identity, bez zmiany historycznych receipts ani zgód live.
- `ADR-0027` — jawny tryb izolowanego XCUITest harnessu obejmuje własny projekt,
  scheme i test host w protected inputs, bez nadpisywania projektu kandydata.
- `ADR-0028` — jawny profil full-flow wybiera związana manifestem wersja
  evaluation; legacy pozostaje bez zmian, a nowy profil wymaga osobnej kwalifikacji.
