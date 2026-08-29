# RA-053 — AUDIT-01

- Task: `RA-053` Subscription-provider qualification and Bedrock retirement
- Data: `2026-08-29`
- Bazowy commit: `3af95886ff23a0fac344508486212e8a2d051a82`
- Audyt: pełny diff od bazowego commita, wszystkie pliki nieśledzone, kod
  wywołujący i wywoływany oraz samodzielnie uruchomiona pełna bramka zgodnie z
  `ADR-0007`

## 1. Uruchomiona bramka audytowa

Po odczycie pełnego diffu i przywróceniu wszystkich mutacji uruchomiono dokładną
bramkę taska:

```text
. scripts/dev/env.sh                    Node 24.19.0; PostgreSQL reachable
pnpm lint                               exit 0; tylko znane warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  29/29, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        3064/3064, 244/244, 1 live skipped, exit 0
pnpm run typecheck --force              46/46, 0 cached, exit 0
pnpm workflow:validate                  OK — 53 tasks, exit 0
git diff --check                        exit 0
```

Przed końcowym przebiegiem lint i format wykryły wyłącznie lokalne błędy w
nowym teście. Kolejny pełny przebieg przekroczył 120-sekundowy limit testu
czterech kombinacji przy równoległym obciążeniu całej suite; ten sam test solo
kończył się w 53.3 sekundy. Limit testowy ustawiono jawnie na 240 sekund,
celowany run przeszedł `2/2`, a pełny run wykonał scenariusz w 117.7 sekundy i
zakończył cały łańcuch exit `0`. Nie był to flake ani timeout produkcyjny.

Bramka korzystała z deterministycznej granicy fake-provider, realnego lokalnego
PostgreSQL i throwaway Git. Nie uruchomiła Codex CLI, Claude Code, Bedrock ani
OpenCode i nie zużyła tokenów subskrypcji.

## 2. Kryteria akceptacji

1. **Cztery kombinacje:** spełnione. Codex/Codex, Codex/Claude,
   Claude/Codex i Claude/Claude przechodzą ten sam production Engineering
   handler, dwa slice'y, jedną korektę, trzy świeże review, gate'y i dokładnie
   jeden lokalny commit na run. Seed, objective, gate i scenario digest są
   identyczne.
2. **Izolowany live opt-in:** spełnione. Live iOS test pozostaje domyślnie
   pominięty i wymaga flagi, unikalnego invocation ID oraz jawnych nazw profili
   IMPLEMENTER i REVIEWER. Nowy case daje nowy workspace/worktree, journal jest
   tworzony wyłącznie przez exclusive create, source HEAD pozostaje bez zmian,
   a push, MR, Jira i Discord nie są wykonywane.
3. **Raport:** spełnione. Strict schema v1 utrwala outcome, gate/review attempts,
   elapsed time, content-free provider usage związane z exact invocation
   digest, posortowane changed paths, diff digest, commit SHA i własny
   weryfikowany report digest. Nie przyjmuje promptu, prose, raw outputu, host
   path ani CoT.
4. **Bounded refusal bez fallbacku:** spełnione. Subscription registry robi
   preflight exact profilu, a auth/quota failure nie konstruuje drugiego
   providera. Missing Engineering config kończy się odmową; API-key login,
   legacy conversation, Bedrock i OpenCode nie są alternatywną route.
5. **Brak Bedrock w Engineering:** spełnione. `worker.ts`, `roles.ts` i wszystkie
   produkcyjne moduły `engineering-*` nie importują ani nie konstruują Bedrock
   lub OpenCode. Stare Bedrock env vars nie wpływają na strict subscription
   config, a OpenCode jest odrzucane przez zamknięty schema providerów.
6. **Historyczne zależności:** spełnione. Historyczne `createBedrock*` aliasy
   usunięto, testy Engineering używają provider-neutral `model-runtime` i nie ma
   już Engineering-only Bedrock konsumenta. Pakiet Bedrock pozostaje wyłącznie
   dla jawnie nazwanego właściciela `CONVERSATION_REPLY_LOOP`; jego config,
   env i transport są zamknięte w `legacy-conversation-model.ts` poza
   Engineering composition.
7. **Mutacje:** spełnione. RED potwierdziły route disconnect, hidden fallback,
   stale Bedrock env influence, OpenCode acceptance po rebuildzie, reuse live
   journal root, profile mismatch, usage bez exact identity, report digest
   bypass oraz Bedrock identifier w produkcyjnej granicy. Wszystkie zmiany
   przywrócono przed końcową bramką.
8. **Pełna bramka i audyt M10:** spełnione. Niecache'owany łańcuch zakończył się
   exit `0`, a niniejszy audyt całego diffu nie znalazł otwartego findingu
   BLOCKER, HIGH ani MEDIUM.

## 3. Security, recovery i operacyjność

Credential storage pozostaje własnością oficjalnych klientów. RemoteAgent nie
czyta plików auth/keychain i nie przyjmuje API tokenu jako authority. Exact
role/provider/profile/model/client/config identity pozostaje durable przed model
call i jest ponownie sprawdzana przy retry/recovery. Existing writer lease, path
cap, gate receipts, review binding, single-writer i evidence-bound commit nie
zostały poszerzone.

Oficjalna dokumentacja OpenAI potwierdza, że lokalny Codex CLI wspiera
`codex login` przez ChatGPT dla dostępu subskrypcyjnego, osobno od logowania API
key. Implementacja korzysta wyłącznie z pierwszego wariantu i w preflight
odrzuca inną metodę auth.

## 4. Findings

Audyt przeczytał pełny diff od bazy, nowe pliki, production composition i
kwalifikacyjne testy; werdykt pochodzi z własnego uruchomienia bramki, nie z
raportu implementacyjnego. Znaleziono i naprawiono jedynie lokalne lint/format
oraz zbyt niski timeout testowego agregatu pod pełnym obciążeniem. Nie pozostał
finding klasy BLOCKER, HIGH ani MEDIUM i nie powstał nowy finding przekrojowy do
`CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie osiem kryteriów RA-053 jest spełnionych, a pełna niecache'owana
bramka audytowa zakończyła się exit code `0`.
