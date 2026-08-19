# ADR-0003 — Sol koordynuje, lokalny Qwen implementuje

- Status: Accepted
- Date: 2026-08-19
- Scope: workflow budowy RemoteAgent, nie role runtime produktu

## Kontekst

Budowa RemoteAgent wymaga mocnego planowania i niezależnego audytu, ale długie
iteracje implementacyjne nie powinny zużywać ograniczonego budżetu zdalnego
modelu. Lokalny `Qwen3.8-27B-oQ6e-mtp` jest dostępny bez kosztu tokenowego, lecz
ma okno kontekstu `65,536`, maksymalny output `16,384` i concurrency `1`.
Przekazanie mu całego makro-taska wraz z historią repo prowadzi do przeciążenia
kontekstu i osłabia kontrolę zakresu.

## Decyzja

- Stabilna rola `COORDINATOR_AUDITOR` należy do Sol. Sol wybiera task, podejmuje
  decyzje projektowe, rozpisuje work units, przygotowuje context pack, kontroluje
  diff, uruchamia niezależne testy i wydaje końcowy werdykt audytu.
- Stabilna rola `LOCAL_IMPLEMENTER` należy obecnie do
  `Qwen3.8-27B-oQ6e-mtp`. Qwen implementuje dokładnie jeden work unit na nową
  sesję i nie planuje ani nie audytuje.
- Domyślnym transportem Qwena jest oMLX z Codex CLI:
  `omlx launch codex --model Qwen3.8-27B-oQ6e-mtp`. Codex zapewnia procesowe
  wskazanie providera, headless `exec`, sandbox, ephemeryczne sesje i JSONL.
- Model identities pozostają konfiguracją. Zmiana modelu nie może zmienić
  odpowiedzialności ról ani wymagać przebudowy tasków.
- Makro-task z `TASK_INDEX.md` jest jednostką zależności i końcowego audytu.
  Jednostką wykonania Qwena jest mały work unit zapisany przez Sol w
  `docs/work-units/<TASK_ID>/WORK_UNITS.md`.
- Sol używa Qwena do wszystkich zmian kodu produktowego i fixów. Nie przejmuje
  implementacji bez jawnego wyjątku właściciela.
- Audyty i granice makro-tasków są obowiązkowymi bramkami jakości, ale nie
  punktami pauzy. Po `PASS` Sol zamyka task i automatycznie rozpoczyna następny;
  przebieg trwa do polecenia pauzy, Decision Request albo realnej blokady.

## Limity work unit

- jeden rezultat, maksymalnie trzy kryteria akceptacji;
- domyślnie nie więcej niż pięć dozwolonych plików razem z testami;
- context pack poniżej 24k tokenów;
- jedna celowana komenda weryfikacyjna;
- jedna ephemeryczna sesja, bez automatycznego kontynuowania historii;
- brak remote writes, commitów i edycji artefaktów workflow przez Qwena.

## Niezależność audytu

Raport i zielony test uruchomiony przez Qwena są wskazówką, nie dowodem
końcowym. Sol czyta pełny diff od bazowego stanu, uruchamia test ponownie i
sprawdza kryteria taska bez proszenia Qwena o ocenę własnej pracy. Findingi Sol
stają się osobnymi fix work units.

## Alternatywy

- **OpenCode przez oMLX:** działa jako lokalny klient, ale do tego workflow ma
  mniej bezpośredni kontrakt sandbox/headless niż Codex CLI. Pozostaje fallbackiem
  po jawnej decyzji, nie domyślnym transportem.
- **Sol implementuje bezpośrednio:** odrzucone jako domyślny tryb; zużywa
  ograniczony budżet i łączy implementację z audytem.
- **Jeden Qwen run na cały task:** odrzucone z powodu okna 65k, ryzyka dryfu
  zakresu i trudniejszego recovery.

## Konsekwencje

- Każdy rozpoczynany makro-task musi mieć plan małych work units.
- Kolejne units są wykonywane sekwencyjnie i dopiero po akceptacji poprzedniego.
- Awaria Qwena zatrzymuje implementację, ale nie traci planu ani stanu taska.
- Role produktu opisane w `MASTER_PLAN.md` pozostają model-neutralne; ten ADR
  dotyczy wyłącznie procesu budowy repozytorium.

## Rollback

Można zmienić transport albo model implementera przez konfigurację po smoke
teście. Powrót do innego workflow wymaga nowego ADR, ponieważ zmienia
niezależność audytu i własność artefaktów.
