# RA-045 — HANDOFF-01

- Task: `RA-045` Kwalifikacja iOS/Xcode na sondermind-ios
- Data: `2026-08-27`
- Bazowy commit RemoteAgent: `9d8008e56da108ac94a0496234b9df9f39edb727`
- Commit implementacji RemoteAgent: `2c627b4`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

Engineering potrafi teraz bez Jira i Discorda przyjąć zaakceptowany opis jako `UNTRUSTED_DATA`,
przejść produkcyjny approval/worker/Supervisor flow, pracować w izolowanym worktree iOS, uruchomić
server-owned baseline/current/Xcode gates, fresh review, final verification oraz stworzyć jeden
evidence-bound lokalny commit. Push, MR i merge nie zostały wykonane.

Smoke MOBL-2021 pozostawił do inspekcji branch
`remoteagent/engineering-d5612121055d467f32c96b0560d960ca` i commit
`9bf102e5f13d962d39d84e126f93b0f26c437cda` od bazy
`6ef7ec4e7dc4a9fbe6920055ee7516283ea9fcf6`. Zmiana ma 7 plików, 45 insertions i 11 deletions;
source checkout pozostał czysty.

## Inwarianty do zachowania

- Xcode executable, DeveloperDir, destination, argv i disposable roots są code-owned; model ich
  nie wybiera ani nie poszerza.
- Baseline dla gate'ów wymagających test-first musi realnie failować, current musi realnie przejść.
- Xcode scratch cleanup obejmuje tylko exact kanoniczny SwiftPM configuration directory; inne
  zmiany chronionego drzewa są odmową.
- Implementer ma bounded discovery i server-owned path/gate constraints. Nie zwiększać limitu w
  odpowiedzi na no-progress i nie resetować go po patchu.
- Provider usage pochodzi z odpowiedzi, nie z estymacji. Hard stop i rezerwa następnego calla są
  code-owned.
- Każde wejście handlera dostaje osobny JSONL mode `0600`; schema nie przyjmuje promptu, prose,
  patch bytes, request ID, host path, sekretu ani chain-of-thought.
- Diagnostyka po ukończeniu workflow jest best-effort i nie może nadpisać wyniku Engineering.
- LOCAL_COMMIT pozostaje pojedynczy i lokalny; push/MR/merge wymagają osobnej decyzji właściciela.

## Dowód

```text
live Bedrock/PostgreSQL/Git/Xcode      1/1, exit 0, 533.36 s
MOBL-2021 baseline/current             exit 1 / exit 0
Xcode targeted                         exit 0, 44 tests, 0 failures
provider usage                         54,960 tokens, 6 responses
local commit                           9bf102e5f13d962d39d84e126f93b0f26c437cda
debug journal                          26 records, mode 0600, terminal SUCCEEDED
pełna PostgreSQL Vitest                2861 passed, 1 opt-in live skip
build --force                          26/26, 0 cached
typecheck --force                      40/40, 0 cached
lint / format / diff-check             exit 0
workflow:validate                      OK — 47 tasks
audit                                  AUDIT-01 PASS
```

## Granice

Nie wykonano wizualnej automatyzacji simulatora ani snapshot testu UI. Live test jest opt-in i
wymaga lokalnego Xcode/AWS/configu; pełna standardowa bramka celowo go skipuje, a jego zakończony
realny wynik ma osobny durable evidence. Nie wykonano Jira/Discord, push, MR ani merge.
