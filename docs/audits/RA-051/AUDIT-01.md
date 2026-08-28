# RA-051 — AUDIT-01

- Task: `RA-051` Claude Code subscription adapter
- Data: `2026-08-28`
- Bazowy commit: `12c20a7b9717d8a4b3f02170b865b4a0cb62907e`
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
pnpm run build --force                  29/29, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        3039/3039, 240/240, 1 live skipped, exit 0
pnpm run typecheck --force              46/46, 0 cached, exit 0
pnpm workflow:validate                  OK — 53 tasks, exit 0
git diff --check                        exit 0
```

Pierwszy pełny przebieg zatrzymał się na deterministycznym błędzie ESLint
`prefer-const` w nowym współdzielonym control runnerze, zanim wykonał build albo
testy. Konstrukcję procesu poprawiono bez zmiany kontraktu i pełny łańcuch
uruchomiono od początku do exit `0`; nie był to flake.

Live test jest jawnie opt-in i pozostał pominięty. Bramka używała wyłącznie
deterministycznych fake binaries oraz realnego lokalnego PostgreSQL; nie
wykonała model callu do Claude, Codex, Bedrock ani OpenCode.

## 2. Kryteria akceptacji

1. **Pinned official CLI:** spełnione. Adapter uruchamia canonical executable
   przez exact `claude -p`, akceptuje tylko allowlistę wersji `2.1.248` i
   `2.1.250`, pinuje profil/model, restricted/safe/plan mode, stream JSON,
   code-owned settings, pusty MCP config, schema i UUID sesji. Nie ma
   `--bare`, fallback modelu, browsera ani session persistence.
2. **Subscription preflight:** spełnione. Exact `--version` oraz
   `auth status --json` akceptują tylko `loggedIn=true`,
   `authMethod=claude.ai`, `apiProvider=firstParty`. API key, auth/OAuth token,
   console/third-party auth oraz Bedrock, Vertex i Foundry failują przed
   procesem i przed trwałym `STARTED`.
3. **Settings/tool isolation:** spełnione. Claude działa w pustym ephemeral
   katalogu bez worktree. User/project setting sources, hooks, MCP, plugins,
   skills, slash commands i built-in tools są wyłączone; `system/init` musi
   potwierdzić pustą powierzchnię. Modelowy tool request jest wyłącznie
   schema-digest-bound propozycją dla code-owned bounded loopu.
4. **Strict parser:** spełnione. Parser ma limity zdarzeń, głębokości, węzłów,
   identyfikatorów i tokenów; wymusza init jako pierwszy i result jako ostatni,
   exact sesję/client/model/cwd/first-party usage oraz brak permission denial.
   Auth, quota/provider retry, niezerowy terminal provider failure, malformed i
   partial output mapują się do content-free outcomes. Assistant/result/stderr
   prose nie jest zwracane ani journalowane.
5. **Recovery i cancellation:** spełnione. Każde wywołanie ma nowy exact UUID i
   powtórzony profile/auth proof; no-session-persistence uniemożliwia niejawne
   wznowienie. Invocation descriptor wiąże role/provider/profile/client/model i
   deployment digest przed `STARTED`. Timeout/abort kończy detached process
   group TERM→KILL, usuwa invocation root i nigdy nie przełącza providera.
6. **Fake-binary coverage:** spełnione. Testy obejmują credential precedence,
   version/auth drift, strict settings/MCP/argv, split stdout, malformed oraz
   nonzero provider result, forged session/model/cwd/provider usage, deep JSON,
   tool round-trip i parent+descendant kill.
7. **Mutacje:** spełnione. RED potwierdzono dla auth/version/API-cloud env,
   restricted/tools/settings isolation, schema i declared-tool digest,
   foreign/built-in tool, parser session/model/provider/failure binding,
   parser→tool-loop bypass, parent-only kill, disconnected worker constructor
   i foreign pre-intent invocation identity. Wszystkie mutacje przywrócono.
8. **Pełna bramka:** spełnione. Niecache'owany łańcuch zakończył się exit `0` z
   wymaganym PostgreSQL.

## 3. Security, recovery i operacyjność

RemoteAgent przekazuje wyłącznie allowlistę niesekretnych zmiennych potrzebnych
oficjalnemu klientowi do użycia loginu przechowywanego przez klienta/OS. Nie
czyta credential files ani keychain, nie przyjmuje API key lub wstrzykniętego
OAuth tokenu i nie zapisuje danych konta. Prompt, raw stdout/stderr,
chain-of-thought i provider error prose nie mieszczą się w normalized journalu.

Współdzielony runner kontrolny zachowuje canonical executable, bounded argv,
env/output/deadline oraz process-tree kill dla Codex i Claude. Claude parser
dodatkowo dowodzi w `system/init`, że uruchomiony klient faktycznie użył exact
modelu, first-party credential source i pustej powierzchni rozszerzeń.

Worker udostępnia Claude jako jawny subscription slot, ale RA-051 nie wybiera
żadnej roli. Legacy conversation/Bedrock pozostaje osobnym slotem i nie jest
fallbackiem Engineering. Immutable mapowanie profili do DESIGNER/IMPLEMENTER/
REVIEWER/VERIFIER jest wyłączną odpowiedzialnością RA-052.

## 4. Findings

W pre-audit domknięto obsługę terminalnego Claude `result:error` przy niezerowym
exit code: kod zachowuje wyłącznie `PROVIDER_FAILED` i odrzuca prose. Pierwszy
pełny gate ujawnił wyłącznie opisany błąd lint, poprawiony i zweryfikowany pełnym
powtórzeniem. Nie pozostał finding klasy BLOCKER, HIGH ani MEDIUM i nie powstał
nowy finding przekrojowy do `CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie osiem kryteriów RA-051 jest spełnionych, a pełna niecache'owana
bramka audytowa zakończyła się exit code `0`.
