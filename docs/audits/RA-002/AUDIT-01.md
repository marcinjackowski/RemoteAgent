# RA-002 — Audit 01

## Metadata

- Task: `RA-002`
- Audytowany handoff: `docs/handoffs/RA-002/HANDOFF-01.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Implementacja dostarcza szeroki, dobrze testowany fundament kontraktów: wersje
fail-closed, typy wyprowadzane ze schematów Zod, snapshoty JSON Schema,
canonical digest i jawne state machines. Niezależny clean-room gate przechodzi na
przypiętym Node 24.19.0 i pnpm 10.26.1. Audyt adwersarialny ujawnił jednak stany,
które naruszają kluczowe inwarianty autoryzacji, receiptów i izolacji scope:
parser akceptuje wykonywanie akcji po `DENY`, akcję wymagającą approval bez
approval, `SUCCEEDED` bez receipt oraz niespójne connection/case w zagnieżdżonych
kontraktach. Werdykt nie może być `PASS` przy findingach HIGH/MEDIUM.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`, `docs/workflow/AUDIT_CHECKLIST.md`,
  `docs/tasks/TASK_INDEX.md`, `docs/tasks/RA-002.md`, HANDOFF-01 i szablon audytu.
- Sprawdzony stan: pełny tracked diff od `df5c084` oraz wszystkie nowe pliki w
  `packages/contracts/src`, `packages/contracts/test`, fixture'y, snapshot,
  manifest, lockfile i handoff.
- Digest audytowanego zestawu `packages/contracts` + handoff:
  `ed4a8a72835ada6d324710b62e94b737aeb85b03539ac66331d6e3a9105ed792`.
- Uruchomione kontrole: testy kontraktów, root typecheck, lint i format pakietu,
  workflow validator, skan sekretów, adversarial parse matrix oraz niezależny
  clean-room frozen install + pełny `pnpm run check` na przypiętym runtime.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Boundary contracts odrzucają nieznane pola | PASS | `versionedContract`/`valueObject` używają `z.strictObject`; negatywne testy runtime i schema snapshot. |
| 2. `schema_version` i strategia migracji | PASS | `schemaVersion = z.literal(1)`, v1/v2 fixtures, czysty future v2 jest odrzucany, JSON Schema zawiera `const: 1`. |
| 3. Typowany błąd niedozwolonego przejścia bez mutacji | PASS | `InvalidTransitionError`; macierze Case/RunSafety/ExternalAction/WorkUnit. |
| 4. Digest niezależny od kolejności kluczy | PASS | unit + property tests (500 przebiegów) i powiązanie `ExternalAction.action_digest` z payloadem. |
| 5. External content ma jawny trust marker | PASS | provider `display_name` wymusza `UNTRUSTED_DATA`; tool arguments/results i checkpoint summary mają jawny marker. |
| 6. Terminalne statusy i recovery są pokryte | PASS | kompletne sety terminalne i jawne przejścia BLOCKED/AMBIGUOUS w 31 testach state machines. |
| Audit focus: model output nie miesza się z autorytatywnym scope | FAIL | Niespójne connection/case w zagnieżdżonych granicach przechodzą walidację; findingi HIGH i MEDIUM. |

## Findingi

### HIGH — ExternalAction dopuszcza wykonanie bez autoryzacji i fałszywy sukces bez receipt

- Lokalizacja: `packages/contracts/src/external-action.ts:107-154`,
  `packages/contracts/src/external-action-machine.ts:14-34`.
- Dowód: niezależna macierz runtime zwróciła `true` dla:
  `policy_decision=DENY,status=EXECUTING`,
  `policy_decision=REQUIRES_APPROVAL,status=EXECUTING,approval_id=null` oraz
  `status=SUCCEEDED,external_receipt=null`.
- Wpływ: kontrakt reprezentuje akcję odrzuconą przez policy jako wykonywalną,
  pozwala ominąć wymaganą zgodę i deklarować sukces write'a bez potwierdzonego
  receipt. Narusza to zasady „model nie jest warstwą autoryzacji” oraz „write bez
  receipt pozostaje AMBIGUOUS, nie SUCCESS”.
- Wymagana zmiana: związać `policy_decision`, `approval_id`, `status` i
  `external_receipt` fail-closed (dyskryminowana unia albo walidowane inwarianty)
  oraz dodać policy-aware walidację przejść. Co najmniej: `DENY` nie może wejść w
  APPROVED/EXECUTING/SUCCEEDED; `REQUIRES_APPROVAL` nie może wejść w wykonanie bez
  approval; `SUCCEEDED` wymaga receipt; brak potwierdzenia po rozpoczęciu daje
  `AMBIGUOUS`. Dodać negatywne testy wszystkich tych stanów.

### HIGH — EventEnvelope pozwala powiązać zdarzenie z encją innego connection/provider

- Lokalizacja: `packages/contracts/src/event-envelope.ts:62-80`.
- Dowód: poprawny fixture v1 z top-level `connection_id=conn-jira-private`
  przechodzi po zmianie wyłącznie `entity_ref.connection_id` na `conn-other`.
  Analogicznie nie ma więzi między top-level `provider` i `entity_ref.provider`.
- Wpływ: resolver może skorelować event jednego konta z encją drugiego konta,
  tworząc cross-account/cross-provider leakage już na wspólnym kontrakcie, zanim
  późniejsze warstwy scope dostaną dane.
- Wymagana zmiana: runtime invariant wymuszający równość top-level
  `connection_id`/`provider` z `entity_ref.connection_id`/`provider`, z testami
  mismatch dla obu pól i zgodnym opisem projekcji JSON Schema/runtime.

### MEDIUM — WAITING_FOR_USER może przenieść DecisionRequest do innego case

- Lokalizacja: `packages/contracts/src/agent-completion.ts:50-72`.
- Dowód: fixture `AgentCompletion` dla `case-compat-1` nadal przechodzi po zmianie
  `decision_request.case_id` na `case-other`.
- Wpływ: modelowy completion może utworzyć trwałe pytanie przypisane do innej
  sprawy niż run, co grozi błędnym routingiem odpowiedzi właściciela i zmianą
  checkpointu obcego case.
- Wymagana zmiana: związać `decision_request.case_id` z completion `case_id`
  w walidacji boundary i dodać negatywny test cross-case. Deterministyczny
  orchestrator nadal musi wiązać `run_id` z autorytatywnym runem poza modelem.

### MEDIUM — Approval dopuszcza niespójny stan zużycia

- Lokalizacja: `packages/contracts/src/external-action.ts:69-86`.
- Dowód: `consumed=true` bez `consumed_at` przechodzi `approval.safeParse`; schema
  dopuszcza również `consumed=false` z `consumed_at` i nie sprawdza kolejności
  `granted_at < expires_at`.
- Wpływ: persisted approval może mieć niejednoznaczny stan one-shot, utrudniając
  recovery i bezpieczne rozstrzygnięcie, czy grant wolno ponownie wykorzystać.
- Wymagana zmiana: modelować consumed/unconsumed jako spójne warianty albo dodać
  fail-closed invariants (`consumed` dokładnie odpowiada obecności
  `consumed_at`, expiry jest późniejsze niż grant) i testy obu stron.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run packages/contracts` | 0 | 8 plików, 84/84 testy PASS. |
| `pnpm run typecheck` | 0 | root tsc + 20/20 workspace typechecks. |
| `pnpm exec eslint packages/contracts` | 0 | brak błędów; tylko istniejące warningi konfiguracji boundaries. |
| `pnpm exec prettier --check packages/contracts` | 0 | wszystkie pliki pakietu sformatowane. |
| `pnpm run workflow:validate` | 0 | `workflow:validate OK — 26 tasks`. |
| Clean-room: Node `24.19.0`, pnpm `10.26.1`, frozen install + `pnpm run check` | 0 | lint/format/typecheck/test/build 20/20 bez cache + validator PASS. |
| Adversarial parse matrix (6 stanów) | 0 procesu, 6 nieoczekiwanych akceptacji | Wszystkie unsafe/cross-scope fixtures zwróciły `safeParse(...).success=true`. |
| Skan wzorców sekretów w `packages/contracts` i handoffie | 0 | brak trafień. |

## Ryzyka przekrojowe

- Security/privacy: typy scope są server-side, ale brakuje relacyjnych więzi
  connection/case i policy/action, więc sam strict shape nie zamyka granicy.
- Idempotencja/recovery: canonical digest i AMBIGUOUS są dobre; receipt i approval
  muszą jednak reprezentować wyłącznie spójne stany, aby restart nie powtórzył
  write'a ani nie zadeklarował sukcesu bez dowodu.
- Współbieżność: WorkUnit poprawnie wymusza jedynego writera (IMPLEMENTER).
- Observability: trace/correlation fields istnieją; typowane błędy przejść są
  actionable. Cross-field validation powinna zwracać ścieżki konkretnych pól.
- Kompatybilność: wersja 1 jest literalna i future fail-closed; poprawki
  invariants mogą pozostać w v1 jako naprawa odrzucająca stany, które od początku
  były semantycznie nielegalne.

## Wymagane działania po `continue`

1. Implementer ustawia `RA-002` z `CHANGES_REQUESTED` na `IN_PROGRESS`.
2. Naprawia cztery findingi bez rozszerzania zakresu na persistence/executor.
3. Dodaje adwersarialne regresje oraz aktualizuje snapshot wyłącznie, jeśli
   projekcja JSON Schema rzeczywiście się zmienia, z uzasadnieniem.
4. Uruchamia pełny clean-room gate, tworzy `HANDOFF-02` i ponownie ustawia
   `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Mechaniczne kryteria RA-002 i pełny gate są zielone, lecz kontrakty są fundamentem
autoryzacji i recovery późniejszych tasków. Akceptowanie policy `DENY` jako
wykonywalnego, sukcesu bez receipt oraz cross-connection/cross-case zagnieżdżeń
pozostawia findingi HIGH i MEDIUM. Zgodnie z checklistą `PASS` jest niedozwolony;
werdykt to `CHANGES_REQUIRED`.
