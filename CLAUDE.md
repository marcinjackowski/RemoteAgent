# RemoteAgent — Claude Code bootstrap

@AGENTS.md

`AGENTS.md` jest nadrzędnym kontraktem tego repozytorium. Przeczytaj go w całości
i stosuj przed rozpoczęciem jakiejkolwiek pracy.

## Specjalne znaczenie `continue`

W tym repozytorium wiadomość użytkownika zawierająca samo `continue` **nie**
oznacza „odtwórz poprzednią rozmowę Claude”. Jest trwałą komendą workflow.

Po `continue` zawsze:

1. Nie odpowiadaj, że brakuje wcześniejszego taska lub kontekstu sesji.
2. Odtwórz stan z plików repozytorium, zaczynając od:
   - `AGENTS.md`
   - `docs/MASTER_PLAN.md`
   - `docs/workflow/EXECUTION_AND_AUDIT.md`
   - `docs/tasks/TASK_INDEX.md`
3. Wykonaj dokładnie algorytm `continue` z
   `docs/workflow/EXECUTION_AND_AUDIT.md`.
4. Dla początkowego stanu repozytorium wybierz `RA-001`, ponieważ jest pierwszym
   taskiem ze statusem `READY`.
5. Po ukończeniu taska utwórz handoff, ustaw `AWAITING_AUDIT` i zatrzymaj się
   zgodnie z wymaganym komunikatem `STOP` z `AGENTS.md`.

Historia chatu może być pusta. Repozytorium jest źródłem prawdy dla stanu pracy.

## MCP

Ostrzeżenie o nieuwierzytelnionym MCP nie blokuje pracy, jeżeli aktualny task nie
wymaga tego serwera. Nie uruchamiaj logowania ani nie proś o credentials na zapas.
W szczególności `RA-001` nie wymaga MCP.

