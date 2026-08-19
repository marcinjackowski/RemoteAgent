# RA-002 — Handoff 03

## Metadata

- Task: `RA-002`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: `df5c084` + working tree po HANDOFF-02 i
  remediacji AUDIT-02 (RA-002 CHANGES_REQUESTED → IN_PROGRESS)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (zmiany w `packages/contracts` i `docs/`)

## Wynik

Oba findingi MEDIUM z AUDIT-02 zostały naprawione fail-closed, a koordynatorska
macierz przed handoffem wykryła i domknęła trzy dalsze niespójności w tym samym
zakresie `ExternalAction` (R4/policy/status/approval). Kontrakty egzekwują teraz
autoryzację i okno ważności zgody wyłącznie w spójnych stanach. Pełny clean-room
`pnpm run check` na przypiętym Node 24.19.0 / pnpm 10.26.1 przechodzi (exit 0).

## Zrealizowany zakres

- AUDIT-02 MEDIUM#1 (policy guard): jedno źródło prawdy `PolicyDecision`
  (`policy-decision.ts`), wyczerpująca walidacja runtime w
  `assertExternalActionTransition` z fail-closed `PolicyTransitionError` dla
  nieznanej decyzji; zakaz `AUTO_ALLOW + APPROVED` w guardzie i persisted schema.
- AUDIT-02 MEDIUM#2 (Approval temporalny): dla `consumed` wymuszone
  `granted_at <= consumed_at < expires_at`.
- Macierz przed-handoffowa: (1) `risk_tier=R4 + AUTO_ALLOW` odrzucone niezależnie
  od statusu; (2) `AUTO_ALLOW` nie wchodzi w `REJECTED` (schema + guard);
  (3) `REQUIRES_APPROVAL` wiąże `approval_id` ze statusem dokładnie — `null` w
  PROPOSED/REJECTED, wymagany w APPROVED/EXECUTING/SUCCEEDED/FAILED/AMBIGUOUS.
- Dodane pełne testy pozytywne/negatywne macierzy; zachowane wcześniejsze
  regresje AUDIT-01 i AUDIT-02.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/contracts/src/policy-decision.ts` | nowy moduł — jedyne źródło `PolicyDecision`/schema | AUDIT-02 MEDIUM#1 (koniec duplikacji unii) |
| `packages/contracts/src/external-action-machine.ts` | runtime walidacja decyzji, fail-closed unknown, zakaz AUTO_ALLOW→APPROVED/REJECTED, exhaustive switch | AUDIT-02 MEDIUM#1 + macierz #2 |
| `packages/contracts/src/external-action.ts` | R4+AUTO_ALLOW reject; AUTO_ALLOW nie w APPROVED/REJECTED; REQUIRES_APPROVAL approval_id↔status; Approval `granted_at<=consumed_at<expires_at` | AUDIT-02 MEDIUM#1/#2 + macierz #1/#2/#3 |
| `packages/contracts/test/external-action.test.ts` | +macierz R4/policy/status/approval + granice temporalne | Dowód pozytywny/negatywny |
| `packages/contracts/test/state-machine.test.ts` | +guard: unknown policy, AUTO_ALLOW→APPROVED/REJECTED | Dowód fail-closed guardu |

## Decyzje i uzasadnienie

- **Jedno źródło prawdy zamiast ręcznej unii.** Ręcznie przepisany typ decyzji
  mógł rozjechać się z runtime schema; alias `ExternalActionPolicyDecision =
  PolicyDecision` + walidacja `safeParse` czynią guard deterministyczną warstwą
  policy, nie polegającą na typie TypeScript (AGENTS.md §6).
- **Decyzje czasowe Approval.** Okno ważności to `granted_at <= consumed_at <
  expires_at`: dolna granica inclusive (konsumpcja w momencie grantu jest
  możliwa), górna exclusive (w chwili `expires_at` grant jest już wygasły,
  spójnie z regułą `expires_at > granted_at` z HANDOFF-02). Konsumpcja przed
  grantem lub po/na expiry to stan temporalnie niemożliwy — recovery nie może go
  wziąć za autoryzowane wykonanie.
- **R4 zawsze exact approval.** MASTER_PLAN §10 klasyfikuje R4 jako zawsze
  wymagający dokładnej zgody; `AUTO_ALLOW` dla R4 jest więc niereprezentowalny.
  Egzekwowane niezależnie od statusu, aby żaden persisted rekord nie mógł
  reprezentować R4 jako auto-dozwolonego. R4+DENY i R4+REQUIRES_APPROVAL
  pozostają legalne.
- **AUTO_ALLOW ma jedną ścieżkę.** Wykonuje shortcut `PROPOSED -> EXECUTING`;
  APPROVED należy do ścieżki approval, a REJECTED do DENY / odrzuconej ścieżki
  REQUIRES_APPROVAL. Ujednolicono schema i guard.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Odrzucanie nieznanych pól na granicy | PASS | `z.strictObject`/`versionedContract`; testy unknown-key |
| 2. `schema_version` + strategia migracji | PASS | `z.literal(1)`, fixtures v1/v2, snapshot `const: 1` |
| 3. Typowany błąd przejścia bez mutacji | PASS | `InvalidTransitionError`, `PolicyTransitionError` (w tym unknown policy) |
| 4. Canonical digest niezależny od kolejności kluczy | PASS | `canonical.property.test.ts` (500 przebiegów) |
| 5. External content jawnie trusted/untrusted | PASS | `trust.ts`; literalny `UNTRUSTED_DATA` |
| 6. Terminalne statusy i recovery pokryte | PASS | `state-machine.test.ts` pełne sety + BLOCKED/AMBIGUOUS |
| Audit focus: brak mieszania scope, brak duplikacji typów | PASS | jedno źródło `PolicyDecision`; policy/receipt/scope związane cross-field |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run packages/contracts` (host) | 0 | 8 plików, 122/122 PASS |
| `pnpm --filter @remoteagent/contracts run typecheck` (host) | 0 | `tsc` src + test, bez błędów |
| `pnpm exec prettier --check packages/contracts` (host) | 0 | wszystkie pliki sformatowane |
| clean-room `pnpm install --frozen-lockfile` (node:24.19.0-bookworm-slim, pnpm 10.26.1) | 0 | install OK |
| clean-room `pnpm run check` (ten sam obraz) | 0 | lint/format/typecheck/test/build 20/20 + `workflow:validate OK — 26 tasks`; repo 10 plików / 206 testów, w tym contracts 122 |

Clean-room: świeża kopia working tree (rsync) bez `.git`, `node_modules`,
`dist`, `.turbo`, `.remote-agent` i lokalnego `.claude/settings.local.json`;
pnpm 10.26.1 aktywowane przez `corepack prepare`; store poza `/app`
(`--store-dir /root/.pnpm-store`); `CI=true`.

## Snapshoty i artefakty

- Artefakt/ścieżka: `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- Czy snapshot się zmienił i dlaczego: NIE. Wszystkie nowe reguły to cross-field
  superRefine oraz guard runtime, których `z.toJSONSchema` nie projektuje;
  projekcja nadal reklamuje wyłącznie per-field shapes. Runtime Zod pozostaje
  autorytatywną bramką, więc snapshot się nie zmienił, a
  `schema-snapshot.test.ts` przechodzi bez aktualizacji.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; zmiany dotyczą definicji typów/schematów i testów.
  `.claude/settings.local.json` nietknięty i wykluczony z clean-room.
- Izolacja kont/scope: `target_scope`/`connection_id` pozostają autorytatywne
  poza modelem; R4 nie może być auto-dozwolone; policy jest walidowana runtime.
- Side effecty i idempotencja: brak remote writes; `SUCCEEDED` wymaga receipt,
  inaczej `AMBIGUOUS`; Approval reprezentuje wyłącznie spójne, czasowo możliwe
  stany one-shot.
- Dane zewnętrzne traktowane jako niezaufane: `trust.ts` literalny
  `UNTRUSTED_DATA`; model nie jest warstwą autoryzacji.

## Znane ograniczenia i ryzyka

- Relacje cross-field i temporalne nie są wyrażalne w JSON Schema (ograniczenie
  `z.toJSONSchema`); jedyną autorytatywną bramką jest walidacja runtime Zod.
- Reprodukcja clean-room wymaga obrazu `node:24.19.0-bookworm-slim` i
  pnpm 10.26.1 (host używa Node 25.x, więc uruchomiono gate w Dockerze).
- Zmiany nie są zacommitowane (zgodnie z poleceniem: brak commita/pusha).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: oba findingi AUDIT-02 i trzy niespójności macierzy naprawione;
  122/122 testów pakietu i pełny clean-room gate zielone; status `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać RA-003.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: `packages/contracts/src`
  i `packages/contracts/test`; snapshot aktualizować świadomie z uzasadnieniem.
