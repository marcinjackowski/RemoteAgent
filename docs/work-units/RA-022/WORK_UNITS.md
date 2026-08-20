# RA-022 — Work units

## Metadata

- Task: `RA-022`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES`. Zależności `DONE`:
  RA-003, RA-004, RA-005, RA-006, RA-008. Niedokończona: RA-021.
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test`

## Global boundaries

- In scope: deterministyczna policy R0–R4, approval binding, kill switches i
  osobny action executor dla external writes.
- Out of scope: automatyczne production merge/deploy, admin/permission management.
- **Model nie jest warstwą autoryzacji.** Policy i approval są rozstrzygane
  deterministycznie poza modelem. Żadna deklaracja modelu ani annotacja zdalnego
  narzędzia nie może auto-approve'ować akcji.
- **R4 (merge, force-push, delete, prod deploy, permissions) zawsze wymaga jawnej
  zgody właściciela.**

## Ustalenia z kodu przed planowaniem (2026-08-20)

Sprawdzone w repozytorium, nie założone:

1. **Kontrakty `approval` i `externalAction` już istnieją i są mocne** —
   `packages/contracts/src/external-action.ts`:
   - `approval` z `granted_by`, `action_digest` („exact action digest this approval
     authorizes — no wildcard"), `expires_at`, `consumed`, `consumed_at`, plus
     `superRefine` wymuszający `consumed ⟺ consumed_at` i `expires_at > granted_at`;
   - `externalAction` z `superRefine`, który **przelicza** `canonicalDigest`
     payloadu i fail-closed przy niezgodności — to bezpośrednio realizuje AC1
     („zmiana jednego parametru po approval unieważnia zgodę");
   - `RiskTier` i `riskTierSchema`.
   Nie tworzyć drugiego zestawu kontraktów.
2. **Migracja `008_actions_approvals_receipts` już istnieje** i zawiera tabele
   `external_actions` oraz `approvals`. `approvals` ma: `approval_id`, `case_id`,
   `granted_by`, `action_digest` (z CHECK na format sha256), `granted_at`,
   `expires_at`, `consumed`, `consumed_at`, `updated_at`, oraz CHECK-i
   `approvals_expiry_after_grant` i `approvals_consumed_consistent`.
   `external_actions` ma `UNIQUE INDEX` na `action_digest`.
3. **POTWIERDZONA LUKA: brak `checkpoint_revision` w `approvals`.** AC2 wymaga, by
   approval „odrzucał stale checkpoint revision", a tabela nie ma żadnej kolumny
   wiążącej zgodę z rewizją checkpointu. Kontrakt `approval` też jej nie ma.
   To nie jest kosmetyka — bez tego approval udzielony przy rewizji `N` pozostaje
   ważny po zmianie stanu case do `N+1`, co jest dokładnie TOCTOU wskazanym w
   audit focus taska. **Rozstrzygnięcie „rozszerzyć `008` czy dodać nowy ledger"
   jest pierwszą decyzją tego taska** (zob. Decision Request poniżej).
4. **`UNIQUE INDEX external_actions_digest_idx` na `action_digest`** oznacza, że ta
   sama kanoniczna akcja nie może istnieć dwukrotnie. To dobre dla idempotencji, ale
   trzeba sprawdzić, czy nie blokuje legalnego retry po `AMBIGUOUS` — do
   zweryfikowania w unicie executora, nie do założenia.
5. **Numer migracji: NIE tworzyć `026`** — jest zajęty przez
   `026_jira_reconciliation_watermarks`. `027` bierze RA-012; RA-013/014/015/017/
   019/020/021 wezmą kolejne. RA-022 bierze następny wolny **po ponownym
   sprawdzeniu `ls packages/database/migrations/`**.
6. **`packages/policy` już istnieje** i zawiera `credential-refresh.ts`,
   `credential-vault.ts`. Uwaga na `CTF-001` (duplikat klas
   `CredentialRefresh*Error` względem `packages/database`) — jeśli RA-022 dotknie
   tej granicy, domknąć `CTF-001` osobnym unitem.

## Decision Request — do rozstrzygnięcia przy starcie taska

- **Decyzja:** rozszerzyć istniejącą tabelę `approvals` (nowa migracja dodająca
  `checkpoint_revision` i ewentualne pola scope), czy utworzyć osobny
  approval grant/use ledger?
- **Dlaczego teraz:** AC2 i AC6 (kill switch między approval a execute) wymagają
  wiązania zgody z rewizją checkpointu oraz atomowego single-use. Obecna tabela
  daje single-use przez `consumed`, ale bez rewizji.
- **Opcja A — rozszerzyć `008` nową migracją:** mniej ruchomych części, zachowuje
  istniejące CHECK-i i `UNIQUE INDEX`. Wymaga migracji dodającej kolumnę
  `NOT NULL` do potencjalnie niepustej tabeli, czyli backfillu albo wartości
  domyślnej — trzeba to zaprojektować fail-closed (brak rewizji ≠ „każda rewizja OK").
- **Opcja B — osobny grant/use ledger:** czystszy model „grant vs use" i miejsce na
  audyt każdego użycia, ale duplikuje pojęcie approval w dwóch tabelach i wymaga
  jasnego rozstrzygnięcia, która jest authority.
- **Rekomendacja koordynatora: Opcja A**, o ile backfill da się zrobić
  fail-closed (istniejące, niezużyte approvals unieważnić, nie uznać za ważne).
  Decyzja należy do właściciela, bo zmienia zaakceptowany schemat z RA-003/RA-008.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-022-WU-01` | `DRAFT` | risk/policy/approval contracts + checkpoint/scope binding | RA-021 DONE, decyzja wyżej |
| `RA-022-WU-02` | `DRAFT` | durable approval grant/use ledger z atomic single-use | WU-01 |
| `RA-022-WU-03` | `DRAFT` | czysty deterministyczny evaluator R0–R4 + kill-switch snapshot | WU-01 |
| `RA-022-WU-04` | `DRAFT` | authenticated Discord approval ingestion i resume trigger | WU-02, WU-03 |
| `RA-022-WU-05` | `DRAFT` | provider-neutral ExternalAction intent/receipt/reconciliation | WU-02, WU-03 |
| `RA-022-WU-06` | `DRAFT` | final fake-provider integration proof | WU-04, WU-05 |

## Wymagania do rozdzielenia na units

- **AC1 (zmiana parametru po approval unieważnia zgodę)** → `WU-01`; wykorzystać
  istniejący `superRefine` przeliczający `canonicalDigest`; test tampered payload.
- **AC2 (approval jednorazowe, owner-scoped, odrzuca stale checkpoint revision)** →
  `WU-01` + `WU-02`; **wymaga domknięcia luki `checkpoint_revision`**; testy replay,
  expired, wrong-owner, stale revision.
- **AC3 (policy sprawdzana przy proposal i bezpośrednio przed execute)** → `WU-03`
  + `WU-05`; podwójne sprawdzenie to rdzeń obrony przed TOCTOU.
- **AC4 (niepotwierdzony provider timeout → `AMBIGUOUS` + reconciliation)** →
  `WU-05`; ta sama zasada co RA-012/RA-017/RA-021; **nigdy blind replay**; testy
  timeout przed i po side effekcie.
- **AC5 (R4 nie może być auto-approved przez model ani remote annotation)** →
  `WU-03`; test adwersarialny z annotacją zdalnego narzędzia próbującą obniżyć tier.
- **AC6 (kill switch działa między approval a execute)** → `WU-03` + `WU-05`; test
  race: kill switch aktywowany po approval, przed execute.
- **AC7 (receipt wiąże action, provider result i external entity version)** →
  `WU-05`; oparte na `externalReceipt`.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, sondę przecięcia eksportów, oraz osobno weryfikuje siedem
kryteriów akceptacji — w szczególności tampered digest, stale checkpoint revision,
kill-switch race, timeout po możliwym side effekcie i próbę auto-approve R4.
Migracja musi być odwracalna (`up` → `down` → `up`). **Żaden live external write
nie jest wykonywany bez jawnej zgody właściciela.** Następnie handoff i niezależny
audyt.
