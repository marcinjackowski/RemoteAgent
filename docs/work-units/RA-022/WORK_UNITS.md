# RA-022 — Work units

## Metadata

- Task: `RA-022`
- Plan revision: `2`
- Plan status: `READY` — task jest `READY`, wszystkie zależności `DONE`
  (RA-003, RA-004, RA-005, RA-006, RA-008, RA-021 — sprawdzone w `TASK_INDEX.md`
  przy starcie `2026-08-21`).
- Rola: jedna rola wykonawcza (ADR-0007). Rewizja `1` była pisana pod ADR-0005 i
  pod status `BLOCKED_BY_DEPENDENCIES`; ta rewizja usuwa oba założenia, zamyka
  Decision Request (rozstrzygnięty przez właściciela) i koryguje ustalenia z kodu.
- Base commit: `0a47b734927e3660b88ff4174e168deaa9d6843d`
- Base tree: `0d660ac1417c17bf4c4ac6fde198237cfeedbfa1`
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
- **Żaden live external write bez jawnej zgody właściciela.** Wszystkie testy
  przeciwko fake providerowi.

## Decyzja właściciela — zamknięta, nie jest już Decision Request

`CTF-005` rozstrzygnięty `2026-08-20`: **rozszerzyć `approvals` nową migracją o
`checkpoint_revision`, bez osobnego grant/use ledgera**, z warunkiem
**fail-closed backfill** — istniejące, niezużyte zgody bez rewizji zostają
unieważnione, nie uznane za ważne. Uzasadnienie: jedno źródło prawdy o zgodzie i
mniejszy blast radius niż utrzymywanie spójności między dwiema tabelami.

Konsekwencja dla planu: `WU-01` zaczyna od migracji, nie od pytania. Rewizja `1`
tego pliku miała tu Decision Request — jest zamknięty i usunięty.

## Ustalenia z kodu przed implementacją (`2026-08-21`)

Sprawdzone w repozytorium, nie założone. Trzy pozycje korygują rewizję `1`.

1. **Kontrakty `approval` i `externalAction` istnieją i są mocne** —
   `packages/contracts/src/external-action.ts`:
   - `approval` z `granted_by`, `action_digest` („exact action digest this approval
     authorizes — no wildcard"), `expires_at`, `consumed`/`consumed_at`, oraz
     `superRefine` wymuszający `consumed ⟺ consumed_at`, `expires_at > granted_at`
     **i** `granted_at ≤ consumed_at < expires_at`;
   - `externalAction` z `superRefine`, który **przelicza** `canonicalDigest`
     payloadu i fail-closed przy niezgodności — to jest AC1;
   - `RiskTier` (R0–R4) i `riskTierSchema`.
   Nie tworzyć drugiego zestawu. RA-021 nauczył, że to realna pułapka: sonda
   `CTF-002` odrzuciła tam trzy kolizje przy pierwszym uruchomieniu.
2. **Migracja `008` egzekwuje już część AC5 natywnie** —
   `external_actions_r4_requires_approval` CHECK czyni
   `risk_tier = 'R4' AND policy_decision = 'AUTO_ALLOW'` **niereprezentowalnym** w
   SQL. To fundament AC5, nie do przepisania w TypeScripcie.
   `external_action_machine.ts` dokłada guard tranzycji: `DENY` pozwala wyłącznie
   `PROPOSED → REJECTED`, `REQUIRES_APPROVAL` blokuje skrót
   `PROPOSED → EXECUTING`.
3. **POTWIERDZONA LUKA — brak `checkpoint_revision` w `approvals`.** Tabela ma
   `approval_id`, `case_id`, `granted_by`, `action_digest`, `granted_at`,
   `expires_at`, `consumed`, `consumed_at`, `updated_at`. Kontrakt `approval` też
   nie ma tego pola. To AC2 i główne TOCTOU z audit focus.
4. **KOREKTA rewizji 1: warstwa Discorda jest już gotowa na rewizję.**
   `packages/discord/src/custom-id.ts` **już koduje `checkpointRevision` w
   `custom_id` przycisku approval** (`encodeApproval`, `decodeInteraction` →
   `ApprovalInteraction.checkpointRevision`), a `dispatcher.ts` już renderuje
   przyciski z `approval.checkpoint_revision`. Luka jest więc **wyłącznie** w
   schemacie i kontrakcie, nie w interakcji. `WU-04` jest przez to znacznie
   mniejszy, niż zakładała rewizja `1`.
5. **KOREKTA rewizji 1: wzorzec odrzucania stale revision już istnieje.**
   `packages/contracts/src/decision.ts` ma `assertAnswerMatchesRequest` +
   `StaleDecisionAnswerError` — dokładnie ten kształt, którego AC2 potrzebuje dla
   approvals. Powtórzyć wzorzec, nie wymyślać drugiego.
6. **KOREKTA rewizji 1: numer migracji to `029`.** Rewizja `1` mówiła „następny
   wolny po sprawdzeniu"; `027` wziął RA-012, **`028` wziął RA-021**. Sprawdzone:
   `ls packages/database/migrations/` → najwyższa `028_mcp_tool_calls`.
7. **`UNIQUE INDEX external_actions_digest_idx` na `action_digest`** — ta sama
   kanoniczna akcja nie może istnieć dwukrotnie. Dobre dla idempotencji, ale
   **trzeba sprawdzić, czy nie blokuje legalnego retry po `AMBIGUOUS`** — do
   zweryfikowania testem w `WU-05`, nie do założenia w żadną stronę.
8. **`packages/policy` ma `scope.ts`, `connection-guard.ts`, `credential-*.ts`** i
   jeden plik testowy (`connection-security.test.ts`). Uwaga na `CTF-001`
   (duplikat `CredentialRefresh*Error` względem `database`) — RA-022 **nie** ma
   domykać `CTF-001`, to zakres `RA-023-WU-00`; unikać dotykania tej granicy.
9. **Wzorce z RA-021 do ponownego użycia, nie do przepisania:** commit intentu
   **przed** side effektem, `AMBIGUOUS` przy braku receiptu, fence w SQL na
   statusie, sonda przecięcia eksportów w bramce, mutation check per mechanizm.

## Korekty po red-teamie (do utrzymania)

1. **Policy sprawdzana dwa razy — przy proposal i bezpośrednio przed execute.**
   Jednokrotne sprawdzenie to TOCTOU: policy albo kill switch mogą się zmienić
   między zgodą a wykonaniem (AC3, AC6).
2. **Kill switch czytany w tej samej transakcji co consumption approvalu.**
   Sprawdzenie „przed" bez fencingu to ten sam TOCTOU o jeden poziom niżej (AC6).
3. **Timeout providera po możliwym side effekcie → `AMBIGUOUS`, nigdy blind
   replay.** Ta sama zasada co RA-012, RA-017 i RA-021 (AC4).
4. **Digest liczony z kanonicznego payloadu, nie z tekstu żądania.** Inaczej
   zmiana serializacji unieważnia zgody, a zmiana kolejności kluczy je omija (AC1).
5. **Annotacja zdalnego narzędzia nie obniża tieru.** Tier jest server-owned,
   jak registry w RA-021 (AC5).
6. **Approval jest jednorazowe atomowo**, nie „sprawdź i ustaw" (AC2).

## Unit index

| Unit | Status | Result | Komenda weryfikacyjna |
|---|---|---|---|
| `RA-022-WU-01` | **`DONE`** | migracja `029` (`checkpoint_revision`, fail-closed backfill) + kontrakt `approval` | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/approval-schema.integration.test.ts` → `12/12`, exit `0` |
| `RA-022-WU-02` | `READY` | durable approval repository z atomowym single-use i fencingiem rewizji | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/approval.integration.test.ts` |
| `RA-022-WU-03` | `READY` | czysty deterministyczny evaluator R0–R4 + kill-switch snapshot | `pnpm vitest run packages/policy/test/policy-engine.test.ts` |
| `RA-022-WU-04` | `READY` | approval ingestion nad istniejącym `custom_id` Discorda | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/ingestion.integration.test.ts` |
| `RA-022-WU-05` | `READY` | action executor: podwójna policy, receipt, `AMBIGUOUS`, reconciliation | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/executor.integration.test.ts` |
| `RA-022-WU-06` | `READY` | fake-provider proof: tamper, replay, race, R4 | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test` |

## Stan przy pauzie (`2026-08-21`) — drzewo CZYSTE

`WU-01` jest ukończony, zweryfikowany i **zacommitowany**. Właściciel potwierdził
commit w trakcie taska dla tego kroku, żeby zmiana zaakceptowanego kontraktu
`approval` była recenzowalna osobno.

```text
372c490 feat(contracts,database): bind an approval to the checkpoint it was granted at
f5b3b92 docs(workflow): make task closure leave a self-sufficient repository
0a47b73 docs(audits): pass RA-021 ...     <- bazowy commit RA-022
```

Następny krok: **`WU-02`**, nie powtarzanie `WU-01`. Drzewo jest czyste, więc jeśli
`git status` pokazuje zmiany, są nowe i nie pochodzą z `WU-01`.

## Stan wykonania — `WU-01` zamknięty (`2026-08-21`)

Zapisane tutaj, bo są to ustalenia z uruchomionych komend, nie z planu. Historia
chatu może być pusta; ten plik jest źródłem prawdy dla stanu pracy.

### Co powstało

- `packages/database/migrations/029_approval_checkpoint_revision.{up,down}.sql` —
  `checkpoint_revision` + `owner_id` w `approvals`, fail-closed backfill zgodnie z
  decyzją właściciela, `approvals_revision_valid` CHECK, composite FK do
  `cases (case_id, owner_id)`, index częściowy na `consumed = false`.
- `packages/contracts/src/external-action.ts` — `approval` dostał `owner_id` i
  `checkpoint_revision` (`z.int()`, nie `nonnegative`, bo sentinel `-1` musi być
  reprezentowalny) plus `superRefine` lustrzany do CHECK-a.
- `packages/policy/test/approval-schema.integration.test.ts` — 12 testów.
- Zaktualizowane fixture'y: `packages/contracts/test/external-action.test.ts`
  (3 literały + 3 nowe testy), snapshot JSON Schema (12 wstawek, zero usunięć,
  diff przejrzany polami: tylko `approval`), `packages/database/test/scope.integration.test.ts`
  (3 INSERT-y `approvals` dostały wymagane kolumny; `caseA`→owner `A`, `caseB`→`B`).

### Uruchomione bramki po `WU-01`

```text
packages/policy/test/approval-schema.integration.test.ts   12/12, exit 0
całe repo                                                  1619/1619, 134 pliki
turbo run typecheck --force                                 36 successful, 0 cached
pnpm run build --force                                      26 successful, 0 cached
eslint + prettier (policy, contracts)                       czysto
```

### Mutation check `WU-01` — 5 mutacji, wszystkie łapane

| Mutacja | Skutek |
|---|---|
| grandfathering zamiast inwalidacji | 12 testów czerwonych |
| sentinel `0` zamiast `-1` | 2 czerwone |
| `DEFAULT 0` na kolumnie | 3 czerwone |
| `owner_id = granted_by` | 1 czerwony (**po naprawie testu**, patrz niżej) |
| usunięty `approvals_revision_valid` | 1 czerwony |

**Mutacja `owner_id = granted_by` najpierw PRZEŻYŁA** — mój własny test „derives
owner_id from the case rather than from granted_by" przechodził, bo fixture miał
`granted_by === owner_id`, więc asercja nie potrafiła rozróżnić dwóch źródeł. To
wzorzec `CTF-010` w moim własnym teście. Naprawione: aktor to teraz
`delegate-who-clicked`, różny od ownera case'a; mutacja jest łapana.

### Dwie decyzje projektowe, których nie wolno cofnąć bez powodu

1. **`policy` NIE MOŻE mieć `@remoteagent/database` w `dependencies` ani w
   `devDependencies`.** Próbowałem obu — `turbo` przerywa `build` z
   `Cyclic dependency detected`, bo `packages/database` ma `@remoteagent/policy` w
   swoich `devDependencies` (dla własnych testów). Test integracyjny importuje
   harness **relatywnie** (`../../database/src/index.js`), co nie tworzy krawędzi
   w grafie pakietów i dodatkowo utrzymuje JEDNĄ tożsamość klasy `Database`
   wspólną z harnessem.
2. **`packages/policy/tsconfig.test.json` wyłącza `test/**/*.integration.test.ts`.**
   Konsekwencja punktu 1: relatywny import wychodzi poza `rootDir`, więc `tsc`
   daje `TS6059` dla każdego tranzytywnie osiągniętego pliku. Obie granice (brak
   cyklu pakietów + `rootDir`) nie dają się spełnić razem bez rozstrzygnięcia
   src-vs-dist w całym repo — a to jest jawnie zakres własnego unitu w `CTF-004`.
   Uzasadnienie jest zapisane w samym pliku `tsconfig.test.json`.

### Ustalenie dla `WU-02` (sprawdzone w kodzie, nie założone)

Repozytorium approvali należy do **`packages/database/src/repositories/`**, nie do
`packages/policy`. Wzorzec: `CredentialRefreshIntentRepository` importuje wyłącznie
`@remoteagent/contracts` + lokalne `../client.js` i przyjmuje `Queryable`, więc
metoda działa zarówno na puli, jak i w transakcji. `Transaction` jest brandowanym
typem, którego `Database` (auto-commit) **nie** spełnia — API wymagające
atomowości ma go żądać w sygnaturze, co czyni „przekaż pulę jako transakcję"
błędem kompilacji (AUDIT-01 HIGH-02 w RA-003). Atomowe single-use consumption
approvalu musi więc żądać `Transaction`, a kill switch ma być czytany w **tej
samej** transakcji (AC6).

Nowy plik: `packages/database/src/repositories/approval.ts` + wpis w
`repositories/index.ts`.

## Mapa kryteriów akceptacji na units

- **AC1 (zmiana parametru unieważnia zgodę)** → `WU-01`; oparte na istniejącym
  `superRefine` przeliczającym `canonicalDigest`; test tampered payload **i** test
  zmiany kolejności kluczy (kanonizacja nie może unieważniać legalnej zgody).
- **AC2 (jednorazowe, owner-scoped, odrzuca stale revision)** → `WU-01` + `WU-02`;
  wymaga migracji `029`; testy replay, expired, wrong-owner, stale revision;
  single-use **atomowo**, nie check-then-set.
- **AC3 (policy przy proposal i bezpośrednio przed execute)** → `WU-03` + `WU-05`;
  test zmiany policy między jednym a drugim sprawdzeniem.
- **AC4 (timeout → `AMBIGUOUS` + reconciliation)** → `WU-05`; testy timeout przed
  i po side effekcie; dowód braku blind replay.
- **AC5 (R4 nie auto-approved przez model ani remote annotation)** → `WU-03`;
  bazuje na CHECK z migracji `008`; test adwersarialny z annotacją narzędzia
  próbującą obniżyć tier.
- **AC6 (kill switch między approval a execute)** → `WU-03` + `WU-05`; test race
  z kill switchem aktywowanym po approval, przed execute, czytany w tej samej
  transakcji co consumption.
- **AC7 (receipt wiąże action, provider result i external entity version)** →
  `WU-05`; oparte na `externalReceipt` i tabeli `receipts` (append-only).

## Final task gate

Pełna suite pakietu na prawdziwym PostgreSQL, całe repo bez regresji (wiele
przebiegów — `CTF-012`), `typecheck`/`build` z `--force`, scoped lint/format,
`pnpm workflow:validate`, `git diff --check`, sonda przecięcia eksportów
(wartości **i** type-level), mutation check dla każdego mechanizmu bezpieczeństwa,
sonda adwersarialna, migracja odwracalna (`up` → `down` → `up`), oraz osobna
weryfikacja siedmiu kryteriów akceptacji — w szczególności tampered digest, stale
checkpoint revision, kill-switch race, timeout po możliwym side effekcie i próba
auto-approve R4. **Żaden live external write.**
