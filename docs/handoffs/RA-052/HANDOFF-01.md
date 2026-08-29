# RA-052 — HANDOFF-01

- Task: `RA-052` Configurable Engineering role routing and recovery
- Data: `2026-08-29`
- Bazowy commit: `2dac08ed7de7add60dee27d518e771fddda62139`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

Production Engineering ma jeden strict, code-owned registry profili
subskrypcyjnych. Plik wskazany przez `RA_ENGINEERING_MODEL_CONFIG_PATH` używa
schema v2 i mapuje każdą rolę `DESIGNER`, `IMPLEMENTER`, `REVIEWER`, `VERIFIER`
na nazwany profil Codex CLI albo Claude Code. Role można przełączać niezależnie
bez zmiany workflow, promptu lub write authority.

Registry preflightuje wszystkie używane profile przed skonstruowaniem
jakiegokolwiek transportu. Każdy modelowy operation intent utrwala exact
role/provider/profile/model/client/deployment digest i role-specific config
digest. Recovery porównuje tę samą tożsamość i robi świeży subscription
preflight; config/auth/client drift blokuje bez fallbacku.

Content-free JSONL journal zapisuje rzeczywiste provider-reported tokeny per
odpowiedź oraz cumulative usage, przypisane do exact roli, slice'a, attempt i
invocation digest. Nie zapisuje promptu, stdout/stderr, executable path ani CoT.

## Inwarianty do zachowania

- Wszystkie cztery role muszą istnieć w configu i wskazywać istniejący profil;
  nie dodawać defaultu, modelowego wyboru ani pierwszego profilu jako fallback.
- Jedynymi providerami Engineering są `codex_cli` i `claude_code` przez
  oficjalne adaptery subscription CLI. API keys, OpenCode i Bedrock nie są
  fallbackiem.
- Preflight wszystkich używanych profili musi zakończyć się przed konstrukcją
  transportów; przed każdym durable model invocation route jest rewalidowana.
- Stage-to-role mapping pozostaje code-owned. `DISCOVERY`, `GATE_EXECUTION` i
  `LOCAL_COMMIT` nie mają model route.
- Exact invocation descriptor i role-specific config digest muszą istnieć przed
  call i zgadzać się podczas recovery. Drift kończy się odmową, nie zmianą
  providera.
- `SupervisorRuntime` pozostaje jedynym driverem. Adapter nie może tworzyć
  drugiego loopu, gate authority ani commita.
- Implementer zachowuje bounded tool loop: max 8 tur/32 calls, 3 tury rezerwy na
  mutację, content-free compaction i successful-mutation-after-failure.
- Journal może zawierać tylko zamknięte identyfikatory, digests, liczniki i
  decision codes. Prompt, model prose, host path, credential i CoT są zakazane.

## Dowód

```text
pełna real-PG bramka                3055/3055, 242/242, 1 live skipped, exit 0
build --force                       29/29, 0 cached, exit 0
typecheck --force                   46/46, 0 cached, exit 0
lint / format / diff-check          exit 0
workflow:validate                   OK — 53 tasks
audit                               AUDIT-01 PASS
```

## Wejście do RA-053

RA-053 jest teraz `READY` i odpowiada za kwalifikację oraz retirement:

- uruchomić deterministycznie wszystkie cztery kombinacje implementer/reviewer
  na identycznym seed/objective/gates;
- każdy opt-in live run ma użyć osobnego worktree/journal i jawnej route; live
  call wymaga osobnej decyzji właściciela, a push/MR/Jira/Discord osobnej zgody;
- raport porównuje outcome, attempts, elapsed, usage, paths/diff digest i commit
  SHA bez promptu/prose/CoT;
- brak quota/auth blokuje tylko dany run, nigdy nie uruchamia drugiego providera,
  API key, Bedrock ani OpenCode;
- usunąć Bedrock z aktywnej konfiguracji Engineering i dopiero po sprawdzeniu
  konsumentów usunąć historyczne Engineering-only zależności.

## Decyzje i ślepe uliczki

- Nie użyto live Codex, Claude, Bedrock ani OpenCode. Testy miały fake clients
  na zewnętrznej granicy oraz realny PostgreSQL/Git.
- Nie dodano automatycznego provider fallbacku. Mutacja dodająca taki fallback
  została wykryta przez quota test.
- Per-role config nie zastępuje policy implementera; jest dalej deterministycznie
  zawężany przez `engineeringImplementationRuntimeConfig`.
- Legacy conversation/Bedrock pozostaje chwilowo osobnym slotem; jego usunięcie
  z produktu jest świadomie zakresem RA-053.

## Granice zewnętrzne

Nie wykonano push, MR, Jira, Discord ani żadnego live model call.
