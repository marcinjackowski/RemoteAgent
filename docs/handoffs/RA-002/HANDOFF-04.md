# RA-002 — Handoff 04

## Metadata

- Task: `RA-002`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: `df5c084` + working tree po HANDOFF-03 i
  remediacji AUDIT-03 (RA-002 CHANGES_REQUESTED → IN_PROGRESS)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (zmiany w `packages/contracts` i `docs/`)

## Wynik

Oba findingi MEDIUM z AUDIT-03 zostały naprawione fail-closed: referencja encji
nie może już łączyć providera z kind innego providera, a granice zawierające
treść modelu/narzędzia/zewnętrzną wymuszają literalny `UNTRUSTED_DATA`. Zmiany są
wyrażalne także w JSON Schema (discriminated union + trust const). Pełny
clean-room `pnpm run check` na przypiętym Node 24.19.0 / pnpm 10.26.1 przechodzi
(exit 0).

## Zrealizowany zakres

- AUDIT-03 MEDIUM#1 (ExternalEntityRef provider-kind): zamknięta macierz
  provider→kind jako jedno źródło prawdy i `z.discriminatedUnion("provider", …)`;
  standalone `ExternalEntityRef` oraz nested `EventEnvelope.entity_ref` oba
  odrzucają cross-provider kind.
- AUDIT-03 MEDIUM#2 (trust relabeling): literalny `UNTRUSTED_DATA` na
  `CaseCheckpoint.summary` (persisted external-derived), `checkpointPatch.summary`
  (model output) i `ToolResult.output` (tool-derived).
- Dodane testy: pełna macierz pozytywna + all-pairs negatywna dla provider-kind
  (standalone i nested) oraz regresje trust (TRUSTED odrzucone / UNTRUSTED
  akceptowane) na trzech granicach.
- Świadoma aktualizacja snapshotu JSON Schema (enum→const, provider-kind oneOf) z
  weryfikacją diffu; zachowane wszystkie wcześniejsze poprawki AUDIT-01/02 i
  macierz R4/policy/status/approval.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/contracts/src/external-entity.ts` | mapa `providerKindSchema` + `buildEntityRefUnion` → discriminated union dla value i versioned form | AUDIT-03 MEDIUM#1 (jedno źródło, JSON-Schema-expressible) |
| `packages/contracts/src/checkpoint.ts` | `untrustedSummary.trust` → `z.literal(UNTRUSTED_DATA)` | AUDIT-03 MEDIUM#2 (CaseCheckpoint.summary + checkpointPatch.summary) |
| `packages/contracts/src/tool.ts` | `toolResult.output.trust` → `z.literal(UNTRUSTED_DATA)` | AUDIT-03 MEDIUM#2 (tool output) |
| `packages/contracts/test/external-entity.test.ts` | nowy: 9 pozytywnych + 36 all-pairs negatywnych (standalone i nested) | Dowód macierzy provider-kind |
| `packages/contracts/test/trust-boundaries.test.ts` | nowy: TRUSTED odrzucone / UNTRUSTED akceptowane na 3 granicach | Dowód literalnego trust |
| `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap` | enum→const (8×) + ExternalEntityRef/entity_ref object→oneOf | Świadoma projekcja nowych kontraktów |

## Decyzje i uzasadnienie

- **Discriminated union zamiast runtime refine.** AUDIT-03 preferował
  rozwiązanie wyrażalne w JSON Schema bez ręcznego duplikowania list.
  `z.discriminatedUnion("provider", …)` projektuje się do `oneOf` z `const`
  provider i `const`/`enum` kind, więc para provider-kind jest egzekwowana w
  runtime i w projekcji — a wariant zbudowany z jednej mapy zasila zarówno formę
  nested (`externalEntityRefValue`), jak i standalone (`externalEntityRef`).
  Alternatywa (dwa niezależne enumy + superRefine) nie pojawiłaby się w JSON
  Schema i rozproszyłaby regułę.
- **Literalny trust na granicy wejściowej.** Trust jest przypisywany przez
  boundary, nie wybierany przez nadawcę: model ani narzędzie nie mogą podnieść
  własnej treści do `TRUSTED` i osłabić obrony prompt-injection późniejszego
  context buildera. Zmianę ograniczono do trzech wskazanych granic; pola już
  literalne (`actor.display_name`, `toolIntent.arguments`) nietknięte, a
  provenance całego `AgentCompletion` jest znane z boundary, więc nie było
  potrzeby rozszerzać zmiany. Osobny deterministyczny trusted wariant, gdyby był
  potrzebny, wymaga odrębnego system-only kontraktu, nie tej granicy.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Odrzucanie nieznanych pól na granicy | PASS | `z.strictObject`/`versionedContract`; testy unknown-key |
| 2. `schema_version` + strategia migracji | PASS | `z.literal(1)`, fixtures v1/v2, snapshot `const: 1` |
| 3. Typowany błąd przejścia bez mutacji | PASS | `InvalidTransitionError`, `PolicyTransitionError` |
| 4. Canonical digest niezależny od kolejności kluczy | PASS | `canonical.property.test.ts` (500 przebiegów) |
| 5. External content jawnie i wiarygodnie untrusted | PASS | literalny `UNTRUSTED_DATA` na checkpoint/patch/tool output; `trust-boundaries.test.ts` |
| 6. Terminalne statusy i recovery pokryte | PASS | `state-machine.test.ts` pełne sety + BLOCKED/AMBIGUOUS |
| Audit focus: scope/identity nie miesza providerów | PASS | provider-kind discriminated union; `external-entity.test.ts` all-pairs |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run packages/contracts` (host) | 0 | 10 plików, 173/173 PASS |
| `pnpm --filter @remoteagent/contracts run typecheck` (host) | 0 | `tsc` src + test, bez błędów |
| `pnpm exec prettier --check packages/contracts` (host) | 0 | wszystkie pliki sformatowane |
| clean-room `pnpm install --frozen-lockfile` (node:24.19.0-bookworm-slim, pnpm 10.26.1) | 0 | install OK |
| clean-room `pnpm run check` (ten sam obraz) | 0 | lint/format/typecheck/test/build 20/20 + `workflow:validate OK — 26 tasks`; repo 12 plików / 257 testów, w tym contracts 173 |

Clean-room: świeża kopia working tree (rsync) bez `.git`, `node_modules`,
`dist`, `.turbo`, `.remote-agent` i lokalnego `.claude/settings.local.json`;
pnpm 10.26.1 aktywowane przez `corepack prepare`; store poza `/app`
(`--store-dir /root/.pnpm-store`); `CI=true`. Host używa Node 25.x, więc gate
uruchomiono w przypiętym obrazie Dockera.

## Snapshoty i artefakty

- Artefakt/ścieżka: `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- Czy snapshot się zmienił i dlaczego: TAK — świadomie, wyłącznie w dwóch
  zamierzonych kategoriach zweryfikowanych diffem względem kopii sprzed zmiany:
  (1) trust `enum ["TRUSTED","UNTRUSTED_DATA"]` → `const "UNTRUSTED_DATA"` w 8
  miejscach (`CaseCheckpoint.summary`, sześć wariantów
  `AgentCompletion.checkpoint_patch.summary`, `ToolResult.output`); po zmianie
  brak jakiegokolwiek `"TRUSTED"` w snapshotcie; (2) `ExternalEntityRef` i
  `EventEnvelope.entity_ref` z płaskiego `object` na `oneOf` pięciu wariantów
  per provider (`const` provider + `const`/`enum` kind). Brak innych zmian.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; zmiany dotyczą definicji typów/schematów i testów.
  `.claude/settings.local.json` nietknięty i wykluczony z clean-room.
- Izolacja kont/scope: provider-kind nie może już wskazać encji innego
  connectora; trust marker nie może być podniesiony przez nadawcę, co utrzymuje
  obronę prompt-injection opartą o marker.
- Side effecty i idempotencja: brak remote writes; invariants action/approval/
  receipt z poprzednich audytów zachowane.
- Dane zewnętrzne traktowane jako niezaufane: literalny `UNTRUSTED_DATA` na
  granicach modelu/narzędzia/external-derived; model nie jest warstwą autoryzacji.

## Znane ograniczenia i ryzyka

- Provider-kind pairing jest teraz wyrażony w JSON Schema (`oneOf`); pozostałe
  relacje cross-field/temporalne z wcześniejszych audytów nadal są egzekwowane
  wyłącznie runtime (ograniczenie `z.toJSONSchema`).
- Reprodukcja clean-room wymaga obrazu `node:24.19.0-bookworm-slim` i
  pnpm 10.26.1 (host: Node 25.x).
- Zmiany nie są zacommitowane (zgodnie z poleceniem: brak commita/pusha).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: oba findingi AUDIT-03 naprawione; 173/173 testów pakietu i
  pełny clean-room gate (257 testów repo) zielone; status `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać RA-003.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: `packages/contracts/src`
  i `packages/contracts/test`; snapshot aktualizować świadomie z uzasadnieniem.
