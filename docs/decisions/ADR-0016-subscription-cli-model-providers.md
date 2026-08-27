# ADR-0016 — Subscription CLI model providers

- Status: `ACCEPTED`
- Data: `2026-08-27`
- Zastępuje dla Engineering: część `ADR-0011` i Master Planu wiążącą runtime z Bedrock
- Uzupełnia: `ADR-0015`
- Taski: `RA-049`–`RA-053`

## Kontekst

Kwalifikacja RA-048 dowiodła działania bezpiecznego Engineering Control Plane,
ale płatne smoke tests przez Bedrock były kosztowne, zależne od dostępu
organizacyjnego i nie dają właścicielowi oczekiwanej swobody porównywania modeli.
Właściciel ma subskrypcje obejmujące oficjalne klienty Codex i Claude Code i chce
wybierać podczas eksperymentów, który klient wykonuje implementację, review i
pozostałe role. Użycie ma obciążać subskrypcję, nie API key ani cloud-provider
billing.

OpenCode upraszcza wspólny interfejs wielu providerów, lecz nie jest oficjalnym
klientem Anthropic. Nie może być pośrednikiem Claude subscription credentials.
RemoteAgent nie może też kopiować, przechowywać ani odświeżać vendorowych OAuth
credentials.

## Decyzja

1. Engineering dostaje provider-neutralny port wykonania modelu. Jego kontrakt
   opisuje role, structured result, usage, session identity, terminal outcome i
   bounded normalized events; nie opisuje Bedrock Converse.
2. Wspierane backendy to wyłącznie opublikowane, niezmodyfikowane binaria:
   `codex` i `claude`. RemoteAgent uruchamia je bezpośrednio przez argument vector,
   nigdy przez shell command string ani OpenCode.
3. Uwierzytelnienie jest wykonane przez właściciela w oficjalnym flow klienta i
   przechowywane przez klienta/OS. RemoteAgent nie odczytuje credential files ani
   keychain, nie przyjmuje API key w configu i nie zapisuje OAuth tokenu w DB,
   journalu ani env fixture.
4. Adapter fail-closuje, jeżeli aktywne jest API-key/cloud-provider auth albo
   provider nie potwierdza subscription login. Nie ma automatycznego przejścia na
   API credits, Bedrock, OpenCode ani drugi model po quota/auth failure.
5. Code-owned deployment config definiuje nazwane profile i osobny route dla
   `DESIGNER`, `IMPLEMENTER`, `REVIEWER` i `VERIFIER`. Test może wybrać dowolną
   dozwoloną kombinację Codex/Claude. Model, prompt, Jira ani tool input nie mogą
   zmienić routingu.
6. Exact provider kind, client version, model identity, profile/config digest i
   rola są wiązane z operation intent przed wywołaniem. Recovery używa tego samego
   profilu; zmiana profilu wymaga nowej operacji/runu.
7. Oficjalny klient nie dostaje szerszej authority niż obecny Engineering.
   Built-in writes, shell, network i MCP są deny-by-default. Jeśli rola wymaga
   narzędzi, klient widzi wyłącznie per-invocation code-owned bridge do bounded
   tools; durable receipts, writer fence, path cap, gates i Git pozostają
   autorytatywne po stronie RemoteAgent.
8. Każde wywołanie ma osobny content-free journal. Normalizujemy provider events,
   usage, elapsed time, tool receipts i wynik, lecz nie zapisujemy promptów, raw
   model prose, chain-of-thought ani credentials.
9. Bedrock zostaje najpierw odłączony od production Engineering composition, a po
   kwalifikacji obu oficjalnych klientów jego adapter i zależności są usuwane.
   Do tego czasu istniejący kod może pozostać wyłącznie jako nieosiągalna ścieżka
   historyczna/testowa. Live Bedrock tests są wstrzymane.

## Odrzucone alternatywy

- **OpenCode jako wspólna brama:** dodaje trzeci control plane i nie jest
  dozwoloną drogą użycia Claude Pro/Max credentials.
- **API keys OpenAI/Anthropic:** łamią wymaganie rozliczania przez subskrypcję.
- **Automatyczny fallback providerów:** po niejednoznacznym lub rozpoczętym
  model callu mógłby powtórzyć pracę pod inną tożsamością i rozbić recovery.
- **Bezpośrednie, nieograniczone narzędzia oficjalnego CLI:** omijają writer fence,
  path cap, test-first chronology i durable receipts.
- **Hardcoded Codex implementer / Claude reviewer:** uniemożliwia żądane
  porównanie czterech kombinacji ról.

## Konsekwencje

- Lokalne wykonanie wymaga zalogowanego użytkownika OS i dostępnej subskrypcji;
  quota reset lub wylogowanie są jawnym, retry-safe terminalem bez fallbacku.
- Personal subscription może być użyta tylko tam, gdzie polityka właściciela
  kodu na to pozwala. Repo firmowe może wymagać kont Business/Enterprise/Team.
- Format eventów i flagi CLI są zewnętrznym, wersjonowanym kontraktem. Adaptery
  pinują wspierany zakres wersji i mają fake-binary compatibility tests.
- Provider comparison staje się powtarzalnym eksperymentem: ten sam seed,
  objective, config/gates i role mapping, osobne worktree/journal oraz zero push.

## Migracja

1. `RA-049`: provider-neutral contracts, process/auth boundary i odłączenie
   production Engineering od automatycznego Bedrock defaultu.
2. `RA-050`: oficjalny Codex CLI subscription adapter.
3. `RA-051`: oficjalny Claude Code subscription adapter.
4. `RA-052`: immutable role routing, recovery i matrix harness.
5. `RA-053`: opt-in kwalifikacja kombinacji, porównanie evidence i usunięcie
   Bedrock/OpenCode z aktywnej konfiguracji oraz zależności Engineering.

## Rollback

Rollback wyłącza wszystkie model stages i pozostawia jobs bezpiecznie
`BLOCKED`; nie przywraca Bedrock ani API key fallbacku. Durable operation z
profilem nowej wersji może być wznowiona wyłącznie przez kompatybilny adapter o
tym samym config digest. Powrót do innego providera wymaga nowego runu i jawnej
decyzji właściciela.
