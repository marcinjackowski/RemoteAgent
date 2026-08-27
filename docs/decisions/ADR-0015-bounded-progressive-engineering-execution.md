# ADR-0015 — Bounded progressive Engineering execution

- Status: `ACCEPTED`
- Data: `2026-08-27`
- Uzupełnia: `ADR-0011`, `ADR-0014`
- Task: `RA-048`

## Kontekst

Live smoke iOS pokazał, że bezpieczny vertical-slice loop może nadal zużyć zbyt
dużo kontekstu przed pierwszym dowodem. MOBL-2023 miał jeden zbyt szeroki slice,
powtarzał pełną historię narzędzi, nie rezerwował tur na testy i mutacje oraz
zakończył się przed pierwszym gate. Samo podniesienie limitu tur zwiększa koszt,
ale nie zwiększa prawdopodobieństwa powstania małego, zweryfikowanego rezultatu.

## Decyzja

`SupervisorRuntime` pozostaje jedynym driverem. Rozszerzamy istniejący proces o
deterministyczny, progresywny kontrakt wykonania:

1. `ProgramDesign` niesie uporządkowane, strict blueprints slices. Każdy blueprint
   ma jeden obserwowalny rezultat, bounded write roots, test roots i wymagane gate
   IDs. Kod sprawdza limity rozmiaru i materializuje kolejne `SliceContract` z
   zaakceptowanego blueprintu; model nie replanuje swobodnie każdego slice.
2. Każdy slice przechodzi istniejące required gates i review przed następnym.
   Gates mogą być oznaczone jako slice-local albo final; required slice-local gate
   nie może zostać odłożony do końca runu.
3. Generator jest code-owned, wywoływany przez ID z deployment configu i nigdy
   przez raw command modelu. Wykonuje się w disposable copy, a dokładny delta jest
   materializowany pod świeżym fence wyłącznie w zadeklarowanych outputs; receipt
   wiąże command/config/pre/post tree i changed paths.
4. Dla `test_first` pierwszy trwały write/patch slice musi dotknąć code-owned test
   roots. Baseline RED/current GREEN pozostaje niezależnym dowodem wykonania testu.
5. Implementacja ma osobne rezerwy: tury discovery, mutation i final report oraz
   provider-token reserve. Read-only call jest odmawiany, gdy naruszyłby rezerwę
   na pierwszą mutację lub zakończenie.
6. Working history jest kompaktowana deterministycznie. Niezmienne instrukcje i
   najnowsze tool pairs pozostają pełne; starsze pary są zastępowane content-free
   projekcją z digestami, outcome i budżetem. Raw evidence pozostaje w durable
   store/journalu, nie w każdym kolejnym prompt request.
7. Przed trwałym receipt kod odrzuca suspicious destructive delta: complete-file
   replacement istniejącego pliku i przekroczenie server-owned deletion budgetu.
8. Każde invocation JSONL zapisuje strict, content-free progress snapshots:
   slice/checklist, gate state, used/reserved/remaining rounds i tokeny oraz
   code-owned reason/decision codes. Nie zapisuje promptu, bytes, model prose ani
   chain-of-thought.
9. Nieudana mutacja pozostaje nierozwiązana, dopóki późniejsza mutacja nie zwróci
   `SUCCEEDED`. Modelowy final report przed takim odzyskaniem jest odrzucany, a
   ostatnia dostępna próba udostępnia wyłącznie narzędzia mutujące. Gdy code-owned
   limit tokenów lub powtarzających się odmów przerwie sesję, istniejące
   `SUCCEEDED` receipts mogą zastąpić wyłącznie redundantny final report; nigdy
   nie zastępują `AMBIGUOUS`, a kompletność nadal rozstrzygają fresh actual delta,
   required gates i niezależny review.
10. Zwykły assertion failure required gate tworzy bounded, server-owned
    `GateFailure` z digestami receiptów i odfiltrowanym `UNTRUSTED_DATA` excerptem.
    Supervisor zwiększa attempt i ponawia implementację tego samego slice bez
    review nieprzechodzącej próby. Timeout, cancellation, infrastructure failure,
    brak exact failed receiptu i stan niejednoznaczny pozostają terminalne.

Wszystkie policy-significant wartości są code-owned i wchodzą do config digestu.
Model nie może poszerzyć ścieżek, generatorów, gates, budżetów ani progów.

## Odrzucone alternatywy

- **Tylko większy limit tur:** powtarza koszt i odracza pierwszy gate.
- **Generator jako modelowy command:** model wybierałby side effect i jego scope.
- **Test-first wyłącznie w promptcie:** nie dowodzi chronologii mutacji.
- **Pełny transcript w debug logu:** ujawnia dane i prywatne rozumowanie, a nie
  daje stabilnych sygnałów operacyjnych.
- **Drugi orchestrator dla micro-slices:** łamie ADR-0011.

## Migracja i rollback

Kontrakty są wersjonowane, a deployment config dostaje nową wersję. Brak nowych
tabel: durable artifact/operation ledgers przechowują nowe receipt i digests.
Rollback composition wyłącza nowe execution config; istniejące runy ze starym
config digestem nie są wznawiane pod inną policy. Nie ma fallbacku do szerokiego
slice ani modelowego commandu.
