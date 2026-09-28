# ADR-0025 — granica dowodu kwalifikacyjnego Xcode

- Status: `ACCEPTED`
- Data: `2026-09-08`
- Uzupełnia: `ADR-0019`
- Task: `RA-055`

## Kontekst

Ostatni MOBL-2023 zatrzymał się na lexical predicate odrzucającym konstrukcję
przez produkcyjną konfigurację. Nazwa konstruktora nie dowodzi działania ani
jego braku. Offline `evaluateBehavioralTrace` ocenia dostarczone obserwacje;
literalne `EVALUATOR` i `EXECUTED_ASSERTION` nie uwierzytelniają ich producenta.

Parser xcresult pomijał `Skipped`, akceptował `Expected Failure` jako wykonany
test bez błędu i dopasowywał suite po dowolnym komponencie identyfikatora.
Test innego targetu albo częściowo pominięta suite mogły więc dostarczyć
pozornie kompletnego evidence. To luka adaptera, niezależna od błędu Swift.

## Decyzja

1. Static FAST precheck dowodzi tylko własności plików i jawnych warunków
   strukturalnych. Nie jest dowodem zachowania. Nieznana konstrukcja nie
   uzasadnia behavioral FAIL; usunięcie lexical predicate wymaga zastąpienia
   jego roli rzeczywistą kwalifikacją, nie bezwarunkowym PASS.
2. Obecny offline oracle pozostaje narzędziem testowym. Nie podłączamy go do
   produkcyjnych gate receipts ani nie uznajemy ręcznego JSON za wykonanie.
3. Nowy parser Xcode akceptuje wyłącznie `Passed` i `Failed` dla liści testów.
   `Skipped`, `Expected Failure` oraz nierozpoznany status kończą odczyt
   evidence błędem, klasyfikowanym przez istniejący adapter jako INFRASTRUCTURE.
   Nie nadaje to typed assertion correction authority.
4. Identyfikator testu ma dokładnie `Suite/test` albo `Target/Suite/test`.
   W drugim wariancie target musi odpowiadać katalogowi; skrócony wariant
   wymaga jednoznacznej nazwy suite. Nie szukamy trafienia w dowolnym segmencie.
5. Rzeczywisty dowód zachowania nowego benchmarku wymaga evaluator-owned
   testów, niezmiennych i niedostępnych do zapisu dla implementera, z kontrolą
   digestu i wykonanych test IDs. Samo xcresult testów napisanych przez model
   nadal nie dowodzi jakości ich asercji. Przygotowanie dokładnego nowego
   bundle i sposobu udostępnienia produkcyjnego API poprzedza zgodę live.
6. Gdy istniejący katalog wskazuje pełny selector
   `-only-testing:Target/Suite/test`, musi być wykonany ten test, nie tylko
   dowolny test tej suite. Parser porównuje znormalizowane pełne IDs z
   xcresult (opcjonalne końcowe `()` dla metody XCTest); nie interpretuje
   podciągów ani wildcardów jako tożsamości testu. Brak wybranego testu
   oznacza INFRASTRUCTURE, nie assertion failure. Wykonany test z wynikiem
   Failed pozostaje prawdziwym failure. Ta kontrola korzysta z argv już
   związanych z command digest; nie dodaje authority ani nowego formatu receipt.

## Alternatywy i granice

- Kolejne `includes("SafetyAlertConfiguration(")`: odrzucone; utrwala tę samą
  klasę false-negative i przepuszcza komentarze/nieużyte konstrukcje.
- Wiara w nazwę testu albo `substantive: true`: odrzucone; to dane, nie authority.
- Traktowanie expected failure jak zaliczonego wymagania: odrzucone dla tej
  kwalifikacji. Ewentualna polityka wyjątków wymaga osobnej jawnej decyzji.
- Nie zmieniamy starego bundle, scope, modeli, budżetu ani historycznych
  receipts. Ta decyzja nie jest zgodą na dodatkowe live ani nowy benchmark.

## Migracja i weryfikacja

Najpierw syntetyczne RED dla mieszanych Passed/Skipped, Expected Failure oraz
niezgodnego targetu. Następnie poprawka parsera, adapter-level odmowa PASS,
mutation RED/restore/GREEN i pełna bramka RA-055. Zachować pozytywne przypadki
obu kształtów ID oraz rzeczywiste Failed. Nowa wersja benchmarku wymaga osobnej
kwalifikacji rzeczywistych testów; ten ADR jej nie zastępuje.

## Rollback

Nie przywracać liberalnego parsera dla zaliczenia przebiegu. Nierozpoznany
format pozostaje INFRASTRUCTURE do czasu zbadania fixture i jawnej aktualizacji
polityki. Istniejące historyczne receipts pozostają czytelne i niezmienione.
