# ADR-0030 — kontrolowany pilot Engineering, oddzielony od jakości MOBL-2023

- Status: `ACCEPTED`
- Data: `2026-09-14`
- Task: `RA-055`
- Decyzja właściciela: wykonać przedstawiony plan pilota bez kolejnych pauz na potwierdzenie.

## Cel i granice

Właściciel chce zacząć samodzielnie testować Engineering i ulepszać go na
podstawie logów kolejnych prób. Gotowość ograniczonego pilota nie wymaga
idealnego wykonania dotychczasowego zadania iOS. Nie zmieniamy historycznych
wyników, nie ogłaszamy MOBL-2023 zakończonym i nie osłabiamy jego evaluatorów.
Pierwotne kryteria zamknięcia RA-055 pozostają odrębne od bramki pilota.

Pilot używa tego samego produkcyjnego SupervisorRuntime, stage executor,
izolowanych worktree, gate receipts, review i GitLifecycle. Nie powstaje drugi
orchestrator ani bezpośredni nieograniczony model writer. Dozwolony pierwszy
smoke ma niewielkie, deterministycznie sprawdzalne zadanie w osobnym lokalnym
repozytorium testowym, bez Xcode i bez modyfikacji SonderMind. Wybór tego smoke
jest realizacją zaakceptowanego planu, nie zamianą benchmarku iOS na pozorny PASS.

## Bramka zielonego światła

1. Co najmniej jeden rzeczywisty przebieg: opis, design, implementacja,
   rzeczywiste testy, niezależne review, final verification i dokładnie jeden
   lokalny commit z receiptem. Nie wolno wstrzykiwać gotowej odpowiedzi modelu.
2. Zatrzymanie, odmowa przekroczenia scope, błędy narzędzi i budżet mają
   niezależne testy z mutation checks. Nieznane wyniki pozostają nieznane.
3. Każde wywołanie ma osobny journal i czytelne podsumowanie, także po błędzie;
   etapy, zdarzenia, czas, usage, gates i identyfikatory wyniku bez sekretów,
   raw promptów, model prose i chain-of-thought. Brak usage nie oznacza zera.
4. Użytkownik dostaje uruchamialną instrukcję opisu zadania, obserwacji wyniku,
   zatrzymania i odczytania raportu. Jedno zadanie naraz, izolowany worktree,
   brak push/MR/merge i integracji zewnętrznych.
5. Pełna niecache'owana bramka repozytorium zakończona exit 0. Gotowość pilota
   nie jest deklaracją niezawodności autonomicznej pracy ani końcowym PASS RA-055.

## Budżet i logowanie

Transport przed dispatch uwzględnia pełny serializowalny request (messages,
tools i output schema). Rezerwa nie może być mniejsza od istniejącego progu
roli/korekty. Konserwatywny szacunek wejścia oparty na UTF-8 bytes i rezerwa
odpowiedzi są jawnie szacunkami: provider dodaje własny kontekst i raportuje
usage po odpowiedzi, więc nie deklarujemy matematycznej gwarancji hard cap.
Po przekroczeniu raportowanego zużycia nadal nie wolno wykonać proposed tools
ani zamienić tego w sukces przez receipt-backed finalization. Bez zwiększania
limitów 750k/1.2M/1.8M ani fallbacku providera.

## Uprawnienia i recovery

Codex przez istniejącą subskrypcję, jawne dotychczasowe role; bez Bedrock,
OpenCode i API key. Nowy lokalny wynik i commit pozostają do inspekcji.
Żadnego usuwania starych worktree ani obniżania progu 40 GiB dla Xcode.
Mały smoke bez Xcode ma własne jawne wymagania zasobowe i nie kwalifikuje iOS.
Brak loginu, quota lub zasobów blokuje live, nigdy nie uzasadnia fake evidence.
