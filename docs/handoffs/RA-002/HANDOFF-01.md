# RA-002 — Handoff 01

## Metadata

- Task: `RA-002`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: `df5c084` (working tree z RA-002 IN_PROGRESS)
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (branch `df5c084` + zmiany w `packages/contracts` i `docs/tasks/TASK_INDEX.md`)

## Wynik

Kontrakty domenowe i state machines RA-002 zostały sfinalizowane przed audytem:
`DecisionRequest` jest zgodny z nadrzędnym workflow (dokładnie 2–3 opcje), a testy
maszyn stanów jawnie asercjonują kompletne zbiory wszystkich stanów terminalnych
oraz wszystkie przejścia recovery. Cała paczka `@remoteagent/contracts` przechodzi
lint, format, typecheck i testy, a pełny `pnpm run check` przechodzi w czystej,
przypiętej clean-roomowej kopii repo (Node 24.19.0, pnpm 10.26.1).

## Zrealizowany zakres

- `DecisionRequest.options` zmienione z `min(2).max(8)` na `min(2).max(3)`, aby
  dopasować kontrakt do reguły workflow „2–3 realne opcje”
  (`docs/workflow/EXECUTION_AND_AUDIT.md` §Decision Request). Dodano komentarz
  wskazujący źródło reguły.
- Zaktualizowano oba wystąpienia `maxItems` (8 → 3) w snapshotcie JSON Schema
  (`DecisionRequest` jako kontrakt samodzielny i osadzony w `AgentCompletion`).
- Dodano testy `DecisionRequest`: akceptacja dokładnie 3 opcji oraz odrzucenie
  czwartej opcji.
- Rozszerzono `test/state-machine.test.ts` o jawne asercje kompletnych zbiorów
  stanów terminalnych oraz wszystkich przejść recovery dla każdej maszyny;
  zachowano testy niedozwolonych przejść i braku mutacji.
- Uruchomiono `prettier --write` wyłącznie na `packages/contracts` (bez dotykania
  ignorowanego `.claude/settings.local.json` ani plików spoza zakresu).

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/contracts/src/decision.ts` | `options` `max(8)`→`max(3)`, komentarz o źródle reguły | Zgodność `DecisionRequest` z workflow (2–3 opcje) |
| `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap` | `maxItems` 8→3 w dwóch miejscach (DecisionRequest samodzielny i w AgentCompletion) | Snapshot musi odzwierciedlać nowy limit; zmiana oczekiwana i uzasadniona |
| `packages/contracts/test/contracts.test.ts` | +test akceptacji 3 opcji, +test odrzucenia 4. opcji | Dowód granicy 2–3 |
| `packages/contracts/test/state-machine.test.ts` | Jawne asercje kompletnych zbiorów terminalnych i recovery dla Case, RunSafety, WorkUnit, ExternalAction | Kryterium akceptacji 6 (terminalne + recovery) |
| `packages/contracts/src/*.ts`, `test/*.ts` | Reformat Prettierem w obrębie paczki | Wymagane `prettier --write packages/contracts` |

Uwaga: pozostałe pliki `packages/contracts/*` widoczne jako untracked/modified
pochodzą z wcześniejszego stanu RA-002 IN_PROGRESS i wchodzą w zakres tego samego
taska; ten handoff finalizuje całość przed audytem.

## Decyzje i uzasadnienie

- **2–3 opcje twardo w schemacie.** Workflow wymaga „2–3 realnych opcji”.
  Egzekwowanie tego runtime'owo (a nie tylko dokumentacyjnie) czyni kontrakt
  granicą fail-closed: model nie może zaproponować rozdrobnionego zestawu opcji,
  który obszedłby intencję decyzji właściciela. Alternatywa (pozostawić `max(8)`
  i walidować poza schematem) rozproszyłaby regułę i osłabiła granicę.
- **Aktualizacja snapshotu.** Nowy wynik `maxItems: 3` jest oczekiwany, ponieważ
  bezpośrednio wynika ze zmiany kontraktu; zmieniono dokładnie dwa wystąpienia
  odpowiadające `DecisionRequest`, resztę snapshotu pozostawiono nietkniętą.
- **Testy jako pełne zbiory.** Zamiast pojedynczych „happy path” asercji, testy
  porównują `new Set(machine.terminalStates())` i `machine.transitions[state]`
  z pełnymi oczekiwanymi zbiorami, więc każde przyszłe rozszerzenie lub zwężenie
  maszyny (nowy stan terminalny, nowe przejście recovery) natychmiast rozbije test.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Kontrakty odrzucają nieznane pola na granicy | PASS | `z.strictObject`/`versionedContract`; testy „unknown key” w `contracts.test.ts` |
| 2. `schema_version` + strategia migracji | PASS | `schema.ts`/`common.ts`, `compatibility.test.ts`, snapshot |
| 3. Niedozwolone przejście → typowany błąd bez mutacji | PASS | `InvalidTransitionError`; testy „does not mutate state on a disallowed transition” dla każdej maszyny |
| 4. Canonical digest niezależny od kolejności kluczy | PASS | `canonical.property.test.ts`, `canonical.test.ts` |
| 5. External content jawnie trusted/untrusted | PASS | `trust.ts`; użycie w kontraktach |
| 6. Testy pokrywają wszystkie stany terminalne i recovery | PASS | `state-machine.test.ts`: pełne zbiory terminalne (Case DONE/CANCELLED; WorkUnit COMPLETED/FAILED/CANCELLED; RunSafety SUCCEEDED/FAILED/AMBIGUOUS; ExternalAction REJECTED/SUCCEEDED/FAILED) + recovery z BLOCKED i AMBIGUOUS manualny |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run packages/contracts` (host) | 0 | 8 plików, 84 testy PASS |
| `pnpm run typecheck` w `packages/contracts` (host) | 0 | `tsc -p tsconfig.json` + `tsconfig.test.json`, bez błędów |
| `pnpm exec eslint packages/contracts` (host) | 0 | tylko ostrzeżenia migracyjne `boundaries` v6 (nie błędy) |
| `pnpm exec prettier --check packages/contracts` (host) | 0 | „All matched files use Prettier code style!” |
| clean-room `pnpm install --frozen-lockfile` (docker node:24.19.0-bookworm-slim, pnpm 10.26.1) | 0 | 21 workspace projects, install OK |
| clean-room `pnpm run check` (ten sam obraz) | 0 | lint+format+typecheck+test+build (20/20 tasks) + `workflow:validate OK — 26 tasks` |

Clean-room: czysta kopia bieżącego working tree (rsync) bez `.git`,
`node_modules`, `dist`, `.turbo`, `.remote-agent` i lokalnego
`.claude/settings.local.json`; pnpm 10.26.1 aktywowane przez `corepack prepare`;
store poza `/app` (`--store-dir /root/.pnpm-store`), aby odwzorować realny setup
(brak `.npmrc` przypinającego store). `CI=true` ustawione dla nieinteraktywnego
`pnpm`.

## Snapshoty i artefakty

- Artefakt/ścieżka: `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- Czy snapshot się zmienił i dlaczego: TAK — `maxItems` 8→3 w dwóch miejscach
  (`DecisionRequest` samodzielny i osadzony w `AgentCompletion`), co bezpośrednio
  wynika ze zwężenia `DecisionRequest.options` do `max(3)`. Reszta snapshotu bez zmian.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; zmiany dotyczą wyłącznie definicji typów/schematów i
  testów. Nie odczytywano ani nie logowano sekretów. `.claude/settings.local.json`
  nietknięty (`git status` nie wykazuje żadnej zmiany w `.claude`).
- Izolacja kont/scope: `integration_scope`/`authoritative_scope` pozostają
  autorytatywne i przypisywane poza modelem; model nie może ich rozszerzyć.
- Side effecty i idempotencja: kontrakty są czyste; `RunSafety`/`ExternalAction`
  zachowują `AMBIGUOUS` jako punkt zatrzymania automatycznego replayu
  (RunSafety terminalny; ExternalAction rozstrzygany wyłącznie manualnie do
  SUCCEEDED/FAILED). Podwójne uruchomienie `pnpm run check` w tej samej kopii
  dało ten sam wynik (exit 0) — brak niedeterministycznych side effectów testów.
- Dane zewnętrzne traktowane jako niezaufane: `trust.ts` oznacza treści z
  integracji jako `UNTRUSTED_DATA`; kontrakty nie mieszają danych modelu z
  autorytatywnym scope.

## Znane ograniczenia i ryzyka

- Runtime: audytor nie ma dostępu do lokalnego Docker/host tak jak implementer;
  dowody clean-room są w tabeli powyżej. Reprodukcja wymaga tego samego obrazu
  `node:24.19.0-bookworm-slim` i pnpm 10.26.1.
- ESLint zgłasza ostrzeżenia migracyjne `eslint-plugin-boundaries` v6 (istniejące,
  poza zakresem RA-002); nie są błędami i nie wpływają na exit code.
- Zmiany nie są zacommitowane (zgodnie z poleceniem: nie commituj, nie pushuj).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: kontrakty i maszyny stanów RA-002 wraz z testami; wszystkie
  bramki (host + clean-room) zielone.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie rozpoczynać RA-003.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: `packages/contracts/src`
  i `packages/contracts/test`; snapshot aktualizować świadomie z uzasadnieniem.
