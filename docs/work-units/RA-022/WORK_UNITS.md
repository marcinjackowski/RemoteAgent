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
| `RA-022-WU-02` | **`DONE`** | durable approval repository z atomowym single-use i fencingiem rewizji + migracja `030` (niezmienność grantu) | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/approval.integration.test.ts` → `32/32`, exit `0` |
| `RA-022-WU-03` | **`DONE`** | czysty deterministyczny evaluator R0–R4 + kill-switch snapshot | `pnpm vitest run packages/policy/test/policy-engine.test.ts` → `32/32`, exit `0` |
| `RA-022-WU-04` | **`DONE`** | approval ingestion nad istniejącym `custom_id` Discorda + `ExternalActionRepository` | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/ingestion.integration.test.ts` → `25/25`, exit `0` |
| `RA-022-WU-05` | **`DONE`** | action executor: podwójna policy, receipt, `AMBIGUOUS`, reconciliation + migracja `031` | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/executor.integration.test.ts` → `29/29`, exit `0` |
| `RA-022-WU-06` | **`DONE`** | fake-provider proof: tamper, replay, race, R4 | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test` → `183/183`, exit `0` |

## Stan wykonania — `WU-03`…`WU-06` zamknięte (`2026-08-21`)

Ustalenia z uruchomionych komend. Sekcje `WU-01` i `WU-02` niżej bez zmian.

### Co powstało

- `packages/policy/src/policy-engine.ts` — `ACTION_REGISTRY` (server-owned tier per
  tool, `Object.freeze`), `evaluatePolicy`, `policyEvaluationsAgree`,
  `assertR4NeverAutoAllowed`, `toPolicyKillSwitches`. **Czysta funkcja** — żadnej
  transakcji, żadnego zegara, żadnego side effectu.
- `packages/policy/src/ingestion-ports.ts` — strukturalne porty (patrz „kolizja
  eksportów" niżej).
- `packages/policy/src/approval-ingestion.ts` — `ingestApprovalClick` + bounded TTL.
- `packages/policy/src/action-executor.ts` — `executeAction`,
  `reconcileAmbiguousAction`.
- `packages/database/src/repositories/external-action.ts` —
  `ExternalActionRepository` + `ReceiptRepository`.
- `packages/database/migrations/031_receipt_entity_version.{up,down}.sql` —
  `entity_version` + `entity_version_field` w `receipts` (AC7).
- Trzy suity: `policy-engine.test.ts` (32), `ingestion.integration.test.ts` (25),
  `executor.integration.test.ts` (29).

### Decyzje projektowe, których nie wolno cofnąć bez powodu

1. **Tier NIGDY nie pochodzi od modelu ani z annotacji.** `ACTION_REGISTRY` jest
   zamkniętą allowlistą (nie pattern-matchem: `jira.issue.*` wchłonęłoby przyszłe
   `jira.issue.delete`). Nieznane narzędzie → `UNKNOWN_ACTION` + raportowane jako R4.
   Annotacja obniżająca tier to **REFUSAL**, nie „zignoruj" — rozbieżność znaczy, że
   coś jest nie tak wyżej, a cicha kontynuacja to ukryje (AC5).
2. **Kill switch sprawdzany PRZED guardem RA-005 i przed tierem.** Powód niżej
   (PROBE 1 WU-03): guard dopasowuje CONNECTION switch po providerze **i**
   connection id, więc akcja z innym providerem przechodziła obok stopu wystawionego
   dla jej własnego connectiona. Engine traktuje **każdy** enabled switch w
   snapshotcie jako stop; zawężanie zakresu to zadanie `listEffective`, nie tej
   funkcji.
3. **`killSwitchEventIds` są SORTOWANE.** Inaczej samo przetasowanie listy dawało
   FAŁSZYWY mismatch AC3 i blokowało legalną egzekucję.
4. **Executor otwiera DWIE transakcje, side effect strictly pomiędzy.** Jedna
   transakcja przez cały call providera przypięłaby połączenie na czas jego latencji —
   wolny provider = awaria bazy. Test „does not hold a transaction open" tego pilnuje.
5. **`ports.now(tx)` czyta zegar BAZY.** `PolicyInput.now` jest jedynym zaufanym
   wejściem czystego evaluatora, a sonda WU-03 (PROBE 2) potwierdziła: backdated `now`
   zmienia wygasły credential w dozwoloną akcję. Domknięte w executorze, nie w
   evaluatorze — tam się nie da.
6. **Adapter, który RZUCIŁ, daje `AMBIGUOUS`, nie `FAILED`.** `FAILED` licencjonuje
   retry, a rzucony błąd nie mówi nic o tym, czy żądanie opuściło proces.

### Kolizja eksportów type-only — wprowadzona i naprawiona w tej bramce

Sonda type-level (`ts.Program` + `checker.getExportsOfModule()`) wykryła, że
`ingestion-ports.ts` wprowadził **cztery** nowe kolizje nazw z `packages/database`:
`ApprovalRow`, `ApprovalGrantOutcome`, `ApprovalConsumption`, `ExternalActionRow`
(plus `Transaction`). To dokładnie `CTF-002` w najcichszej formie: typy nie mają
wartości, więc `typecheck`, `build` **i** runtime `Object.keys` są zielone.

Naprawione prefiksem `Policy*` (`PolicyApprovalRow`, `PolicyTransaction`, …), zgodnie
z zapisaną w rejestrze rekomendacją „jednoznaczne nazwy". **Sonda wartościowa by tego
nie znalazła** — to argument za `CTF-002-U1` jako guardrailem, nie ręczną sondą.

### Mutation check — 42 mutacje w tych czterech unitach, 6 PRZEŻYŁO

| Unit | Mutacje | Przeżyły → co wymusiły |
|---|---:|---|
| `WU-03` | 12 | `agreement` porównuje tylko `decision` → test wariujący **wyłącznie** `riskTier` (poprzedni zmieniał też `toolName`, więc nie izolował pola) |
| `WU-04` | 13 | `attachApproval` bez fence'a; `reject` bez fence'a → testy uderzające w fence **bezpośrednio**, bo `ingestApprovalClick` sprawdza status wcześniej i nigdy tam nie dociera |
| `WU-05` | 16 | fence statusu na `EXECUTING` → test na akcji **AUTO_ALLOW**, gdzie nie ma approvalu, więc fence statusu jest jedyną ochroną |
| `WU-05` | — | kolejność receipt/status w jednej transakcji → **mutacja przeżyła słusznie**: w obrębie transakcji kolejność jest nieobserwowalna, więc skorygowałem KOMENTARZ, który twierdził inaczej (`CTF-010` w moim własnym opisie) |

Wzorzec powtarzalny i wart zapamiętania: **mutacja przeżywa najczęściej tam, gdzie
warstwa wyżej sprawdza to samo wcześniej.** Wtedy trzeba testu, który wchodzi w fence
bezpośrednio — inaczej dowodem jest cudzy `if`.

### Sondy adwersarialne — 6 findingów przy zielonych testach

`WU-03` (8 sond, 3 findingi):

| Sonda | Finding | Naprawa |
|---|---|---|
| PROBE 1 | CONNECTION switch pominięty przy niezgodnym providerze | każdy enabled switch = stop |
| PROBE 3 | przetasowanie switchy = fałszywy mismatch AC3 | sortowanie event ids |
| PROBE 2 | backdated `now` reanimuje wygasły credential | udokumentowane, domknięte w `WU-05` (`ports.now`) |

`WU-04` (8 sond, 1 finding): **PROBE 1 — TTL `1e15` ms dał grant ważny 31 709 LAT.**
Migracja 008 wymaga tylko `expires_at > granted_at`, co absurdalna data spełnia.
Naprawa: `MIN_GRANT_TTL_MS`/`MAX_GRANT_TTL_MS` + `Number.isFinite` **przed** zakresem
(`NaN` przechodzi każde `<`/`>`, więc goły zakres by go PRZYJĄŁ).

`WU-05` (7 sond, 2 findingi):

| Sonda | Finding | Naprawa |
|---|---|---|
| PROBE 2/3 | nieudany zapis receiptu zostawiał akcję w `EXECUTING` — a `reconcileAmbiguousAction` przyjmuje tylko `AMBIGUOUS`, więc **nic nigdy tego nie rozwiąże**; operator widząc „executing" ponowi write, który już się udał | `AMBIGUOUS` + nowa transakcja (stara jest aborted) |
| PROBE 4 | reconciliation przyjmowała receipt dla **dowolnego** obiektu (`TOTALLY-UNRELATED-999`) | `matchedIdempotencyKey` obowiązkowy i porównywany |

Sondy, które NIE dały findingu (sprawdzone, fail-closed): mutacja payloadu przez
adapter (payload w bazie nietknięty), cross-case reuse `approval_id`
(`ApprovalIdentityError`), cross-action bind approvalu (FK z migracji 011), re-propose
identycznego payloadu po `AMBIGUOUS` (`CONFLICT` na `action_digest` — odpowiedź na
pytanie 7 z „Ustaleń": unique index **blokuje** naiwny retry, i to jest właściwe).

### Uruchomione bramki po `WU-06`

```text
packages/policy/test (cały pakiet)      183/183, 6 plików, exit 0
całe repo                               1737/1737, 138 plików, 4 przebiegi, 0 Errors
turbo run typecheck --force             36 successful, 0 cached
pnpm run build --force                  26 successful, 0 cached
migracje 030 i 031: up → down(29) → up → down(0) → up   odwracalne
eslint (policy, database/repositories)  czysto
prettier                                czysto
sonda przecięcia eksportów (wartości)   tylko preexistujące CTF-001/CTF-002
sonda type-level                        4 nowe kolizje ZNALEZIONE i naprawione
git diff --check                        exit 0
```

## Stan wykonania — `WU-02` zamknięty (`2026-08-21`)

Ustalenia z uruchomionych komend. `WU-01` niżej pozostaje bez zmian.

### Co powstało

- `packages/database/src/repositories/approval.ts` — `ApprovalRepository` z
  `grant`, `consume`, `findById`, `listUnconsumedForDigest`. Oba mutujące API
  żądają brandowanego `Transaction` (nie `Queryable`), więc „przekaż pulę zamiast
  transakcji" jest błędem kompilacji — wzorzec AUDIT-01 HIGH-02 z RA-003.
- `packages/database/migrations/030_approvals_immutable_grant.{up,down}.sql` —
  trigger niezmienności grantu (SQLSTATE `P0103`), zakaz `DELETE`, oraz częściowy
  unique index `approvals_one_live_grant_per_action_idx` na `consumed = false`.
- `ImmutableGrantError` w `errors.ts` + wpis `P0103` w `translatePgError`.
- `packages/policy/test/approval.integration.test.ts` — 32 testy.

### Cztery fence'y consumption, wszystkie w JEDNYM `UPDATE`

`consumed = false`, `owner_id`, `action_digest`, `checkpoint_revision` — plus
`expires_at > now()` na zegarze BAZY. Jedno stwierdzenie, więc nie ma okna
check-then-act. Dodatkowo `SELECT ... FOR SHARE` na `cases` przed odczytem
rewizji: bez tego `CheckpointRepository.append` może wcisnąć się między odczyt i
`UPDATE`.

### CZTERY DEFEKTY znalezione sondą adwersarialną przy 21 ZIELONYCH testach

To najważniejszy zapis tego unitu. Wszystkie cztery mają jedną przyczynę: fence'y
czytają trwały stan, a nic tego stanu nie chroniło.

| Sonda | Defekt | Naprawa |
|---|---|---|
| PROBE 5 | `UPDATE approvals SET consumed = false` → grant do ponownego użycia | trigger `030`, reguła jednokierunkowa |
| PROBE 6 | `UPDATE ... SET action_digest = <inny>` → zgoda na payload A autoryzuje B (**AC1 odwrócone**) | trigger `030`, zamrożone terms |
| PROBE 4 | dwa `approval_id` na ten sam digest = dwa wydania jednej zgody | częściowy unique index |
| PROBE 7 | cofnięcie `cases.checkpoint_revision` wskrzeszało grant już odrzucony jako `STALE_REVISION` | supersession check na append-only `case_checkpoints` |

PROBE 3 sprawdzony i **nie** jest defektem: grant na cudzy case dostaje
`owner_id` tego case'a, więc grantujący nie może go skonsumować (`WRONG_OWNER`).

### Mutation check — 16 mutacji, 3 PRZEŻYŁY i wymusiły nowe testy

| Mutacja | Wynik |
|---|---|
| fence `consumed = false` usunięty | 2 czerwone |
| fence rewizji tautologiczny | 1 czerwony |
| fence digestu tautologiczny | 1 czerwony |
| `owner_id` → `granted_by` | **PRZEŻYŁA** → nowy test z delegatem |
| `FOR SHARE` usunięty | **PRZEŻYŁA** → nowy test „append musi CZEKAĆ" |
| unique index usunięty | **PRZEŻYŁA** → test celujący w index bezpośrednio |
| reguła un-consume wyłączona | najpierw przeżyła (reguła 3 łapała pierwsza) → asercja na treści reguły |
| pozostałe 9 (delete guard, translator `P0103`, identity check, supersession, partial index, …) | wszystkie łapane |

`owner_id` → `granted_by` przeżyła z DOKŁADNIE tego samego powodu co w `WU-01`:
fixture'y miały aktor == owner, więc żadna asercja nie rozróżniała źródeł. To
`CTF-010` dwa razy w tym samym tasku, w moich własnych testach.

### Flake we WŁASNYM teście, wykryty mutation checkiem

Pierwsza wersja testu wygaśnięcia używała `expires_at = granted_at + interval
'1 millisecond'`. Czerwieniła się pod dwiema mutacjami NIEZWIĄZANYMI z
wygaśnięciem — to był sygnał. Przyczyna: `now()` jest instantem STARTU
TRANSAKCJI, więc 1 ms okno zamykało się tylko, gdy transakcja konsumująca zdążyła
zacząć się później. Test mierzył scheduling, nie mechanizm. Poprawka: grant z
`expiresAt` już przeszłym (tamperowanie `UPDATE`-em jest teraz słusznie blokowane
przez `030`).

Wniosek do utrzymania: **mutacja czerwieniąca test w niezwiązanym obszarze jest
sygnałem flake'a, nie fałszywym alarmem.**

### Decyzja projektowa: pre-check + index, nie catch unique violation

`grant` sprawdza istniejący live grant PRZED insertem. Pierwsza wersja łapała
unique violation w `catch` — nie działa, bo nieudane stwierdzenie przerywa całą
transakcję (`current transaction is aborted`), więc `catch` nie mógł już
odpytać bazy. Index pozostaje gwarancją pod współbieżnością; pre-check daje czysty
`LIVE_GRANT_EXISTS` w przypadku sekwencyjnym.

Odrzucony wariant testu: dwie równoległe transakcje. O wyniku decydował raz
pre-check, raz index, zależnie od timingu commitów — łapał usunięty index tylko
czasami. Test niedeterministyczny nie jest bramką (`CTF-012`).

### Uruchomione bramki po `WU-02`

```text
packages/policy/test/approval.integration.test.ts   32/32, exit 0 (7 przebiegów)
całe repo                                           1651/1651, 135 plików, 7 przebiegów, 0 Errors
turbo run typecheck --force                         36 successful, 0 cached
pnpm run build --force                              26 successful, 0 cached
migracja 030: up → down(29) → up → down(0) → up     odwracalna, triggery i index wracają
eslint + prettier (zmienione pliki)                 czysto
sonda przecięcia eksportów                          tylko preexistujące CTF-001/CTF-002
git diff --check                                    exit 0
```

**Uwaga do bramki:** pierwszy pełny przebieg był czerwony na
`test/golden-path` — guardrail `CTF-011` poprawnie odmówił uruchomienia na
nieaktualnym `dist/` po zmianie `database/src`. Kolejność jest więc obowiązkowa:
`build --force` PRZED pełnym przebiegiem.

### Ustalenie dla `WU-03`

`ApprovalRepository.consume` **musi** być wołane w tej samej transakcji, w której
executor czyta kill switch — `KillSwitchRepository.listEffective` przyjmuje
`Queryable`, więc `Transaction` ją spełnia. Test AC6 w tym unicie dowodzi, że
rollback transakcji zostawia grant niezużyty, czyli zgoda właściciela przeżywa
operatorski stop. `WU-05` nie ma prawa czytać kill switcha osobną transakcją.

## Stan przy pauzie po `WU-01` (`2026-08-21`) — drzewo CZYSTE

`WU-01` jest ukończony, zweryfikowany i **zacommitowany**. Właściciel potwierdził
commit w trakcie taska dla tego kroku, żeby zmiana zaakceptowanego kontraktu
`approval` była recenzowalna osobno.

```text
372c490 feat(contracts,database): bind an approval to the checkpoint it was granted at
f5b3b92 docs(workflow): make task closure leave a self-sufficient repository
0a47b73 docs(audits): pass RA-021 ...     <- bazowy commit RA-022
```

Następny krok po `WU-01` był **`WU-02`** — wykonany, zob. sekcję wyżej. Następny
krok teraz: **`WU-03`** (deterministyczny evaluator R0–R4 + kill-switch snapshot).

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
