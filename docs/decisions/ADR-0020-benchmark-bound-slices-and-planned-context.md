# ADR-0020 — benchmark-bound slices i planned read context

- Status: `ACCEPTED`
- Data: `2026-09-05`
- Uzupełnia: `ADR-0015`, `ADR-0018`
- Task: `RA-055`

## Kontekst

Manifest kwalifikacyjny przechowuje code-owned slice IDs, targety i kontekst,
ale dotychczasowy planner nie był zobowiązany do użycia tych samych IDs.
`GateFailure` mógł więc być poprawny i receipt-backed, a mimo to nie znaleźć
criterion należącego do aktywnego slice'a. Preflight nie wykrywał tego driftu.

Druga sprzeczność dotyczy kontekstu bramki sprawdzającej nowy plik. Gate może
potrzebować przeczytać `SafetyAlert.swift` dopiero po pierwszej mutacji, podczas
gdy benchmark uruchamia się z seedem, w którym plik zgodnie z taskiem jeszcze
nie istnieje. Wymóg `must_exist=true` dla każdego gate context uniemożliwiał
poprawny preflight; ogólne dopuszczenie `false` osłabiłoby boundary.

## Decyzja

1. Jeżeli execution config zawiera zwalidowane benchmarkowe
   `gateFailureMapping`, jego uporządkowane slice IDs stają się server-owned
   constraintem planowania.
2. Prompt planera otrzymuje tylko tę ograniczoną listę IDs. Zwrócony
   `ProgramDesign` musi mieć dokładnie te IDs w tej samej kolejności; brak,
   nadmiar, zmiana kolejności lub nazwy kończą się policy repair, a następnie
   fail-closed.
3. Server nadal wiąże harmonogram gate'ów, required mutation/test paths i
   generator outputs. Benchmark nie daje modelowi nowej authority i nie
   materializuje modelowego objective ani kodu.
4. `required_read_context.must_exist=false` oznacza wyłącznie
   `PLANNED_MUTATION_OUTPUT`: dokładny path musi być pokryty przez target typu
   `SOURCE`, `TEST` albo `GENERATOR` należący do tego samego slice'a.
5. `false` dla obcego path, read-only support path albo targetu spoza slice'a
   pozostaje naruszeniem ownership. `true` nadal wymaga istnienia canonical
   path w czystym seedzie i ochrony przed symlink escape.
6. Gate context wskazujący planned output jest dostępny dopiero po utworzeniu
   go w zweryfikowanym workspace. Brak pliku podczas rzeczywistego odczytu nie
   jest ignorowany ani zastępowany treścią modelową.

## Doprecyzowanie initial prefetch — 2026-09-10

Live Phbmzv/02 przeszedł design i materializację slice'a, lecz initial prefetch
próbował wymusić istnienie dwóch jawnych planned outputs przed pierwszym write.
`must_exist=false` musi dotrzeć z walidowanego mappingu do przygotowania kontekstu
aktywnego slice'a. Nie jest argumentem modelu ani globalną optional allowlistą.

Tylko podczas pierwszej implementacji dokładny, należący do tego slice'a planned
output może dać negatywną obserwację `exists:false`, jeśli granica odczytu
potwierdziła brak pliku. Failed read receipt pozostaje FAILED; nie tworzymy
treści ani SUCCESS. Istniejący plik nadal podlega zwykłemu odczytowi. Nie wolno
utożsamiać ogólnego DISCOVERY_FAILED z nieistnieniem: błędy uprawnień, I/O,
symlinków, polityki i limitów pozostają błędami. Wymaga to code-owned rozróżnienia
potwierdzonego braku pliku od innych odmów, bez logowania host paths.

Kolejne correction attempts nie dziedziczą initial planned-output wyjątku.
Obowiązkowe gate/review reads oraz required dependencies nadal są exact/fatal.
Nie zmienia to manifestu, target ownership, scope zapisu ani evaluatorów.
Regresje i mutacje muszą wykazać initial missing output, odczyt istniejącego,
odmowę required/foreign/read-only paths i nieignorowanie innych błędów.

## Uzupełnienie bounded initial context — 2026-09-10

Rzeczywista sonda niemodyfikowanego seeda potwierdziła OUTPUT_TOO_LARGE dla
Localizable.strings (77,535 bytes), mimo że plik mieści się w fizycznym limicie
odczytu. Nie zmieniamy frozen implementation_context ani maksymalnego envelope.
Zwykły initial/non-compiler prefetch może po OUTPUT_TOO_LARGE lub jawnym
niepełnym READ pobrać bounded readExcerpt fragments tego samego pliku.

Fragmenty zachowują osobne envelopes, line bounds i wspólny full_file_digest.
Code-owned EOF pozwala rozpoznać koniec również na dokładnej granicy porcji.
Niespójna ścieżka/range/digest, brak postępu, nieznane EOF, odmowa polityki lub
przekroczenie budżetu pozostają błędem. Nie powstaje fikcyjny complete:true READ
ani jeden sklejony oversized envelope. Istniejąca kompletność compiler repair
i jego budżet48000bytes nie są zmieniane.

Polityka jest code-owned: okno256lines, maksymalnie24 dodatkowe wywołania
fragmentów na cały prefetch (w istniejącym total cap48), maksymalnie256KiB
tekstu per fallback file. Za duże okno można zmniejszać aż do pojedynczej
linii, nadal licząc każde wywołanie; nieczytelna pojedyncza linia daje odmowę.
Budżet nie jest parametrem modelu. Zmiana tej polityki musi zmieniać właściwą
identity/config digest etapu. Wymagane: regresje kompletnego dużego pliku,
exact EOF, mismatch/overlap/gap/digest drift, truncation/no-progress/budget,
mutacje guardów i read-only replay rzeczywistego kontekstu przed live.

## Ciągłość wymagań w korektach i epochach — 2026-09-14

Live06 wykazał powtarzaną niezgodność copy, a lokalna sonda potwierdziła utratę
treści taska w compaction: ingress objective jest instrukcją ogólną; exact owner
request pochodzi z kontekstu sprawy. Sam hash tego kontekstu nie daje nowej
sesji modelu dostępu do tekstu. Nie dowodzi to wyłącznej przyczyny nieudanych
decyzji modelu, ale jest deterministyczną luką przekazywania wymagań.

Korekta i każdy implementation context epoch zachowują cały już skompilowany,
zredagowany i ograniczony packet kontekstu sprawy wraz z digestem. Obowiązują
istniejące metadane trust/provenance, binding case/run/revision i byte budget
(produkcja domyślnie32KiB). Nie pobieramy ponownie źródeł inną ścieżką, nie
parsujemy packetu heurystycznie i nie zastępujemy wymagań streszczeniem modelu.
Duże prefetched repository bytes i stara historia tool results nadal pozostają
skompaktowane w epochach. Zmiana nie daje nowej write/tool authority.

Weryfikacja musi pokazać exact task literal dostępny przy generic objective
w initial/correction prompt i initial/correction epoch, zachowane trust oraz
digest, redakcję i limit kompilatora. Osobne mutacje usunięcia packetu z
korekty i epoki muszą czerwienić regresje; samo istnienie hasha nie wystarcza.
Nie zmieniamy frozen benchmarku ani historycznych receipts.

## Odrzucone alternatywy

- Kopiowanie slice IDs z historycznego journala: modelowe nazwy nie są
  kontraktem i mogą zmienić się między invocationami.
- Pozostawienie dynamicznych IDs i prose fallback dla correction: ponownie
  pozwala nieufnej treści tworzyć write authority.
- Wymaganie nowego pliku w seedzie: zmienia baseline i odbiera testowi dowód
  rzeczywistego utworzenia funkcji.
- Akceptowanie dowolnego `must_exist=false`: pozwala manifestowi ukryć brak
  potrzebnego read-only dependency.
- Usunięcie późniejszego READ z gate context: osłabia bounded correction i
  zwiększa zgadywanie modelu.

## Konsekwencje

- Prywatny manifest MOBL-2023 może jawnie opisać nowy `SafetyAlert.swift` jako
  planned output, zachowując ścisłość wszystkich istniejących dependencies.
- ProgramDesign, SliceContract i GateFailure używają tej samej identity slice'a.
- Zmiana listy/orderu slices jest compatibility drift i wymaga nowego runu.
- Constraint oraz planned-output wyjątek wymagają osobnych mutation checks.

## Migracja

1. Rozszerzyć planning constraints o exact ordered benchmark slice IDs.
2. Związać prompt, walidację i config digest z tą listą.
3. Zawęzić gate ownership dla `must_exist=false` do targetu tego samego slice'a.
4. Dodać regresje dla slice-ID drift i foreign optional context.
5. Dopiero potem utworzyć oraz zweryfikować prywatny manifest/overlay R9.

## Rollback

Rollback usuwa możliwość live qualification benchmarku zawierającego nowy
plik i kończy preflight jako `BLOCKED`. Nie wolno wracać do dynamicznych IDs,
prose-derived correction authority ani ogólnego optional read context.
