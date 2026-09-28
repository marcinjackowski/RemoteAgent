# ADR-0022 — typed target authority dla korekty review

- Status: `ACCEPTED`
- Data: `2026-09-06`
- Uzupełnia: `ADR-0017`, `ADR-0021`
- Task: `RA-055`

## Kontekst

Pre-commit review musi zakotwiczyć każdy blocking finding w rzeczywistej,
zmienionej linii aktualnego patcha. Taka lokalizacja jest dowodem, że reviewer
oceniał bieżące bajty, ale nie zawsze wskazuje plik, którego bajty trzeba
zmienić. Defekt przez brak może być widoczny w nowym `SafetyAlert.swift`, podczas
gdy jego naprawa wymaga uzupełnienia niezmienionego dotąd
`TestFlight/WhatToTest.en-US.txt`.

Live invocation `mobl-2023-eof-repair-recovery-20260906T0254CEST` trzykrotnie
zwrócił ten sam brak. Dotychczas correction runtime wyprowadzał authority z
tekstowej lokalizacji findingu. Implementer dostawał więc anchor zamiast pliku
docelowego, nie mógł odczytać wymaganych bajtów i odtwarzał wcześniej odrzucony
patch. Bezpieczny guard zakończył przebieg jako `PRE_COMMIT_REVIEW_NO_CHANGE`,
ale pętla nie mogła wykonać poprawnej korekty.

## Decyzja

1. Review finding rozdziela dwie niezależne informacje:
   - `location` i `evidence` są server-validated anchorem w aktualnym patchu;
   - `required_fix_paths` jest minimalnym zbiorem dokładnych plików, których
     bajty muszą się zmienić, aby usunąć blocking finding.
2. Reviewer musi podać `required_fix_paths` dla każdego findingu klasy
   `BLOCKER`, `HIGH` albo `MEDIUM`. Ścieżka może wskazywać niezmieniony plik,
   jeżeli jest dokładnym, model-editable leaf wpisem aktywnego
   `SliceContract.allowed_paths`.
3. Serwer normalizuje ścieżki jako sorted/unique i akceptuje je tylko wtedy,
   gdy każda:
   - jest dokładnym wpisem aktywnego slice'a;
   - nie jest katalogiem/rootem będącym przodkiem innego dozwolonego wpisu;
   - nie jest code-owned outputem generatora;
   - pozostaje w istniejącym write authority.
4. Nieprawidłowy albo pusty target downgraduje finding i nie tworzy write
   authority. Modelowy tekst, nazwa pliku w podsumowaniu oraz anchor nigdy nie
   są fallbackiem dla ścieżki mutacji.
5. Serwer zapisuje unię targetów aktywnych blocking findingów jako
   `ReviewDecision.required_mutation_paths`. To pole, a nie prose, jest jedynym
   źródłem następnej correction authority.
6. Bezpośrednia korekta review otrzymuje exact `READ` bieżących bajtów każdego
   targetu i wymaga successful substantive mutation receipt dla **wszystkich**
   typed paths przed ponownym review. Anchor nie staje się wymaganym targetem,
   jeżeli reviewer nie podał go jawnie.
7. Historyczny `ReviewDecision` schema v1 bez nowego pola pozostaje odczytywalny
   z wartością domyślną `[]`, lecz nie może uruchomić korekty. Runtime kończy
   taki przypadek deterministycznie i fail-closed, bez parsowania prose.
8. Finding identity obejmuje target paths. Dwa findingi o podobnym opisie i tym
   samym anchorze, ale wymagające zmian różnych plików, pozostają niezależne.

## Odrzucone alternatywy

- Użycie `location.relative_path` jako targetu: myli dowód obserwacji z miejscem
  naprawy i nie obsługuje defektów przez brak.
- Parsowanie nazw plików z `summary`, `evidence` albo `required_fix`: nadaje
  nieufnej treści modelowej możliwość wyznaczania write authority.
- Dopuszczenie dowolnego potomka katalogowego `allowed_paths`: reviewer mógłby
  wymyślić nową ścieżkę, której planner nie zatwierdził jako dokładnego targetu.
- Semantyka ANY dla kilku review targetów: pozwala pozostawić część niezależnych
  blocking findings bez naprawy.
- Odrzucenie wszystkich historycznych decyzji bez pola: uniemożliwia bezpieczny
  odczyt istniejącego journalu, mimo że można oddzielić odczyt od write authority.

## Konsekwencje

- Prompt i schema review mają dodatkowe pole, a executor utrwala je w decyzji.
- Correction context może zawierać niezmienione dotąd pliki, ale wyłącznie z
  zamrożonej authority aktywnego slice'a.
- Brak poprawnego typed targetu jest widocznym błędem kontraktu review, zamiast
  ukrytej pętli zmian w pliku anchora.
- Test load-bearing musi rozdzielać anchor `SafetyAlert.swift` i target
  `WhatToTest.en-US.txt`, potwierdzać aktualne prefetched bytes oraz wymóg
  mutation receipt wyłącznie dla targetu.

## Migracja

1. Dodać `required_fix_paths` do modelowego kontraktu pre-commit review.
2. Walidować targety po stronie serwera i zwracać ich deterministyczną unię.
3. Dodać `required_mutation_paths` do trwałego `ReviewDecision`.
4. Przekazać typed paths do correction prefetch, promptu i polityki
   `requiredSuccessfulMutationPathsAll`.
5. Zachować legacy parse, ale odrzucać legacy correction bez typed authority.
6. Wykonać focused RED→GREEN mutation i świeży live invocation MOBL-2023.

## Rollback

Rollback wyłącza automatyczną korektę review i kończy `CHANGES_REQUIRED` jako
bezpieczne `BLOCKED`/`RECONCILE`. Nie wolno wracać do wyprowadzania targetu z
anchora albo tekstu findingu. Ponowne włączenie wymaga innego server-owned,
typed źródła ścieżek o authority nie szerszym niż aktywny slice.
