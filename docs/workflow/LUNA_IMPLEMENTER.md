# Implementer — kontrakt uruchomienia

> **`SUPERSEDED` od `2026-08-20`** —
> [ADR-0007](../decisions/ADR-0007-verification-first-delivery.md) zniósł rolę
> osobnego implementera i dispatch przez `opencode run --agent implementer`. Jest
> jedna rola wykonawcza; obowiązującym kontraktem jest `AGENTS.md`.
>
> Ten plik zostaje jako zapis stanu z chwili powstania i punkt rollbacku do
> ADR-0006 (konfiguracja agenta w `.opencode/agent/implementer.md` jest
> nienaruszona). **Nie stosuj go do nowej pracy.**

## Cel

Implementer wykonuje skupione work units przygotowane przez koordynatora. Nie
wybiera tasków, nie projektuje planu i nie audytuje. Każdy unit używa nowej,
ephemerycznej sesji z rolą `IMPLEMENTER`.

Obowiązująca tożsamość modelu: `Claude Opus 4.8`
(`amazon-bedrock/us.anthropic.claude-opus-4-8`, `variant: high`), zob.
[ADR-0006](../decisions/ADR-0006-opus48-implementer.md). Nazwa `Luna` w tym pliku
(również w jego nazwie) jest historycznym aliasem roli `IMPLEMENTER`, nie
tożsamością modelu.

Koordynator (`Opus 5`) i implementer (`Opus 4.8`) różnią się modelem, ale izolacja
nie opiera się na tej różnicy. Zapewniają ją trzy warstwy: inny model, granica
sesji z zamkniętym context packiem oraz deterministyczne permissions harnessu.
Implementer nie otrzymuje `MASTER_PLAN.md`, task indexu ani historii
handoffów/audytów — te ścieżki są zablokowane do odczytu, nie tylko odradzone.

## Preflight Sol

Przed uruchomieniem unit Sol sprawdza:

1. task i wszystkie zależności mają poprawny status;
2. working tree oraz bazowy commit/tree są zapisane i rozpoznane;
3. nie działa inny implementer tego taska ani zapisujący do tego samego zakresu;
4. unit ma jeden rezultat, maksymalnie trzy kryteria, jawne allowed paths oraz
   jedną komendę weryfikacyjną;
5. domyślnie obejmuje do ośmiu plików i context pack poniżej 80k tokenów;
6. prompt zabrania commitów, remote writes i edycji artefaktów workflow.

Limit nie jest celem samym w sobie. Nie rozbijaj spójnego pięcioplikowego
zachowania na mikrosesje. Dziel unit, gdy zawiera niezależne zachowania,
potrzebuje różnych bramek testowych albo pierwsza próba ujawni scope drift.

## Dispatch

Sol uruchamia dla unit osobną, ephemeryczną sesję agenta `implementer`
(`.opencode/agent/implementer.md`) bez forkowania historii rozmowy koordynatora.
Łącznie mogą działać trzy takie sesje dla niezależnych tasków o rozłącznych
allowed paths. Prompt zawiera:

- rolę `IMPLEMENTER`, task ID i work-unit ID;
- dokładny rezultat oraz maksymalnie trzy kryteria;
- zamknięty context pack i allowed paths;
- jedną komendę weryfikacyjną z oczekiwanym wynikiem;
- `Out of scope`, zakaz planowania/audytu i zakaz remote writes;
- wymagany krótki raport końcowy.

### Komenda uruchomienia

Allowed paths nie są tylko zdaniem w promptcie — Sol wstrzykuje je jako
allowlistę `edit` na czas tego jednego dispatchu:

```bash
export OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json",
  "agent":{"implementer":{"permission":{"edit":{
    "*":"deny",
    "packages/<pkg>/src/<plik>.ts":"allow",
    "packages/<pkg>/test/<plik>.test.ts":"allow"}}}}}'

opencode run --auto --print-logs --log-level INFO \
  --agent implementer \
  -m amazon-bedrock/us.anthropic.claude-opus-4-8 \
  "<prompt work unitu>" > <log> 2>&1 &
```

Zasady dispatchu:

1. `-m` podajemy **jawnie**, mimo że agent ma `model` w konfiguracji. Log musi
   potwierdzać `agent=implementer` oraz `llm.model=us.anthropic.claude-opus-4-8`.
   Agent z `mode: subagent` byłby przez `opencode run --agent` odrzucony z cichym
   fallbackiem na agenta i model domyślny — dlatego agent ma `mode: all`, a Sol
   sprawdza log, a nie ufa flagom.
2. `--auto` jest wymagane, bo sesja nieinteraktywna nie ma komu odpowiedzieć na
   `ask`. Bezpieczeństwo daje `deny`, nie brak `--auto`.
3. Uruchamiamy w tle z logiem do pliku i pollujemy log. Wynik agenta pojawia się w
   logu dopiero na końcu tury — cisza w logu to nie awaria.
4. Ścieżka spoza allowlisty kończy się odmową harnessu, którą implementer widzi
   jako błąd narzędzia. To jest oczekiwane i **nie** jest powodem do poszerzenia
   allowlisty w trakcie sesji.
5. `edit` liczy się per plik, więc allowlista musi zawierać każdy plik, który unit
   ma prawo utworzyć — również testy i `package.json`, jeżeli unit ich dotyczy.

### Czego harness nie egzekwuje

`bash` implementera jest szeroki, bo musi uruchamiać `pnpm`, `node` i `git
status/diff`. Deny na `read`/`edit` można więc obejść `cat`em albo przekierowaniem.
Permissions są **defense in depth**, a autorytatywną kontrolą pozostaje porównanie
rzeczywistego diffu z allowlistą przez Sol przed akceptacją unitu.

## Raport implementera

Implementer zwraca:

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

### Nigdy nie uruchamiaj drugiej sesji dla tego samego unitu „na wyczucie"

Brak plików w repozytorium **nie jest** dowodem, że implementer padł. Implementer
może długo czytać context pack i projektować rozwiązanie przed pierwszym zapisem;
rozmiar transcriptu też nic nie rozstrzyga.

Jedyne bezpieczne przesłanki zakończenia sesji:

1. jawny raport końcowy implementera;
2. status `killed` albo `failed` zgłoszony przez harness;
3. odpowiedź implementera na status check.

### Deterministyczny sygnał życia (od ADR-0006)

Dispatch przez `opencode run` w tle daje Solowi twarde przesłanki, których
poprzedni transport nie miał. Zamiast zgadywać, sprawdzaj:

```bash
pgrep -f "agent implementer"    # proces sesji żyje?
ls -l <log>                     # log rośnie?
tail -5 <log>                   # ostatnie wywołanie narzędzia i timestamp
```

Żywy proces oznacza żywą sesję, nawet jeśli w repozytorium nie ma jeszcze żadnego
pliku, a log nie rósł od kwadransa. Zniknięcie procesu z jednoczesnym brakiem
raportu w logu oznacza realną awarię — dopiero to jest podstawą do ponowienia.

Przy wątpliwości koordynator wysyła status check i **czeka**. Uruchomienie drugiej
sesji na tej samej allowliście łamie single-writer i grozi przeplecionym zapisem
dwóch sesji do jednego pliku.

**Brak odpowiedzi na status check nie jest odpowiedzią.** Implementer odbiera
wiadomość dopiero przy następnej turze narzędziowej, więc cisza oznacza „pracuje",
nie „padł". Długi czas bez zapisu na dysk również nic nie rozstrzyga: implementer
może kwadranse czytać kontekst, projektować i uruchamiać testy, nie tworząc
plików.

### Zatrzymanie sesji to decyzja, nie diagnoza

Jeżeli koordynator musi zatrzymać implementera — na przykład dlatego, że właściciel
polecił pauzę — wolno mu to zrobić, ale musi to zapisać jako **własną decyzję z
podaną przyczyną**, nigdy jako wniosek „agent nie żyje". Różnica jest praktyczna:
decyzja o zatrzymaniu wymaga odnotowania, że praca unitu jest do powtórzenia,
podczas gdy fałszywa diagnoza awarii prowadzi do przyjęcia niedokończonego kodu
albo do uruchomienia duplikatu.

### Dwa udokumentowane naruszenia tej reguły

Oba `2026-08-20`, oba przez koordynatora, oba bez szkody w kodzie — ale obrazują,
jak łatwo tę regułę złamać:

1. **`RA-012-WU-02`** — koordynator uznał żywą sesję za martwą (transcript stał na
   159 bajtach, brak plików ~15 minut) i wystartował duplikat na tej samej
   allowliście. Pierwsza sesja ukończyła unit poprawnie. Weryfikacja braku szkody:
   pełna suite pakietu, mutation testing i całe repo zielone.
2. **`RA-012-WU-05`** — koordynator zatrzymał sesję po braku odpowiedzi na status
   check i 43 minutach bez zapisu. Agent w tym momencie pisał „Typecheck passes.
   Now the test suite." Praca unitu przepadła i wymaga powtórzenia.

Szczegóły w `docs/work-units/RA-012/WORK_UNITS.md` i
`docs/handoffs/RA-012/HANDOFF-01.md`. Drugi przypadek zdarzył się **po** zapisaniu
pierwszej wersji tej reguły, co pokazuje, że sama zasada „pytaj i czekaj" była
zbyt miękka — stąd jawne rozdzielenie decyzji od diagnozy powyżej.
- Historia Luny nie jest wznawiana między units; źródłem prawdy pozostaje repo.
- Po dwóch nieudanych próbach tego samego celu Sol dokumentuje finding i zmienia
  strategię podziału zamiast powtarzać identyczny prompt.
