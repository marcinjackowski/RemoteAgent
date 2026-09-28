# ADR-0028 — jawny profil kwalifikacji full-flow

- Status: `ACCEPTED`
- Data: `2026-09-08`
- Task: `RA-055`
- Uzupełnia: `ADR-0025`, `ADR-0026`, `ADR-0027`

## Decyzja

Nowy lokalny benchmark zachowania obu flow jest osobnym profilem, a nie
osłabieniem frozen benchmarku. Manifest pozostaje V1. Wybór korzysta wyłącznie
z jego już walidowanego i związanego digestem `projection_versions.evaluation`:

- `v1` zachowuje legacy contract i dotychczasowe benchmark IDs, poza nowym
  zarezerwowanym ID;
- `full-flow-v1` wymaga dokładnie `benchmark_id: MOBL-2023-full-flow-v1`;
- zarezerwowany nowy ID z `v1`, nieznana wersja i brak wersji oznaczają odmowę.

Nie wybieramy profilu na podstawie obecności protected inputs, layoutu,
ścieżki, gate ID ani argumentu modelu. W harnessie dispatch i cały kontrakt
profilu muszą wykonać się w callbacku poprawnego preflight PRZED utworzeniem
model composition. Używają `preflight.resolved.manifest.manifest`; nie czytają
ponownie pliku manifestu. Sam selector nie autoryzuje wykonania.

## Kontrakt nowego profilu

Niezależne testy Swift (cztery osobne pliki, 11 metod) oraz pełny harness UI
(cztery scenariusze single/multi × general/sharing, pięć chronionych inputs)
zastąpią implementacyjnie zależne lexical assertions wyłącznie w nowym profilu.
Dokładne qualified input digests, executed IDs, targety i schedules muszą być
code-owned i sprawdzane przed modelem. Do ich rzeczywistej kwalifikacji nowy
profil nie jest gotowy do live. Nie dopuszczamy fallbacku do legacy po błędzie.

Gates są wymagane, current-only, LAST_SLICE/FULL, bez baseline/test-first.
Nowe interfejsy mogą nie kompilować się w seed; compile failure nie jest
behawioralnym RED. Protected evaluator paths nie mogą być mutation targets ani
model-owned test paths. `required_test_paths: []` jest poprawne dla tych gates;
nie znosi required executed IDs ani ochrony ich treści.

### Doprecyzowanie kandydatów naprawy po live03 — 2026-09-10

Puste `required_test_paths` nie oznacza pustej authority dla naprawy kodu.
Zgodnie z ADR-0021 oba końcowe evaluatory Xcode muszą jawnie deklarować
`required_mutation_paths`: dokładnie 11 plików SOURCE z zatwierdzonej
20-elementowej write allowlist, z wyłączeniem generator-owned output oraz
ośmiu model-owned TEST paths. Nie przeklasyfikowujemy TEST na SOURCE.
Jest to zestaw kandydatów: naprawa nie musi zmienić wszystkich plików.
Chronione pliki evaluatorów nie stają się kandydatami ani model-owned testami.
Preflight sprawdza dokładny zestaw przed model factory; pusty, niepełny,
zduplikowany albo rozszerzony zestaw oznacza odmowę. Diagnostyka kompilatora
nie dodaje uprawnień, a runtime nadal odmawia niesklasyfikowanej authority.

Live03 pokazał sprzeczność konfiguracji profilu z ADR-0021: poprzedni validator
wymagał pustych obu list, przez co legalna odmowa następowała dopiero po
kosztownej kompilacji. Korekta dotyczy nowej konfiguracji i preflightu,
nie osłabienia runtime. Zamrożony pakiet Phbmzv oraz jego receipts pozostają
bez zmian; poprawiony pakiet otrzyma osobne pliki, nowe związane digests
i osobne potwierdzenie dokładnego live zgodnie z regułą poniżej.

Limit `VerificationGateDefinition.required_mutation_paths` pozostaje 16.
Propozycja19 i zwiększenie limitu do256 zostały wycofane po odtworzeniu
rzeczywistego GateFailure 2026-09-13: ownership validator słusznie odrzucał
osiem TEST paths w polu dla SOURCE/GENERATOR. Sama akceptacja shape katalogu
i profilu nie dowodzi akceptacji mappingu. Test musi obejmować prawdziwy
parser katalogu, ownership mapping oraz resolver authority. Exact11 mieści
się w istniejącym limicie; `required_test_paths`, generator, scope, schemat,
narzędzia i budżety pozostają bez zmian. To kandydaci naprawy produktu:
Engineering może nadal edytować dozwolone model-owned testy w ramach slice'a,
ale same te edycje nie zastępują wymaganej naprawy produktu przy failure
chronionego evaluatora. Nowy config/catalog/manifest/overlay wiążemy osobno.

Nadal obowiązują manifest/overlay/config/catalog/schema/seed binding, server-owned
ownership, ograniczone ścieżki i kontekst, dokładny asset input/generator oraz
changelog, jeśli jest częścią objective. Stare definicje, lexical checks i ich
legacy dispatch pozostają bez zmiany. W nowym profilu należy zachować
równoważne obowiązki jakości, ale nie wymagać nieużywanego pliku
AIMultiAgentFlowView zamiast rzeczywistej trasy ChatView/Session.

Testy behawioralne nie stanowią dowodu gradientu, rozmiaru ikony, układu ani
pełnej zgodności wizualnej. Tę granicę raportuje się jawnie; ostateczny odbiór
zadania nadal wymaga kontroli projektu. Prywatna referencja nie jest wynikiem
autonomicznego Engineering ani dostarczonym commitem.

## Podział nowego benchmarku

### Doprecyzowanie source-precheck po live05 — 2026-09-14

Właściciel zatwierdził przez `continue` przedstawioną korektę oraz nową próbę
do 1.8M tokenów, z tym samym modelem i zakresem zadania, bez push. Naprawialny
source-precheck wymaga dokładnie trzech kandydatów SOURCE pod
`SonderClient/SonderClientLibrary/Sources/Shared`:

- `AgentAI/SafetyAlert.swift`;
- `AgentAI/SafetyAlertPresentation.swift`;
- `Resources/en.lproj/Localizable.strings`.

Wszystkie już należą do write allowlist. Semantyka pozostaje candidate-ANY
z ADR-0021; `required_test_paths` pozostaje puste. Nie dopuszczamy generator
output, testów ani ścieżek wyprowadzanych z diagnostics. Dokładne trzy ścieżki
muszą być zweryfikowane przed factory, a regresja musi objąć rzeczywisty
catalog parser, mapping i GateFailure resolver. Oracle/argv prechecku,
chronione evaluatory i końcowe11 SOURCE candidates pozostają niezmienione.

Puste obie listy w hcakTA powodowały poprawną odmowę dopiero po pierwszej
implementacji. Nie osłabiamy runtime guarda; poprawiamy katalog i jego
preflight. hcakTA oraz wyniki04/05 pozostają niezmienione. Nowa konfiguracja
otrzymuje osobny bundle i ponownie związane digests; bez pełnej lokalnej
bramki oraz canonical preflight nie uruchamiamy zatwierdzonego live06.

Nowy full-flow benchmark ma jeden server-owned vertical slice obejmujący alert,
oba rzeczywiste flow, wspólną blokadę send/rendering oraz changelog. Wszystkie
pięć gates (asset, source precheck, changelog, combined Swift, UI) wiąże jego
końcowy stan. Nie przenosimy dwóch starych slices z pierwszym sprawdzanym tylko
przez asset gate: nowy niezależny evaluator wymaga już współdziałających
interfejsów obu flow, więc taki częściowy odbiór nie dawałby dowodu funkcji.
To zmiana wyłącznie nowego manifestu; legacy slices i receipts zostają bez zmian.
Zakres mutacji jest nadal dokładną listą plików, nie całym drzewem. Protected
test files nie należą do tej listy. Dopuszczone dodatkowe pliki rzeczywistej trasy
ChatView/Session/SharedLibrary oraz opcjonalny typed presentation state muszą
być wymienione przed live i związane nowym digestem manifestu.

Granica autoryzacji wymaga doprecyzowania: manifest targets służą kwalifikacji
i mapowaniu failures; runtime nie używa ich automatycznie jako przecięcia
globalnej write allowlist. Dlatego NOWA konfiguracja ma file-exact write
allowlist (12 produkcyjnych/resource/generator/changelog paths oraz dotychczasowe
8 test paths). Nie zachowuje szerokich prefixów starej konfiguracji. Ponieważ
loader wymaga objęcia trigger paths generatora globalną authority, nowy generator
ma trigger listę siedmiu dokładnych dozwolonych plików AgentAI zamiast całego
katalogu AgentAI. Command/argv/output/cwd generatora pozostają takie same.
To zawężenie nowego profilu, nie zmiana starego generatora ani globalnego
kontraktu runtime. Pinned common checker musi sprawdzić także dokładną write
allowlist; wygenerowany output pozostaje generator-owned.

## Weryfikacja i uprawnienia

### Doprecyzowanie planowania po live — 2026-09-09

Dokładny server-owned benchmark order zastępuje domyślne minimum liczby
blueprints, nie klasyfikację ryzyka ani wymagane review i gates. Bez benchmarku
pozostają minima 1/2/3 i limit czterech modelowych write roots.

Dla zwalidowanego benchmark mapping planner otrzymuje per-slice zakres
wyprowadzony wyłącznie z jego mutation targets, nadal zawarty w globalnych
write/test allowlists. Model może wybrać podzbiór tych korzeni, nie ich rodzica
ani target innego slice'a. Budżet korzeni wynika z tej ograniczonej listy,
nie z argumentu modelu. Generator i obowiązkowe gate paths nadal wiąże serwer;
ich domknięcie również musi mieścić się w dozwolonym zakresie.

Limit strukturalny `ProgramDesign` blueprint allowed_paths zostaje wyrównany
do istniejącego limitu `SliceContract` (256). To limit reprezentacji, nie
uprawnienie do 256 dowolnych zapisów: generic policy nadal dopuszcza cztery,
a benchmark tylko zatwierdzony per-slice zakres. Test_paths pozostaje max16.
Nowy profil z 20 dokładnymi plikami mieści się w reprezentacji bez rozszerzania
globalnej allowlist ani zmiany frozen manifestu. Zmiana schema digest jest jawna.

Jedna wspólna walidacja wykonalności ma działać przed model factory oraz przy
tworzeniu stage executora: sprawdza liczbę/unikalność IDs, zakres, limity
reprezentacji, wymagane test paths i domknięcie generator/gates. Prompt,
policy repair, walidacja ProgramDesign i materializacja stosują tę samą regułę.
Niespełnialna konfiguracja kończy się odmową przed wydaniem tokenów.

Najpierw pure selector z negatywnymi przypadkami i mutacjami, następnie exact
profile contract, canonical preflight-before-factory regressions, wiring,
pełna niecache'owana bramka. Nieznana wersja, pomylony ID, stale digests oraz
zmienione/niekompletne wejścia muszą zatrzymać przebieg przed providerem.

Nowy bundle otrzyma osobne pliki i digest. Nie zmieniamy frozen bundle, source,
seed, starych worktrees ani historycznych receipts. Ten ADR nie autoryzuje
piątego provider live, push, MR ani zmiany budżetu. Dokładny nowy live nadal
wymaga osobnego zatwierdzenia bundle i limitu.
