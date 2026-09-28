# ADR-0021 — candidate authority dla korekty Engineering gate

- Status: `ACCEPTED`
- Data: `2026-09-05`
- Uzupełnia: `ADR-0015`, `ADR-0018`
- Task: `RA-055`

## Kontekst

`GateFailure` v2 z ADR-0018 wiąże awarię z server-owned kryterium, gate receiptami
i katalogowymi target IDs. Dotychczas runtime projektował wszystkie ścieżki
powiązanych targetów jako jednocześnie obowiązkowe mutacje. To było bezpieczne,
ale zbyt silne: jedno kryterium może mapować kilka alternatywnych miejsc naprawy,
a gate może wykryć defekt tylko w jednym z nich.

Live invocation `mobl-2023-generator-correction-20260905-1001` wykazał ten
konflikt. Selector gate wskazał brak observable routing w dwóch istniejących
testach. Model naprawił dwa należące do taska suite'y, po czym runtime nadal
wymagał behawioralnej zmiany każdego poprawnego już targetu. Guard słusznie
odmówił import-only albo sztucznej mutacji, więc wymaganie ALL uniemożliwiało
legalne ukończenie korekty.

## Decyzja

1. Trwały `GateFailure` nadal zachowuje wszystkie server-owned observations,
   related target IDs, receipts i diagnostics. Ta szeroka obserwacja nie jest
   redukowana.
2. Correction authority jest wyliczane wyłącznie z
   `required_mutation_paths ∪ required_test_paths` każdego blocking gate w
   zamrożonym `VerificationGateCatalog`.
3. Każda wymagana ścieżka musi być reprezentowana przez related target aktywnego
   slice'a i mieścić się w jego authority. Brak definicji gate, pusty zbiór,
   obcy target, obca ścieżka, niezgodny mapping digest albo niesklasyfikowana
   awaria kończą się `UNCLASSIFIED_GATE_FAILURE`, bez modelowego write.
4. Human-readable diagnostics pozostają `UNTRUSTED_DATA`. Nie wybierają ścieżek,
   nie poszerzają scope i nie są parsowane jako authority.
5. Dla gate correction dokładne ścieżki katalogowe są zbiorem kandydatów:
   przed final report co najmniej jedna musi otrzymać udany, substantive mutation
   receipt. Dla kandydata testowego import, komentarz i whitespace nie są
   zmianą behawioralną.
6. Sukces mutacji nie oznacza naprawy. Ten sam code-owned gate jest obowiązkowo
   uruchamiany ponownie; dopiero nowy PASS receipt potwierdza zachowanie.
7. Review correction zachowuje semantykę ALL: każdy dokładny path odpowiada
   osobnemu blocking findingowi i musi zostać zmieniony przed ponownym review.
8. Code-owned generator output może pozostać w trwałym mappingu i evidence, ale
   jest usuwany z modelowego zbioru kandydatów. Generator uruchamia wyłącznie
   serwer po zmianie source input.

## Odrzucone alternatywy

- Wymaganie mutacji wszystkich related target paths: wymusza sztuczne zmiany w
  poprawnym kodzie i może być logicznie niespełnialne.
- Wybór jednego pliku przez nazwę albo symbol z diagnostic excerpt: przywraca
  prose-driven authority zakazane przez ADR-0018.
- Uznanie dowolnej mutacji w slice za postęp: pozwala ominąć blocking gate przez
  zmianę niepowiązanego pliku.
- Uznanie candidate mutation za sukces korekty bez rerun gate: myli receipt
  operacji zapisu z dowodem zachowania.
- Zmiana review correction na ANY: mogłaby pozostawić inne niezależne findingi
  bez naprawy.

## Konsekwencje

- Katalog gate musi jawnie deklarować niepusty zbiór required paths dla każdej
  awarii produktu, którą Engineering ma automatycznie naprawiać.
- Szerokie benchmark mappings pozostają użyteczne dla provenance, ale nie
  wymuszają zmian wszystkich targetów.
- Toolset i model runtime mają dwa jawne kontrakty: candidate-ANY dla gate oraz
  exact-ALL dla review.
- Błędny wybór kandydata pozostaje bezpieczny: ponowny gate nie wystawi PASS i
  następna korekta nadal bazuje na nowych server-owned receipts.

## Migracja

1. Zawęzić resolver v2 do required paths katalogu i dodać test z dodatkowym,
   mapowanym, ale niewymaganym targetem.
2. Przekazać zbiór candidate-ANY przez executor do bounded toolsetu oraz przez
   runtime policy do kontroli final report.
3. Zachować behavioral guard dla test candidates i ALL policy dla review.
4. Uzupełnić prywatny katalog live o required paths dla naprawialnych bramek,
   ponownie związać digests manifestu i wykonać preflight przed live invocation.

## Rollback

Rollback wyłącza automatyczną korektę danej awarii i kończy ją jako
`UNCLASSIFIED_GATE_FAILURE`. Nie wolno wracać do parsowania prose ani do uznania
dowolnej mutacji za dowód. Semantykę ALL można przywrócić dopiero po takim
przeprojektowaniu katalogu, w którym każdy blocking gate reprezentuje dokładnie
jedną obowiązkową ścieżkę.
