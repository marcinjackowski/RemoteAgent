# Engineering Loop — audyt techniczny checkpointu

- Data: `2026-09-05` (Europe/Warsaw).
- Audytowany HEAD: `ce9b2ff62e3c947c72c0fafca47d192af983ce98`.
- Baseline zmian RA-055: `b4fb467e929fa06193d6bb881856a1d4c0daf9a0`.
- Werdykt: `CHANGES_REQUIRED`.
- Kolejka: RA-055 pozostaje `IN_PROGRESS`; WU-01 nieukończony, WU-02 oczekuje.
- Plan wykonawczy: [ENGINEERING_COMPLETION_PLAN.md](../work-units/RA-055/ENGINEERING_COMPLETION_PLAN.md).

## 1. Wniosek

Engineering ma użyteczny szkielet: produkcyjny control plane, izolowane worktree,
receipty, twardą granicę narzędzi, role subscription CLI i rzeczywiste Xcode gates.
Nie ma jednak dowodu, że obecna konfiguracja potrafi autonomicznie dostarczyć
MOBL-2023. Powtarzanie pełnego zadania po każdej lokalnej poprawce jest obecnie
zbyt kosztowną metodą diagnozowania orkiestratora.

Nie zalecam przepisywania całości ani dalszego zwiększania limitów. Zalecam
utrzymać autoryzację i trwałość, naprawić poniższe konkretne granice, zastąpić
tekstowe substytuty testów dowodem zachowania i kwalifikować system warstwowo.

`FAIL-CLOSED` jest wartościową cechą bezpieczeństwa, ale nie jest miarą
użyteczności. `3173` zielone testy nie oznaczają ukończonego Engineering.

## 2. Zakres i metoda

To audyt diagnostyczny na żądanie właściciela, nie końcowy `AUDIT-01` RA-055 ani
ponowne zatwierdzenie wszystkich historycznych tasków. Nie zmienia kolejki,
architektury, statusu na `DONE` ani uprawnień do live.

Przeczytano komplet dokumentów obowiązkowych, w tym 3303-wierszową historię
RA-055. Sprawdzono statystykę całego diffu RA-055 (`50` plików, `14414` dodanych
wierszy, `599` usuniętych), krytyczne zmienione ścieżki wykonania i ich testy.
Zakres ręcznego code review był celowany; nie deklarujemy odczytu każdego
wiersza wszystkich 50 plików ani pełnego audytu bezpieczeństwa produktu.

Dwie eksploracje Luna dostarczyły wskazania. Primary sam odczytał krytyczny kod,
uruchomił pełną bramkę i sondy. Nie przyjęto jako findingów niepotwierdzonych
tez: braku testów tool-loop, eskalacji przez LOW/NIT, ataku na zaufany Git diff.
Testy provider-neutralnego tool-loop istnieją w historycznej lokalizacji
`packages/bedrock-runtime/test/tool-loop.test.ts`.

Nie wykonano model calls, Xcode builds, zapisów w iOS, commitów, pushów ani
sprzątania worktree. Sondy korzystały z fake boundary/in-memory danych; nie
mutowano produkcyjnych mechanizmów. Nie jest to nowy komplet mutation
RED→GREEN wymagany do końcowego PASS napraw.

## 3. Dowód wykonanej bramki

Komenda uruchomiona samodzielnie przez primary, jeden pełny przebieg:

```sh
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check
```

Wynik: **exit `0`**.

| Krok | Wynik |
|---|---|
| lint / format | exit 0 |
| build | 29/29, Cached: 0 |
| Vitest, PostgreSQL wymagany | 244 pliki passed, 2 skipped; 3173 testy passed, 2 skipped |
| Czas Vitest | 180.12 s |
| typecheck | 46/46, Cached: 0 |
| workflow:validate | OK — 55 tasks |
| git diff --check | exit 0 |

Log lokalny: `/tmp/remoteagent-engineering-audit.JCVZiM/gate.log`.
Pominięte testy opt-in nie są dowodem live. W tym przebiegu nie było faila
wymagającego rozstrzygnięcia flake'a.

## 4. Rzeczywisty stan prób i zużycia

Odczytano JSONL w lokalnym `live-mobl-2023/artifacts/engineering-debug`.
Kohorta to pliki, których pierwszy event ma `recorded_at >= 2026-08-29`;
nie jest to deklaracja 89 identycznie skonfigurowanych eksperymentów.

| Pomiar | Wynik |
|---|---:|
| Wszystkie znalezione JSONL, także starsze/puste | 124 |
| JSONL w wybranej kohorcie | 89 |
| RUN_COMPLETED = FAILED | 75 |
| Brak RUN_COMPLETED | 14 |
| Raportowany commit w końcowym evencie | 0 |
| Suma ostatnich globalnych MODEL_USAGE.total_tokens per plik | 69 652 809 |
| Odpowiedzi bez usage, według ostatnich snapshotów | 11 |

To **zgłoszone tokeny**, nie cena API, zużycie procentu subskrypcji ani pełny
rzeczywisty koszt. Przerwane wywołania mogą nie mieć końcowego usage. Nie wolno
sumować kolejnych kumulatywnych snapshotów ani ostatnich snapshotów per rola.
Kohorta zawiera różne configi, przerwania i diagnostykę: nie nadaje się do
uczciwego rankingu modeli.

Ostatni udokumentowany pełny invocation:
`mobl-2023-semantic-gate-correction-20260902-2009`.
Journal: `engineering-78f2b2accedbbd03ce6954ee7b7972fb412e48ee161e356d82b93cf2b49d7154.jsonl`.

- `1 226 936` zgłoszonych tokenów: `1 193 868` input, `33 068` output.
- `41` odpowiedzi, w tym `2` bez usage; około `97.3%` zgłoszonych tokenów to input.
- `61` tool results z `DISCOVERY_FAILED` (wyszukiwania bez trafienia).
- `51` gate receipts PASSED i `11` FAILED; wszystkie **7** receipts
  `ios-safety-alert-tests-final` mają exit `65`.
- Historia podaje `4036.97s`, około 67 minut; brak final verification i commita.
- Ostatni zachowany błąd kompilacji dotyczy conformance
  `SafetyAlertTestAnalyticsService : AnalyticsServiceType`.
- Dwa końcowe procesy Codex: `PROCESS_EXIT_FAILED`, bez usage.

Korekta interpretacji historii: wybranie ośmiu suites w argv nie dowodzi
wykonania ośmiu suites. Run 89 ma czerwone FULL receipts oraz błędy kompilacji
test targetu. Nie ma podstaw do twierdzenia, że wszystkie osiem zostało wtedy
wykonanych. Podobnie krótki zielony subscription smoke po awarii dowodzi
osiągalności tej krótkiej operacji, **nie diagnozuje** przyczyny failure długiego
requestu jako przejściowej.

Seed jest obecnie czysty na `cd46c82de01d6ec4c5e614bcab9dc15f07560642`.
Zachowany Run 89 ma ten sam HEAD, lecz bieżąca statystyka indexu wynosi
`12 files / 437 insertions / 17 deletions`, wobec historycznego `422/17`.
Nie ustalono przyczyny różnicy i niczego nie przywracano. Nie wolno utożsamiać
obecnych bajtów worktree z dawnym gate receipt bez ponownego digest bindingu.

## 5. Potwierdzone findingi

Severity dotyczy skuteczności/wiarygodności kwalifikacji, chyba że wskazano
konkretny inwariant bezpieczeństwa. Żaden poniższy dowód sam nie pokazuje
nieautoryzowanego pushu ani przejścia całego final commit gate.

### EL-01 — HIGH: tekstowy gate akceptuje brak implementacji

Miejsce: lokalny `engineering.json`, gate `mobl-2023-flow-integration`
(definicja od wiersza 33); podobne wzorce w incremental/final safety i selector
gates. Harness w `engineering-live-ios.integration.test.ts` również sprawdza
fragmenty konfiguracji zamiast niezależnego wyniku zachowania.

Primary wykonał niezmienione ciało programu flow gate z podmienionym wyłącznie
read-only `readFile`. Każdy z czterech plików zawierał:

```swift
// SafetyAlert emergencyResources safetyAlert size: .fullScreen
```

Wynik gate: **exit `0`**, mimo braku jakiegokolwiek kodu. Kontrola z komentarzem
`// no implementation` daje exit `1`. Komenda sondy zakończyła się exit `0`,
ponieważ asertowała wykrycie tej rozbieżności, nie poprawność produktu.

Wpływ: false positives; historia Run 78/79/81 dokumentuje również false
negatives dla poprawnych konstrukcji Swift. Rosnący zbiór regexów wymusza
konkretny styl implementacji i zużywa budżet na dostosowanie do testu.

Wymagana zmiana: tekstowe checks nazwać preflightem strukturalnym; zachowanie
udowadniać uruchomionymi testami rzeczywistych flow, akcji i stanu. Usunięcie
wywołania produkcyjnego musi zaczerwienić test mimo pozostawionych nazw/komentarzy.

### EL-02 — HIGH: fallback omija nierozwiązany failed mutation

Miejsce: `apps/agent-worker/src/engineering-execution.ts:184`,
`receiptBackedImplementationReport`; callback `executeAndObserve` około 2270.

Helper przyjmuje `unresolvedMutationFailure`, lecz go nie sprawdza. Primary
wywołał zbudowany eksport z `ToolLimitError`, successful path `src/A.swift`,
all-of `[src/A.swift]`, `unresolvedMutationFailure=true`, ambiguity false.
Wynik: zaakceptowane `{changed_files:["src/A.swift"]}`; sonda exit `0`.

Osiągalny scenariusz: A zapisany poprawnie, kolejna poprawka A odrzucona,
tool-loop zatrzymuje się, a zewnętrzny fallback używa wcześniejszego receiptu.
Normalny tool-loop ma dokładniejszy unresolved-path guard, ale catch przyjmuje
jego `ToolLimitError`. Test około wiersza 253 w
`engineering-execution.integration.test.ts` wprost oczekuje akceptacji tego
stanu. Dowód pokazuje niespójność warstw, nie tylko brak testu.

Dodatkowo callback kasuje boolean failed-state po sukcesie dowolnego pliku.
Fresh actual diff nie udowodni naprawy odmówionej korekty: odmowa nie zmienia bajtów.

Wymagana zmiana: jednoznaczny stan per target, sticky ambiguity, zamknięty
zbiór dopuszczalnych terminali fallbacku; brak akceptacji unresolved failure.
Test normalnego sukcesu musi pozostać zielony po naprawieniu **tego samego**
targetu. Nie zastępować receiptów deklaracjami modelu ani request targetami.

### EL-03 — MEDIUM: review gubi niezależne wymagane poprawki

Miejsce: `packages/review-loop/src/pre-commit.ts:304-322`, `serverFindings`.
Klucz mapy to wyłącznie effective `path:line`; ID również pochodzi z lokalizacji.

Primary uruchomił publiczne `executeFreshPreCommitReview` na poprawnym fixture:
dwa HIGH na tej samej zmienionej linii, dwa różne `required_fix`.
Wynik: **2 wejściowe findingi → 1 finding i 1 blocking ID**; sonda exit `0`.
Nearest-line reanchoring może dodatkowo zlać pierwotnie różne lokalizacje.

Wpływ: implementer dostaje niepełną checklistę; reviewer może odkryć pominięty
defekt dopiero po następnych kosztownych gates. Nie wolno redukować tego do
„model nie przeczytał wszystkich uwag”.

Wymagana zmiana: deduplikacja identycznych findingów, nie całych lokalizacji;
wersjonowana identity zachowująca niezależne fixes i proweniencję reanchoringu.

### EL-04 — MEDIUM: journal myli obsłużenie callbacku z sukcesem Engineering

Miejsce: `engineering-debug-journal.ts:1606-1632`; powiązanie z
`SupervisorRuntime` około 587-599 i `handlers.ts:createCaseResumeHandler`.

Journal ustawia `SUCCEEDED`, jeżeli callback nie rzucił wyjątku. Runtime może
poprawnie zapisać completion `BLOCKED`, zakończyć obsługę i zwrócić
`blocked:false` dla obsłużonego unitu. To nie jest błąd kolejki: obsłużenie
terminala jest zakończoną pracą handlera. Nie jest jednak sukcesem zadania.

Sonda produkcyjnego journal runnera: callback resolves, DB zwraca wyłącznie
`TerminalReason`, brak commita. Wynik końcowy: **`SUCCEEDED`, commit null,
artifact_kinds=[TerminalReason]**. Sonda exit `0`; użyła fake DB i temp artifacts,
nie zmieniała rzeczywistego case'a.

Live wrapper ma osobne sprawdzenie exact commit/evidence, dlatego jego FAILED
nie dowodzi poprawności production summary. Wymagana zmiana: osobno outcome
handlera, durable completion zadania i kompletność diagnostyki; awaria odczytu
DB daje nieznany status diagnostyczny, nigdy domniemany sukces Engineering.

### EL-05 — HIGH: eksperyment nie jest przenośnym, odtwarzalnym benchmarkiem

Miejsce: `engineering-live-ios.integration.test.ts:77,635-720`, lokalny
`engineering.json`, `models-codex.json`, `objective.txt`.

- Właściwe task-specific gate programs, guidance i context znajdują się poza
  Git RemoteAgent; ich digest nie odtwarza utraconych bajtów konfiguracji.
- `finally { await created.drop(); }` usuwa bazę testową wraz z pełnymi
  artifacts/operation intents/receipts. JSONL zachowuje projekcje, nie cały
  canonical evidence bundle. Worktree zostaje, lecz dokładnego runu nie da się
  po prostu otworzyć z tej bazy po zakończeniu.
- Liczne runy mają brak summary przy przerwaniu; `close()` generuje je dopiero
  na końcu. Nie ma w tym harnessie ćwiczenia rzeczywistego resume tego samego
  zachowanego runu po restarcie.
- Różne configi/gates, ręczne stop i zmieniające się limity nie stanowią jednej
  serii porównawczej. Historia obejmuje nawet uruchomienie podczas mutacji
  licznika (Run 65).

Wymagana zmiana: wersjonowany benchmark manifest + lokalny prywatny overlay,
canonical evidence export albo trwała, izolowana baza runnera; jawna obsługa
przerwania i rozdzielenie recovery test od fresh benchmark run.

### EL-06 — HIGH: kontekst korekt i koszt nie mają skutecznej kwalifikacji

Miejsce: `engineering-execution.ts:741-834`,
`engineeringCompilerRepairContext`, model tool surface około 2211.

Po wybraniu diagnostic paths funkcja nadal dodaje **wszystkie** configured
READs, także niepowiązane z błędem, i potem symbole × search roots aż do limitu
24. Po niepustym prefetch model dostaje tylko mutation tools; compiler repair
ma wyłącznie patch. Brak deklaracji nie może być wtedy naprawiony zwykłym
odczytem na żądanie. Silent `add()` cap może ukryć potrzebny fragment.

Run 89 potwierdza koszt: 61 nieudanych wyszukiwań, pierwsze calls wielu korekt
około 48k–68k tokenów, siedem czerwonych FULL uruchomień. To nie dowodzi, że
każdy brak wynika z kontekstu, ale obala tezę o już tanim, minimalnym repair.

Wymagana zmiana: testowy corpus exact compiler failures, priorytetyzowany
bounded context z provenance i informacją o pominięciach, kontrolowany read-only
context request wewnątrz istniejącej authority. Optymalizacja wymaga pomiaru
trafności i regresji, nie kolejnego `MUST` w prompcie.

## 6. Ryzyka wymagające testów, nie deklarowane jako potwierdzone exploity

- All-of „dotknij każdej zakotwiczonej ścieżki” nie jest równoważne „napraw każde
  kryterium”; poprawna naprawa w callee może nie wymagać edycji callera. Zmiana
  tej policy wymaga decyzji/wersji i utrzymania starej ochrony do czasu nowego dowodu.
- Budget reserve jest heurystyczny, a missing usage nie zwiększa liczbowego
  total. Nie wolno obiecywać twardego limitu rzeczywistych tokenów subskrypcji.
  Przy recovery trzeba jawnie określić budżet per invocation i per trwały run.
- Pre-effect filesystem drift między preflight i zapisem: sprawdzić założenie
  wyłączności workspace; nie wykazano tutaj wyścigu w pełnym production flow.
- Parser Xcode oparty na logach i broad inventory potrzebuje corpus/limitów;
  same nieznane formaty nie dowodzą, że konkretny obecny failure jest źle klasyfikowany.
- Nieaudytowane w tym przebiegu: aktualna zgodność live Claude, dostęp konta,
  UX iOS, aktualne zewnętrzne integracje oraz prawo do użycia firmowego kodu
  na danej subskrypcji. Nie uruchamiać tych zakresów na podstawie tego dokumentu.

## 7. Kryteria RA-055 — stan na checkpoint

| AC | Ocena |
|---|---|
| 1 preflight Codex/Xcode/seed | historyczne evidence; seed sprawdzony teraz, login/model/Xcode live nieodnawiane |
| 2 exact cztery role / nowe invocation | historyczne role-routed journals; brak nowego live w audycie |
| 3 produkcyjna ścieżka exact taska | wielokrotnie rozpoczęta, brak dowodu pełnego zakończenia |
| 4 gates → fresh review → verifier → jeden commit | NIESPEŁNIONE; w kohorcie zero raportowanych commitów |
| 5 zachowanie source/seed/worktree | seed czysty, Run 89 zachowany; statystyka obecnego diffu różni się od historii |
| 6 journal i porównanie usage | częściowe; EL-04/05/06, missing usage i niekompletne runy |
| 7 izolacja integracji / non-live gate | własna pełna bramka exit 0; brak nowych zewnętrznych działań; nie jest to pełna ponowna kwalifikacja wszystkich policy guards |

Nie powstaje handoff ukończenia ani status `DONE`. Kolejny agent zaczyna od
planu wykonawczego i reprodukcji findingów, nie od kolejnego pełnego live rerunu.

## 8. Stan po zapisaniu audytu i planu

EL-02 i EL-04 występują już przed RA-055, dlatego zostały dodatkowo zapisane
jako otwarte `CTF-025` (HIGH) i `CTF-026` (MEDIUM) w rejestrze przekrojowym.
Nie zamykano ani nie obniżano findingów dla utrzymania zielonej etykiety.

Wykonano po tej zmianie:

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/acceptance/criteria.test.ts --reporter=dot
```

Wynik: **exit `1`, 17 passed / 2 failed**. Oba faile są dokładnie związane z
nowo jawnymi CTF-025/026: AC2 odrzuca otwarte HIGH/MEDIUM, a AC3 wymaga wpisów
decyzji właściciela w `OPEN_FINDING_DECISIONS` także dla tych severity, mimo
historycznej nazwy testu odnoszącej się do LOW. Nie zmieniano kodu tego testu
ani produkcji. Zatem pełna bramka **baseline** miała exit 0, lecz obecny
rejestr świadomie blokuje końcową acceptance. Nie deklarujemy zielonej pełnej
bramki po dopisaniu findingów.

Walidacja dokumentów: `pnpm format` i `pnpm workflow:validate` zakończyły się
exit `0` (`OK — 55 tasks`), `git diff --check` dla tracked changes również
exit `0`. Kontrola istniejących lokalnych linków: exit `0`, `LOCAL_LINKS_OK=7`.
Pierwszy łączony hygiene chain zakończył się exit `1` na
`git diff --no-index --check /dev/null <nowy plik>`: Git raportuje różnicę
względem pustego pliku, bez diagnostyki whitespace. Nie liczymy tego łańcucha
jako zielonej bramki. Nowe Markdown podlegają oddzielnej kontroli whitespace
i conflict markers. Markdown jest wyłączony z Prettier przez repo; jego format
check nie jest dowodem merytorycznego audytu dokumentów.

Poprawiony końcowy łańcuch: `. scripts/dev/env.sh`, `pnpm workflow:validate`,
`git diff --check` oraz kontrola Node obu nowych dokumentów (trailing
whitespace, conflict markers, końcowy newline, lokalne linki) zakończył się
exit `0`: `NEW_DOCS_OK=2; LOCAL_LINKS_OK=3`. Wcześniejsza kontrola siedmiu
linków obejmowała także zmieniony WORK_UNITS i CTF register.

Zamierzone zmiany tej sesji to wyłącznie cztery pliki dokumentacyjne wymienione
w aktywnym checkpointcie WORK_UNITS. Brak commita/pusha, zmian source/tests,
nowych live calls i usuniętych worktree.
