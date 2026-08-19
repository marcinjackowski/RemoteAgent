# <TASK_ID> — Audit <NN>

## Metadata

- Task: `<TASK_ID>`
- Audytowany handoff: `<path>`
- Audytor:
- Implementer model/transport:
- Work-units plan:
- Data:
- Werdykt: `PASS | CHANGES_REQUIRED | BLOCKED`

## Podsumowanie

Krótka, niezależna ocena implementacji.

## Zakres audytu

- Przeczytane dokumenty:
- Sprawdzony diff/commity:
- Uruchomione kontrole:
- Potwierdzenie, że audytor nie implementował ocenianego kodu:

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| | PASS/FAIL/NOT_VERIFIED | |

## Findingi

### <SEVERITY> — <tytuł>

- Lokalizacja:
- Dowód:
- Wpływ:
- Wymagana zmiana:

Jeśli brak findingów, wpisz `Brak`.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| | | |

Raporty Qwena i unit gates nie zastępują powyższych, ponowionych kontroli.

## Ryzyka przekrojowe

- Security/privacy:
- Idempotencja/recovery:
- Współbieżność:
- Observability:
- Kompatybilność:

## Fix work units po `CHANGES_REQUIRED`

Lista jest obowiązkowa dla `CHANGES_REQUIRED`; każdy finding musi zostać
zamieniony przez Sol na mały unit dla Qwena. Dla `PASS` wskaż kolejny makro-task.

1. ...

## Uzasadnienie werdyktu

Wyjaśnij werdykt na podstawie kryteriów i dowodów.
