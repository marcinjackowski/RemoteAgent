# ADR-0029 — kwalifikacja alertu tekstowego bez rozłączania głosu

- Status: `ACCEPTED`
- Data: `2026-09-14`
- Task: `RA-055`
- Uzupełnia: `ADR-0028`

## Decyzja właściciela i przyczyna

Po LIVE09 właściciel wyjaśnił, że wymaganie rozłączania rozmowy głosowej
wykracza poza MOBL-2023 i obecnie nie jest istotnym testem odbioru. Kolejne
`continue` zatwierdza realizację tego zawężenia. Alert dotyczy rozmowy tekstowej.
Nie wyprowadzamy nowego zachowania voice z ogólnego zalecenia unikania regresji.

Wymóg ten został nadmiarowo dodany podczas kwalifikacji. Nie naprawiamy teraz
voice ani nie dodajemy jego zależności do kontekstu. Nie przepisujemy historii:
LIVE09 pozostaje FAILED, a stare manifesty i wyniki nadal oznaczają stary zakres.

## Kontrakt

1. Nowy profil `full-flow-text-v1` wymaga dokładnego benchmark ID
   `MOBL-2023-full-flow-text-v1`. Stary `full-flow-v1` oraz legacy zachowują
   swoje dotychczasowe kryteria. Zamiana ID/weryfikatora ma być odrzucona
   przed model factory; nie ma automatycznego fallbacku ani flagi skip-voice.
2. Nowy gate `ios-text-flow-model-tests-final` wymaga dokładnie dziewięciu
   istniejących przypadków copy/actions, blokowania wysyłki i przywrócenia stanu.
   Wykluczone są tylko dwa ID z `RA055SafetyFlowVoiceTests` i odpowiadający im
   chroniony plik. Treść pozostałych trzech plików pozostaje byte-identical.
   Snapshot trzech inputs/nine IDs:
   `sha256:1823cf8866e8a0b93e219fde2f5829097f6e159ea751de7207af44f92aedfc50`.
3. Cztery testy UI oraz ich pięć chronionych inputs pozostają bez zmian.
   Asset, source-precheck, changelog, exact11 SOURCE candidates, globalne
   allowlisty, generator ownership i receipt binding nie są osłabiane.
4. Nowy pakiet usuwa z objective dopisany wymóg voice pause/disconnect,
   jawnie pozostawia głos poza zakresem nowych zmian, i otrzymuje nowe
   manifest/overlay/config/catalog digests. Pozostałe wymagania tekstowego
   alertu, seed i modele pozostają bez zmian. Stare pakiety nie są edytowane.
5. Nie ma ręcznego poprawiania iOS candidate, push ani rozszerzenia budżetu.
   Usunięcie dwóch testów nie jest dowodem naprawy czterech błędów UI.

## Weryfikacja i migracja

Wymagane: selector cross-rejection, pozytywny factory control, odrzucenie
zmienionych/niekompletnych IDs, argv, inputs i scope, mutation RED/restoreGREEN,
read-only walidacja rzeczywistego nowego pakietu, pełna bramka bez cache.
Nowy run nie może korzystać z dawnych receipts jako dowodu nowej kwalifikacji.
Rzeczywiste wykonanie dziewięciu testów modelu i czterech UI nadal jest wymagane.

Wycofanie polega na wyborze istniejącego profilu, nigdy reinterpretacji jego
historii. Ten ADR nie deklaruje PASS ani zakończenia RA-055. Dokładny live
podlega dotychczasowej bramce lokalnej i zasadom zatwierdzenia pakietu.
