# Implementer GPT-5.6 Luna w Codex

## Cel

GPT-5.6 Luna z reasoning effort `medium` wykonuje skupione work units
przygotowane przez Sol. Nie wybiera tasków, nie projektuje planu i nie audytuje.
Każdy unit używa nowej sesji z rolą `IMPLEMENTER`.

## Preflight Sol

Przed uruchomieniem unit Sol sprawdza:

1. task i wszystkie zależności mają poprawny status;
2. working tree oraz bazowy commit/tree są zapisane i rozpoznane;
3. nie działa inny implementer zapisujący do tego samego zakresu;
4. unit ma jeden rezultat, maksymalnie trzy kryteria, jawne allowed paths oraz
   jedną komendę weryfikacyjną;
5. domyślnie obejmuje do ośmiu plików i context pack poniżej 80k tokenów;
6. prompt zabrania commitów, remote writes i edycji artefaktów workflow.

Limit nie jest celem samym w sobie. Nie rozbijaj spójnego pięcioplikowego
zachowania na mikrosesje. Dziel unit, gdy zawiera niezależne zachowania,
potrzebuje różnych bramek testowych albo pierwsza próba ujawni scope drift.

## Dispatch

Sol uruchamia jednego subagenta `gpt-5.6-luna` z reasoning effort `medium` i bez
forkowania zbędnej historii rozmowy. Prompt zawiera:

- rolę `IMPLEMENTER`, task ID i work-unit ID;
- dokładny rezultat oraz maksymalnie trzy kryteria;
- zamknięty context pack i allowed paths;
- jedną komendę weryfikacyjną z oczekiwanym wynikiem;
- `Out of scope`, zakaz planowania/audytu i zakaz remote writes;
- wymagany krótki raport końcowy.

## Raport implementera

Luna zwraca:

- task ID i work-unit ID;
- `COMPLETED`, `BLOCKED` albo `FAILED`;
- zmienione pliki;
- komendę weryfikacyjną, exit code i wynik;
- ryzyka lub materialny Decision Request;
- jednozdaniowy następny krok dla Sol.

Raport nie zmienia stanu taska. Sol sprawdza rzeczywisty diff, odrzuca zmiany
poza allowlistą i niezależnie ponawia test.

## Recovery

- Przy częściowym, spójnym diffie Sol może zlecić Lunie mały fix unit.
- Przy scope drift Sol przerywa sesję i zawęża prompt lub unit.
- Historia Luny nie jest wznawiana między units; źródłem prawdy pozostaje repo.
- Po dwóch nieudanych próbach tego samego celu Sol dokumentuje finding i zmienia
  strategię podziału zamiast powtarzać identyczny prompt.

