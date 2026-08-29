# RA-053 — HANDOFF-01

- Task: `RA-053` Subscription-provider qualification and Bedrock retirement
- Data: `2026-08-29`
- Bazowy commit: `3af95886ff23a0fac344508486212e8a2d051a82`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

M10 ma produkcyjne Engineering oparte wyłącznie o nazwane profile oficjalnych
Codex CLI i Claude Code uwierzytelniane subskrypcją. Role DESIGNER,
IMPLEMENTER, REVIEWER i VERIFIER pozostają wybierane niezależnie w strict
deployment config; brak auth/quota lub config kończy run odmową bez drugiego
providera, API key, Bedrock albo OpenCode.

Deterministyczna qualification suite uruchamia wszystkie cztery kombinacje
IMPLEMENTER/REVIEWER przez prawdziwy Engineering composition, realny PostgreSQL
i throwaway Git. Każdy raport jest content-free i związany z exact invocation
identity oraz własnym digestem. Live iOS runner pozostaje wyłączony domyślnie;
wymaga jawnej flagi, unikalnego invocation ID i dokładnych nazw obu profili.

Bedrock nie jest już częścią Engineering production ani test helpers. Jego
jedyny pozostawiony konsument ma jawnego właściciela
`CONVERSATION_REPLY_LOOP` w `legacy-conversation-model.ts`, ponieważ historyczny
reply loop pozostaje poza M10 Engineering.

## Inwarianty do zachowania

- Engineering profile provider jest zamknięty do `codex_cli|claude_code`; nie
  dodawać OpenCode, Bedrock, API tokenu ani first-profile fallbacku.
- Każdy używany profil przechodzi exact subscription preflight przed budową
  transportów. Brak auth/quota blokuje tylko ten run i nie przełącza providera.
- Route identity to pełny descriptor roli, profilu, modelu, klienta i config
  digest; label providera/modelu sam nie wystarcza.
- Live test pozostaje opt-in i tworzy unikalny journal/workspace. Source HEAD ma
  pozostać bez zmian; push, MR, Jira i Discord wymagają osobnej zgody.
- Qualification report nie może przechowywać promptu, model prose, stdout,
  stderr, host path, credential ani CoT.
- Legacy conversation slot nie może zostać przekazany do Engineering factory,
  użyty jako fallback ani zacząć wpływać na Engineering env resolution.
- `SupervisorRuntime` pozostaje jedynym driverem, a recovery nie powtarza gate
  command ani local commit.

## Dowód

```text
pełna real-PG bramka                3064/3064, 244/244, 1 live skipped, exit 0
build --force                       29/29, 0 cached, exit 0
typecheck --force                   46/46, 0 cached, exit 0
lint / format / diff-check          exit 0
workflow:validate                   OK — 53 tasks
audit                               AUDIT-01 PASS
```

## Decyzje i ślepe uliczki

- Nie uruchomiono live Codex, Claude, Bedrock ani OpenCode. Cała kwalifikacja
  wykorzystała fake provider boundary z realnym workflow/PG/Git.
- Pierwsza mutacja OpenCode była fałszywie zielona z powodu starego `dist` i nie
  została uznana za dowód. Po wymuszonym rebuildzie mutacja była RED; źródło i
  build przywrócono.
- Pierwszy pełny test po poprawkach przekroczył dawny 120-sekundowy limit
  agregatu pod równoległym obciążeniem, chociaż solo trwał 53.3 sekundy.
  Jawny limit 240 sekund zachowuje bounded run i pełna suite zakończyła się w
  117.7 sekundy dla tego scenariusza.
- Bedrock package nie został usunięty z całego produktu, bo nadal obsługuje
  historyczne rozmowne odpowiedzi. Został usunięty wyłącznie z Engineering i
  ma teraz jednego jawnego właściciela poza tą granicą.

## Granice zewnętrzne

Nie wykonano push, MR, Jira, Discord ani żadnego live model call. Nie zmieniono
zewnętrznego projektu SonderMind.
