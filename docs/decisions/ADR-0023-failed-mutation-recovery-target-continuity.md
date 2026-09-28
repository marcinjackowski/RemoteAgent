# ADR-0023 — ciągłość targetów po odrzuconej mutacji

- Status: `ACCEPTED`
- Data: `2026-09-06`
- Uzupełnia: `ADR-0015`, `ADR-0021`
- Task: `RA-055`

## Kontekst

Bounded tool loop zachowuje nierozstrzygnięte ścieżki mutacji po wyniku
`FAILED`. Jest to konieczne, ponieważ późniejszy udany zapis do innego pliku nie
jest dowodem naprawienia wcześniejszej operacji. Po compact epoch dokładna para
tool-use/tool-result może jednak wypaść z aktywnego kontekstu modelu.

Live invocation
`mobl-2023-strict-review-targets-20260906T0411CEST` ujawnił tę lukę. Codex
najpierw wybrał właściwe pliki integracji, lecz patch został odrzucony jako
`REPLACEMENT_MISMATCH`, a kolejna próba produkcyjna jako
`CORRECTION_BEHAVIORAL_MUTATION_REQUIRED`. Runtime nadal poprawnie pamiętał
nierozstrzygnięte targety, ale ogólny komunikat
`FAILED_MUTATION_NOT_RECOVERED` nie przekazywał ich nazw. Po rotacji kontekstu
model wielokrotnie zmieniał ostatni widoczny, już naprawiony test. Każdy taki
sukces zerował licznik odmów finalizacji, więc pętla zużyła kolejne rundy bez
zbliżenia się do naprawienia pierwotnych targetów.

## Decyzja

1. Nierozstrzygnięte ścieżki po nieudanej mutacji pochodzą wyłącznie z
   znormalizowanych argumentów tool-use oraz server-owned `changed_files`
   receipts. Tekst diagnostyki i prose modelu nie tworzą recovery authority.
2. Gdy final report jest blokowany przez
   `requireSuccessfulMutationAfterFailure`, serwer przekazuje sorted
   `unresolved_failed_mutation_paths` oraz jawny
   `unresolved_unscoped_mutation_failure` w strukturalnym komunikacie recovery.
3. Każda wymieniona ścieżka wymaga późniejszego udanego receipt dla tej samej
   dokładnej ścieżki. Sukces na siblingu nie rozstrzyga wcześniejszego failure.
4. Nieskopowany failure pozostaje nierozstrzygnięty w obrębie attemptu, ponieważ
   późniejszy zapis nie może dowieść, jaki target miał zostać naprawiony.
5. Licznik bounded completion recovery zeruje się tylko po rzeczywistym
   postępie: usunięciu co najmniej jednego failed path albo spełnieniu wcześniej
   brakującego wymagania correction ANY/ALL. Dowolna inna udana mutacja nie jest
   postępem recovery.
6. Ambiguous mutation pozostaje sticky i wymaga zewnętrznej rekonsyliacji; ta
   decyzja nie wprowadza retry dla stanu `AMBIGUOUS`.
7. Semantyka ADR-0021 pozostaje bez zmian: gate correction nadal używa
   candidate-ANY i obowiązkowego rerunu gate. Nie wymusza sztucznej mutacji
   wszystkich poprawnych już plików.

## Odrzucone alternatywy

- Zmiana candidate-ANY na ALL: łamie ADR-0021 i wymusza edycje targetów, które
  nie muszą być przyczyną konkretnego failure.
- Ponowne wyprowadzanie ścieżki z diagnostic excerpt: nadaje nieufnemu tekstowi
  uprawnienia do zapisu.
- Zerowanie failure po dowolnym udanym zapisie: pozwala siblingowi ukryć
  nierozstrzygniętą operację.
- Zachowanie wyłącznie digestu starej pary narzędziowej: dowodzi integralności,
  ale nie daje modelowi dokładnego, wykonalnego targetu recovery.

## Konsekwencje

- Po compact epoch model nadal otrzymuje minimalną i dokładną instrukcję
  naprawy bez przywracania pełnych logów lub promptu.
- Pętla kończy pozorny postęp w stałej liczbie prób zamiast konsumować cały
  dostępny budżet rund i tokenów.
- Udany receipt na rzeczywistym failed path nadal umożliwia normalną
  finalizację i obowiązkowy rerun gate.

## Migracja

1. Rozszerzyć recovery envelope w `packages/model-runtime/src/tool-loop.ts`.
2. Związać reset bounded recovery z różnicą server-owned unresolved/required
   sets przed i po batchu.
3. Dodać regresje dla failed A + successful B, późniejszego successful A oraz
   deterministycznie posortowanego batchu wielu failed paths.
4. Wykonać RED→GREEN mutation starego bezwarunkowego resetu, pełną bramkę
   RemoteAgent i kolejny fresh live invocation MOBL-2023.

## Rollback

Bezpieczny rollback wyłącza automatyczne retry po failed mutation i kończy
attempt jako `BLOCKED`. Nie wolno przywrócić ogólnego recovery bez exact paths
ani uznawać sibling mutation za rozstrzygnięcie wcześniejszego failure.
