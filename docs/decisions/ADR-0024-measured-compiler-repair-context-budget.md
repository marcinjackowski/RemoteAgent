# ADR-0024 — zmierzony budżet kontekstu korekty kompilacji

- Status: `ACCEPTED`
- Data: `2026-09-07`
- Task: `RA-055`

## Kontekst

Drugi invocation zamrożonego benchmarku MOBL-2023 z changelogiem
(`mobl-2023-context-recovery-20260907T011533Z`) zakończył się FAILED przed
wywołaniem modelu w próbie 6. Odczyty były poprawne: 25 calls przy limicie 48.
Pięć plików testowych wymagało 12 diagnostic windows oraz source-backed
deklaracji i kompletnego manifestu SwiftPM. Mimo bezstratnego usunięcia
podwójnego kodowania envelope zestaw nie mieścił się w domyślnych 24000 bytes /
6000 estimated tokens. Nie był to brak tokenów w budżecie całego invocation.

Prywatny niemutujący replay dokładnego eksportu i worktree potwierdził:

- 24000 bytes / 6000 tokens: REQUIRED_DECLARATION_TRUNCATED;
- 28000 bytes / 7000 tokens: REQUIRED_DECLARATION_TRUNCATED;
- pomiar przy 32000 bytes / 8000 tokens: kompletne evidence, 31415 bytes,
  7854 estimated tokens, 22 retained entries.

To pomiar diagnostyczny z kopiami limitów w pamięci, nie sukces live ani
zmiana zamrożonego benchmarku. Produkcyjny replay przed zmianą kończył się
exit 1. Poprzedni przypadek po naprawach lokalnych kończył się exit 0.

## Decyzja

1. Produkcyjny domyślny limit kontekstu jednej korekty wynosi 48000 bytes /
   12000 estimated tokens. Podwojenie poprzedniego limitu daje zapas ponad
   zmierzone minimum, zamiast dostrajać granicę dokładnie do jednego fixture.
2. Limit jest code-owned, wersjonowany i uwzględniony w config digest etapu
   implementacji. Model ani argument narzędzia nie może go podnieść.
3. Nie zmieniamy limitu 48 wywołań odczytu, 24 plan entries, zakresu zapisu,
   uprawnień, limitów plików ani walidacji pochodzenia i kompletności evidence.
4. Wymagane deklaracje, diagnostyki i manifesty zachowują pierwszeństwo.
   Przekroczenie nowego limitu przez wymagane evidence nadal jest błędem,
   a nie cichym obcięciem albo pozornym sukcesem.
5. Budżet całego invocation pozostaje target 750000, warning 1200000,
   hard stop 1800000 provider/accounted tokens. Nie zwiększamy liczby prób,
   timeoutów ani zatwierdzonej kampanii; brak nowego uprawnienia zewnętrznego.
6. Benchmark/config/gates i iOS source nie zmieniają się. Oba zachowane
   przypadki mają przejść ten sam produkcyjny read-only replay przed nowym live.

## Odrzucone alternatywy

- Usuwanie diagnostyk albo manifestu: ukrywa niekompletny kontekst.
- Limit 32000 ustawiony tuż nad jednym przykładem: niewielki zapas dla kolejnej
  porównywalnej diagnostyki i ryzyko dopasowania do konkretnego benchmarku.
- Nieograniczony kontekst albo podniesienie całego budżetu live: pomiar nie
  uzasadnia takiej zmiany.
- Ręczne poprawianie testów iOS: unieważnia kwalifikację autonomicznej pętli.

## Weryfikacja wymagana

Regresja dla kompletnego pakietu przekraczającego stary limit, odmowa ponad
nowym limitem, mutation RED/GREEN kontroli budżetu, config digest zależny od
wersjonowanej polityki, oba zachowane replaye, strict tsc i pełna bramka taska.
Ten ADR nie oznacza wykonania tych komend ani domknięcia RA-055.

## Doprecyzowanie wyboru deklaracji — 2026-09-14

LIVE07 ujawnił, że podobieństwo nazwy pliku testowego do nazwy produkcyjnego
typu nie stanowi dowodu jego deklaracji. Dla błędu brakującego membera receiver
musi otrzymać source-backed declaration evidence także wtedy, gdy kompilator
wskazuje wywołanie w teście. `AgentAIFlowTests.swift` nie zastępuje deklaracji
`AgentAIFlow`, a generyczny receiver musi być rozpoznany bez promowania jego
argumentów do przypadkowych deklaracji naprawy. Dokładny skonfigurowany READ
wewnątrz istniejącego zakresu odczytu ma pierwszeństwo przed zbędnym root lookup.
Zatwierdzony przez konfigurację odczyt zależności spoza aktywnego zakresu
zapisu pozostaje dozwolony; wybór declaration evidence nie nadaje prawa zapisu.

To korekta selekcji evidence, nie poszerzenie write authority lub budżetów.
Limity48calls/24entries/48000bytes/12000tokens pozostają; brak wymaganej
deklaracji nadal blokuje korektę. Wersja polityki kontekstu identyfikuje zmianę.
Regresje muszą obejmować test-only prior dependency, rzeczywisty produkcyjny
receiver, generyki i mutation RED/GREEN dla fałszywego dopasowania deklaracji.

## Doprecyzowanie lookupu memberów — 2026-09-14, po LIVE08

Odtworzenie08 ujawniło błędy get-only assignment i konwersji argumentu przy
wywołaniu metody. Ich lokalizacja w niezależnym teście nie wyznacza pliku
produkcyjnej deklaracji ani prawa zapisu. WersjaV5 dodaje identyfikację pola
z diagnostyki oraz wywołanej metody z fragmentu kodu, bez reguł dla nazw
benchmarku. Dowodem jest odczyt rzeczywistej deklaracji var/let/func; komentarz,
string, nazwa pliku lub samo wcześniejsze zmodyfikowanie pliku nie wystarczają.

Domain lookupu membera jest ustalany przez serwer z zatwierdzonych source READs
konfiguracji, a przy ich braku z istniejących źródłowych roots zakresu. Nie
wybieramy arbitralnie pierwszych N ścieżek. Niejednoznaczność oceniamy wewnątrz
tego jawnego domain; żaden wynik nie rozszerza prawa zapisu ani dostępu do
evaluatorów. Instruction dla modelu pozwala naprawić powiązaną deklarację z
dostępnego evidence tylko wewnątrz istniejącego slice.allowed_paths.

Globalny lookup w rzeczywistym repo zwraca jawne OVERSIZE. Wyłącznie taki
znany clean limit odczytu (lub kompletny poprawny no-match) może przejść do
pełnego przeszukania wszystkich ustalonych roots. Niepełny/malformed sukces,
inny błąd ani niekompletny scoped wynik nie mogą dać evidence. Każdy root musi
zostać rozstrzygnięty; brak deklaracji albo wiele deklarujących plików blokuje
korektę. Worst-case calls wszystkich roots są liczone przed uruchomieniem;
limity48calls/24entries/48000bytes/12000tokens pozostają bez zmian. Odczyt
deklaracji i manifestu oraz source-backed anchored fragment zachowują provenance.

Wymagane dowody: zmienione nazwy w syntetycznym corpus, kompletna ścieżka
prefetch/finalizer, ambiguity/decoy/truncation/malformed/OVERSIZE controls,
realny source-patch receipt i scope refusal, mutacje RED/restoredGREEN,
odtworzenia07/08 oraz pełna bramka. Ten zapis nie oznacza ich zaliczenia.

Konserwatywny koszt member lookupu obejmuje globalne wyszukiwanie, wszystkie
ustalone roots, exact READ i manifest — nie tylko3 calls happy path. Po tym
przeliczeniu rzeczywisty08 ujawnił dodatkowe zbędne wymaganie deklaracji typu
wywnioskowanego przy niejawnej składni `.member`. Taka diagnostyka nie dowodzi,
że wywnioskowany constraint jest typem z repozytorium. Nie stosujemy listy nazw
stdlib ani wyjątku dla konkretnego benchmarku: rozróżnienie wynika z dokładnej
składni membera w masked excerpt i komunikatu kompilatora. Jawny receiver,
brak jednoznacznego fragmentu albo mieszane implicit/explicit diagnostics
zachowują wymagane deklaracje. Deduplikacja nie może zgubić tego rozróżnienia.
Diagnostyki oraz ich lokalizacje pozostają w kontekście; opcjonalny lookup
wywnioskowanego receivera nie wypiera rzeczywistego obowiązkowego membera.

### Korekta semantyki kompletności — po bramce1664

Powyższy algorytm global search/fallback dla memberów zostaje zastąpiony:
produkcyjny searchSafeText świadomie zwraca pierwszy pasujący plik, więc
complete envelope NIE dowodzi kompletności całego domain. Literalny query
`var name` dodatkowo pomija let i inne białe znaki. Nie zmieniamy kontraktu
wyszukiwarki ani pozostałych lookupów typów w ramach tej poprawki.

Nowa selekcja member evidence odczytuje w całości wszystkie dokładne źródłowe
pliki w istniejącym, ustalonym przez serwer domain. Dopiero po kompletnych,
poprawnych READs rozstrzyga liczbę plików zawierających rzeczywistą deklarację
var/let/func. Parser działa na pełnych zamaskowanych bytes, nie na wyniku
substring search; uwzględnia białe znaki i nowe linie. Brak deklaracji, więcej
niż jeden plik, niepełny/błędny read albo katalog zamiast dokładnego pliku
blokuje evidence. Nie dodajemy nieograniczonego tree walk. Koszt wszystkich
odczytów i manifestu mieści się w istniejącej rezerwacji albo plan jest odrzucony;
nie zwiększamy żadnego limitu. Nowa wersja policy odróżni tę selekcję odV5.
To wybór dowodu źródłowego, nie semantyczny resolver Swift ani nowe prawo zapisu.

Regresja musi korzystać z rzeczywistego read broker/filesystem, obejmować
var+let w dwóch plikach oraz let/whitespace/newline i późny niepełny odczyt.
Mutacja akceptująca pierwszy znaleziony plik ma dać RED, następnie restoreGREEN.

FinalizerV6 nie może rozwiązać obowiązku membera samym SEARCH usage ani regułą
dla struct/class. Wymaga retained exact declaration READ z dokładnie tego
file-domain i rzeczywistej deklaracji var/let/func w zdekodowanej, zamaskowanej
treści. Fragment zachowuje początek i koniec wieloliniowej deklaracji (odstęp
do10linii w istniejących oknach); większy span odrzuca zamiast przekazać sam
keyword bez nazwy. Generic/non-member anchoring pozostaje bez zmian.
