# RA-050 — AUDIT-01

- Task: `RA-050` Codex CLI subscription adapter
- Data: `2026-08-28`
- Bazowy commit: `3c8d2eaa01eddf3e7e56c6925e1ec1aa02fe6d24`
- Audyt: pełny diff od bazowego commita, wszystkie pliki nieśledzone, kod
  wywołujący i wywoływany oraz samodzielnie uruchomiona pełna bramka zgodnie z
  `ADR-0007`

## 1. Uruchomiona bramka audytowa

Po odczycie całego diffu i przywróceniu wszystkich mutacji uruchomiono dokładną
bramkę taska:

```text
. scripts/dev/env.sh                    Node 24.19.0; PostgreSQL reachable
pnpm lint                               exit 0; tylko znane warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  28/28, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        2987/2987, 236/236, 1 live skipped, exit 0
pnpm run typecheck --force              44/44, 0 cached, exit 0
pnpm workflow:validate                  OK — 53 tasks, exit 0
git diff --check                        exit 0
```

Live test jest jawnie opt-in i pozostał pominięty. Bramka używała wyłącznie
deterministycznych fake binaries oraz realnego lokalnego PostgreSQL; nie
wykonała model callu do Codex, Claude, Bedrock ani OpenCode.

## 2. Kryteria akceptacji

1. **Pinned official CLI:** spełnione. Adapter uruchamia canonical executable
   przez exact argv `codex exec`, `shell:false`, przypina wersję `0.147.0`, model,
   strict/ignored user config, ephemeral JSONL, read-only sandbox i code-owned
   output schema w osobnym pustym katalogu.
2. **Subscription preflight:** spełnione. Exact `--version` i `login status`
   akceptują wyłącznie `Logged in using ChatGPT`; API-key env/status, logout,
   obcy provider, nieznany status oraz version drift failują przed odczytem
   kontekstu, intentem i `STARTED`. Proces powtarza proof bezpośrednio przed
   spawnem.
3. **Strict JSONL:** spełnione. Parser ma limity eventów, tekstu, identyfikatorów,
   tokenów, głębokości i liczby węzłów. Wymusza jeden session/turn/final envelope,
   mapuje usage i content-free outcomes oraz nie zwraca reasoning, todo ani
   stderr.
4. **Deny-by-default tools:** spełnione. Built-in shell/file/MCP/web są wyłączone
   w configu i każda obserwacja takiego eventu failuje jako
   `TOOL_BOUNDARY_VIOLATION`. Jedyny modelowy tool request jest danymi związanymi
   exact schema/tool digestem i trafia do istniejącego code-owned bounded tool
   loopu; CLI nie otrzymuje worktree.
5. **Cancellation:** spełnione. Deadline i abort kończą detached process group
   TERM/KILL, również dla osobnych preflight commands; invocation root jest
   usuwany w `finally`, a przerwanie nie może zwrócić success.
6. **Fake-binary coverage:** spełnione. Testy obejmują split chunks, bounded
   argv/env/stdin/stdout/stderr, malformed/provider/quota output, strict usage i
   session, version/auth drift, tool round-trip oraz parent+descendant kill.
7. **Mutacje:** spełnione. RED potwierdzono dla auth/version/API-env, sandbox i
   shell flag, schema/tool digest, foreign/built-in tool, transcript ordering i
   structural bound, parser→tool-loop bypass, parent-only kill obu typów procesu,
   disconnected worker constructor, pre-intent preflight, invocation identity i
   obowiązkowego stage descriptoru. Wszystkie mutacje przywrócono.
8. **Pełna bramka:** spełnione. Niecache'owany łańcuch zakończył się exit `0` z
   wymaganym PostgreSQL.

## 3. Security, recovery i operacyjność

RemoteAgent przekazuje wyłącznie allowlistę niesekretnych zmiennych potrzebnych
oficjalnemu klientowi do użycia loginu przechowywanego przez klienta/OS. Nie
czyta credential files ani keychain, nie przyjmuje API key i nie zapisuje OAuth
tokenu. Prompt, raw stdout/stderr, chain-of-thought i tool prose nie mieszczą się
w normalized journalu.

Model invocation descriptor jest związany przed `STARTED` z rolą, providerem,
profilem, wersją klienta, modelem i digestami executable/deployment/profile.
Recovery porównuje exact descriptor. Produkcyjny binding reparsuje wymagany
descriptor każdego modelowego etapu; brak proofu lub descriptoru kończy się
odmową. Legacy Bedrock conversation pozostaje osobnym slotem i nie jest
fallbackiem Engineering.

## 4. Findings

W pre-audit domknięto trzy fail-open edges: preflight przed trwałym `STARTED`,
bounded provider JSON recursion oraz utrzymanie TERM→KILL timera aż do wyjścia
całej grupy procesu kontrolnego. Każda poprawka ma load-bearing mutation check.
Nie pozostał finding klasy BLOCKER, HIGH ani MEDIUM i nie powstał nowy finding
przekrojowy do `CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie osiem kryteriów RA-050 jest spełnionych, a pełna niecache'owana
bramka audytowa zakończyła się exit code `0`.
