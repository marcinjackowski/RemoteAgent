# RemoteAgent — Claude Code bootstrap

@AGENTS.md

`AGENTS.md` jest nadrzędnym kontraktem tego repozytorium. Przeczytaj go w całości
i stosuj przed rozpoczęciem jakiejkolwiek pracy.

Od `2026-08-20` (zob.
[ADR-0006](docs/decisions/ADR-0006-opus48-implementer.md))
`Claude Opus 5` prowadzi rolę `COORDINATOR_AUDITOR`, a rolę `IMPLEMENTER` wykonuje
`Claude Opus 4.8` (`amazon-bedrock/us.anthropic.claude-opus-4-8`, `variant: high`)
w osobnej, ephemerycznej sesji per work unit. ADR-0006 zastąpił ADR-0005, w którym
obie role dzieliły tożsamość modelu, ponieważ `Opus 4.8` nie był wtedy osiągalny.

Implementacji nie wykonujesz nigdy w tej sesji: każdy work unit uruchamiasz jako
osobną sesję agenta `implementer` (`.opencode/agent/implementer.md`) z zamkniętym
context packiem i allowlistą ścieżek egzekwowaną przez permissions harnessu. Ta
sesja pozostaje koordynatorem i audytorem, więc nie może być writerem kodu
produktowego, który następnie ocenia. Komenda dispatchu:
`docs/workflow/LUNA_IMPLEMENTER.md`.

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
3. Wykonaj algorytm wznowienia z `docs/workflow/EXECUTION_AND_AUDIT.md` w roli
   `COORDINATOR_AUDITOR` i prowadź ciągły przebieg do polecenia pauzy,
   materialnego Decision Requestu albo realnej blokady.

Kodu produktowego nie piszesz samodzielnie także po `continue`: planujesz, dzielisz
na work units, uruchamiasz implementerów jako subagentów i niezależnie audytujesz
ich wynik.

Do `2026-08-20` ten punkt brzmiał „nie implementuj, odeślij do Sol”, ponieważ rolę
koordynatora prowadził osobny model. Od ADR-0005 (i dalej w ADR-0006) rolę
koordynatora prowadzi ta sesja — nie ma komu odsyłać, a odesłanie byłoby
zatrzymaniem przebiegu bez blokady.

Historia chatu może być pusta. Repozytorium jest źródłem prawdy dla stanu pracy.

## MCP

Ostrzeżenie o nieuwierzytelnionym MCP nie blokuje pracy, jeżeli aktualny task nie
wymaga tego serwera. Nie uruchamiaj logowania ani nie proś o credentials na zapas.
W szczególności `RA-001` nie wymaga MCP.
