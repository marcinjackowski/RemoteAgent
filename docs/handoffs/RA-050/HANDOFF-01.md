# RA-050 — HANDOFF-01

- Task: `RA-050` Codex CLI subscription adapter
- Data: `2026-08-28`
- Bazowy commit: `3c8d2eaa01eddf3e7e56c6925e1ec1aa02fe6d24`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

RemoteAgent ma bezpieczny adapter oficjalnego Codex CLI używający logowania
subskrypcją ChatGPT zamiast API key. Adapter pinuje wspieraną wersję, exact
model/profile, strict config, read-only sandbox i JSONL/output schema. Każde
wywołanie powstaje w pustym ephemeral katalogu bez worktree, shella, sieci, MCP,
apps, hooks, subagentów lub pamięci.

Model może zwrócić wyłącznie strict final envelope albo jedną propozycję toola.
Propozycja jest walidowana jako dane i wykonywana przez istniejący code-owned
bounded tool loop z dotychczasowymi fence/path/receipt boundaries. Auth proof i
exact invocation descriptor są sprawdzane przed operation `STARTED` oraz ponownie
przed procesem.

## Inwarianty do zachowania

- Codex uruchamia tylko canonical executable w dokładnie wspieranej wersji;
  żadnego shella, wrappera, OpenCode ani custom endpointu.
- Akceptowane jest wyłącznie `codex login` przez ChatGPT. API-key status/env,
  unknown auth i logout failują bez fallbacku.
- CLI nie może otrzymać Engineering worktree ani built-in write/shell/network/
  MCP authority. `read-only` sandbox i wszystkie no-authority flagi są
  load-bearing.
- Response schema digest obejmuje exact output schema oraz code-owned tools.
  Foreign tool, built-in tool event, malformed JSONL albo identity mismatch są
  terminalną odmową, nigdy częściowym success.
- Przed każdym modelowym `STARTED` musi istnieć pozytywny subscription preflight
  i wymagany exact invocation descriptor; recovery nie zmienia profilu/modelu.
- Timeout, cancel i lease loss kończą cały process tree; raw reasoning/prose,
  stderr i credentials nie trafiają do journala.
- Brak bindingu Codex/Claude pozostaje odmową. Bedrock conversation nie może być
  użyty jako Engineering fallback.

## Dowód

```text
pełna real-PG bramka                2987/2987, 236/236, 1 live skipped, exit 0
build --force                       28/28, 0 cached, exit 0
typecheck --force                   44/44, 0 cached, exit 0
lint / format / diff-check          exit 0
workflow:validate                   OK — 53 tasks
audit                               AUDIT-01 PASS
```

## Wejście do RA-051

RA-051 implementuje analogiczny, ale niezależny adapter oficjalnego Claude Code:

- używa provider-neutralnego `runSubscriptionProcess` i nie kopiuje procesu;
- dowodzi subscription OAuth i odrzuca API key/token oraz Bedrock/Vertex/Foundry
  przed `STARTED`;
- izoluje user/project settings, hooks, MCP i built-in tools;
- pinuje wersję/model/profile i strict event/structured-output contract;
- zachowuje ten sam pre-intent proof, process-tree kill, content-free events i
  fake-binary/mutation evidence;
- nie przypisuje jeszcze modeli do ról. Immutable DESIGNER/IMPLEMENTER/REVIEWER/
  VERIFIER routing pozostaje wyłącznie RA-052.

## Decyzje i ślepe uliczki

- Nie używamy OpenCode, API tokenów ani automatycznego fallbacku.
- RA-050 kwalifikuje adapter, lecz production main celowo nie wybiera jeszcze
  profilu Codex dla żadnej roli; brak routingu jest fail-closed do RA-052.
- Codex `0.147.0` nie daje w JSONL stabilnego typed quota code. Adapter nie
  parsuje prose i mapuje provider/quota failure do jednego bezpiecznego,
  nieretrywalnego outcome.
- W tym tasku nie wykonano żadnego live model callu. Sprawdzono tylko lokalne,
  niemodelowe control surfaces klienta; właściwa kwalifikacja live pozostaje
  osobnym opt-in etapem RA-053.

## Granice zewnętrzne

Nie wykonano push, MR, Jira, Discord ani żadnego live model call.
