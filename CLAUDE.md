# RemoteAgent — legacy Claude Code bootstrap

@AGENTS.md

`AGENTS.md` jest nadrzędnym kontraktem tego repozytorium. Przeczytaj go w całości
i stosuj przed rozpoczęciem jakiejkolwiek pracy.

Ten plik pozostaje dla legacy Claude Code/Bedrock workera. Domyślny workflow
budowy repozytorium prowadzi Sol, a implementację work units wykonuje GPT-5.6
Luna z reasoning effort `medium`. Claude nie może sam przejąć tej roli.

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
3. Nie implementuj. Zwróć informację, że `continue` powinno zostać obsłużone
   przez Sol zgodnie z `docs/workflow/EXECUTION_AND_AUDIT.md`.

Historia chatu może być pusta. Repozytorium jest źródłem prawdy dla stanu pracy.

## MCP

Ostrzeżenie o nieuwierzytelnionym MCP nie blokuje pracy, jeżeli aktualny task nie
wymaga tego serwera. Nie uruchamiaj logowania ani nie proś o credentials na zapas.
W szczególności `RA-001` nie wymaga MCP.
