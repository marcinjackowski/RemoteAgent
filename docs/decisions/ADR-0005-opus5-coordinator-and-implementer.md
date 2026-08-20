# ADR-0005 — Claude Opus 5 koordynuje i implementuje przez izolowane sesje

- Status: `SUPERSEDED` przez [ADR-0006](ADR-0006-opus48-implementer.md) w części
  model identity (`2026-08-20`); pozostałe ustalenia o izolacji sesji obowiązują
- Data: `2026-08-20`
- Zastępuje model identity z: [ADR-0004](ADR-0004-sol-luna-delivery-workflow.md)
- Nie zmienia: kontraktu ról z `AGENTS.md` ani protokołu z
  `docs/workflow/EXECUTION_AND_AUDIT.md`

## Kontekst

Poprzedni koordynator (`GPT-5.6 Sol`) i implementer (`GPT-5.6 Luna`) przestali
być dostępni w trakcie pracy: właściciel wyczerpał limit dostawcy. Stan pracy
został zapisany w `docs/handoffs/CURRENT_WORK_STATUS-2026-08-20.md`, a dwa taski
(`RA-011`, `RA-016`) pozostały `BLOCKED` z niezaakceptowanym WIP i otwartym
Decision Requestem.

Handoff transferowy rekomendował `Opus 4.8` albo `Sonnet` jako implementera.
`Opus 4.8` nie jest osiągalny jako model subagenta w bieżącym harnessie —
dostępne tożsamości to `opus` (Opus 5), `sonnet` (Sonnet 5), `haiku` i `fable`.
Rekomendacja była więc niewykonalna i wymagała rozstrzygnięcia właściciela.

Oba pozostałe fix unity to adversarial security (`RA-011`: forged serialized
binding) i concurrency ordering (`RA-016`: lock przed REST). Każdy z nich już
dwa razy nie przeszedł Sol gate pod implementerem o effort `medium`.

## Decyzja

Właściciel zdecydował `2026-08-20`:

- `COORDINATOR_AUDITOR` = **Claude Opus 5**;
- `IMPLEMENTER` = **Claude Opus 5** z wysokim reasoning effort, uruchamiany
  wyłącznie jako osobny subagent w świeżej, ephemerycznej sesji per work unit;
- limit automatycznych prób zresetowany (opcja A) dla `RA-011-WU-09G` oraz
  `RA-016-WU-08E` — po jednym finalnym fix unicie na task.

Separację `IMPLEMENTER` od `COORDINATOR_AUDITOR` zapewnia **granica sesji i
zamknięty context pack**, nie różnica tożsamości modelu:

- implementer dostaje wyłącznie work unit, allowed paths i context pack; nie
  widzi `MASTER_PLAN.md`, task indexu, historii handoffów ani audytów;
- koordynator/audytor nie pisze kodu produktowego, który następnie audytuje;
  weryfikuje rzeczywisty diff względem allowlisty i samodzielnie odtwarza bramki
  w swojej własnej sesji;
- raport implementera nie jest dowodem; dowodem jest niezależne uruchomienie
  komendy weryfikacyjnej przez audytora.

## Odrzucone opcje

- **Sonnet 5 jako implementer** — tańszy, ale oba unity już przegrały pod
  implementerem o niższym effort. Trzecia nieudana próba wymagałaby kolejnego
  resetu limitu i kolejnej decyzji właściciela.
- **Koordynator implementuje bezpośrednio** — łamie `AGENTS.md`: audytor nie może
  być writerem kodu, który ocenia. Odrzucone przez właściciela.

## Konsekwencje

- Nazwy `Sol` i `Luna` pozostają w historycznych handoffach i audytach jako
  zapis stanu z chwili powstania; nie są przepisywane wstecz.
- Bieżące dokumenty workflow (`AGENTS.md`, `EXECUTION_AND_AUDIT.md`,
  `LUNA_IMPLEMENTER.md`) wymagają aktualizacji model identity przy zachowaniu
  semantyki ról. Pliki `docs/work-units/*/WORK_UNITS.md` aktualizują pole
  `Implementer` przy najbliższej rewizji planu.
- Nadal obowiązuje: maksymalnie trzy równoległe strumienie, najwyżej jeden writer
  na task/case, rozłączne allowed paths, zakaz commitów i remote writes po
  stronie implementera.
- Ponieważ implementer i audytor dzielą tożsamość modelu, audyt musi jawnie
  odnotować, że werdykt powstał z odczytu diffu i własnego uruchomienia testów, a
  nie z raportu implementera.

## Rollback

Jeżeli implementer w tej konfiguracji ponownie nie domknie unitu, koordynator nie
ponawia cicho trzeciej próby: dokumentuje blokadę, dzieli unit inaczej albo
zwraca właścicielowi Decision Request o zmianie zakresu lub tożsamości modelu.
