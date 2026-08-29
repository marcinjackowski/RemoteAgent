# RA-054 — AUDIT-01

- Task: `RA-054` Codex subscription live compatibility repair
- Data: `2026-08-29`
- Bazowy commit: `a4caec6c8fa066b12bb37b28f52c7d5549065b79`
- Audyt: pełny diff od bazowego commita, wszystkie nowe pliki, produkcyjny
  preflight/transport, journal budżetowy oraz samodzielnie uruchomione bramki
  zgodnie z `ADR-0007`

## 1. Uruchomione bramki

Owner-enabled live smoke po przywróceniu wszystkich mutacji:

```text
canonical codex-cli 0.147.0 + ChatGPT subscription + gpt-5.6-sol
production preflight/transport             1/1, 4.960s, exit 0
provider usage                              input 8749, output 84, total 8833
model-runtime + Codex builds                exit 0
typecheck --force                           4/4, 0 cached, exit 0
```

Po implementacji uruchomiono dokładną pełną bramkę taska:

```text
. scripts/dev/env.sh                        Node 24.19.0; PostgreSQL reachable
pnpm lint                                   exit 0; tylko znane warnings boundaries
pnpm format                                 exit 0
pnpm run build --force                      29/29, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run  3069/3069, 244/244,
                                             2 opt-in skipped, exit 0
pnpm run typecheck --force                  46/46, 0 cached, exit 0
pnpm workflow:validate                      OK — 54 tasks, exit 0
git diff --check                            exit 0
```

Pierwszy pełny start zatrzymał się deterministycznie na Prettierze trzech
zmienionych testów. Kolejny pełny przebieg ujawnił dwa skutki taska: historyczny
fixture budżetu nadal używał starej liczby oraz acceptance register widział
naprawiany `CTF-024` jako `OPEN`. Fixture związano z produkcyjnymi stałymi, a
finding zamknięto realnym live dowodem. Testy celowane przeszły `1/1` oraz
`19/19`; następny pełny przebieg wykonał całą macierz i zakończył exit `0`.
Nie był to flake i żaden fail nie został przemilczany.

## 2. Kryteria akceptacji

1. **Exact auth channel:** spełnione. `codex login status` może zwrócić jedną
   dozwoloną linię na stdout albo stderr. Oba kanały, oba puste, wiele linii,
   unknown status i API-key mode kończą się typed refusal bez zachowania raw
   outputu.
2. **Strict response schema:** spełnione. Wszystkie code-owned `const` i `enum`
   w envelope mają jawny `type`; dotyczy to wersji, digestu, kind i nazwy
   narzędzia. Digest nadal jest wyliczany z dokładnego output schema i tool set.
3. **Jawny model i izolacja:** spełnione. Test wymaga canonical executable oraz
   jawnego `RA_CODEX_MODEL`; nie zmienia routingu roli. Transport tworzy pusty
   ephemeral root, używa read-only sandboxu, zero tools/calls, wyłączonych web,
   MCP, subagentów i shell surface, a root jest usuwany po wywołaniu.
4. **Budżet diagnostyczny 3×:** spełnione. Whole-invocation target/warning/hard
   limit/reserve to odpowiednio `750000/1200000/1800000/105000`. Granica
   przed stage i transportem używa tych samych stałych, journal raportuje exact
   zużycie, a przekroczenie nadal fail-closuje.
5. **Real subscription smoke:** spełnione. Canonical klient zalogowany przez
   ChatGPT wykonał produkcyjny preflight i proces `gpt-5.6-sol`, zwracając exact
   `CODEX_ENGINEERING_OK`, pełną content-free sekwencję zdarzeń oraz usage.
   Nie było repo/workspace, commita ani zewnętrznego write.
6. **Mutacje:** spełnione. RED były: stdout-only auth, akceptacja obu kanałów,
   usunięcie typu envelope, mnożnik `3→1` i syntetyczny transport omijający
   preflight/proces. Każda mutacja zakończyła właściwy test exit `1` i została
   przywrócona przed GREEN.
7. **Pełna bramka:** spełnione. Końcowy niecache'owany łańcuch zakończył się
   exit `0`, a `CTF-024` jest zamknięty realnym, nie fake-binary dowodem.

## 3. Security i operacyjność

RemoteAgent nadal nie czyta ani nie przechowuje credentialu Codex. Oficjalny
klient korzysta z loginu ChatGPT; środowisko child procesu zawiera tylko
zamkniętą allowlistę i odrzuca API/cloud key variables. Dokumentacja OpenAI
rozdziela „Sign in with ChatGPT” dla dostępu subskrypcyjnego od API key:
<https://learn.chatgpt.com/docs/auth>. Jawnie wybrany model smoke jest dostępny
w aktualnym katalogu Codex: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>.

Budżet pozostaje granicą całego Engineering invocation, nie pojedynczej roli.
To jest celowe: jeden run może mieszać providerów per rola, a journal agreguje
zużycie całego runu. Zmiana nie wybiera modelu, providera ani fallbacku.

## 4. Findings

Audyt pełnego diffu nie znalazł pozostałego findingu klasy BLOCKER, HIGH ani
MEDIUM. `CTF-024` był reprodukowalnym findingiem wejściowym i został zamknięty
tym taskiem. Claude, Bedrock i OpenCode nie zostały uruchomione ani dodane jako
fallback. Nie wykonano push, MR, Jira, Discord ani zmian w projekcie
SonderMind.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie siedem kryteriów RA-054 jest spełnionych, realny subscription smoke i
pełna bramka zakończyły się exit code `0`, a diff nie pozostawia findingu
BLOCKER, HIGH ani MEDIUM.
