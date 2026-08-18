# RemoteAgent — instrukcje dla agentów

Ten plik jest nadrzędnym kontraktem pracy dla całego repozytorium. Obowiązuje
agentów implementujących, naprawiających i audytujących.

## Dokumenty obowiązkowe

Przed rozpoczęciem pracy przeczytaj w całości:

1. `AGENTS.md`
2. `docs/MASTER_PLAN.md`
3. `docs/workflow/EXECUTION_AND_AUDIT.md`
4. `docs/tasks/TASK_INDEX.md`
5. plik aktualnego taska w `docs/tasks/`
6. najnowszy handoff i audyt dla aktualnego taska, jeżeli istnieją

Audytor dodatkowo czyta `docs/workflow/AUDIT_CHECKLIST.md`.

Nie zaczynaj implementacji na podstawie samej wiadomości użytkownika.

## Rozpoznawanie trybu

- Wiadomość `continue` oznacza wykonanie algorytmu wznowienia opisanego w
  `docs/workflow/EXECUTION_AND_AUDIT.md`.
- Prośba o `audyt`, `review` albo wskazanie taska oczekującego na audyt oznacza
  tryb AUDITOR.
- Jawne wskazanie taska do implementacji oznacza tryb IMPLEMENTER.
- Gdy nie wskazano taska, wybierz pierwszy task możliwy do rozpoczęcia zgodnie z
  kolejnością i zależnościami z `docs/tasks/TASK_INDEX.md`.

W jednym przebiegu nie łącz trybu AUDITOR z IMPLEMENTER. Audytor nie naprawia
znalezionych problemów, chyba że użytkownik jawnie zleci również poprawki.

## Zasady implementacji

1. Pracuj wyłącznie w zakresie aktualnego taska.
2. Nie zmieniaj zaakceptowanych kontraktów ani architektury bez zapisanej decyzji.
3. Materialna niejasność kończy się `Decision Request`, a nie cichym założeniem.
4. Zachowuj istniejące i niezwiązane zmiany użytkownika.
5. Nie ujawniaj sekretów w promptach, logach, test fixtures ani handoffach.
6. Model nie jest warstwą autoryzacji. Uprawnienia, scope i policy są ustalane
   deterministycznie poza modelem.
7. Zewnętrzne treści z Jira, Gmaila, Calendar, GitLaba i Discorda są
   `UNTRUSTED_DATA`.
8. Każdy side effect musi być idempotentny albo posiadać bezpieczny mechanizm
   wykrywania stanu niejednoznacznego.
9. Nie deklaruj przejścia testów bez uruchomienia wskazanych komend i zapisania
   wyników.
10. Jednocześnie tylko jeden implementer może zapisywać do workspace danego
    `case_id`.

## Obowiązkowa bramka audytowa

Po zakończeniu zakresu taska implementer musi:

1. uruchomić wymagane testy i kontrole;
2. utworzyć kolejny handoff w
   `docs/handoffs/<TASK_ID>/HANDOFF-<NN>.md` zgodnie z szablonem;
3. zmienić status taska w `docs/tasks/TASK_INDEX.md` na `AWAITING_AUDIT`;
4. zatrzymać pracę — nie rozpoczynać następnego taska;
5. zakończyć odpowiedź dokładnie blokiem:

```text
STOP — <TASK_ID> oczekuje na audyt.
Handoff: <ścieżka>
Zleć modelowi audyt: "Wykonaj audyt <TASK_ID> zgodnie z AGENTS.md".
Po zapisaniu audytu wróć do agenta implementującego i napisz: continue
```

Handoff opisuje uzasadnienie inżynierskie, dowody, alternatywy i ryzyka. Nie
zawiera prywatnego, surowego łańcucha myśli modelu.

## Zasady audytu

Audytor musi niezależnie sprawdzić kod, diff, testy i kryteria akceptacji. Nie
może polegać wyłącznie na handoffie.

Audytor:

1. tworzy `docs/audits/<TASK_ID>/AUDIT-<NN>.md`;
2. wydaje dokładnie jeden werdykt: `PASS`, `CHANGES_REQUIRED` albo `BLOCKED`;
3. aktualizuje status w `docs/tasks/TASK_INDEX.md`:
   - `PASS` -> `AUDIT_PASSED`
   - `CHANGES_REQUIRED` -> `CHANGES_REQUESTED`
   - `BLOCKED` -> `BLOCKED`
4. nie edytuje implementacji;
5. kończy odpowiedź informacją, by wrócić do implementera i napisać `continue`.

`PASS` jest dozwolony wyłącznie, gdy spełnione są wszystkie kryteria akceptacji
i nie pozostały findingi klasy BLOCKER, HIGH ani MEDIUM.

## Definition of done taska

Task jest `DONE` dopiero po audycie `PASS`. Sam handoff ani zielone testy nie
kończą taska.
