# Lokalny implementer Qwen przez oMLX i Codex CLI

## Cel

Lokalny Qwen wykonuje małe work units przygotowane przez Sol. Nie wybiera tasków,
nie projektuje planu i nie audytuje. Domyślny model wykonawczy:

```text
Model: Qwen3.8-27B-oQ6e-mtp
Context: 65,536
Max output: 16,384
Concurrency: 1
Memory Guard: 36 GB
Metal limit: 42,000 MB
Lightning MTP: ON
```

## Dlaczego Codex CLI

`omlx launch codex` przekazuje lokalny provider tylko do uruchamianego procesu i
nie podmienia modelu w interaktywnej sesji Sol. Codex CLI udostępnia headless
`exec`, ephemeryczną sesję, jawny sandbox, katalog roboczy i JSONL. OpenCode jest
fallbackiem, a nie domyślnym workerem.

## Preflight

Przed pierwszym work unit w danym uruchomieniu Sol sprawdza:

1. oMLX odpowiada na `http://127.0.0.1:8000`;
2. wskazany model jest załadowany i raportuje context `65,536`;
3. working tree i bazowy commit są zapisane w planie;
4. nie działa inny lokalny implementer;
5. work unit ma kompletny kontrakt i mieści się w limicie kontekstu.

### Zweryfikowana konfiguracja

Smoke z 2026-08-19 na oMLX `0.6.3rc1` zakończył się poprawnym `READY` bez
wywołania narzędzi i bez zmian plików. Użył `--ephemeral`,
`--ignore-user-config` i `-s read-only`. Bootstrap Codex zużył około `13,202`
input tokens mimo pustego context pack, dlatego jednostka nie może planować
wykorzystania pełnego okna 65k.

oMLX `0.6.3rc1` zwraca katalog modeli w standardowym polu `data`, podczas gdy
bieżący Codex zgłasza nieblokujące ostrzeżenie o brakującym polu `models` i
używa fallback metadata. `omlx launch` przekazuje procesowo
`model_context_window=65536`, a smoke mimo ostrzeżenia przeszedł. Sol ma po
aktualizacji oMLX/Codex powtórzyć smoke; błąd tool calls albo nieprawidłowe
limity blokują implementację zamiast uruchamiać cichy fallback.

## Wywołanie implementacyjne

Sol uruchamia nową sesję dla jednego unit. Prompt nie może brzmieć `continue`:

```bash
omlx launch codex --model Qwen3.8-27B-oQ6e-mtp -- \
  exec --ephemeral --ignore-user-config --json --color never \
  -s workspace-write \
  -C /Users/marcinjackowski/Private/RemoteAgent \
  "Execution role: LOCAL_IMPLEMENTER. Execute only <TASK_ID>/<WU_ID>. Read AGENTS.md and the referenced work unit. Do not plan, audit, commit, push, or edit workflow artifacts."
```

`--ignore-user-config` ogranicza przypadkowe MCP, pluginy i skills zabierające
kontekst. Procesowe ustawienia providera dodane przez `omlx launch` nadal są
przekazywane argumentami. Nie używaj bypassu sandboxa.

Do testu transportu albo analizy konfiguracji użyj `-s read-only`; taki test nie
może wykonywać bieżącego work unit.

## Context pack

Sol wskazuje w work unit zamkniętą listę dokumentów i plików. Obowiązkowe
minimum to `AGENTS.md`, sekcja konkretnego unit i bezpośrednie kontrakty kodu.
Nie dołączaj automatycznie:

- całego `MASTER_PLAN.md`, jeżeli wystarczy wskazana sekcja;
- starych handoffów i audytów niezwiązanych z unit;
- pełnych logów testów;
- innych tasków albo nieużywanych pakietów.

Jeżeli początkowy context pack przekracza 24k tokenów albo wymaga więcej niż
pięciu plików do edycji, Sol dzieli unit. Maksymalny output modelu nie jest celem;
raport powinien być krótszy niż 2k tokenów.

## Raport implementera

Qwen kończy odpowiedź wyłącznie raportem zawierającym:

- task ID i work-unit ID;
- `COMPLETED`, `BLOCKED` albo `FAILED`;
- zmienione pliki;
- uruchomioną komendę, exit code i wynik;
- ryzyka, niejasności i ewentualny Decision Request;
- jednozdaniowy następny krok dla Sol.

Raport nie zmienia stanu taska. Sol odczytuje rzeczywisty diff i nie ufa samej
deklaracji `COMPLETED`.

## Zatrzymanie i recovery

- Brak postępu, przekroczenie zakresu lub rosnący kontekst: przerwij sesję,
  zachowaj diff i rozpisz mniejszy unit.
- Częściowy diff nie jest automatycznie odrzucany. Sol ustala, czy jest spójny,
  czy należy go dokończyć nowym unit.
- Nie wznawiaj historii Qwena między units. Stan pochodzi z repozytorium i planu.
- Po dwóch nieudanych próbach tego samego unit Sol zapisuje blokadę zamiast
  bez końca powtarzać prompt.
