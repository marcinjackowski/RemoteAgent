# RA-022 — AUDIT-01

- Task: `RA-022` Policy, approvals and action executor
- Data: `2026-08-21`
- Bazowy commit: `0a47b734927e3660b88ff4174e168deaa9d6843d`
- Audytowane commity: `372c490`, `7ddd743`, `2c05ca3` + praca `WU-03`…`WU-06`
- Rola: jedna rola wykonawcza (ADR-0007) — ta sesja planowała, implementowała i
  weryfikowała

Werdykt jest w §9. `workflow:validate` odrzuca dokument z dwiema liniami werdyktu,
więc nie ma go w nagłówku.

## 1. Bramka — uruchomiona, nie zapowiedziana

Pełna bramka taska, uruchomiona przeze mnie po ostatnim unicie:

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test
  → 183/183, 6 plików, exit 0

RA_REQUIRE_POSTGRES=1 pnpm vitest run          (całe repo)
  → 1737/1737, 138 plików, exit 0
  → CZTERY przebiegi z rzędu, zero `Errors` w każdym

pnpm turbo run typecheck --force  → 36 successful, 0 cached, exit 0
pnpm run build --force            → 26 successful, 0 cached, exit 0
```

Cztery przebiegi całego repo, bo `CTF-012` wymaga podania liczby przebiegów, nie
wyniku jednego. Zero faili, zero `Errors` — flake z `CTF-012` nie wystąpił ani raz.

`--force` w obu bramkach kompilacyjnych, bo `turbo` raportuje sukces z cache bez
uruchomienia czegokolwiek (`0 cached` potwierdza, że nie było cache'a).

Odwracalność migracji, uruchomiona na osobnej bazie:

```text
up (31 migracji) → down do 29 → up → down do 0 → up
  triggery `approvals_immutable_grant`/`approvals_no_delete`: 2 → 0 → 2
  index `approvals_one_live_grant_per_action_idx`:            1 → 0 → 1
  kolumny `receipts.entity_version*`:                         2 → 0 → 2
  REVERSIBILITY OK
```

Lint i format na zmienionych ścieżkach: czysto. `git diff --check`: exit `0`.

## 2. Kryteria akceptacji — każde osobno

### AC1 — zmiana jednego parametru po approval unieważnia zgodę → **spełnione**

Trzy niezależne mechanizmy, nie jeden:

1. Kontrakt `externalAction` **przelicza** `canonicalDigest(canonical_payload)` i
   fail-closed przy niezgodności (istniejący kod, RA-003).
2. `ApprovalRepository.consume` fencuje na `action_digest` w tym samym `UPDATE`,
   więc grant nie autoryzuje innego payloadu (`DIGEST_MISMATCH`).
3. Migracja `030` zamraża `action_digest` granta — bez tego jeden `UPDATE`
   przekierowywał zgodę z payloadu A na B (finding sondy `WU-02`, patrz §4).

Dowód: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test -t "digest"` →
6 passed. Mutacja tautologizująca fence digestu → 1 czerwony.

### AC2 — approval jednorazowe, owner-scoped, odrzuca stale revision → **spełnione**

Cztery fence'y w JEDNYM `UPDATE` (`consumed = false`, `owner_id`, `action_digest`,
`checkpoint_revision`) + `expires_at > now()` na zegarze bazy. Nie „sprawdź i
ustaw": test racingu dwóch konsumentów daje dokładnie jedno `CONSUMED`.

Owner scope pochodzi z **case'a**, nie od aktora — mutacja `owner_id → granted_by`
przeżyła pierwszy przebieg i wymusiła test z delegatem (patrz §5).

Stale revision: migracja `029` + fence, plus supersession check na append-only
`case_checkpoints`, bo cofnięcie licznika `cases.checkpoint_revision` wskrzeszało
grant już odrzucony.

Dowód: `-t "stale"` → 9 passed, `-t "owner"` → 13 passed.

### AC3 — policy sprawdzana przy proposal i bezpośrednio przed execute → **spełnione**

`evaluatePolicy` jest czysta, więc daje się przeliczyć identycznie na granicy
egzekucji. Executor porównuje obie ewaluacje `policyEvaluationsAgree`, które
porównuje `decision`, `riskTier`, `refusalCode` **i** evidence (tool, case,
connection, event ids switchy, `killSwitchActive`) — nie samą decyzję, bo switch
włączony i wyłączony daje tę samą decyzję z innego stanu.

`reason` celowo NIE jest porównywany: to proza audytowa, a jej porównywanie
zmieniłoby edycję komunikatu w zmianę policy.

Dowód: testy „detects a policy change between proposal and execute", „detects a
CHANGED kill-switch snapshot even when the decision is unchanged", „detects a
retiered action even when the decision is unchanged". Mutacja redukująca
porównanie do `decision` → czerwony (po naprawie testu, §5).

### AC4 — niepotwierdzony timeout daje `AMBIGUOUS` + reconciliation → **spełnione**

`UNCONFIRMED` → `AMBIGUOUS` bez receiptu. Adapter, który **rzucił**, też daje
`AMBIGUOUS`, nie `FAILED` — bo `FAILED` licencjonuje retry. Druga próba egzekucji
akcji `AMBIGUOUS` nie dociera do providera (`NOT_EXECUTABLE`, `calls.length === 0`).

`reconcileAmbiguousAction` tylko **czyta** providera i wymaga
`matchedIdempotencyKey` zgodnego z akcją; nieudany lookup zostawia `AMBIGUOUS`,
bo „nie mogłem sprawdzić" nie jest dowodem nieobecności.

Dowód: `-t "AMBIGUOUS"` → 14 passed.

### AC5 — R4 nie może być auto-approved przez model ani annotację → **spełnione**

Cztery warstwy: CHECK migracji `008` (niereprezentowalne w SQL), guard tranzycji
kontraktu, `APPROVAL_REQUIRED_TIERS` w evaluatorze, oraz
`assertR4NeverAutoAllowed` jako druga, niezależna asercja. Annotacja obniżająca
tier to **REFUSAL** (`TIER_DOWNGRADE_ATTEMPT`), nie „zignoruj".

Sonda `WU-03` PROBE 7 przeczesała iloczyn kartezjański wejść (5 narzędzi R4 × 4
health × 10 annotacji × 3 zestawy switchy × 3 zakresy) i policzyła
`AUTO_ALLOW = 0`. Registry jest `Object.freeze`d, więc nie da się obniżyć tieru w
runtime; nazwa z prototypu (`constructor`, `__proto__`) nie rozwiązuje się na tier.

Dowód: `-t "R4"` → 7 passed.

### AC6 — kill switch działa pomiędzy approval a execute → **spełnione**

`KillSwitchRepository.listEffective` czytane w **tej samej** transakcji, która
konsumuje approval. Test: grant → operator włącza switch → egzekucja odmawia
`KILL_SWITCH_ACTIVE`, provider **nie jest wołany**, a grant zostaje
**NIEZUŻYTY** — operatorski stop nie niszczy zgody właściciela.

Dowód: `-t "kill switch"` → 16 passed. Mutacja usuwająca pre-check → 6 czerwonych.

### AC7 — receipt wiąże action, provider result i external entity version → **spełnione**

Migracja `031` dodaje `entity_version` + `entity_version_field` z CHECK-iem „oba
albo żaden, oba niepuste". `ProviderReceipt` wymaga ich **nieopcjonalnie**, bo
`external_id` sam nie odpowiada na „czy mój write wszedł?" — Jira issue zachowuje
klucz przez edycje, event Calendara zachowuje id.

Receipt jest append-only (`ra_deny_mutation`, SQLSTATE `P0100` potwierdzony w
teście) i jeden na akcję.

Dowód: `-t "receipt"` → 8 passed.

## 3. Audit focus taska

- **Fail-closed semantics** — każda odmowa ma własny kod, nie klasę wyniku.
  Nieznane narzędzie → R4 + `UNKNOWN_ACTION`. Pusty `caseConnectionIds` → odmowa,
  nie zgoda (wzorzec `declaredPaths` z RA-014).
- **TOCTOU approval/execute** — domknięte trzema rzeczami: `FOR SHARE` na case
  przed odczytem rewizji, jedna transakcja dla switcha + consumption, oraz
  porównanie dwóch ewaluacji. Test „makes a concurrent checkpoint append WAIT"
  dowodzi locka przez jego **obserwowalny skutek**, nie przez `pg_locks`.
- **Canonicalization** — digest liczony z kanonicznego payloadu; zmiana kolejności
  kluczy nie unieważnia legalnej zgody (test w `WU-01`).
- **Replay** — `approval_id` użyty dla innego granta → `ApprovalIdentityError`;
  drugi live grant na tę samą akcję → `LIVE_GRANT_EXISTS` + partial unique index;
  re-propose identycznego payloadu → `CONFLICT` na `action_digest`.
- **Brak autoryzacji opartej na deklaracji modelu** — nie istnieje wejście, przez
  które model podałby tier, decyzję, ownera albo digest. Wszystkie pochodzą z
  registry albo z trwałego wiersza.

## 4. Findingi sond adwersarialnych — 7, wszystkie naprawione w tasku

Sonda per unit; **każda dała finding, którego zielone testy nie dawały**. To ósmy
task z rzędu z tym wynikiem.

| Unit | Finding | Severity | Naprawa |
|---|---|---|---|
| `WU-02` | `UPDATE approvals SET action_digest` przekierowywał zgodę z payloadu A na B — **AC1 odwrócone** | BLOCKER | trigger migracji `030` |
| `WU-02` | `UPDATE approvals SET consumed = false` czynił grant ponownie użytecznym | HIGH | reguła jednokierunkowa `030` |
| `WU-02` | dwa `approval_id` na jeden digest = dwa wydania zgody | MEDIUM | partial unique index |
| `WU-02` | cofnięcie `cases.checkpoint_revision` wskrzeszało grant odrzucony jako stale | MEDIUM | supersession vs append-only `case_checkpoints` |
| `WU-03` | CONNECTION kill switch pomijany przy niezgodnym providerze | HIGH | każdy enabled switch = stop |
| `WU-04` | TTL `1e15` ms → grant ważny **31 709 lat** | HIGH | bounded TTL + `isFinite` |
| `WU-05` | nieudany zapis receiptu zostawiał `EXECUTING` — stan, którego **nic nie rozwiązuje** | HIGH | `AMBIGUOUS` w nowej transakcji |
| `WU-05` | reconciliation przyjmowała receipt dowolnego obiektu | HIGH | `matchedIdempotencyKey` |

Wszystkie zweryfikowane ponownym uruchomieniem sondy po naprawie i pokryte
testami regresyjnymi w suicie, nie tylko naprawione.

## 5. Mutation check — 58 mutacji, 9 przeżyło pierwszy przebieg

Mutacja per mechanizm bezpieczeństwa, zgodnie z `AGENTS.md`. Wynik istotny nie
liczbą, a tym, **co przeżyło**:

| Przeżyła | Dlaczego | Co wymusiła |
|---|---|---|
| `owner_id` → `granted_by` (`WU-02`) | fixture'y miały aktor == owner | test z delegatem — `CTF-010` w moim teście, **drugi raz w tym tasku** |
| `FOR SHARE` usunięty | brak testu locka | test „append musi CZEKAĆ" |
| unique index usunięty | pre-check w `grant` odpowiadał pierwszy | test uderzający w index bezpośrednio |
| reguła un-consume wyłączona | reguła 3 (`consumed_at`) łapała pierwsza | asercja na **treści** reguły, nie na SQLSTATE |
| `agreement` tylko `decision` | test zmieniał dwa pola naraz | wariant zmieniający **wyłącznie** `riskTier` |
| `attachApproval` bez fence'a | caller sprawdza status wcześniej | test wchodzący w fence bezpośrednio |
| `reject` bez fence'a | jak wyżej | jak wyżej |
| fence statusu `EXECUTING` | single-use approvalu łapał race | test na **AUTO_ALLOW**, gdzie approvalu nie ma |
| kolejność receipt/status | w jednej transakcji nieobserwowalna | **skorygowany komentarz** — kod był OK, opis kłamał |

Wzorzec wart zapamiętania: mutacja przeżywa najczęściej tam, gdzie warstwa wyżej
sprawdza to samo wcześniej. Wtedy dowodem jest cudzy `if`, nie testowany fence.

Dodatkowo mutation check ujawnił **flake w moim własnym teście** wygaśnięcia
(`expires_at = granted_at + 1ms`): czerwieniał pod dwiema mutacjami niezwiązanymi
z wygaśnięciem, bo `now()` to instant startu transakcji. Test mierzył scheduling,
nie mechanizm.

## 6. Trwałość i współbieżność

- **Granice transakcji.** Executor otwiera **dwie**, side effect strictly pomiędzy.
  Jedna transakcja przez cały call providera przypięłaby połączenie na czas jego
  latencji — wolny provider stałby się awarią bazy. Test „does not hold a
  transaction open across the provider call" tego pilnuje.
- **Crash przed/po.** Intent (`EXECUTING`) commitowany **przed** side effektem, więc
  crash w trakcie zostawia stan „mogło się stać" → `AMBIGUOUS` → reconciliation.
  Test czyta akcję z **osobnego połączenia** w trakcie calla i widzi `EXECUTING`,
  co dowodzi commitu przed wywołaniem.
- **Retry nie powtarza side effectu.** `AMBIGUOUS` nie jest wykonywalny;
  `idempotency_key` jest UNIQUE; digest jest UNIQUE.
- **Jeden writer.** Compare-and-set na statusie elektuje jednego wykonawcę: dwa
  równoległe `executeAction` dają jedno `SUCCEEDED` i **jeden** call providera.

## 7. Security i privacy

- Owner, connection, tier i digest ustalane **poza modelem**: registry albo trwały
  wiersz. `owner_id` derywowany z case'a w tym samym `INSERT`, plus composite FK
  czyniący niezgodną parę niereprezentowalną.
- Zewnętrzne treści: adapter dostaje payload z wiersza; sonda potwierdziła, że
  mutacja obiektu przez adapter nie zmienia stanu w bazie.
- Sekrety: żaden test fixture ani komunikat błędu nie zawiera credentiala. Kody
  odmowy są enumeracjami, nie interpolacją cudzych danych.
- `WRONG_OWNER` nie zwraca wiersza — próba przez granicę własności nie poznaje
  treści granta.
- **Żaden live external write.** Cała suita `WU-05` przeciwko fake providerowi
  in-process.

## 8. Findingi tego audytu

**Brak findingów BLOCKER, HIGH i MEDIUM.** Wszystkie siedem findingów sond zostało
naprawionych w trakcie taska i pokrytych regresją, zgodnie z `AGENTS.md` §4
(finding naprawiaj od razu, opisz w commit message).

Jeden finding przekrojowy dopisany do rejestru: `CTF-002` zyskał dowód, że sonda
**wartościowa nie wystarcza** — cztery kolizje type-only, które sam wprowadziłem w
`ingestion-ports.ts`, były niewidoczne dla `typecheck`, `build` i `Object.keys`, a
wykryła je tylko sonda `ts.Program`. Naprawione prefiksem `Policy*`. Osobno
odnotowany nowy, preexistujący `RefreshIntentStatus` (database/policy).

## 9. Werdykt

Wszystkie siedem kryteriów akceptacji spełnione i zweryfikowane osobno. Bramka
uruchomiona: pakiet `183/183`, całe repo `1737/1737` w czterech przebiegach,
`typecheck`/`build` z `--force` bez cache'a, migracje odwracalne. Mutation check
per mechanizm, sonda adwersarialna per unit. Brak otwartych findingów
BLOCKER/HIGH/MEDIUM.

- Werdykt: `PASS`
