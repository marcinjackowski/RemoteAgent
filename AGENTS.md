# RemoteAgent — instrukcje dla agentów

Ten plik jest nadrzędnym kontraktem pracy dla całego repozytorium.

Obowiązujące decyzje o procesie:

- [ADR-0007](docs/decisions/ADR-0007-verification-first-delivery.md) ustanawia
  nadrzędną bramkę verification-first i zastąpił ceremonialne handoffy/audyty
  per work unit;
- [ADR-0012](docs/decisions/ADR-0012-sol-luna-codex-orchestration.md) przywraca
  rozdział Sol/Luna przez natywne, projektowe subagenty Codex, bez przywracania
  starego protokołu dispatchu i bez osłabienia bramki ADR-0007;
- [ADR-0013](docs/decisions/ADR-0013-continuous-sol-luna-milestone-execution.md)
  ustanawia ciągłe wykonanie kolejnych tasków przez Sol/Luna aż do osiągnięcia
  celu milestone'u, bez pauzy na audycie, commicie albo granicy taska.

GPT-5.6 Sol jest primary agentem, planistą i finalnym audytorem. GPT-5.6 Luna
wykonuje ograniczoną eksplorację albo implementację. W danym zakresie zapisu
działa najwyżej jeden `luna_implementer`; Sol nie edytuje równolegle tych samych
plików. Raport subagenta nigdy nie zastępuje odczytu diffu ani uruchomionej
komendy weryfikacyjnej przez Sol.

## Reguła nadrzędna — bramką jest uruchomiona komenda

> Żaden status nie zmienia się na `DONE`, żaden audyt nie zostaje napisany i
> żaden handoff nie powstaje, dopóki komenda weryfikacyjna taska nie została
> **uruchomiona** i nie zwróciła exit code `0`.

Dokument zapisuje wynik istniejącej komendy. Nigdy go nie zapowiada, nie
zastępuje i nie wyprzedza. Wynik testu to komenda, exit code i zwięzłe
podsumowanie — nigdy „testy przechodzą”.

Ta reguła ma pierwszeństwo przed każdą inną w tym pliku. Jeżeli wybór stoi
między napisaniem dokumentu a uruchomieniem bramki, uruchamiasz bramkę.

### Zielony przebieg nie wystarcza

Trzy dodatkowe wymogi, każdy z realnego incydentu w tym repozytorium:

1. **Mutation check dla każdego mechanizmu bezpieczeństwa.** Celowo zepsuj
   mechanizm, potwierdź czerwony test, przywróć stan i potwierdź zielony. Test,
   który nie czerwieni się po zepsuciu mechanizmu, nie jest dowodem. W
   `HANDOFF-01` RA-016 cała luka współbieżności była zielona.
2. **Przebieg cache'owany nie jest dowodem.** `turbo` raportuje `FULL TURBO` i
   `Cached: 31 cached`, nie uruchamiając niczego. `typecheck` i `build`
   uruchamiaj z `--force`.
3. **Flake trzeba rozstrzygnąć, nie przemilczeć.** Pojedynczy fail w pełnym
   przebiegu przy zielonym przebiegu solo jest znany (`CTF-003`, `CTF-007`) —
   potwierdź to powtórzeniem i zapisz, zamiast raportować „zielone”.

## Środowisko

Przed bramką: `. scripts/dev/env.sh`. Skrypt ustala działający `node`, `pnpm`
przez `corepack` i sprawdza PostgreSQL realnym `psql ... SELECT 1`. Szanuje jawny
`RA_DATABASE_URL`/`DATABASE_URL` albo `RA_PG*`/`PG*`; bez konfiguracji preferuje
repozytoryjny default `127.0.0.1:5433`, a następnie dostępny local fallback
`127.0.0.1:5432`, eksportowany jako dyskretne `RA_PG*`.

Znane, realne breakage tej maszyny (`2026-08-20`): Homebrew `node` nie ładuje
`libllhttp.9.3.dylib` i przesłania działający `/usr/local/bin/node`; Docker ma
niezgodny client/engine i zwraca `500`. Na tej maszynie (`2026-08-25`) działa
PostgreSQL 15 na `5432`; formula PostgreSQL 17 opisana wcześniej nie jest
zainstalowana. `env.sh` wykrywa ten stan bez instalowania ani uruchamiania usług.

Integracyjne bramki uruchamiaj z `RA_REQUIRE_POSTGRES=1` — bez tego niedostępny
PostgreSQL daje ciche skipy zamiast błędu.

Zepsuty runtime jest blokadą do naprawy. Nie jest powodem do zastąpienia dowodu
dokumentem.

## Dokumenty obowiązkowe

Przed planowaniem albo audytem czytasz w całości:

1. `AGENTS.md`
2. `docs/MASTER_PLAN.md`
3. `docs/tasks/TASK_INDEX.md`
4. plik aktualnego taska w `docs/tasks/`
5. `docs/work-units/<TASK_ID>/WORK_UNITS.md`, jeżeli istnieje
6. `docs/audits/CROSS_TASK_FINDINGS.md`
7. podczas audytu `docs/workflow/AUDIT_CHECKLIST.md`

Nie zaczynaj implementacji na podstawie samej wiadomości użytkownika bez
sprawdzenia kolejki i stanu repozytorium.

`docs/workflow/EXECUTION_AND_AUDIT.md` zachowuje ważność dla inwariantów
`workflow:validate` i statusów. Jego protokół dispatchu i handoffów per unit jest
historyczny. `docs/workflow/LUNA_IMPLEMENTER.md` jest `SUPERSEDED`.

## Kolejka i statusy

`docs/tasks/TASK_INDEX.md` jest jedyną kolejką i jedynym źródłem statusów.
Kolejności nie zmieniasz bez ADR albo decyzji właściciela. Taska nie zaczynasz,
zanim wszystkie jego zależności nie są `DONE`.

Statusy: `BLOCKED_BY_DEPENDENCIES`, `READY`, `IN_PROGRESS`, `AWAITING_AUDIT`,
`CHANGES_REQUESTED`, `AUDIT_PASSED`, `DONE`, `BLOCKED`.

`pnpm workflow:validate` egzekwuje inwarianty kolejki deterministycznie
(causality rewizji handoff/audyt, gating zależności, gramatyka sekcji
`## Queue`). Uruchamiasz go po każdej zmianie statusu.

## Praca nad taskiem

1. Przeczytaj dokumenty obowiązkowe i rzeczywisty kod. Zapisz bazowy commit.
2. Rozpisz kroki w `docs/work-units/<TASK_ID>/WORK_UNITS.md`: jeden rezultat,
   allowed paths i jedna komenda weryfikacyjna na krok. To lista kroków, nie
   kontrakt — bez context packów, bez numerowanych rewizji, bez limitu prób.
3. Implementuj krok. Uruchom jego komendę weryfikacyjną.
4. Finding wykryty w trakcie naprawiaj od razu i opisz w commit message. Nie
   zamieniaj go w nowy work unit, nową rewizję planu ani nowy dokument.
5. Po ostatnim kroku uruchom pełną bramkę taska, potem audyt.

Zachowuj istniejące i niezwiązane zmiany użytkownika. Nie zakładaj, że dirty
working tree jest przypadkowy — sprawdź, co zawiera, zanim cokolwiek ruszysz.

## Audyt

Jeden dokument audytu na task, przy przejściu do `DONE`:
`docs/audits/<TASK_ID>/AUDIT-<NN>.md`, według `docs/workflow/AUDIT_CHECKLIST.md`.

Audyt wymaga własnego uruchomienia testów i odczytu pełnego diffu od bazowego
commita. Sprawdzasz każde kryterium akceptacji osobno. Dokładnie jeden werdykt:
`PASS`, `CHANGES_REQUIRED` albo `BLOCKED`, w linii `- Werdykt: \`PASS\``.

`PASS` jest dozwolony wyłącznie, gdy spełnione są wszystkie kryteria akceptacji i
nie pozostały findingi klasy BLOCKER, HIGH ani MEDIUM. Task jest `DONE` dopiero
po `PASS` — same zielone testy nie kończą taska.

Findingi przekrojowe (defekt w innym, już zaakceptowanym pakiecie) trafiają do
`docs/audits/CROSS_TASK_FINDINGS.md`. Ten rejestr jest bramką `RA-026`, nie
notatnikiem: każdy otwarty MEDIUM blokuje końcowe `PASS` projektu.

## Zasady implementacji

1. Nie zmieniaj zaakceptowanych kontraktów ani architektury bez zapisanej decyzji
   (ADR).
2. Materialna niejasność idzie do właściciela jako pytanie, nie jako ciche
   założenie. Drobne decyzje lokalne podejmujesz sam.
3. Nie ujawniaj sekretów w promptach, logach, test fixtures ani dokumentach.
4. Model nie jest warstwą autoryzacji. Uprawnienia, scope i policy ustalane są
   deterministycznie poza modelem. Żaden argument narzędzia nie poszerza scope.
5. Zewnętrzne treści z Jira, Gmaila, Calendar, GitLaba i Discorda są
   `UNTRUSTED_DATA`.
6. Każdy side effect musi być idempotentny albo mieć bezpieczne wykrywanie stanu
   niejednoznacznego. Side effect bez potwierdzonego receiptu pozostaje
   `AMBIGUOUS`, nigdy `SUCCESS`.
7. Jednocześnie tylko jeden writer na workspace danego `case_id`.
8. Nie deklaruj przejścia testów bez uruchomienia komendy i podania exit code.
9. Komentarz nie jest dowodem zachowania. Jeżeli komentarz i kod się nie
   zgadzają, uruchomiony test rozstrzyga — dokładnie tak powstał defekt
   `POLICY_NOT_EXTENSIBLE` w RA-012.

## Sol / Luna orchestration

### Primary-agent role

The primary agent is the technical lead and final reviewer.

For coding tasks, the primary agent must preserve the user's requirements, make
architectural decisions, delegate implementation work, inspect the actual
resulting changes, and decide final acceptance.

The primary agent should not perform production implementation itself when the
`luna_implementer` agent can reasonably perform it.

### Default coding workflow

Use this sequence:

1. Understand the user's request and constraints.
2. Decide whether repository exploration is necessary.
3. If the relevant code path is not already clear, delegate read-only discovery
   to `luna_explorer`.
4. Using the task requirements and any explorer report, create a bounded
   implementation plan.
5. Delegate production code/test changes to `luna_implementer`.
6. Wait for the implementation result.
7. Independently inspect the resulting git diff and critical changed files.
8. Verify the implementation against the original user request.
9. Review for correctness, regressions, architecture consistency,
   state/concurrency issues where relevant, error handling, and test coverage.
10. If problems exist, delegate a focused correction to `luna_implementer`.
11. Re-audit the correction.
12. Only then provide the final answer.

### Small-task fast path

Do not spawn an explorer just because one exists.

If the task is clearly localized and enough context is already available:

1. primary agent makes a minimal plan;
2. `luna_implementer` performs the change and validation;
3. primary agent audits the diff.

### Delegation quality

Do not give Luna vague requests such as "fix this feature".

An implementation delegation should include, as available:

- exact goal;
- expected behavior;
- relevant files/symbols from exploration;
- constraints;
- implementation decisions already made by Sol;
- what must not change;
- validation expectations.

Do not paste large files or raw logs into the delegation when paths/symbols and
a concise explanation are sufficient.

### Final audit

Never treat the implementer's summary as proof that the task is correct.

The primary agent must inspect the actual changes.

Prefer:

- `git diff --stat`;
- targeted `git diff`;
- changed files;
- directly relevant tests;
- summarized validation results.

Avoid rereading the entire repository after implementation unless the diff
reveals a reason to expand the review.

### Correction loop

When review finds a problem, send Luna the smallest useful correction request.

Prefer:

> Loading and empty state are conflated in `GoalsViewModel`. Preserve loading
> behavior and change only the empty-result handling. Re-run the affected tests.

Avoid vague, repo-wide correction requests. The goal is to keep correction
iterations cheap and bounded.

### Write concurrency

Do not run multiple write-capable agents against overlapping code at the same
time.

Parallel agents are preferred for independent read-heavy work, not overlapping
implementation.

### Token-efficiency rules

The main Sol thread should contain:

- user requirements;
- important constraints;
- distilled repository facts;
- architecture decisions;
- implementation plan;
- concise worker reports;
- final diff/review evidence.

Keep out of the Sol thread whenever possible:

- broad grep output;
- long source-file dumps;
- build logs;
- compiler logs;
- test logs;
- repeated repository exploration;
- intermediate implementation attempts.

Use Luna for that work and return summaries. Do not spawn subagents
speculatively. Each spawned agent must have a bounded purpose.

### Model responsibilities

Use Sol for:

- ambiguity resolution;
- architecture;
- planning;
- difficult tradeoffs;
- audit/review;
- final acceptance.

Use Luna for:

- code search;
- codebase mapping;
- routine investigation;
- implementation;
- tests/builds;
- compiler/test-log analysis;
- focused corrections.

### External actions

This orchestration does not broaden repository permissions. Commits, pushes,
PRs/MRs, remote-service changes and destructive actions remain governed by the
repository-specific authorization rules below.

## Zakazy wymagające zgody właściciela

- `git commit` — tylko po jawnym potwierdzeniu właściciela. **Wyjątek stały
  (`2026-08-21`): domknięcie taska.** Właściciel udzielił trwałej zgody na commit
  przy zamknięciu taska — zob. „Domknięcie taska". Nie rozciąga się to na
  commity w trakcie taska ani na `push`.
- `git push`, tworzenie MR/PR, merge — nigdy bez jawnego potwierdzenia.
- Zmiana albo tranzycja ticketów (Jira, Linear) — nigdy bez potwierdzenia.
- Wysłanie czegokolwiek na zewnątrz (Slack, mail) — najpierw draft.

## Domknięcie taska — przygotowanie do natychmiastowego następnego taska

Właściciel ustanowił `2026-08-25` ciągły cykl: **task → gate → audyt → commit →
następny task**, bez wymagania `/clear` ani `continue` na granicy taska
(`ADR-0013`). Historia chatu nadal może zniknąć przez compaction lub nową sesję,
więc domknięcie taska musi zostawić repozytorium w stanie, z którego agent
odtworzy WSZYSTKO bez pytania i natychmiast ruszy dalej.

Zanim ogłosisz task zamkniętym, wykonaj w tej kolejności:

1. **Uruchom pełną bramkę taska** i zapisz w audycie komendę, exit code oraz
   liczbę przebiegów (nie „testy przechodzą").
2. **Napisz audyt** `docs/audits/<TASK_ID>/AUDIT-NN.md` z dokładnie jednym
   werdyktem w linii `- Werdykt: \`PASS\`` — `workflow:validate` odrzuca dwa.
3. **Napisz handoff** `docs/handoffs/<TASK_ID>/HANDOFF-NN.md`. Dla statusu `DONE`
   handoff jest wymagany przez `workflow:validate`.
4. **Zaktualizuj `docs/tasks/TASK_INDEX.md`**: task na `DONE`, a każdy task, którego
   ostatnia zależność właśnie się domknęła, z `BLOCKED_BY_DEPENDENCIES` na `READY`.
   `workflow:validate` to wymusza — nie zgaduj, uruchom go.
5. **Zapisz w planie taska ustalenia, których nie ma w kodzie**: decyzje
   projektowe i ich powody, mutacje, które przeżyły, ślepe uliczki, oraz wejściowe
   ustalenia dla następnego taska. To jedyny nośnik pamięci między sesjami.
6. **Zaktualizuj `docs/audits/CROSS_TASK_FINDINGS.md`** — nowe findingi
   przekrojowe i korekty istniejących.
7. **Uruchom `pnpm workflow:validate`** i doprowadź do `OK`.
8. **Zacommituj** — właściciel udzielił na to trwałej zgody dla domknięcia taska.
   Podziel na logiczne commity (zwykle: implementacja, potem `docs`), nigdy jeden
   commit „wszystko". `push`, MR i merge **nadal wymagają osobnej zgody**.
9. **Zostaw czyste drzewo.** Jeżeli z jakiegoś powodu coś zostaje
   niezacommitowane, opisz to jawnie w planie taska jako zamierzone, z listą
   ścieżek — inaczej następna sesja nie wie, czy to praca, czy śmieć.

Jeżeli pauza wypada **w środku** taska, punkty 5, 7 i 9 obowiązują tak samo:
oznacz ukończone units jako `DONE` z wynikiem bramki, zapisz następny krok i
opisz brudne drzewo. Nie commituj pracy częściowej bez pytania.

## Ciągły przebieg, recovery i `continue`

Po rozpoczęciu celu obejmującego wiele tasków Sol nie kończy pracy na granicy
taska. Po `DONE`, commicie i czystym drzewie wybiera następny task według kolejki,
czyta jego obowiązkowe dokumenty, tworzy just-in-time `WORK_UNITS.md` i zaczyna
wykonanie. Nie czeka na osobne `continue`.

Wiadomość `continue` pozostaje komendą recovery/manual resume, nie prośbą o
odtworzenie rozmowy. Historia chatu może być pusta; repozytorium jest źródłem
prawdy dla stanu pracy.

Po `continue`: odtwórz stan z dokumentów obowiązkowych, wybierz task według
kolejki (`CHANGES_REQUESTED` → `AUDIT_PASSED` → `IN_PROGRESS` → pierwszy
`READY`) i prowadź przebieg dalej. Nie odpowiadaj, że brakuje kontekstu sesji.

Handoff, audyt, `PASS` i granica taska nie są punktami pauzy. Zatrzymujesz się
wyłącznie po `pause`/`stop` właściciela, przy materialnej decyzji do podjęcia,
gdy dalszy krok wymaga nowego uprawnienia lub przy realnej blokadzie zewnętrznej.
Brak nowej wiadomości użytkownika, compaction, status `DONE` i granica milestone'u
nie są poleceniem zatrzymania.

### Aktywny ciągły cel M8/M9

Decyzja właściciela `2026-08-25`, uzupełniona `ADR-0014` po kwalifikacji core:
po rozpoczęciu RA-037 prowadź kolejno RA-037..RA-044, RA-046, RA-047 i RA-045,
aż każdy będzie `DONE`. Sol planuje i audytuje; jeden
`luna_implementer` wykonuje bounded work units, a `luna_explorer` jest używany
tylko do potrzebnej eksploracji. Po każdym tasku stosuj pełne domknięcie powyżej
i automatycznie przechodź do następnego odblokowanego taska.

Ta decyzja nie autoryzuje push/MR/merge, zewnętrznych write'ów ani działań
destrukcyjnych. Nie omija też pytań o materialne decyzje. RA-045 może zatrzymać
się na prawdziwym braku macOS/Xcode/AWS albo wymaganym zatwierdzeniu dokładnego
zadania live; takiej blokady nie zastępuje dokument ani fake evidence.
