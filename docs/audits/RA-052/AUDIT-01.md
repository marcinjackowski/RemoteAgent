# RA-052 — AUDIT-01

- Task: `RA-052` Configurable Engineering role routing and recovery
- Data: `2026-08-29`
- Bazowy commit: `2dac08ed7de7add60dee27d518e771fddda62139`
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
                                        3055/3055, 242/242, 1 live skipped, exit 0
pnpm run typecheck --force              46/46, 0 cached, exit 0
pnpm workflow:validate                  OK — 53 tasks, exit 0
git diff --check                        exit 0
```

Pierwszy pełny przebieg zatrzymał się na `pnpm format`: pięć task-owned plików
wymagało mechanicznego Prettiera. Sformatowano tylko wskazane pliki i cały
łańcuch uruchomiono od początku do exit `0`; nie był to flake. Bramka używała
deterministycznych fake clients i realnego lokalnego PostgreSQL. Nie wykonała
model callu do Codex, Claude, Bedrock ani OpenCode.

## 2. Kryteria akceptacji

1. **Strict role config:** spełnione. Versioned schema v2 wymaga dokładnie
   `DESIGNER`, `IMPLEMENTER`, `REVIEWER` i `VERIFIER`; każda route wskazuje
   istniejący, posortowany profil. Nie ma roli ani providera domyślnego.
2. **Dowolne kombinacje:** spełnione. Registry obsługuje Codex→Claude,
   Claude→Codex, Codex→Codex i Claude→Claude. Dwa kierunki mieszane przeszły
   pełny production handler przez dwa slice'y, korektę, review i commit.
3. **Durable identity:** spełnione. Przed model call operation descriptor wiąże
   exact role/provider/profile/model/client/deployment digest, a operation
   zapisuje role-specific config digest. Stage-to-role jest code-owned i prompt,
   Jira, model oraz tool input nie mają wejścia do wyboru route.
4. **Exact recovery:** spełnione. Same-lease i cross-fence recovery porównują
   pierwotny invocation descriptor, config/schema/deadline oraz wykonują świeży
   preflight przed bezpiecznym retry modelu. Drift albo brak klienta blokuje bez
   fallbacku; gate receipts i LOCAL_COMMIT nadal odzyskują się bez powtórzenia
   command/commita.
5. **Usage i journal:** spełnione. Każda odpowiedź zapisuje content-free actual
   input/output/total tokens, provider-reported flag oraz exact
   role/slice/attempt/invocation/profile/model/client. Journal nie zawiera
   promptu, executable path, raw output ani CoT.
6. **Jeden driver:** spełnione. `createWorkerHandlers → SupervisorRuntime →
   PostgresEngineeringRuntimePort` pozostaje jedynym driverem. Registry tworzy
   wyłącznie adaptery stage/implementation/review; nie tworzy workflow, gate ani
   commita. Pełna macierz zakończyła się dokładnie jednym LocalCommitReceipt.
7. **Macierz odporności:** spełnione. Real-PG/fake-client testy pokrywają dwa
   slice'y, `CHANGES_REQUIRED → correction → PASS`, review, retry-safe model,
   gate i commit recovery, auth/quota loss, cancellation, stale lease oraz dwa
   concurrent cases z izolowanymi route'ami.
8. **Mutacje:** spełnione. RED wykazały: brak roli, foreign profile, hidden
   default, route assertion bypass, auth-before-partial-construction, identity
   mismatch, role recheck bypass, missing-config fallback, role swap,
   stage-config digest bypass, recovery invocation/preflight bypass, journal
   misattribution, review bez slice/attempt i runtime provider fallback. Każdą
   mutację przywrócono przed końcową bramką.
9. **Pełna bramka:** spełnione. Niecache'owany łańcuch zakończył się exit `0` z
   wymaganym PostgreSQL.

## 3. Security, recovery i operacyjność

Deployment config jest oddzielony od repository/write policy. Profile mogą
wybrać wyłącznie oficjalne adaptery `codex_cli` albo `claude_code`; registry
najpierw preflightuje wszystkie używane profile, a dopiero potem konstruuje
transporty. Missing config, auth refusal, API credentials, identity drift i
quota/provider failure nie uruchamiają drugiego profilu ani legacy Bedrock.

Credential storage pozostaje własnością oficjalnych klientów. RemoteAgent nie
czyta keychain/config files i nie przyjmuje API tokenów jako Engineering
authority. Existing writer lease, path cap, gate receipts, review binding,
single-writer i commit evidence nie zostały poszerzone. Implementer nadal
przechodzi przez code-owned limit 8 tur/32 calls, rezerwę 3 tur na mutację,
kompakcję historii i wymóg udanej mutacji po wcześniejszym błędzie.

## 4. Findings

Audyt sprawdził potencjalną regresję polityki tool loopu: per-profile config
jest dalej zawężany przez `engineeringImplementationRuntimeConfig`, więc reserve
i kompakcja z RA-048 pozostają aktywne. Pierwszy pełny gate ujawnił wyłącznie
opisany błąd formatowania. Nie pozostał finding klasy BLOCKER, HIGH ani MEDIUM i
nie powstał nowy finding przekrojowy do `CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie dziewięć kryteriów RA-052 jest spełnionych, a pełna niecache'owana
bramka audytowa zakończyła się exit code `0`.
