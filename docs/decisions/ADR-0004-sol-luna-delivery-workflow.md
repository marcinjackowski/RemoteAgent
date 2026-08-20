# ADR-0004 — Sol high koordynuje, GPT-5.6 Luna medium implementuje

- Status: Accepted
- Date: 2026-08-19
- Supersedes: `ADR-0003`
- Scope: workflow budowy RemoteAgent, nie role runtime produktu

## Kontekst

Lokalny implementer używany przez ADR-0003 wielokrotnie zużywał czas i kontekst
na szeroką eksplorację bez dostarczenia kompletnego work unit. Właściciel wycofał
jego użycie. Nadal potrzebujemy rozdzielenia implementacji od planowania i
audytu, aby ograniczać zużycie najmocniejszego modelu bez osłabiania bramki
jakości.

## Decyzja

- `GPT-5.6 Sol` z reasoning effort `high` jest `COORDINATOR_AUDITOR`: planuje,
  podejmuje decyzje architektoniczne, kontroluje diff, ponawia testy i wykonuje
  niezależny audyt.
- `GPT-5.6 Luna` z reasoning effort `medium` jest `IMPLEMENTER`: realizuje jeden
  aktywowany work unit w nowej sesji, uruchamia wskazaną weryfikację i nie
  audytuje własnej pracy.
- Model lokalny z ADR-0003 nie jest fallbackiem. Może wrócić wyłącznie po nowej,
  jawnej decyzji właściciela.
- Jeden work unit pozostaje spójnym zachowaniem, ale limit wynikający z małego
  lokalnego kontekstu znika. Domyślna granica to osiem plików, trzy kryteria,
  context pack poniżej 80k tokenów i jedna celowana weryfikacja.
- Sol dzieli unit dalej tylko wtedy, gdy łączy niezależne zachowania, przekracza
  granice albo rzeczywista próba Luny ujawni przeciążenie lub scope drift.
- Implementer ma concurrency `1` na task ze względu na single-writer, nie
  ograniczenie modelu. Sol może utrzymywać maksymalnie trzy równoległe sesje
  Luny dla niezależnych tasków z rozłącznymi zakresami zapisu.
- Audyt, fix loop, `PASS` i przejście do następnego taska odbywają się bez pauzy
  aż do polecenia właściciela, materialnego Decision Request, realnej blokady lub
  ukończenia całej kolejki.

## Niezależność i uprawnienia

- Luna nie edytuje task index, planów work units, handoffów, audytów ani ADR.
- Luna nie wykonuje commitów, push, MR ani innych remote writes.
- Sol nie uznaje raportu implementera za dowód: czyta diff i sam uruchamia
  weryfikację.
- Finding audytu staje się nowym fix unit; Sol nie poprawia kodu w roli audytora.

## Konsekwencje

- Istniejące plany z pięcioma plikami są wystarczająco małe dla Luny i nie
  wymagają dodatkowych mikropodziałów tylko ze względu na model.
- Kolejność indeksu nadal rozstrzyga przydział, lecz nie blokuje równoległego
  startu dalszego taska `READY`, gdy wcześniejszy task zajmuje inny strumień.
- Sol zużywa swój budżet przede wszystkim na decyzje i kontrolę jakości, a Luna
  na seryjną implementację.
- Historyczne handoffy, audyty i ADR-0003 zachowują pierwotną proweniencję.

## Rollback

Zmiana domyślnego modelu implementera lub ponowne dopuszczenie modelu lokalnego
wymaga jawnej decyzji właściciela i nowego ADR. Role oraz artefakty workflow
pozostają model-neutralne.
