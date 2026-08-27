# RA-049 — AUDIT-01

- Task: `RA-049` Provider-neutral subscription model runtime
- Data: `2026-08-28`
- Bazowy commit: `2189f4b1911f2605a16cb1d97a34d90b099ccc59`
- Audyt: pełny diff od bazowego commita, wszystkie pliki nieśledzone, kod
  wywołujący i wywoływany oraz samodzielnie uruchomiona pełna bramka zgodnie z
  `ADR-0007`

## 1. Uruchomiona bramka audytowa

Po odczycie całego diffu i przywróceniu wszystkich mutacji uruchomiono od
początku dokładną bramkę taska:

```text
. scripts/dev/env.sh                    Node 24.19.0; PostgreSQL reachable
pnpm lint                               exit 0; tylko znane warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  27/27, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        2947/2947, 231/231, 1 live skipped, exit 0
pnpm run typecheck --force              42/42, 0 cached, exit 0
pnpm workflow:validate                  OK — 53 tasks, exit 0
git diff --check                        exit 0
```

Pierwszy pełny przebieg był również zielony, ale końcowy odczyt wykrył mutable
`Map` profili obok niezmiennego config digestu. Zastąpiono go niezmiennym
widokiem, mutacja przywracająca zwykły `Map` dała RED, a powyższa pełna bramka
została uruchomiona ponownie na finalnym kodzie.

## 2. Kryteria akceptacji

1. **Neutralne kontrakty:** spełnione. `@remoteagent/model-runtime` jest jednym
   właścicielem configu, transportu, retry, streamu, structured completion,
   tool loopu, identity, usage, events i terminal outcomes. Nie importuje AWS
   ani Bedrock; pakiet Bedrock zachowuje wyłącznie adaptery AWS i re-export.
2. **Strict profile config:** spełnione. Dopuszczone są wyłącznie nazwane,
   posortowane `codex_cli` i `claude_code`. Unknown fields, `bedrock`,
   `opencode`, endpoint i API key są odrzucane. Profile, tablica, config i lookup
   są runtime-immutable i związane canonical digestem.
3. **Process boundary:** spełnione. Canonical executable, bounded argv/stdin/
   stdout/stderr, `shell:false`, allowlista env, jeden deadline obejmujący
   preflight i proces, cancel oraz TERM/KILL całej grupy procesów są
   load-bearing. Niepoprawny UTF-8 failuje zamknięcie.
4. **Subscription preflight:** spełnione na neutralnej granicy. Preflight jest
   code-owned, bounded i musi potwierdzić exact provider/profile/model/client;
   API/cloud credential env jest odrzucany, a RemoteAgent nie czyta ani nie
   zapisuje vendor credential file. Konkretne oficjalne proofy powstaną w
   RA-050 i RA-051.
5. **Brak Bedrock fallbacku:** spełnione dla Engineering. Production ma osobny
   slot legacy conversation i osobny jawny `OFFICIAL_SUBSCRIPTION_CLI` slot.
   Brak drugiego daje `null` i odmowę; transport rozmów nie jest używany jako
   Engineering fallback.
6. **Recovery binding:** spełnione. Przed `STARTED` intent może utrwalić role,
   provider, profile, client version, model, executable digest, deployment
   config digest i profile digest. Same-current-lease recovery odczytuje ten
   descriptor i odmawia po jakiejkolwiek zmianie przed invoke. Cross-fence
   routing obu adapterów należy zgodnie z kolejką do RA-052.
7. **Mutacje:** spełnione. RED potwierdzono dla provider/field allowlist,
   credential/env isolation, shell, canonical executable/config, process-tree
   kill, output bound/UTF-8, bounded preflight, exact auth identity, immutable
   lookup, neutral-runtime identity, Bedrock fallback oraz trwałego descriptoru
   i recovery comparison. Wszystkie mutacje przywrócono.
8. **Pełna bramka:** spełnione. Finalny niecache'owany łańcuch zakończył się
   exit `0` z realnym PostgreSQL.

## 3. Security, recovery i operacyjność

Proces dostaje tylko niezbędne ścieżki środowiska (`HOME`, `PATH`, temp, locale,
terminal i opcjonalny XDG config), dzięki czemu oficjalny klient może użyć
własnego, wcześniej utworzonego logowania subskrypcyjnego. RemoteAgent nie
przekazuje API key, auth token, cloud mode ani custom endpointu. Argv nie
przechodzi przez shell, output jest bounded i fatalnie dekodowany jako UTF-8,
a journal może reprezentować jedynie content-free stany i identity.

RA-049 celowo nie implementuje parsera ani argumentów konkretnego klienta i nie
wykonuje live call. Nie powstał więc nowy zewnętrzny side effect ani nowa ścieżka
credential storage. Legacy Bedrock pozostaje tylko dla istniejących ról
rozmownych do czasu RA-053; Engineering jest od niego odłączony już teraz.

## 4. Findings

W audycie zamknięto mutable profile lookup przy zachowanym starym digestcie.
Load-bearing mutacja zwykłego `Map` dała RED. Nie pozostał finding klasy
BLOCKER, HIGH ani MEDIUM i nie powstał nowy finding przekrojowy do
`CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie osiem kryteriów RA-049 jest spełnionych, a pełna niecache'owana
bramka audytowa zakończyła się exit code `0`.
