# ADR-0013 — Ciągłe wykonanie milestone'ów przez Sol/Luna

- Status: `ACCEPTED`
- Data: `2026-08-25`
- Uzupełnia: `ADR-0007`, `ADR-0012`
- Decyzja właściciela: pracować bez pauzy na granicach tasków aż do domknięcia
  pełnej implementacji Engineering Control Plane (`RA-037..RA-045`)

## Kontekst

Dotychczasowy proces zakładał ręczny rytm `jeden task → /clear → continue`.
Repozytorium ma już trwałą kolejkę, checkpointy procesu, audyty, handoffy i
standing permission na lokalny commit przy domknięciu taska. Granica taska nie
jest więc techniczną blokadą i nie wymaga każdorazowej zgody właściciela.

Natywna konfiguracja Codex rozdziela odpowiedzialność: Sol podejmuje decyzje i
audytuje, Luna wykonuje ograniczoną implementację. Właściciel chce, żeby ten
podział działał ciągle przez całą kolejkę M8/M9, zamiast zatrzymywać sesję po
każdym `DONE`.

## Decyzja

### Ciągły cel

Po rozpoczęciu ciągłego przebiegu Sol pracuje aż do spełnienia celu terminalnego:

```text
RA-037 DONE -> RA-038 DONE -> ... -> RA-044 DONE -> RA-045 DONE
```

Po domknięciu taska Sol natychmiast:

1. potwierdza czyste drzewo i `workflow:validate` exit `0`;
2. odczytuje z `TASK_INDEX.md` następny task według zwykłego priorytetu;
3. odtwarza jego obowiązkowy kontekst;
4. tworzy just-in-time `WORK_UNITS.md`;
5. rozpoczyna pierwszy krok bez oczekiwania na `continue`.

Audyt, handoff, commit, `/clear`, compaction i granica milestone'u nie są
punktami pauzy. Po utracie historii nowa sesja odtwarza aktywny cel z repozytorium
i kontynuuje kolejkę.

### Podział Sol/Luna

- **Sol**: utrzymuje wymagania i aktywny cel, czyta dokumenty obowiązkowe,
  podejmuje decyzje architektoniczne, przygotowuje bounded work units, deleguje,
  czyta rzeczywisty diff, sam uruchamia bramki, wykonuje finalny audyt, aktualizuje
  statusy i przechodzi do następnego taska.
- **Luna explorer**: tylko bounded read-only discovery, gdy ścieżka kodu jest
  niejasna albo przekrojowa.
- **Luna implementer**: jeden bounded krok implementacyjny naraz, wraz z testami
  i lokalnymi korektami. Nigdy dwa write-capable subagenty na nakładającym się
  zakresie.
- Raport Luny nie jest dowodem. Sol weryfikuje diff i uruchamia komendę taska.

### Dozwolona autonomia

Bez dodatkowych pytań wolno:

- czytać i edytować pliki w aktualnym repozytorium w zakresie aktywnego taska;
- tworzyć work units, testy, migracje i dokumenty wymagane przez plan;
- uruchamiać lokalne, niedestrukcyjne testy/buildy/gates;
- naprawiać findings należące do taska;
- wykonywać lokalne commity przy domknięciu taska zgodnie ze standing permission;
- rozpoczynać następny odblokowany task aż do celu terminalnego.

### Jedynie dozwolone zatrzymania

Przebieg zatrzymuje się wyłącznie, gdy:

1. właściciel napisze `pause`, `stop` albo zmieni cel;
2. wymagana jest materialna decyzja z co najmniej dwiema znacząco różnymi
   konsekwencjami, której nie rozstrzygają ADR-y, task ani kod;
3. dalszy krok wymaga nowego uprawnienia: push/MR/merge, zewnętrzny write,
   destrukcja, zakup lub poszerzenie scope;
4. występuje realna zewnętrzna blokada, której nie można naprawić w zakresie
   taska, albo spełniony jest procesowy próg `BLOCKED`;
5. kolejka nie ma odblokowanego taska, choć cel nie jest osiągnięty — wtedy Sol
   diagnozuje niespójność zamiast zgadywać.

Brak odpowiedzi użytkownika, długość taska, zielony handoff, udany audyt,
compaction, koszt testów lub wygoda raportowania nie są blokadami.

## Granice, których decyzja nie poszerza

- `git push`, MR/PR, merge i zewnętrzne wiadomości nadal wymagają osobnej zgody;
- materialnie destrukcyjne operacje nadal podlegają istniejącym zakazom;
- task nie może ominąć zależności, pełnej bramki, mutation checks, audytu ani
  `workflow:validate`;
- continuous mode nie pozwala zmienić architektury poza zaakceptowanym planem bez
  ADR ani poszerzyć policy/tool scope;
- RA-045 nadal wymaga rzeczywiście dostępnego macOS/Xcode/AWS i jawnego,
  dozwolonego lokalnego zadania docelowego; brak prerequisites jest prawdziwą
  blokadą, nie powodem do sfabrykowania smoke evidence.

## Konsekwencje

- `continue` pozostaje komendą recovery/manual resume, ale nie jest wymagane na
  normalnej granicy taska.
- Finalne odpowiedzi użytkownikowi są checkpointami informacyjnymi, nie domyślną
  pauzą aktywnego ciągłego celu.
- Repozytorium musi po każdym tasku pozostać samowystarczalne i czyste, ponieważ
  kolejny task może rozpocząć się w nowej, skompaktowanej sesji.
- Cel jest ukończony dopiero po `DONE` ostatniego taska objętego decyzją albo po
  jawnej zmianie zakresu przez właściciela.
