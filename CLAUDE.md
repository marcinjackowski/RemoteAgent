# RemoteAgent — Claude Code bootstrap

@AGENTS.md

`AGENTS.md` jest nadrzędnym kontraktem tego repozytorium. Przeczytaj go w całości
i stosuj przed rozpoczęciem jakiejkolwiek pracy.

Od `2026-08-20` obowiązuje
[ADR-0007](docs/decisions/ADR-0007-verification-first-delivery.md): jest **jedna
rola wykonawcza**. Ta sesja planuje, implementuje i weryfikuje. Rozdział na
koordynatora i implementera oraz dispatch osobnych sesji implementera
(ADR-0006, ADR-0005, ADR-0004, ADR-0003) nie obowiązują. Aliasy `Sol` i `Luna`
są historyczne.

## Reguła nadrzędna

Bramką jest **uruchomiona komenda**, nie dokument. Żaden status nie zmienia się
na `DONE`, żaden audyt ani handoff nie powstaje, dopóki komenda weryfikacyjna
nie zwróciła exit code `0`. Zielony przebieg nie wystarcza: mechanizmy
bezpieczeństwa wymagają mutation checku, a `typecheck`/`build` uruchamiaj z
`--force`, bo `turbo` raportuje sukces z cache bez uruchomienia czegokolwiek.

Powód jest konkretny: RA-012 stał 99% ukończony za jedną linią, która odwracała
kryterium „model nie poszerza server-owned policy”. Cztery istniejące testy
wykrywały to natychmiast. Nikt ich nie uruchomił, a plan orzekł, że unit trzeba
powtórzyć od zera.

## Środowisko

Przed bramką: `. scripts/dev/env.sh`, potem `RA_REQUIRE_POSTGRES=1`.

Na tej maszynie Homebrew `node` jest zepsuty i przesłania działający
`/usr/local/bin/node`, a Docker ma niezgodny client/engine. PostgreSQL 17 działa
lokalnie na `5433` — zgodnie z domyślną konfiguracją repozytorium, więc Docker
nie jest do niczego potrzebny.

## Specjalne znaczenie `continue`

W tym repozytorium wiadomość zawierająca samo `continue` **nie** oznacza
„odtwórz poprzednią rozmowę”. Jest trwałą komendą workflow.

Po `continue` zawsze:

1. Nie odpowiadaj, że brakuje wcześniejszego taska ani kontekstu sesji.
2. Odtwórz stan z repozytorium: `AGENTS.md`, `docs/MASTER_PLAN.md`,
   `docs/tasks/TASK_INDEX.md`, plik aktualnego taska,
   `docs/audits/CROSS_TASK_FINDINGS.md`.
3. Wybierz task według kolejki (`CHANGES_REQUESTED` → `AUDIT_PASSED` →
   `IN_PROGRESS` → pierwszy `READY`) i prowadź ciągły przebieg do polecenia
   pauzy, materialnej decyzji właściciela albo realnej blokady.

Historia chatu może być pusta. Repozytorium jest źródłem prawdy dla stanu pracy.

## Zgoda właściciela

`git commit` wymaga jawnego potwierdzenia. `git push`, MR/PR, merge oraz zmiany
ticketów — nigdy bez potwierdzenia.

## MCP

Ostrzeżenie o nieuwierzytelnionym MCP nie blokuje pracy, jeżeli aktualny task nie
wymaga tego serwera. Nie uruchamiaj logowania ani nie proś o credentials na zapas.
