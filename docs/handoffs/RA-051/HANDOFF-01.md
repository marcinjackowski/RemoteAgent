# RA-051 — HANDOFF-01

- Task: `RA-051` Claude Code subscription adapter
- Data: `2026-08-28`
- Bazowy commit: `12c20a7b9717d8a4b3f02170b865b4a0cb62907e`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

RemoteAgent ma bezpieczny adapter oficjalnego Claude Code używający lokalnego
logowania subskrypcją Claude zamiast Anthropic API key, Bedrock, Vertex,
Foundry albo OpenCode. Adapter pinuje wspierane wersje, exact model/profile,
restricted/safe/plan mode, code-owned settings, empty MCP/tool surface i strict
stream-JSON/output-schema contract.

Każde wywołanie działa w nowym pustym ephemeral katalogu bez Engineering
worktree. Model może zwrócić wyłącznie strict final envelope albo jedną
propozycję toola. Propozycja jest walidowana jako dane i wykonywana przez
istniejący provider-neutral bounded tool loop z dotychczasowymi fence/path/
receipt boundaries. Auth proof i exact invocation descriptor są sprawdzane
przed operation `STARTED` oraz ponownie bezpośrednio przed procesem.

## Inwarianty do zachowania

- Claude uruchamia tylko canonical executable w jawnie wspieranej wersji;
  żadnego wrappera, shella, OpenCode ani custom endpointu.
- Akceptowany jest wyłącznie `claude.ai` + `firstParty` login. API-key env,
  auth/OAuth token injection, console/third-party i cloud-provider mode failują
  bez fallbacku.
- Nie wolno dodać `--bare`: oficjalny klient pomija wtedy subscription
  OAuth/keychain i wymaga API/provider credentials.
- CLI nie otrzymuje worktree ani built-in write/shell/network/MCP authority.
  `system/init` musi potwierdzić exact model, `apiKeySource=none`, plan mode oraz
  puste tools/MCP/plugins/skills/slash commands.
- Response digest obejmuje exact output schema oraz code-owned tools. Foreign
  tool, built-in tool event, malformed stream lub identity mismatch są
  terminalną odmową, nigdy częściowym success.
- Przed każdym modelowym `STARTED` musi istnieć pozytywny subscription preflight
  i exact invocation descriptor; recovery nie zmienia profilu/modelu.
- Timeout, cancel i lease loss kończą cały process tree. Raw assistant/result/
  error prose, stderr, dane konta i credentials nie trafiają do journala.
- Brak bindingu Codex/Claude pozostaje odmową. Bedrock conversation nie może być
  użyty jako Engineering fallback.

## Dowód

```text
pełna real-PG bramka                3039/3039, 240/240, 1 live skipped, exit 0
build --force                       29/29, 0 cached, exit 0
typecheck --force                   46/46, 0 cached, exit 0
lint / format / diff-check          exit 0
workflow:validate                   OK — 53 tasks
audit                               AUDIT-01 PASS
```

## Wejście do RA-052

RA-052 jest jedynym właścicielem produkcyjnego routingu modeli:

- strict config mapuje każdą rolę DESIGNER/IMPLEMENTER/REVIEWER/VERIFIER na
  nazwany, już zakwalifikowany profil Codex albo Claude;
- route/profile/provider/model/client/config digest musi być durable przed call
  i nie może być zmieniony przez prompt, Jira, model ani tool input;
- recovery używa exact pierwotnego route, a config drift lub brak klienta
  blokuje bez fallbacku;
- role mogą mieć dowolne jawne kombinacje obu adapterów; RA-052 nie kopiuje ich
  process/parser/auth implementacji;
- usage i content-free events muszą zostać przypisane do roli, slice, attempt i
  invocation w porównywalny sposób.

## Decyzje i ślepe uliczki

- Nie używamy OpenCode, API tokenów ani automatycznego fallbacku.
- `--bare` nie jest izolacją odpowiednią dla subscription auth; właściwy
  boundary to `--restricted` + `--safe-mode` + puste settings/MCP/tools.
- Wersja lokalnego Claude Code `2.1.247` oraz lokalny auth
  `third_party` nie spełniają kontraktu. Adapter słusznie odmówi live callu;
  nie aktualizowano klienta, nie logowano konta i nie czytano credential storage.
- RA-051 kwalifikuje adapter, ale production main celowo nie wybiera jeszcze
  profilu Claude dla żadnej roli. Brak routingu jest fail-closed do RA-052.
- W tasku nie wykonano żadnego live model callu. Właściwa kwalifikacja live
  pozostaje osobnym opt-in etapem RA-053.

## Granice zewnętrzne

Nie wykonano push, MR, Jira, Discord ani żadnego live model call.
