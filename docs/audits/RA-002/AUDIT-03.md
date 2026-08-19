# RA-002 — Audit 03

## Metadata

- Task: `RA-002`
- Audytowany handoff: `docs/handoffs/RA-002/HANDOFF-03.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacja AUDIT-02 oraz dodatkowa macierz R4/policy/status/approval są
skuteczne: wszystkie wcześniejsze przypadki adwersarialne są odrzucane, a
niezależny clean-room gate przechodzi na przypiętym runtime. Pełny przegląd
pozostałych kontraktów ujawnił jednak dwa inne stany niemożliwe. Referencja encji
może łączyć provider z kind należącym do innego providera, a kontrakty opisane
jako zawierające dane zewnętrzne/untrusted pozwalają nadawcy ustawić marker
`TRUSTED`. Oba findingi są klasy MEDIUM, więc `PASS` pozostaje niedozwolony.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`, `docs/workflow/AUDIT_CHECKLIST.md`,
  `docs/tasks/TASK_INDEX.md`, `docs/tasks/RA-002.md`, AUDIT-01/02 i HANDOFF-03.
- Sprawdzony stan: wszystkie źródła/testy/snapshoty `packages/contracts`,
  manifest, lockfile i artefakty workflow.
- Digest zestawu plików `packages/contracts`:
  `04602f4c925658e1684236193cb1ec0b38262ca24118bf427a06dc5f9e2ea123`.
- Digest HANDOFF-03:
  `dcf04cfea768d860db35e2f9ed547f55b72ee55056933af2791c598a43c6dbac`.
- Uruchomione kontrole: testy kontraktów, root typecheck, lint, format,
  `workflow:validate`, `git diff --check`, adwersarialna macierz identity/trust i
  niezależny clean-room frozen install + pełny `pnpm run check`.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Boundary contracts odrzucają nieznane pola | PASS | Strict boundaries i testy unknown-key. |
| 2. `schema_version` i strategia migracji | PASS | Literalne v1, future fail-closed, fixtures i snapshot. |
| 3. Typowany błąd niedozwolonego przejścia bez mutacji | PASS | Structural i policy-aware guards, w tym unknown policy fail-closed. |
| 4. Digest niezależny od kolejności kluczy | PASS | Unit/property tests oraz invariant action digest. |
| 5. External content ma jawny, wiarygodny trust marker | FAIL | Model/tool boundary może relabelować treść zewnętrzną jako `TRUSTED`. |
| 6. Terminalne statusy i recovery są pokryte | PASS | Pełne sety terminalne i ścieżki recovery. |
| Audit focus: scope/identity nie miesza providerów | FAIL | `provider=jira` z `kind=gmail_thread` przechodzi w ExternalEntityRef i EventEnvelope. |

## Findingi

### MEDIUM — ExternalEntityRef nie wiąże kind z providerem

- Lokalizacja: `packages/contracts/src/external-entity.ts:13-72`,
  `packages/contracts/src/event-envelope.ts:62-105`.
- Dowód: `externalEntityRef.safeParse` oraz `eventEnvelope.safeParse` zwracają
  `success=true` dla `provider=jira`, zgodnego connection, ale
  `kind=gmail_thread`. Analogiczne kombinacje są możliwe dla wszystkich enumów.
- Wpływ: wspólny kontrakt może skierować identyfikator do parsera/resolvera innego
  typu providera albo utworzyć trwałą korelację o sprzecznej tożsamości. Zależnie
  od późniejszego dispatchu po `provider` lub po `kind` grozi to błędnym użyciem
  connection i mieszaniem kontekstu między connectorami.
- Wymagana zmiana: zdefiniować provider-kind jako jedno źródło prawdy (np.
  dyskryminowana unia lub jawna mapa + runtime refine) i odrzucać każdą
  kombinację spoza: Jira→jira_issue; Gmail→gmail_thread/gmail_message;
  Calendar→calendar_event; GitLab→project/branch/MR/pipeline;
  Discord→discord_thread. Dodać pełną macierz pozytywną i reprezentatywne
  negatywne testy zarówno standalone ExternalEntityRef, jak i EventEnvelope.

### MEDIUM — Granice untrusted pozwalają nadawcy relabelować treść jako TRUSTED

- Lokalizacja: `packages/contracts/src/checkpoint.ts:32-36,38-43,87-96`,
  `packages/contracts/src/agent-completion.ts:50-59`,
  `packages/contracts/src/tool.ts:76-88`, `packages/contracts/src/trust.ts:3-13`.
- Dowód: parser akceptuje `trust=TRUSTED` dla (1) `CaseCheckpoint.summary`
  nazwanego `untrustedSummary`, (2) modelowego
  `AgentCompletion.checkpoint_patch.summary` i (3) `ToolResult.output`, którego
  komentarz mówi „External data stays untrusted”. Wszystkie trzy minimalne
  payloady zwróciły `success=true`.
- Wpływ: model albo dane z narzędzia mogą same zadeklarować, że treść zewnętrzna
  jest zaufana. Późniejszy context builder może pominąć izolację/redakcję
  prompt-injection opartą o marker, mimo że `trust.ts` definiuje `TRUSTED`
  wyłącznie dla treści wytworzonej deterministycznie przez system.
- Wymagana zmiana: boundary zawierające model/tool/external content muszą
  narzucać literal `UNTRUSTED_DATA`; nadawca nie wybiera poziomu zaufania.
  Co najmniej `checkpointPatch.summary` (model output), persisted
  external-derived checkpoint summary i `ToolResult.output` muszą odrzucać
  `TRUSTED`. Jeżeli system potrzebuje osobnego deterministic trusted wariantu,
  powinien mieć odrębny, jawnie system-only kontrakt/constructor, nie tę samą
  granicę wejściową. Dodać regresje oraz świadomie zaktualizować snapshot JSON
  Schema (`enum` powinien stać się `const`).

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run packages/contracts` | 0 | 8 plików, 122/122 testy PASS. |
| `pnpm run typecheck` | 0 | root tsc i 20/20 workspace typechecks. |
| `pnpm exec eslint packages/contracts` | 0 | brak błędów; istniejące warningi boundaries. |
| `pnpm exec prettier --check ...` | 0 | kod i artefakty RA-002 sformatowane. |
| `pnpm run workflow:validate` | 0 | `workflow:validate OK — 26 tasks`. |
| `git diff --check` | 0 | brak whitespace/conflict errors. |
| Clean-room Node 24.19.0, pnpm 10.26.1, frozen install + `pnpm run check` | 0 | 206/206 testów repo, 20/20 typecheck/build, lint/format i validator PASS bez cache. |
| Macierz identity/trust (5 przypadków) | 0 procesu, 5 nieoczekiwanych akceptacji | Cross-provider kind w ExternalEntityRef/EventEnvelope oraz TRUSTED na trzech untrusted boundaries mają `success=true`. |

## Ryzyka przekrojowe

- Security/privacy: connection/provider equality jest naprawiona, lecz
  provider-kind i samodzielnie nadawany trust marker nadal umożliwiają pomylenie
  connectora oraz osłabienie obrony przed prompt injection.
- Idempotencja/recovery: action/approval/receipt invariants z poprzednich
  audytów są skuteczne; brak nowych findingów w tym obszarze.
- Współbieżność: single-writer WorkUnit pozostaje poprawny.
- Observability: routing po sprzecznym kind/provider generowałby mylące
  telemetry/error provenance; refine powinien wskazywać ścieżkę `kind`.
- Kompatybilność: poprawki odrzucają stany semantycznie nielegalne w v1.
  Provider-kind refine nie pojawi się w JSON Schema, natomiast literal trust
  zmieni snapshot i musi być świadomie zaakceptowany.

## Wymagane działania po `continue`

1. Implementer ustawia `RA-002` z `CHANGES_REQUESTED` na `IN_PROGRESS`.
2. Naprawia wyłącznie dwa findingi AUDIT-03 i dodaje regresje/matrix tests.
3. Aktualizuje schema snapshot wyłącznie dla rzeczywistej zmiany trust literal.
4. Uruchamia testy pakietu oraz pełny clean-room gate.
5. Tworzy `HANDOFF-04` i ponownie ustawia `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Standardowe testy i clean-room są zielone, a wszystkie findingi AUDIT-01/02 są
naprawione. RA-002 definiuje jednak wspólne granice dla connectorów i context
buildera. Sprzeczna tożsamość provider-kind oraz możliwość samodzielnego
podniesienia trust level pozostawiają dwa findingi MEDIUM. Zgodnie z checklistą
`PASS` jest niedozwolony; werdykt to `CHANGES_REQUIRED`.
