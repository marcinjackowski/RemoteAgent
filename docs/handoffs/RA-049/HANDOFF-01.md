# RA-049 — HANDOFF-01

- Task: `RA-049` Provider-neutral subscription model runtime
- Data: `2026-08-28`
- Bazowy commit: `2189f4b1911f2605a16cb1d97a34d90b099ccc59`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

Engineering ma jeden provider-neutralny runtime i bezpieczną granicę procesu
dla oficjalnych klientów subskrypcyjnych. Profile są strict, immutable i
digest-bound; proces nie używa shella ani API/cloud credential env, ma bounded
I/O, preflight, deadline, cancellation i process-tree kill. Każda przyszła
modelowa operacja może utrwalić exact provider/profile/client/model/config
przed `STARTED` i sprawdzić to samo podczas recovery.

Production Engineering nie używa już automatycznego Bedrock defaultu ani
fallbacku. Legacy transport rozmów pozostaje osobnym slotem do czasu RA-053.

## Inwarianty do zachowania

- `@remoteagent/model-runtime` jest jedynym właścicielem neutralnych typów i
  algorytmów; pakiet Bedrock może tylko adaptować lub re-exportować.
- Provider profile nie może zawierać endpointu, API key ani cloud mode. Dozwolone
  są tylko `codex_cli` i `claude_code`.
- RemoteAgent nigdy nie czyta ani nie zapisuje credential file. Właściciel loguje
  oficjalny klient poza workflow, a code-owned preflight jedynie klasyfikuje
  aktywny tryb bez zwracania sekretu.
- Nie wolno osłabić canonical executable/config, `shell:false`, secret-free env,
  globalnego deadline, process-group kill ani bounded/fatal output.
- Descriptor modelowego intentu musi powstać przed `STARTED`; recovery nie może
  przełączyć profilu, modelu, klienta ani deployment configu.
- Brak profilu jest odmową, nigdy przełączeniem na Bedrock, API credits, drugi
  provider lub OpenCode.

## Dowód

```text
pełna real-PG bramka                2947/2947, 231/231, 1 live skipped, exit 0
build --force                       27/27, 0 cached, exit 0
typecheck --force                   42/42, 0 cached, exit 0
lint / format / diff-check          exit 0
workflow:validate                   OK — 53 tasks
audit                               AUDIT-01 PASS
```

## Wejście do RA-050

RA-050 implementuje wyłącznie oficjalny, canonical `codex` adapter. Powinien:

- użyć `runSubscriptionProcess`, a nie budować drugiego spawn/runtime;
- wykonać code-owned preflight, który dowodzi logowania kontem ChatGPT i
  odrzuca API-key mode przed operation `STARTED`;
- przypiąć wspierany client version, exact model/profile, sandbox, permissions i
  JSON event mode do `SubscriptionModelInvocationDescriptorV1`;
- parsować bounded JSONL do neutralnych eventów/usage bez reasoning/prose;
- testować wyłącznie fake binary domyślnie. Live Codex pozostaje osobnym opt-in
  smoke i nie jest autoryzowany przez samo ukończenie RA-049.

RA-051 analogicznie doda Claude Code. Dopiero RA-052 konfiguruje wybór profilu
per `DESIGNER`, `IMPLEMENTER`, `REVIEWER`, `VERIFIER` i cross-fence recovery.

## Decyzje i ślepe uliczki

- Nie używamy OpenCode ani bezpośrednich API tokenów.
- Nie emulujemy subskrypcji przez OpenAI-compatible endpoint.
- Nie wybieramy jeszcze, który model jest implementerem albo reviewerem.
- W tym tasku nie uruchomiono Codexa, Claude'a ani Bedrocka live.
- OpenAI Docs potwierdziły, że logowanie planem ChatGPT należy do oficjalnego
  klienta; dlatego runtime przekazuje wyłącznie bezpieczny HOME/config path i
  nie próbuje samodzielnie pozyskiwać lub przechowywać credentiali.

## Granice zewnętrzne

Nie wykonano push, MR, Jira, Discord ani żadnego live model call.
