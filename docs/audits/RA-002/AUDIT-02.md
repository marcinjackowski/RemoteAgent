# RA-002 — Audit 02

## Metadata

- Task: `RA-002`
- Audytowany handoff: `docs/handoffs/RA-002/HANDOFF-02.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Wszystkie cztery findingi z AUDIT-01 zostały skutecznie usunięte: sześć
wcześniej akceptowanych stanów adwersarialnych jest teraz odrzucanych, a pełny
clean-room gate przechodzi na przypiętym runtime. Rozszerzona macierz audytowa
ujawniła jednak dwa pozostałe stany niemożliwe w kontrakcie approval/policy.
Publiczny policy-aware guard przepuszcza nieznaną decyzję runtime zamiast
fail-closed i duplikuje unię `PolicyDecision`; ponadto kontrakt Approval pozwala
oznaczyć zgodę jako skonsumowaną przed grantem lub po expiry. Oba findingi są
klasy MEDIUM, więc werdykt nie może być `PASS`.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`, `docs/workflow/AUDIT_CHECKLIST.md`,
  `docs/tasks/TASK_INDEX.md`, `docs/tasks/RA-002.md`, AUDIT-01 i HANDOFF-02.
- Sprawdzony stan: implementacja i testy `packages/contracts`, schema snapshot,
  manifest/lockfile oraz remediacja czterech findingów AUDIT-01.
- Digest zestawu plików `packages/contracts`: 
  `3edf3cbbffa9fe79506f36f3246b8e7235ef4baba8399987752e5ff8bf02af12`.
- Digest HANDOFF-02:
  `f4e92b64fddbb0af58c1bf6100d69e800f1e2cb09a173ee42c1d7451ee68f4e1`.
- Uruchomione kontrole: testy kontraktów, root typecheck, lint, format,
  `workflow:validate`, `git diff --check`, rozszerzona macierz adwersarialna oraz
  niezależny clean-room frozen install i pełny `pnpm run check`.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Boundary contracts odrzucają nieznane pola | PASS | Strict Zod boundaries i negatywne testy pozostają zielone. |
| 2. `schema_version` i strategia migracji | PASS | Literalne v1, future fail-closed, fixtures i snapshot. |
| 3. Typowany błąd niedozwolonego przejścia bez mutacji | FAIL | Strukturalne przejścia są typowane, lecz policy guard przy nieznanej wartości runtime zwraca sukces zamiast błędu. |
| 4. Digest niezależny od kolejności kluczy | PASS | Unit/property tests i invariant `action_digest`. |
| 5. External content ma jawny trust marker | PASS | `UNTRUSTED_DATA` pozostaje literalem na boundary. |
| 6. Terminalne statusy i recovery są pokryte | PASS | Pełne sety terminalne i ścieżki AMBIGUOUS/BLOCKED. |
| Audit focus: brak duplikowania typów i model nie autoryzuje | FAIL | `ExternalActionPolicyDecision` kopiuje `PolicyDecision`, a fallback guardu jest allow zamiast deny. |

## Findingi

### MEDIUM — Policy-aware guard nie jest wyczerpujący runtime i duplikuje źródło prawdy

- Lokalizacja: `packages/contracts/src/external-action-machine.ts:37-38,83-114`,
  `packages/contracts/src/external-action.ts:36-48,205-249`.
- Dowód: wywołanie
  `assertExternalActionTransition(PROPOSED, EXECUTING, "UNKNOWN_POLICY")`
  (wartość runtime spoza typu TypeScript) zwraca `EXECUTING`; funkcja kończy się
  bezwarunkowym `return to`. Osobna ręcznie przepisana unia
  `ExternalActionPolicyDecision` może rozjechać się z runtime schema
  `PolicyDecision`. Dodatkowo kontrakt i guard akceptują
  `AUTO_ALLOW + APPROVED`, mimo że komentarze maszyny definiują APPROVED jako
  ścieżkę wymaganego approval, a `approval_id` dla AUTO_ALLOW jest zabroniony.
- Wpływ: guard będący deterministyczną warstwą policy failuje otwarcie po
  rozszerzeniu/niezwalidowanym wywołaniu i może reprezentować niespójny stan
  approval. Typ TypeScript nie jest runtime warstwą autoryzacji.
- Wymagana zmiana: użyć jednego źródła prawdy dla `PolicyDecision`, walidować
  decyzję wyczerpująco runtime i rzucać typowany błąd dla nieznanej wartości.
  Ujednolicić dozwolone statusy z dokumentowaną ścieżką: AUTO_ALLOW wykonuje
  shortcut bez stanu APPROVED, a REQUIRES_APPROVAL przechodzi przez APPROVED.
  Dodać negatywne testy unknown policy oraz `AUTO_ALLOW -> APPROVED` zarówno dla
  guardu, jak i persisted `ExternalAction`.

### MEDIUM — Approval dopuszcza konsumpcję poza oknem ważności

- Lokalizacja: `packages/contracts/src/external-action.ts:74-124`.
- Dowód: `approval.safeParse` zwraca `success=true` dla
  `consumed_at < granted_at` oraz dla `consumed_at > expires_at`, jeżeli
  `consumed=true`; obecna refine sprawdza wyłącznie `expires_at > granted_at`.
- Wpływ: trwały one-shot approval może twierdzić, że został użyty zanim go
  udzielono albo po wygaśnięciu. Recovery nie może na tej podstawie bezpiecznie
  odróżnić autoryzowanego wykonania od stanu niemożliwego, a Master Plan wymaga
  krótkotrwałej zgody sprawdzanej bezpośrednio przed wykonaniem.
- Wymagana zmiana: dla wariantu consumed wymusić
  `granted_at <= consumed_at <= expires_at` (z jawną decyzją co do równości na
  expiry), ścieżkowy błąd Zod i testy obu stron granicy oraz poprawnych wartości.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run packages/contracts` | 0 | 8 plików, 106/106 testów PASS. |
| `pnpm run typecheck` | 0 | root tsc i 20/20 workspace typechecks. |
| `pnpm exec eslint packages/contracts` | 0 | brak błędów; wyłącznie istniejące warningi konfiguracji boundaries. |
| `pnpm exec prettier --check packages/contracts` | 0 | wszystkie pliki sformatowane. |
| `pnpm run workflow:validate` | 0 | `workflow:validate OK — 26 tasks`. |
| `git diff --check` | 0 | brak whitespace/conflict errors. |
| Clean-room Node 24.19.0, pnpm 10.26.1, frozen install + `pnpm run check` | 0 | 190/190 testów repo, lint/format/typecheck/build i validator PASS bez cache. |
| Macierz 6 regresji AUDIT-01 | 0 | wszystkie sześć unsafe payloadów ma `success=false`. |
| Rozszerzona macierz policy/approval | 0 procesu, 5 nieoczekiwanych akceptacji | Unknown policy, AUTO_ALLOW+APPROVED (schema i guard), consumed przed grantem i po expiry są akceptowane. |

## Ryzyka przekrojowe

- Security/privacy: scope connection/case jest już związany poprawnie; otwarty
  fallback policy pozostaje ryzykiem autoryzacji runtime.
- Idempotencja/recovery: receipt invariants są naprawione; czasowo niemożliwy
  Approval nadal utrudnia bezpieczne rozstrzygnięcie one-shot execution.
- Współbieżność: bez nowych findingów; jedyny writer per case pozostaje jawny.
- Observability: błędy istniejących refinements mają ścieżki pól; nowe błędy
  również powinny być typowane/actionable.
- Kompatybilność: obie poprawki odrzucają stany semantycznie nielegalne i mogą
  pozostać w schema v1; projekcja JSON Schema nadal nie wyrazi relacji czasowej.

## Wymagane działania po `continue`

1. Implementer ustawia `RA-002` z `CHANGES_REQUESTED` na `IN_PROGRESS`.
2. Naprawia wyłącznie dwa findingi AUDIT-02 i dodaje regresje adwersarialne.
3. Uruchamia testy pakietu i pełny clean-room gate.
4. Tworzy `HANDOFF-03` i ponownie ustawia `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Remediacja AUDIT-01 jest skuteczna, a wszystkie standardowe bramki są zielone.
Kontrakty RA-002 są jednak źródłem prawdy dla późniejszego policy/executora.
Fail-open fallback publicznego guardu oraz konsumpcja approval poza jego oknem
ważności pozostawiają dwa findingi MEDIUM. Zgodnie z checklistą audytową
`PASS` jest niedozwolony; werdykt to `CHANGES_REQUIRED`.
