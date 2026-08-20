# Protokół wykonania, handoffu i audytu

## Cel

Protokół pozwala Solowi sterować sekwencją skupionych, jednorazowych uruchomień
implementera. Źródłem prawdy są repozytorium, task, plan work units,
wersjonowane handoffy i audyty — nie pamięć sesji modelu.

## Role

### COORDINATOR_AUDITOR (Claude Opus 5 — zob. ADR-0006)

Wybiera makro-task, planuje architekturę i rozpisuje atomowe work units. Przekazuje
je lokalnemu implementerowi pojedynczo, kontroluje working tree, odtwarza testy i
wydaje niezależny werdykt. Jest jedynym autorem planów, statusów kolejki i audytów.
Nie implementuje kodu produktowego, który następnie audytuje.

### IMPLEMENTER (Claude Opus 4.8, variant high — zob. ADR-0006)

Realizuje dokładnie jeden work unit w ephemerycznej sesji. Może edytować tylko
dozwolone ścieżki i uruchomić wskazaną weryfikację. Nie wybiera taska, nie
rozpisuje dalszej pracy, nie audytuje, nie zmienia statusów ani artefaktów
workflow i nie wykonuje remote writes.

### OWNER

Podejmuje materialne decyzje, uruchamia ciągły przebieg komendą `continue` i
zatrzymuje go jawnym poleceniem pauzy. Nie musi ręcznie przełączać się między
implementerem, audytem ani kolejnymi taskami.

## Statusy taska

```text
BLOCKED_BY_DEPENDENCIES
        |
      READY
        |
   IN_PROGRESS <-----------------------+
        |                               |
 AWAITING_AUDIT                         |
        |                               |
   +----+----------------+              |
   |                     |              |
AUDIT_PASSED      CHANGES_REQUESTED ----+
   |
 DONE

Dowolny stan -> BLOCKED po udokumentowaniu realnej blokady.
```

## Algorytm dla wiadomości `continue`

Sol wykonuje poniższe kroki bez proszenia użytkownika o wskazanie taska:

1. Odczytaj `docs/tasks/TASK_INDEX.md`. Lunie nigdy nie przekazuj
   samego `continue`.
2. Jeżeli istnieje `CHANGES_REQUESTED`, wybierz go, przeczytaj najnowszy audyt,
   zmień status na `IN_PROGRESS`, rozpisz każdy finding na mały fix work unit i
   zlecaj je Lunie pojedynczo.
3. Jeżeli po audycie istnieje `AUDIT_PASSED`, natychmiast zmień go na `DONE`,
   odblokuj taski, których wszystkie zależności są `DONE`, i uzupełnij wolne
   strumienie pierwszymi kwalifikującymi się taskami według kolejności indeksu.
4. W przeciwnym razie, jeżeli istnieje `IN_PROGRESS`, wznów go na podstawie
   planu work units, ostatniego handoffu i aktualnego stanu repozytorium.
5. Dla każdego wolnego strumienia, maksymalnie do trzech łącznie, rozpocznij
   pierwszy `READY`: zapisz bazowy commit/tree, ustaw `IN_PROGRESS`, utwórz lub
   zrewiduj plan work units i dopiero potem uruchom pierwszy unit.
6. Jeżeli istnieje `AWAITING_AUDIT`, Sol priorytetowo wykonuje jego audyt; inne
   już uruchomione, rozłączne strumienie mogą w tym czasie kontynuować pracę.
   Kolejny unit audytowanego taska czeka na werdykt.
7. Po `PASS` albo zakończeniu fix loop wróć do kroku 1 bez oczekiwania na
   kolejną wiadomość właściciela.
8. Jeżeli nie ma taska możliwego do rozpoczęcia, przedstaw konkretną blokadę.

Pętla kończy się wyłącznie po jawnym poleceniu pauzy, przy materialnym Decision
Request albo realnej zewnętrznej blokadzie.

Jeżeli właściciel odpowiada bezpośrednio na zapisany `Decision Request`, agent
weryfikuje, że odpowiedź dotyczy najnowszej decyzji, zapisuje jej rezultat (oraz
ADR, jeśli zmienia architekturę), ustawia task z `BLOCKED` na `IN_PROGRESS` i
kontynuuje. Sama komenda `continue` nie jest odpowiedzią na nierozstrzygnięte
pytanie decyzyjne.

Kolejność w indeksie rozstrzyga przydział wolnych strumieni. Sol może uruchomić
do trzech makro-tasków równolegle, jeżeli wszystkie ich zależności są `DONE`,
plany nie współdzielą plików i każdy task ma najwyżej jeden aktywny work unit.
Konflikt zależności, pakietu albo allowed paths wymusza wykonanie sekwencyjne.
Sol serializuje zmiany statusów, planów, handoffów, audytów i integracyjne gate'y.

## Cykl planowania Sol

1. Przeczytaj wymagane dokumenty, task i aktualny kod bez delegowania tej analizy
   Lunie.
2. Sprawdź working tree, zapisz bazowy commit/tree i zachowaj cudze zmiany.
3. Zapisz `docs/work-units/<TASK_ID>/WORK_UNITS.md` według szablonu.
4. Upewnij się, że każdy unit ma jeden rezultat, maksymalnie trzy kryteria,
   domyślnie do ośmiu plików, context pack poniżej 80k tokenów i jedną
   weryfikację. Dziel dalej tylko wtedy, gdy unit łączy niezależne zachowania,
   przekracza te granice albo pierwsza próba ujawni rzeczywiste przeciążenie.
5. Zidentyfikuj zależności między units i tylko jeden unit danego taska oznacz
   jako `READY`. Inne niezależne taski mogą mieć własny pojedynczy `READY`.
6. Materialną niejasność zapisz jako Decision Request przed uruchomieniem
   implementera.

## Cykl pojedynczego work unit

1. Sol wykonuje preflight z `docs/workflow/LUNA_IMPLEMENTER.md`.
2. Sol uruchamia implementera zgodnie z ADR-0006 (`Claude Opus 4.8`, `variant: high`)
   w nowej ephemerycznej sesji z rolą `IMPLEMENTER`, z allowlistą ścieżek
   egzekwowaną przez permissions harnessu, nie tylko treścią promptu.
3. Implementer czyta tylko context pack, edytuje dozwolone ścieżki, uruchamia
   wskazaną komendę i zwraca krótki raport.
4. Sol porównuje rzeczywisty diff z allowlistą. Zmiana poza zakresem oznacza
   odrzucenie unit albo Decision Request, nie cichą akceptację.
5. Sol czyta zmienione przepływy i sam ponawia celowaną weryfikację.
6. Po akceptacji Sol aktualizuje stan unit i odblokowuje tylko jego bezpośredniego
   następcę. Po niepowodzeniu zapisuje mniejszy fix unit.
7. Po dwóch nieudanych próbach tego samego celu Sol zatrzymuje automatyczne
   ponawianie i dokumentuje blokadę.

Luna nie rozpoczyna następnego unit, nawet jeżeli widzi go w planie.

## Handoff i audyt całego taska

Po akceptacji wszystkich units Sol:

1. uruchamia wymagane przez task testy i adekwatną regresję;
2. sprawdza diff, sekrety, migracje, idempotencję i restart/recovery;
3. tworzy handoff jako syntezę implementacji i dowodów;
4. ustawia `AWAITING_AUDIT`;
5. rozpoczyna niezależny audyt bez edycji implementacji.

W audycie Sol:

1. Potwierdź, że task ma status `AWAITING_AUDIT`.
2. Przeczytaj specyfikację taska, plan work units, handoff i wcześniejsze audyty.
3. Sprawdź pełny diff i wszystkie dotknięte przepływy, nie tylko wskazane pliki.
4. Uruchom testy samodzielnie. Raport Luny i wcześniejszy unit gate nie są
   dowodem końcowym.
5. Sprawdź każde kryterium akceptacji osobno.
6. Oceń bezpieczeństwo, izolację kont, idempotencję, recovery, observability i
   kompatybilność kontraktów odpowiednio do zakresu.
7. Utwórz kolejny dokument audytu.
8. Zaktualizuj status taska zgodnie z werdyktem.

Finding zawiera: severity, lokalizację, dowód, wpływ i wymaganą zmianę. Samo
stwierdzenie „to może być lepsze” nie jest findingiem blokującym. Dla
`CHANGES_REQUIRED` Sol po zamknięciu audytu tworzy małe fix work units i
kontynuuje; nie naprawia kodu w roli audytora. `PASS` powoduje `DONE`,
odblokowanie zależności i automatyczny start kolejnego taska.

## Handoff revisions

Pliki są append-only:

```text
docs/handoffs/RA-007/HANDOFF-01.md
docs/audits/RA-007/AUDIT-01.md
docs/handoffs/RA-007/HANDOFF-02.md
docs/audits/RA-007/AUDIT-02.md
```

Nie nadpisuj poprzednich handoffów ani audytów. Każda rewizja ma dokładnie jedną
kanoniczną nazwę: numer zero-paddowany do dwóch cyfr (`01`…`09`), potem naturalny
zapis (`10`, `11`, …, `100`). Bez `00` i bez nadmiarowych zer — `HANDOFF-1.md`,
`AUDIT-001.md` czy `AUDIT-010.md` są odrzucane przez `workflow:validate`, tak samo
jak dwa pliki wskazujące ten sam numer (np. `AUDIT-01.md` i `AUDIT-001.md`).
Najnowszy artefakt wybieramy po numerze rewizji, nie po kolejności katalogu.

Katalogi `docs/handoffs/<TASK_ID>/` i `docs/audits/<TASK_ID>/` mają zamknięty
kontrakt: mogą zawierać wyłącznie kanoniczne pliki danego prefiksu
(`HANDOFF-NN.md`, `AUDIT-NN.md`). Każdy inny wpis — inny sufiks lub rozszerzenie
(`AUDIT-02-final.md`, `AUDIT-02.txt`), literówka w prefiksie (`AUDITT-02.md`),
plik pomocniczy czy podkatalog — jest twardym błędem walidatora, a nie cicho
pomijany. Dzięki temu błędnie nazwany nowszy dokument nie może pozostawić
starszego werdyktu jako obowiązującego.

## Decision Request

Gdy Luna zgłosi materialną niejasność albo Sol wykryje ją przed dispatch, Sol
zapisuje decyzję w najnowszym handoffie i ustawia task na `BLOCKED`. Handoff musi
zawierać jawny marker
`Decision Request` (nagłówek, pogrubienie lub pozycja listy zaczynająca się od
`Decision Request`), a samo pytanie:

- konkretną decyzję;
- dlaczego jest potrzebna teraz;
- 2–3 realne opcje i ich konsekwencje;
- rekomendację;
- zakres pracy zablokowany przez decyzję.

Drobne, lokalne decyzje implementacyjne nie wymagają zatrzymania, jeżeli nie
zmieniają kontraktu, bezpieczeństwa, kosztu, danych ani zakresu.

### Provenance blokady (`BLOCKED`)

`workflow:validate` rozstrzyga źródło blokady deterministycznie, według
NAJNOWSZEGO artefaktu (po numerze rewizji `HANDOFF-NN`/`AUDIT-NN`), a nie przez
samo istnienie jakiegokolwiek audytu:

- najnowszy artefakt to audyt (rewizja audytu ≥ rewizja handoffu) → blokada
  audytowa; werdykt tego audytu musi być `BLOCKED`;
- najnowszy artefakt to handoff → blokada proceduralna; ten handoff musi zawierać
  marker `Decision Request`;
- brak jakichkolwiek artefaktów → blokada nieudokumentowana.

Każdy inny kształt (np. stary audyt `CHANGES_REQUIRED` bez nowszego handoffu z
Decision Request, brak markera, niejednoznaczny lub brakujący werdykt) jest
fail-closed. Dzięki temu Sol może legalnie zatrzymać task z Decision Request po
wcześniejszym `CHANGES_REQUIRED`, a przestarzały audyt nie jest brany za
przyczynę bieżącej blokady.

## Inwarianty walidatora kolejki (`workflow:validate`)

`workflow:validate` deterministycznie egzekwuje poniższe inwarianty na podstawie
`docs/tasks/TASK_INDEX.md` oraz artefaktów w `docs/handoffs/` i `docs/audits/`.
Wszystkie kontrole są fail-closed, a każdy błąd wskazuje lokalizację (`linia`,
task) i wartość naruszającą regułę.

### Causality rewizji handoffu i audytu

Najnowszy artefakt (po numerze rewizji `HANDOFF-NN`/`AUDIT-NN`, nie po kolejności
katalogu) musi odpowiadać miejscu statusu w cyklu audytu, aby przestarzały
werdykt nie mógł zatwierdzić nowszej, niezaudytowanej pracy:

- `AWAITING_AUDIT` jest wejściem Sol po zakończeniu units i zapisaniu handoffu.
  Najnowszy handoff musi więc mieć rewizję nowszą niż najnowszy audyt
  (`rewizja_handoffu > rewizja_audytu`). Stary handoff nienowszy od audytu jest
  błędem.
- `CHANGES_REQUESTED`, `AUDIT_PASSED` i `DONE` są wejściami audytu Sol. Najnowszy
  audyt nie może być starszy od najnowszego handoffu, który ocenia
  (`rewizja_audytu ≥ rewizja_handoffu`); handoff bez nowszego lub równego audytu
  jest błędem.

Poza samą rewizją najnowszy audyt musi mieć werdykt zgodny ze statusem
(dodatkowo do wymogu istnienia handoffu i audytu):

- `CHANGES_REQUESTED` → werdykt `CHANGES_REQUIRED`;
- `AUDIT_PASSED` → werdykt `PASS`;
- `DONE` → werdykt `PASS`.

Werdykt jest odczytywany z jednej linii deklaracji `- Werdykt: \`PASS\`` z
dokładnie jednym tokenem; brak deklaracji lub tokenu to błąd „missing”, a wiele
deklaracji lub wiele tokenów to błąd „ambiguous”. `BLOCKED` nie ma tu
przypisanego werdyktu — jego źródło rozstrzyga sekcja
[Provenance blokady](#provenance-blokady-blocked).

### Gating statusu zależności

Kontrola działa dwukierunkowo po zbudowaniu pełnej mapy tasków. Uwzględniane są
wyłącznie zależności istniejące w indeksie (nieznane zależności są raportowane
osobno). Zależność jest rozstrzygnięta tylko wtedy, gdy ma status `DONE`:

- statusy wykonywalne i terminalne — `READY`, `IN_PROGRESS`, `AWAITING_AUDIT`,
  `CHANGES_REQUESTED`, `AUDIT_PASSED`, `DONE` — wymagają, aby każda istniejąca
  zależność była `DONE`; niedokończona zależność jest błędem wskazującym task i
  jej status;
- `BLOCKED_BY_DEPENDENCIES` jest odwrotnością: musi mieć co najmniej jedną
  istniejącą, niedokończoną zależność. Gdy wszystkie zależności są `DONE` (i żadna
  nie jest nieznana), task powinien być `READY` — brak niedokończonej zależności
  jest błędem;
- `BLOCKED` jest jawnym wyjątkiem od gatingu zależności: udokumentowana blokada
  jest dozwolona z dowolnego stanu, więc statusy zależności nie są dla niego
  sprawdzane.

Cykl w grafie zależności jest wykrywany osobno i raportowany jako błąd.

### Gramatyka sekcji `## Queue`

Operacyjna lista tasków żyje wyłącznie w sekcji `## Queue`, której tabela ma
zamkniętą gramatykę (fail-closed). Numeryczne wiersze w innych tabelach nigdy nie
stają się taskami, a żaden wiersz danych nie jest cicho pomijany:

- musi istnieć dokładnie jedna sekcja `## Queue` (zero albo wiele to błąd);
- pierwsza niepusta linia sekcji musi być dokładnym nagłówkiem
  `| Order | Task | Status | Depends on | Milestone |`, ograniczonym zewnętrznymi
  pipe’ami z obu stron (brak zamykającego pipe’a lub inna treść to błąd);
- bezpośrednio po nagłówku musi wystąpić wiersz separatora o dokładnie pięciu
  komórkach, ograniczony zewnętrznymi pipe’ami; każda komórka to token separatora
  z co najmniej trzema myślnikami i opcjonalnym `:` z przodu/z tyłu (np.
  `|---:|---|---|---|---|`); pojedynczy myślnik jest odrzucany;
- po separatorze musi wystąpić co najmniej jeden wiersz danych; wiersze danych
  biegną do terminującej pustej linii, następnego nagłówka `## ` albo końca
  pliku;
- każdy wiersz danych musi mieć dokładnie pięć komórek ograniczonych zewnętrznymi
  pipe’ami (brakująca komórka jest wykrywana);
- `Order` musi być dodatnią liczbą całkowitą, a napotkane wartości muszą tworzyć
  dokładnie ciągłą, rosnącą, unikalną sekwencję `1..N` w kolejności wierszy;
  wartość spoza sekwencji jest błędem wskazującym oczekiwaną liczbę;
- komórka `Depends on` musi być dokładnie em dash `—` (brak zależności) albo listą
  rozdzielonych przecinkami tokenów `RA-NNN` zakotwiczonych ściśle, bez śmieci i
  bez duplikatów; pusta komórka, nieprawidłowy token lub duplikat to błąd.

Każdy problem jest zwracany jako komunikat z numerem oryginalnej linii i wartością
naruszającą regułę.

## Zasady dowodowe

- Wynik testu to komenda, exit code i zwięzłe podsumowanie wyniku.
- Review odnosi się do konkretnych ścieżek i zachowań.
- Handoff zawiera rationale i alternatywy, ale nie wymaga prywatnego chain of
  thought.
- Zmiana snapshotu wymaga wyjaśnienia, dlaczego nowy wynik jest oczekiwany.
- Side effect bez potwierdzonego receipt pozostaje `AMBIGUOUS`, nie `SUCCESS`.
