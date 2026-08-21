# RA-022 — HANDOFF-01

- Task: `RA-022` Policy, approvals and action executor
- Data: `2026-08-21`
- Bazowy commit: `0a47b734927e3660b88ff4174e168deaa9d6843d`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Co ten task dodał

Kompletna ścieżka od propozycji do zewnętrznego write'u, w której **żadna decyzja
autoryzacyjna nie pochodzi od modelu**:

```text
propose  →  policy (registry, server-owned tier)
         →  Discord approve/reject  (custom_id: approval_id + checkpoint_revision)
         →  re-policy  +  consume approval  +  read kill switch   [JEDNA transakcja]
         →  commit intent (EXECUTING)                             [commit PRZED side effektem]
         →  provider (dokładnie jeden call)
         →  receipt + SUCCEEDED  |  FAILED  |  AMBIGUOUS
         →  reconciliation (tylko READ providera)
```

### Nowe moduły

| Ścieżka | Rola |
|---|---|
| `packages/policy/src/policy-engine.ts` | czysty evaluator R0–R4, `ACTION_REGISTRY`, kill-switch snapshot |
| `packages/policy/src/approval-ingestion.ts` | klik Discorda → trwały grant albo odmowa |
| `packages/policy/src/action-executor.ts` | jedyny kod wykonujący external write + reconciliation |
| `packages/policy/src/ingestion-ports.ts` | strukturalne porty (obejście cyklu pakietów) |
| `packages/database/src/repositories/approval.ts` | `ApprovalRepository` — cztery fence'y w jednym `UPDATE` |
| `packages/database/src/repositories/external-action.ts` | `ExternalActionRepository` + `ReceiptRepository` |

### Nowe migracje

- `029` — `checkpoint_revision` + `owner_id` w `approvals`, fail-closed backfill.
- `030` — niezmienność granta (trigger, SQLSTATE `P0103`), zakaz `DELETE`, partial
  unique index „jeden live grant na kanoniczną akcję".
- `031` — `entity_version` + `entity_version_field` w `receipts` (AC7).

Wszystkie trzy odwracalne (`up → down → up`, oraz `down` do zera i z powrotem).

## Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test   183/183, exit 0
RA_REQUIRE_POSTGRES=1 pnpm vitest run    (całe repo)         1737/1737, 138 plików
                                                            CZTERY przebiegi, 0 Errors
pnpm turbo run typecheck --force                             36 successful, 0 cached
pnpm run build --force                                       26 successful, 0 cached
migracje 029/030/031                                         odwracalne
eslint + prettier (zmienione ścieżki)                        czysto
git diff --check                                             exit 0
```

**Kolejność jest obowiązkowa:** `pnpm run build --force` PRZED pełnym przebiegiem.
Pierwszy pełny przebieg w tym tasku był czerwony na `test/golden-path`, bo
guardrail `CTF-011` poprawnie odmówił weryfikacji na nieaktualnym `dist/` po
zmianie `packages/database/src`.

## Co następny task musi wiedzieć

### `RA-023` (AgentCore Gateway) — bezpośrednie wejście

1. **`CTF-001` jest nadal otwarty i należy do `RA-023-WU-00`.** RA-022 świadomie nie
   dotykał `credential-refresh.ts`. Sonda type-level w tej bramce potwierdziła
   kolizje `CredentialRefreshConflictError`, `CredentialRefreshIdentityError` oraz
   **nową, wcześniej nieodnotowaną** `RefreshIntentStatus` (database ↔ policy).
2. **Porty są strukturalne, nie importowane.** `packages/policy` **nie może** mieć
   `@remoteagent/database` w `dependencies` ani `devDependencies` — turbo przerywa
   `build` z `Cyclic dependency detected`. Jeżeli RA-023 potrzebuje tych typów,
   albo powtarza wzorzec `ingestion-ports.ts`, albo najpierw rozstrzyga cykl.
3. **Nazwy w `ingestion-ports.ts` mają prefiks `Policy*` celowo.** Bez niego
   kolidują z `packages/database`; to `CTF-002` w formie type-only, niewidocznej dla
   `typecheck`, `build` i skanu wartości.

### `RA-024` (hardening) — konkretne zobowiązania

1. **`CTF-006` nadal otwarty.** RA-022 nie polega na `SecretRedactor` w żadnym
   miejscu, więc nie dodał czwartej lokalnej tabeli wzorców. Kody odmowy są
   enumeracjami, nie interpolacją cudzych danych.
2. **`PolicyInput.now` jest zaufanym wejściem czystej funkcji.** Sonda `WU-03`
   pokazała, że backdated `now` zmienia wygasły credential w dozwoloną akcję.
   Domknięte w executorze (`ports.now(tx)` czyta `now()` bazy), ale **każdy nowy
   caller `evaluatePolicy` musi zrobić to samo** — inaczej luka wraca.
3. **Observability nie jest w zakresie RA-022.** `PolicyEvaluation.evidence` nosi
   już wszystko, czego potrzebuje audit log (tool, case, connection, event ids
   switchy), ale nikt jeszcze tego nie zapisuje do `audit_log`. To zakres RA-024.

### Rzeczy, które wyglądają jak defekt, a są decyzją

1. **`AMBIGUOUS` nie da się naiwnie ponowić** — re-propose identycznego payloadu
   daje `CONFLICT` na `action_digest` (UNIQUE z migracji 008). To odpowiedź na
   pytanie 7 z „Ustaleń z kodu": index **blokuje** blind retry, i to jest właściwe.
   Ścieżką wyjścia jest `reconcileAmbiguousAction`, nie nowa propozycja.
2. **Engine traktuje KAŻDY enabled switch w snapshotcie jako stop**, nie tylko
   dopasowany po zakresie. Zawężanie należy do `listEffective`. Wygląda zbyt
   restrykcyjnie; jest reakcją na finding sondy `WU-03` (akcja z niezgodnym
   providerem przechodziła obok stopu dla własnego connectiona).
3. **`killSwitchEventIds` są sortowane.** Bez tego przetasowanie listy dawało
   fałszywy mismatch AC3 i blokowało legalną egzekucję.
4. **Grant NIE jest konsumowany przez ingestion.** Konsumuje go executor, w
   transakcji z kill switchem. Ingestion tylko go tworzy i wiąże z akcją.

## Czyste drzewo

Wszystko zacommitowane. Brak zamierzonych plików niezacommitowanych.
