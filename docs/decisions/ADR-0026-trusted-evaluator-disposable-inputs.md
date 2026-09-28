# ADR-0026 — niezależne wejścia testowe w disposable workspace

- Status: `ACCEPTED`
- Data: `2026-09-08`
- Task: `RA-055`
- Uzupełnia: `ADR-0025`

## Kontekst

Test napisany przez implementera nie jest niezależnym evaluator-em. Włożenie
niezmiennych testów dopiero w adapterze zmienia tested tree już po ustaleniu
jego identity. Oznaczenie takich plików jako mutable outputs wyłączałoby ich
ochronę. Potrzebujemy jawnego związania kandydata z dodatkowym wejściem testu,
bez zmiany źródeł, historycznych receipts i identity finalnego commita.

## Decyzja

1. Dodatkowe wejście jest opcjonalną, server-owned capability katalogu gate,
   nie argumentem narzędzia modelu. Bez tej capability dotychczasowe zachowanie
   i identity pozostają niezmienione. Nie podłączamy synthetic trace do PASS.
2. Wejście zawiera dokładne względne ścieżki nowych plików, tekst UTF-8,
   SHA-256 treści oraz wymagane pełne IDs wykonanych testów. Maksymalnie
   16 plików, 256 KiB łącznie, 64 KiB na plik i 128 IDs. Pliki tego pierwszego
   wariantu są `.swift` pod konwencjonalnym `Tests/`; gate jest Xcode TEST
   (`BUILD_TOOLCHAIN` / `PLATFORM_MANAGED`). Bez host paths i pobierania kodu.
3. Ścieżki nie mogą kolidować z istniejącym plikiem, symlinkiem, mutable output,
   required mutation/test path ani innym plikiem wejścia. Model nie dostaje
   dodatkowego write scope; kolizja kandydata z zarezerwowanym plikiem kończy
   gate jako INFRASTRUCTURE, nigdy overwrite ani pozorny PASS.
4. `runInDisposableWorkspace` najpierw dowodzi dokładnej kopii kandydata,
   następnie instaluje zwalidowane wejście do tej kopii, przed baseline
   protected inventory i przed wywołaniem runnera. Te pliki są chronione
   podczas całego testu, nie mutable outputs. Bezpieczne sprawdzenie rodziców,
   exclusive create, zakaz symlinków i digest verification są obowiązkowe.
5. `TestRun.tree_digest_before` jest prawdziwym digestem augmented tree.
   Boundary wylicza go niezależnie od runnera i waliduje TestRun względem niego.
   Nie przepisuje go na digest źródła. Authoritative tree pozostaje niezmienne.
6. `VerificationGateReceipt.tree_digest` nadal identyfikuje kandydata.
   Opcjonalne `trusted_evaluator_binding` zachowuje osobno digest wejścia oraz
   augmented tree. Complete wykonanie wymaga zgodności obu, protected boundary
   i rzeczywistych wymaganych IDs w xcresult. Infrastrukturalna odmowa przed
   uruchomieniem nie może twierdzić, że augmented tree wykonano.
7. Manifest i command digest obejmują nowe wejście. Receipt ID obejmuje binding.
   Walidacja agregatu i durable recovery sprawdzają zgodność binding z katalogiem
   i IDs, nie tylko obecność pola. Legacy receipts i operacje bez capability
   zachowują swoje dotychczasowe canonical identity; nowe pola są opcjonalne,
   bez default dodawanego do historycznych danych. Nie migrujemy dawnych wyników
   w kwalifikację niezależnego evaluator-a.
8. Testów nie dodajemy do authoritative worktree ani commita. Usuwana jest
   wyłącznie utworzona przez boundary disposable copy. Historyczne worktrees,
   frozen benchmark i jego zgody pozostają nietknięte. Nowy benchmark wymaga
   osobnego dokładnego opt-in przed provider live.

## Sekwencja i dowód

Najpierw bounded primitive instalacji i testy ochrony oraz unchanged source.
Następnie katalog, wykonanie, receipt binding i recovery. Potem integracja
Xcode z exact IDs i prywatne niezależne testy wywołujące produkcyjne API.
Nie deklarować capability gotowej po samym helperze albo samym parserze.

Wymagane RED/restore/GREEN: zły content digest, kolizja, symlink escape,
mutacja evaluator-a przez runner, podmiana augmented digest, brak binding,
receipt replay z innym wejściem, brak wykonanej metody. Zachować pozytywne
legacy recovery, dokładną kopię bez wejścia i prawdziwy assertion failure.
Pełna bramka RA-055 i focused Xcode poprzedzają kwalifikację; ten dokument
jest decyzją implementacyjną, nie wynikiem testu ani zgodą na live.
