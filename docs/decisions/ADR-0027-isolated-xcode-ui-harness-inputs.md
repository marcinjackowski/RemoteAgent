# ADR-0027 — izolowany harness XCUITest jako chronione wejście bramki

- Status: `ACCEPTED`
- Data: `2026-09-08`
- Task: `RA-055`
- Uzupełnia: `ADR-0026`
- Zgoda zakresu: właściciel odpowiedział `continue` na pytanie o dodanie
  izolowanego projektu/test hosta, bez zmiany oryginalnego worktree i bez live providera.

## Kontekst

Publiczny accessibility traversal w SharedTests wykonał dwie metody w Xcode,
ale nie znalazł Close. To nie dowód błędu widoku. Istniejący target UITests
korzysta z jawnych wpisów project.pbxproj; samo dodanie Swift file nie tworzy
działającego test hosta. Nie wolno nadpisywać projektu kandydata w adapterze
ani przypisywać mu dowodu z niezwiązanego zewnętrznego projektu.

## Decyzja

1. `trusted_evaluator_inputs` otrzymuje opcjonalny discriminator
   `layout: "XCODE_UI_HARNESS_V1"`. Brak pola zachowuje dokładnie reguły
   Swift-only ADR-0026 oraz historyczne identity. Nie dodajemy default do
   dawnych danych ani nie migrujemy dawnych receipts.
2. Tryb UI wymaga jednego wspólnego rootu o postaci
   `[repo-relative-prefix/]Tests/RemoteAgentUIHarness`. W nim muszą istnieć
   cztery nowe wejścia:
   - `App/RemoteAgentUIHarnessApp.swift`;
   - `UITests/RemoteAgentUIHarnessUITests.swift`;
   - `RemoteAgentUIHarness.xcodeproj/project.pbxproj`;
   - `RemoteAgentUIHarness.xcodeproj/xcshareddata/xcschemes/RemoteAgentUIHarness.xcscheme`.
   Dodatkowe pliki mogą być wyłącznie Swift pod `App/` albo `UITests/` tego
   samego rootu, z jednym wyjątkiem: opcjonalny dokładny
   `RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
   Jest code-owned kopią lockfile referencyjnej aplikacji, z tymi samymi
   limitami/digestami i pełną ochroną przed zmianą. Nie dopuszczamy innych
   JSON ani ogólnych plist, shell scripts, Package.swift
   poza tymi katalogami ani zmian istniejących plików. Limity 16 plików,
   64 KiB/file, 256 KiB łącznie oraz 128 exact IDs pozostają bez zmian.
3. Każdy plik i discriminator są związane z input/command/catalog identity.
   Discriminator musi przetrwać parsing, transform i immutable catalog snapshot.
   Wszystkie dotychczasowe testy digestów, UTF-8, path/parent conflicts,
   symlinków, global ownership, exclusive create i protected-tree obowiązują
   także dla projektu i scheme. Kolizja oznacza odmowę, nie overwrite.
4. Gate nadal jest platform-managed Xcode TEST. W trybie UI ma dokładnie
   jeden `-project` wskazujący w odniesieniu do `relative_cwd` wstrzyknięty
   projekt, dokładnie jeden `-scheme RemoteAgentUIHarness`, bez `-workspace`.
   Required IDs należą do targetu `RemoteAgentUIHarnessUITests` i nadal mają
   dokładne `-only-testing:` selektory. Nie dopuszczamy aliasu przez `..`
   ani absolutnego project argumentu. Błąd tych powiązań jest preflight error.
5. Projekt, scheme i Swift są code-owned, przeglądanymi wejściami testu, nie
   outputem modelu. Rozszerzenie nie jest interpreterem semantyki dowolnego
   PBX projektu ani nową warstwą autoryzacji. Model nie może wybierać ich
   treści, targetu, executable ani dodatkowych uprawnień.
6. Harness ma własną aplikację i UI-test target, korzystające z produkcyjnego
   lokalnego package. Pierwsza kwalifikacja hostuje rzeczywisty SafetyAlert,
   naciska Close przez XCUIApplication i obserwuje callback/dismissal obu
   wariantów. Testowy host nie jest dowodem routingu oryginalnej aplikacji:
   full-flow, session interruption i inline suppression wymagają osobnych
   scenariuszy opartych na realnych produkcyjnych obiektach.
7. Authoritative tree i commit pozostają bez harnessu. Projekt istnieje tylko
   w augmented disposable tree objętym TestRun i receipt binding ADR-0026.
   Źródłowy checkout, poprzednie worktrees, frozen benchmark i ich zgody nie
   zmieniają się. Nie instalujemy nowych globalnych narzędzi/zależności.

## Weryfikacja i migracja

Najpierw parser/layout/argv i regresja legacy identity, potem rzeczywiste
exclusive installation/protected mutation dla projektu oraz scheme. Każdy
guard wymaga mutacji RED→restore/GREEN. Następnie prywatny harness, XCUITest
positive, odłączona akcja RED i restoration GREEN z identycznymi wejściami.
Exit code bez obu executed test IDs nie wystarcza. Full gate poprzedza odbiór.

Rollback: usunąć capability z nowego katalogu i odmówić jego wykonania;
nie rekonstruować receipt UI jako legacy. Wyłączenie nowego trybu nie zmienia
istniejących konfiguracji Swift-only. Nowy provider live nadal wymaga osobnego
dokładnego opt-in; ten ADR go nie autoryzuje.

## Doprecyzowanie po rzeczywistym buildzie — 2026-09-08

Pierwszy build osobnego projektu rozwiązał nowszy Iterable niż aplikacja
referencyjna i nie skompilował jej Utilities (async/throws API); 0 testów UI.
Zamiast modyfikować aplikację lub podmieniać bibliotekę w kodzie, dopuszczamy
wyżej jeden dokładny lockfile w izolowanym projekcie. Harness kopiuje istniejący
app Package.resolved jako chronione wejście i wymusza użycie zapisanych wersji.
Nie zmienia source Package.swift, starego lockfile, frozen benchmark ani
uprawnień. Czteroplikowe wejścia pozostają poprawne i zachowują identity;
nowy lockfile wpływa na digest wyłącznie po jawnym dołączeniu do wejść.

Kolejna diagnostyka ujawniła crash Xcode przy nadmiarowych pins. Dopuszczona
projekcja kopii referencyjnego lockfile usuwa wyłącznie trzy ustalone test-only
identities: `nimble`, `cwlcatchexception`, `cwlpreconditiontesting`. Użycie
Nimble jest w test targets lokalnych manifestów; rzeczywisty rozwiązany graf
harnessu (przebieg EUvjZa) zawiera 56 remote packages, bez tych trzech.
Wszystkie 56 zachowanych pins mają niezmienione version/revision/location;
oryginał 59 pins pozostaje nietknięty. Projekcja jest code-owned i związana
digestem wejścia, z zapisem provenance source/derived hash; nie jest zgodą
na dobieranie innych wersji lub automatyczne pomijanie kolejnych zależności.
Diagnoza jest hipotezą do sprawdzenia, nie dowodem udanego builda. Pasujące
zgłoszenie: https://developer.apple.com/forums/thread/773478.
