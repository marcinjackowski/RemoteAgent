# Checklist audytora

Checklist wykonuje Sol po implementacji Qwena i jest wspólna dla wszystkich
tasków. Specyficzny `Audit focus` w pliku taska ma pierwszeństwo i rozszerza
poniższe punkty.

## 1. Zakres i wymagania

- Czy implementacja realizuje wszystkie kryteria taska?
- Czy nie wprowadza nieuzgodnionego zakresu albo zmiany architektury?
- Czy każdy materialny wymóg ma konkretny dowód?
- Czy wcześniejsze findingi zostały rzeczywiście usunięte?
- Czy każda zmiana pochodzi z zaakceptowanego work unit, a scope creep został
  jawnie odrzucony albo zatwierdzony przez Sol przed wykonaniem?

## 2. Kod i kontrakty

- Przeczytaj pełny diff oraz istotny kod wywołujący i wywoływany.
- Sprawdź typowanie runtime, błędy, edge cases i kompatybilność schema/version.
- Szukaj duplikacji źródeł prawdy, implicit defaults i stanów niemożliwych.
- Sprawdź migracje oraz rollback, jeśli task dotyka danych.

## 3. Trwałość i współbieżność

- Gdzie jest granica transakcji?
- Co dzieje się przy crash przed/po każdej operacji?
- Czy retry może powtórzyć side effect?
- Czy locks/leases używają fencing i mają poprawny timeout?
- Czy dwa cases pozostają izolowane, a jeden case ma jednego writera?

## 4. Security i privacy

- Czy owner, connection, repo i tool scope są ustalane poza modelem?
- Czy zewnętrzne treści są traktowane jako niezaufane?
- Czy sekrety lub PII mogą trafić do promptu, logu, błędu albo fixture?
- Czy błędy auth/policy failują zamknięcie?
- Czy destructive paths, shell, network i filesystem mają twarde granice?

## 5. Agent i narzędzia

- Czy model nie jest źródłem autoryzacji ani potwierdzenia wykonania?
- Czy structured output jest walidowany i wersjonowany?
- Czy repair/retry nie odtwarza tools lub side effectów?
- Czy tool output ma provenance, limity i redakcję?
- Czy checkpoint wystarcza do wznowienia bez poprzedniej sesji?

## 6. Test evidence

- Uruchom wymagane testy samodzielnie.
- Nie traktuj raportu Qwena ani unit gate jako końcowego dowodu.
- Potwierdź, że test sprawdza zachowanie, a nie tylko mock implementation detail.
- Sprawdź negatywne ścieżki, concurrency, retry, cancellation i recovery.
- Zweryfikuj snapshot diff zamiast automatycznie go akceptować.
- Powiąż wynik z konkretnym kodem/commitem/tree digest.

## 7. Operacyjność

- Czy są wystarczające correlation IDs, metrics i actionable errors?
- Czy limit, timeout, backpressure, DLQ i kill switch zachowują się jawnie?
- Czy operator potrafi rozpoznać i naprawić stan bez ręcznej edycji DB?
- Czy dokumentacja i runbook odpowiadają rzeczywistemu zachowaniu?

## 8. Niezależność Sol/Qwen

- Czy plan i kryteria powstały przed implementacją i były autorstwa Sol?
- Czy Qwen edytował wyłącznie dozwolone ścieżki jednego work unit?
- Czy Qwen nie zmienił task index, planu, handoffu, audytu ani decyzji?
- Czy Sol przeczytał pełny diff od bazowego tree, a nie tylko raport modelu?
- Czy Sol ponowił celowane testy i pełną weryfikację taska?
- Czy findingi są opisane przed utworzeniem fix units, bez edycji kodu podczas
  audytu?

## 9. Inwarianty `workflow:validate`

Sprawdź, że stan kolejki i artefaktów spełnia inwarianty egzekwowane przez
`workflow:validate` (zob. `docs/workflow/EXECUTION_AND_AUDIT.md`):

- Causality rewizji: `AWAITING_AUDIT` ma najnowszy handoff nowszy od najnowszego
  audytu, a `CHANGES_REQUESTED`/`AUDIT_PASSED`/`DONE` mają audyt nie starszy niż
  najnowszy handoff.
- Werdykt najnowszego audytu zgadza się ze statusem
  (`CHANGES_REQUESTED`→`CHANGES_REQUIRED`, `AUDIT_PASSED`/`DONE`→`PASS`) i jest
  jednoznaczny.
- Gating zależności: statusy wykonywalne/terminalne mają wszystkie istniejące
  zależności `DONE`; `BLOCKED_BY_DEPENDENCIES` ma co najmniej jedną niedokończoną
  zależność; `BLOCKED` jest wyjątkiem dopuszczonym z dowolnego stanu.
- Gramatyka `## Queue`: pięć komórek na wiersz, `Order` ciągłe `1..N`, dokładne
  tokeny `RA-NNN` w `Depends on`, zewnętrzne pipe’y i poprawny separator; żaden
  wiersz danych nie jest cicho pomijany.

## 10. Werdykt

- `PASS`: wszystkie kryteria spełnione, brak unresolved BLOCKER/HIGH/MEDIUM.
- `CHANGES_REQUIRED`: implementacja jest naprawialna w zakresie taska; findingi
  zawierają konkretne wymagane zmiany.
- `BLOCKED`: audyt jest niemożliwy albo potrzebna jest zewnętrzna decyzja/stan.

Brak możliwości uruchomienia kluczowego testu oznacza `NOT_VERIFIED`, nie PASS na
podstawie samej deklaracji handoffu.
