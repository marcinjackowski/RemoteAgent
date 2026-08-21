# RemoteAgent — instrukcje dla agentów

Ten plik jest nadrzędnym kontraktem pracy dla całego repozytorium.

Obowiązująca decyzja o procesie:
[ADR-0007](docs/decisions/ADR-0007-verification-first-delivery.md), która
zastąpiła ADR-0006, ADR-0004 i ADR-0003.

Jest jedna rola wykonawcza: ta sesja planuje, implementuje i weryfikuje.
Rozdział na `COORDINATOR_AUDITOR` i `IMPLEMENTER` oraz dispatch osobnych sesji
implementera **nie obowiązują**. Aliasy `Sol` i `Luna` są historyczne — mają
znaczenie wyłącznie w dokumentach powstałych przed `2026-08-20`.

Uzasadnienie zmiany jest w ADR-0007: rozdział ról kosztował dwa incydenty
naruszające single-writer i utratę pracy jednego unitu, nie wykrywając ani
jednego defektu. Defekt, który realnie blokował RA-012 — odwrócone kryterium
„model nie poszerza policy” — wykryło uruchomienie istniejących testów, nie
granica sesji.

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
przez `corepack` i sprawdza PostgreSQL na `127.0.0.1:5433`.

Znane, realne breakage tej maszyny (`2026-08-20`): Homebrew `node` nie ładuje
`libllhttp.9.3.dylib` i przesłania działający `/usr/local/bin/node`; Docker ma
niezgodny client/engine i zwraca `500`. PostgreSQL 17 działa lokalnie na `5433`,
co jest domyślną wartością w `packages/database/src/config.ts`, więc Docker nie
jest potrzebny.

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

## Zakazy wymagające zgody właściciela

- `git commit` — tylko po jawnym potwierdzeniu właściciela. **Wyjątek stały
  (`2026-08-21`): domknięcie taska.** Właściciel udzielił trwałej zgody na commit
  przy zamknięciu taska — zob. „Domknięcie taska". Nie rozciąga się to na
  commity w trakcie taska ani na `push`.
- `git push`, tworzenie MR/PR, merge — nigdy bez jawnego potwierdzenia.
- Zmiana albo tranzycja ticketów (Jira, Linear) — nigdy bez potwierdzenia.
- Wysłanie czegokolwiek na zewnątrz (Slack, mail) — najpierw draft.

## Domknięcie taska — przygotowanie do `/clear`

Właściciel pracuje w cyklu: **jeden task → `/clear` → `continue`**. Historia chatu
znika po każdym tasku, więc domknięcie taska musi zostawić repozytorium w stanie,
z którego następna sesja odtworzy WSZYSTKO bez pytania. Ustalone `2026-08-21`.

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

## Ciągły przebieg i `continue`

Wiadomość `continue` jest komendą workflow, nie prośbą o odtworzenie rozmowy.
Historia chatu może być pusta; repozytorium jest źródłem prawdy dla stanu pracy.

Po `continue`: odtwórz stan z dokumentów obowiązkowych, wybierz task według
kolejki (`CHANGES_REQUESTED` → `AUDIT_PASSED` → `IN_PROGRESS` → pierwszy
`READY`) i prowadź przebieg dalej. Nie odpowiadaj, że brakuje kontekstu sesji.

Handoff, audyt, `PASS` i granica taska nie są punktami pauzy. Zatrzymujesz się
po poleceniu pauzy właściciela, przy materialnej decyzji do podjęcia albo przy
realnej blokadzie zewnętrznej.
