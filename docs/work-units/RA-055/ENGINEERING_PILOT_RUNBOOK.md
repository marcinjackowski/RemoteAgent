# Engineering — kontrolowany pilot lokalny

Status: **gotowy do kontrolowanego pilota Node**, 2026-09-15. LIVE07 zakończył
pełną produkcyjną ścieżkę z rzeczywistym modelem i lokalnym commitem; primary
niezależnie zweryfikował receipts, Git oraz testy w sandboxie (exit 0).
To nie jest PASS całego RA-055 ani kwalifikacja SonderMind/Xcode. ADR-0030.

## Potwierdzony wynik i koszt

- Run: `run_9cf5c936-a393-4e2d-92a0-c0829c8096be`.
- Commit: `0515c519e5a8d41335df5588c7f3c843ae9b0184`, zachowany lokalnie.
- Rzeczywisty gate exit 0, review PASS, final verification VERIFIED.
- 128826 tokenów providera, 9 odpowiedzi, 111.266 s; wszystkie role
  `gpt-5.6-sol` przez istniejącą subskrypcję Codex. Bez API key/fallbacku.
- Szacunek przed próbą: 100000–300000 tokenów. Wynik mieści się w przedziale;
  to koszt całego wieloetapowego Loop, nie pojedynczego napisania funkcji.
- Cała kwalifikacja: **687053 tokeny / 7 prób / 1 ukończone zadanie**.
  Próby 01–03 używały pierwotnego opisu, 04–07 poprawionego `task-v2.md`.
  Nie traktować tego jako pomiaru niezawodności stałej wersji ani dopisywać
  historycznej kampanii iOS do tych liczb.
- Pełna bramka repo: 3846 testów passed / 2 jawne opt-in live skipped,
  273 pliki passed, 241.13 s; build 29 i typecheck 46 bez cache, exit 0.
  Komenda i log: najnowszy checkpoint w WORK_UNITS.md.

Wszystkie dane są zachowane pod:
`/Users/marcinjackowski/.remoteagent/engineering-pilot-smoke-Ph1BPS`.
Wynik: `runs/pilot-live-07/result.json`.
Podsumowanie: `artifacts/engineering-debug/engineering-e591624df7677c290bef27276dd000d6970ba17bd469a1729608f79339b8933b.summary.md`.
Niezależna kontrola: `pilot-live-07-primary-verification.log`.

Obejrzenie rzeczywistej zmiany:

```sh
git -C /Users/marcinjackowski/.remoteagent/engineering-pilot-smoke-Ph1BPS/workspaces/case_0f2e8d2c-a580-4ecd-9614-1fcc73d6edb0/engineering-42bc92e9523a3d308b40ff7e244dbfa4 show 0515c519e5a8d41335df5588c7f3c843ae9b0184
```

## Powtórzenie zakwalifikowanego smoke'a

Poniższa komenda tworzy nowy lokalny przebieg i może utworzyć nowy commit.
Uruchamiaj świadomie; katalog `manual-01` musi jeszcze nie istnieć.
Oryginalny seed pozostaje celowo błędny i czysty — pozwala porównywać próby.

```sh
. scripts/dev/env.sh
pnpm engineering:pilot run \
  --config=/Users/marcinjackowski/.remoteagent/engineering-pilot-smoke-Ph1BPS/engineering.json \
  --models=/Users/marcinjackowski/.remoteagent/live-mobl-2023/models-codex.json \
  --task-file=/Users/marcinjackowski/.remoteagent/engineering-pilot-smoke-Ph1BPS/task-v2.md \
  --run-dir=/Users/marcinjackowski/.remoteagent/engineering-pilot-smoke-Ph1BPS/runs/manual-01 \
  --approve-local-write
```

Dla nowego zadania przygotuj osobny opis i adekwatną konfigurację repo,
dozwolonych plików oraz rzeczywistych testów. Sam opis nie aktualizuje scope.
Nie podmieniaj tylko task.md, pozostawiając oracle sprawdzający poprzednie
zadanie. Gdy wymagany jest test-first, opis musi zezwalać na odpowiedni test;
nie używaj pierwotnego source-only task.md z tej kampanii.

## Granice pierwszej wersji

Jedno niewielkie zadanie naraz, osobny lokalny worktree, jawne testy Node,
niezależne review i final verification przed lokalnym commitem. Bez push,
Jira/Discord network, Bedrock, OpenCode i API key. Konfiguracja i katalog
testów pochodzą od operatora; opis zadania nie nadaje uprawnień.

Ta wersja pilota nie kwalifikuje jeszcze zadania SonderMind ani Xcode.
Nie należy podstawiać do poniższej komendy konfiguracji iOS: obowiązują tam
osobne wymagania i niezmieniony preflight zasobów.

## Uruchomienie

Z katalogu RemoteAgent, po przygotowaniu kontrolowanej konfiguracji repozytorium
i istniejącego profilu modeli zalogowanych subskrypcją:

```sh
. scripts/dev/env.sh
pnpm engineering:pilot run \
  --config=/absolute/path/engineering.json \
  --models=/absolute/path/models.json \
  --task-file=/absolute/path/task.md \
  --run-dir=/absolute/path/new-run-directory \
  --approve-local-write
```

Opcje przyjmują zapis `--klucz=wartość`. `--approve-local-write` jest flagą.
Każdy przebieg wymaga nowego katalogu `--run-dir`; nie nadpisuj poprzedniego.
Źródłowy checkout musi być czysty. Zachowaj plik zadania i konfigurację
niezmienione podczas przebiegu.

`task.md` powinien zawierać cel, konkretne kryteria akceptacji oraz wyłączenia
zakresu. Nie wklejaj kluczy ani danych osobowych. Przykład małego zadania:
naprawić funkcję ograniczającą liczbę do przedziału, zachować sygnaturę,
obsłużyć odwrócone granice zgodnie z wymaganiem, nie zmieniać innych modułów.

## Obserwacja i zatrzymanie

Po nadaniu zgody runtime zapisuje prawdziwy `run_id` w prywatnym `run.json`.
W drugim terminalu:

```sh
. scripts/dev/env.sh
pnpm engineering:pilot status \
  --run-dir=/absolute/path/run-directory \
  --run-id=VALUE_FROM_RUN_JSON

pnpm engineering:pilot stop \
  --run-dir=/absolute/path/run-directory \
  --run-id=VALUE_FROM_RUN_JSON
```

Stop jest trwałym żądaniem anulowania sprawdzanym przez runtime, nie obietnicą
natychmiastowego przerwania trwającej odpowiedzi providera. Nie usuwaj bazy ani
worktree podczas działania. Nie uruchamiaj automatycznie nowej próby po błędzie.

## Wynik i diagnostyka

Znane ograniczenie prezentacji: końcowy `Final checklist` w summary może
zachować wcześniejsze `PENDING`, nawet dla review/commita wykonanego później.
Także `status` może pokazywać `UNPROJECTED` przy końcowym `LOCAL_COMMIT`.
Nie używaj tych pól jako werdyktu. Sprawdzaj `result.json`, sekcje gates/review,
końcowe `VERIFIED` i dokładny `LocalCommitReceipt`; LIVE07 został dodatkowo
sprawdzony niezależnie względem Git. To znany temat do poprawy prezentacji logów,
nie brak wykonanego commita. Nazwa commita jest obecnie ogólna.

Licznik `Campaign usage` pojedynczego journala nie sumuje automatycznie
osobnych pilotowych runów. Powyższe 687053 jest sumą siedmiu zachowanych
summary. Brak kolejnych powtórzeń zielonej wersji oznacza brak oszacowania
jej niezawodności. Zbieraj nowe wyniki bez zakładania, że każda próba się uda.

- `allocation.json`: identyfikacja prywatnej bazy, także przy niepełnym setupie.
- `run.json`: tożsamość nadanego przebiegu i lokalizacje zachowanych danych.
- `result.json`: końcowy wynik; tylko zweryfikowany commit może dać COMPLETED.
- `artifact_root/engineering-debug/`: osobny journal zdarzeń i podsumowanie
  wywołania. Zawierają etapy, outcomes, testy, czas i usage, nie ukryty tok
  rozumowania ani surowe prompty.

Sam exit code komendy, zielony pojedynczy test lub odpowiedź modelu nie są
dowodem ukończenia. Sukces wymaga powiązanych receipts oraz obserwacji Git:
rzeczywisty commit na właściwej gałęzi, poprawny rodzic, czyste worktree i
zgodny digest. Zachowany commit można obejrzeć przez `git show` w worktree.

Usage raportowane przez providera jest wynikiem pomiaru. Rezerwa przed
wywołaniem jest estymatą, a brak usage nie oznacza zera. Do porównań prób
zapisuj co najmniej: wynik, model każdej roli, sumę tokenów, czas, liczbę
korekt oraz etap zatrzymania. Nie porównuj kosztu małego zadania Node bezpośrednio
z historycznym przebiegiem Xcode.
