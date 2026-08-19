# RA-002 — Handoff 02

## Metadata

- Task: `RA-002`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: `df5c084` + working tree po HANDOFF-01 i
  remediacji AUDIT-01 (RA-002 IN_PROGRESS → AWAITING_AUDIT)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (zmiany w `packages/contracts` i `docs/tasks/TASK_INDEX.md`)

## Wynik

Cztery findingi z AUDIT-01 (2× HIGH, 2× MEDIUM) zostały naprawione fail-closed
przez cross-field invariants w kontraktach, z adwersarialnymi regresjami. Cała
paczka `@remoteagent/contracts` przechodzi testy, typecheck, lint i format;
pełny clean-room `pnpm run check` jest zielony. Ten handoff finalizuje pracę
przerwaną przed zapisem artefaktu (implementacja i bramki były już wykonane).

## Zrealizowany zakres

- HIGH ExternalAction: dodano superRefine wiążący `policy_decision`,
  `approval_id`, `status`, `external_receipt` — `DENY` nie jest wykonywalny,
  `REQUIRES_APPROVAL` nie wchodzi w wykonanie bez approval, `SUCCEEDED` wymaga
  receipt, receipt tylko na `SUCCEEDED`. Dodano policy-aware
  `assertExternalActionTransition` + `PolicyTransitionError`.
- HIGH EventEnvelope: superRefine wymusza równość top-level
  `provider`/`connection_id` z `entity_ref.provider`/`connection_id`.
- MEDIUM AgentCompletion: superRefine wiąże `decision_request.case_id` z
  `case_id` completion dla `WAITING_FOR_USER`.
- MEDIUM Approval: superRefine wymusza iff `consumed ⟺ consumed_at` oraz
  `expires_at > granted_at`.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/contracts/src/external-action.ts` | superRefine policy/approval/status/receipt + spójność approval | Finding HIGH#1, MEDIUM Approval |
| `packages/contracts/src/external-action-machine.ts` | policy-aware transition guard + `PolicyTransitionError` | Finding HIGH#1 (przejścia świadome policy) |
| `packages/contracts/src/event-envelope.ts` | superRefine równości connection/provider | Finding HIGH#2 (cross-account leak) |
| `packages/contracts/src/agent-completion.ts` | superRefine `decision_request.case_id == case_id` | Finding MEDIUM (cross-case) |
| `packages/contracts/test/*` | adwersarialne regresje wszystkich czterech findingów | Dowód fail-closed |

## Decyzje i uzasadnienie

- **Runtime Zod jest autorytatywną bramką.** Findingi to relacje cross-field,
  których `z.toJSONSchema` nie potrafi wyrazić. Egzekwujemy je w superRefine, a
  nie tylko w JSON Schema — granica pozostaje fail-closed niezależnie od
  ograniczeń projekcji. Każde miejsce ma komentarz „JSON Schema projection
  limitation”.
- **`schema_version` pozostaje `1`.** Poprawki odrzucają stany, które od
  początku były semantycznie nielegalne (AUDIT-01 §Kompatybilność). Nie dodają
  ani nie zmieniają pól, więc nie ma zmiany kontraktu wymagającej v2; żaden
  wcześniej-legalny, poprawny payload nie zostaje odrzucony.
- **Alternatywa (dyskryminowane unie per stan)** zwiększyłaby powierzchnię typów
  bez korzyści dla granicy; superRefine daje ten sam fail-closed rezultat i
  actionable ścieżki błędów pól.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Odrzucanie nieznanych pól na granicy | PASS | `z.strictObject`/`versionedContract`; testy unknown-key |
| 2. `schema_version` + strategia migracji | PASS | `z.literal(1)`, fixtures v1/v2, snapshot `const: 1` |
| 3. Typowany błąd przejścia bez mutacji | PASS | `InvalidTransitionError`, `PolicyTransitionError`; testy braku mutacji |
| 4. Canonical digest niezależny od kolejności kluczy | PASS | `canonical.property.test.ts` (500 przebiegów) |
| 5. External content jawnie trusted/untrusted | PASS | `trust.ts`; literalny `UNTRUSTED_DATA` |
| 6. Terminalne statusy i recovery pokryte | PASS | `state-machine.test.ts` pełne sety + BLOCKED/AMBIGUOUS |
| Audit focus: brak mieszania scope modelu z autorytatywnym | PASS | 4 findingi cross-field naprawione + regresje |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run packages/contracts` | 0 | 8 plików, 106/106 testy PASS |
| `pnpm run typecheck` | 0 | 20/20 workspace typechecks |
| `pnpm exec prettier --check packages/contracts` | 0 | wszystkie pliki sformatowane |
| clean-room Node 24.19.0, pnpm 10.26.1, `pnpm install --frozen-lockfile` + `pnpm run check` | 0 | lint/format/typecheck/test/build 20/20 + `workflow:validate OK` |
| `git diff --check` | 0 | brak whitespace/conflict errors |

## Snapshoty i artefakty

- Artefakt/ścieżka: `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- Czy snapshot się zmienił i dlaczego: NIE. Remediacja to wyłącznie cross-field
  superRefine, których `z.toJSONSchema` nie projektuje; projekcja nadal
  reklamuje tylko per-field shapes (`maxItems: 3` dla `DecisionRequest.options`
  z HANDOFF-01 bez zmian). Runtime Zod pozostaje autorytatywną bramką, więc
  snapshot słusznie się nie zmienił, a `schema-snapshot.test.ts` przechodzi.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; zmiany dotyczą definicji typów/schematów i testów.
  Skan wzorców sekretów bez trafień; `.claude/settings.local.json` nietknięty.
- Izolacja kont/scope: wzmocniona — EventEnvelope i AgentCompletion domykają
  cross-account/cross-case leak; scope pozostaje autorytatywny poza modelem.
- Side effecty i idempotencja: brak remote writes; kontrakty czyste;
  `ExternalAction` wymusza receipt na `SUCCEEDED`, inaczej `AMBIGUOUS`.
- Dane zewnętrzne traktowane jako niezaufane: `trust.ts` literalny
  `UNTRUSTED_DATA`; model nie miesza danych z autorytatywnym scope.

## Znane ograniczenia i ryzyka

- Cross-field invariants nie są widoczne w JSON Schema (ograniczenie
  `z.toJSONSchema`); walidacja runtime Zod jest jedyną autorytatywną bramką.
- Audytor bez lokalnego Dockera musi odtworzyć clean-room na obrazie
  `node:24.19.0-bookworm-slim` + pnpm 10.26.1.
- Zmiany nie są zacommitowane (zgodnie z poleceniem: brak commita/pusha).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: cztery findingi AUDIT-01 naprawione z regresjami; wszystkie
  bramki (host + clean-room) zielone; status `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać RA-003.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: `packages/contracts/src`
  i `packages/contracts/test`; snapshot aktualizować świadomie z uzasadnieniem.
