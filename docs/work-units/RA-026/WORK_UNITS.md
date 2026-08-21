# RA-026 — Work units

## Metadata

- Task: `RA-026`
- Plan revision: `2`
- Rola: jedna rola wykonawcza (ADR-0007). Rewizja `1` była pisana pod ADR-0005 —
  **historyczna, nie obowiązuje**.
- Plan status: `DONE` — zależność `RA-025` domknięta `2026-08-22` (`AUDIT-01` `PASS`).
- Base commit: `8474d0a` (stan po domknięciu RA-025)
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) +
  `pnpm vitest run test/acceptance`

## Macierz kryteriów §13 — odtworzona z aktualnym stanem (`2026-08-22`)

Rewizja `1` zawierała zdjęcie z `2026-08-20`, gdy dziewięć z dziesięciu źródeł było
`BLOCKED_BY_DEPENDENCIES`. **Wszystkie 25 tasków RA-001..RA-025 są `DONE`.** Aktualne
mapowanie kryterium → dowód:

| # | Kryterium §13 | Dowód | Stan |
|---:|---|---|---|
| 1 | dwa Jira taski równolegle w izolowanych workspace | `test/golden-path` AC1/AC5 | **istnieje** |
| 2 | restart w każdej fazie nie traci checkpointu ani eventu | `test/golden-path` AC3, `packages/workspace-runner/test/recovery.integration` | **istnieje** |
| 3 | niejednoznaczny write nie jest automatycznie powtarzany | `test/golden-path` AC4, `packages/policy/test/executor.integration`, `test/infra/restore-drill` | **istnieje, trzy warstwy** |
| 4 | właściciel odpowiada na trwałe pytanie decyzyjne przez Discord | `test/golden-path` AC6, `packages/database/test/decision-resume.integration` | **istnieje** |
| 5 | branch, commity, evidence, review i MR powiązane z jednym case | `test/golden-path` (pełny przebieg) | **istnieje** |
| 6 | konta private i SonderMind nie przeciekają | `test/security/cross-account.test.ts` (20 testów, oba kierunki obu par) | **istnieje** |
| 7 | webhooki/watch odnawiane i uzgadniane | `packages/connector-jira/test/webhook-renewal`, `reconciliation` | **istnieje** |
| 8 | wszystkie R3/R4 mają policy evidence, approval i receipt | `packages/policy/test/executor.integration`, `approval.integration` | **CZĘŚCIOWO — zob. niżej** |
| 9 | backup/restore oraz kill switch sprawdzone ćwiczeniem | `test/security/kill-switch-drill` (13), `test/infra/restore-drill` (28) | **CZĘŚCIOWO — zob. niżej** |
| 10 | końcowy audyt bezpieczeństwa i niezawodności ma `PASS` | ten task | — |

**Dwa kryteria są częściowe, i to jest najważniejsze ustalenie tego planu.**
Nie zaliczam ich milcząco:

- **§13.8** — `PolicyEvaluation.evidence` jest **produkowane i porównywane**
  (`policyEvaluationsAgree`, więc TOCTOU jest zamknięte), ale **nie utrwalane** w
  `audit_log`. Po restarcie procesu nie istnieje w bazie dowód, na jakim snapshocie
  wykonano akcję. Zawężenie zakresu RA-024-WU-05, zapisane w `AUDIT-01` RA-024 §7.6.
  Osobno `CTF-014`: push brancha jest zapisem zewnętrznym **poza** `ACTION_REGISTRY`.
- **§13.9** — kill switch drill jest **wykonany** przeciwko realnemu executorowi.
  Restore drill jest wykonany dla części decydującej o duplikacie zapisu, przeciwko
  realnej bazie; **sam mechanizm PITR AWS nie był ćwiczony** i żadne wywołanie AWS nie
  miało miejsca (`AUDIT-01` RA-025 §7).

Zadaniem `WU-01` jest zamienić tę tabelę w **maszynowo sprawdzalny** artefakt, żeby
nie mogła cicho rozjechać się z rzeczywistością — tak jak w RA-024 z threat modelem.

## Stan rejestru przekrojowego przy starcie

AC2 wymaga braku otwartych **BLOCKER/HIGH/MEDIUM**. Stan:

```text
BLOCKER:  0
HIGH:     0        (CTF-006 zamknięty w RA-024)
MEDIUM:   0        (CTF-001, CTF-005 zamknięte; CTF-013 zamknięty w RA-024)
LOW:      CTF-002 (CZĘŚCIOWO), CTF-004 (CZĘŚCIOWO), CTF-009, CTF-010 (procesowy),
          CTF-011 (wzorzec), CTF-014, CTF-015
```

**AC2 jest spełnialne.** AC3 wymaga, by każdy otwarty LOW miał **ownera i decyzję**
`accept/fix/defer` — `CTF-014` i `CTF-015` mają, pozostałe pięć **nie** i to jest
zakres `WU-01`.

## Global boundaries

- In scope: końcowy, dowodowy odbiór względem Master Planu i decyzja go/no-go
  **bez ukrywania nierozwiązanych ryzyk**.
- Out of scope: rozszerzenia nieobecne w zaakceptowanym Master Planie. **Nie
  domykam `CTF-014` ani `evidence`→`audit_log`** — oba wymagają zmiany
  zaakceptowanego kontraktu, czyli ADR-a i osobnego taska.
- **`PASS` nie jest zgodą na produkcyjne uruchomienie** (AC6). Nie udzielam tej
  zgody sam i nie traktuję `PASS` jako jej udzielenia.
- Audyt ma **zakwestionować dowody**, nie zebrać je.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-026-WU-01` | `DONE` | macierz §13 jako maszynowo sprawdzalny artefakt + decyzje dla każdego LOW | — |
| `RA-026-WU-02` | `DONE` | acceptance suite: przekrojowe asercje na kryteriach §13 | WU-01 |
| `RA-026-WU-03` | `DONE` | release manifest (schema/model/prompt/tool/IaC/deps) | WU-01 |
| `RA-026-WU-04` | `DONE` | known limitations + operator/user docs | WU-02, WU-03 |

Cztery units, nie siedem jak w rewizji `1`. Powód: rewizja `1` planowała **wytworzyć**
acceptance suite, chaos scenarios, isolation suite i drille od zera. Wszystkie
istnieją i są zielone (`test/golden-path`, `test/security`, `test/infra`,
`packages/*/test`). Duplikowanie ich byłoby drugim, słabszym zestawem dowodów — a
zadaniem tego taska jest **kwestionować** dowody, nie mnożyć je.

Praca własna, **nie work unit**: niezależny final security/reliability audit,
przegląd wszystkich ADR-ów i handoffów, werdykt go/no-go.

## Mapowanie kryteriów akceptacji

- **AC1 (każde kryterium §13 ma niezależny dowód)** → `WU-01` + `WU-02`; macierz
  wskazuje **konkretny plik testowy**, a test weryfikuje, że plik istnieje i że
  nazwany przypadek w nim jest — dokument nie może się rozjechać.
- **AC2 (brak otwartych BLOCKER/HIGH/MEDIUM)** → `WU-01`; sprawdzane testem na
  rejestrze, nie odczytem.
- **AC3 (każdy LOW ma ownera i decyzję)** → `WU-01`; pięć wpisów wymaga decyzji.
- **AC4 (fresh operator wykona start/stop/restore/revoke)** → `WU-04`; weryfikacja
  „świeżym okiem" plus test, że runbook zawiera wykonywalną komendę dla każdej z
  czterech procedur.
- **AC5 (release manifest odtwarza wersję)** → `WU-03`; deterministyczny.
- **AC6 (production enablement to osobna decyzja)** → nie unit. Zapisuję jawnie w
  audycie, że `PASS` nie jest zgodą.

## Final task gate

Pełne repo (kilka przebiegów), `test/acceptance`, wszystkie bramki jakościowe,
`pnpm workflow:validate`, `git diff --check`, sonda type-level kolizji.
Potem **niezależny audyt kwestionujący dowody**: dla każdego kryterium §13 sprawdzam
nie „czy test istnieje", lecz **czy test dowodzi tego, co kryterium mówi**.

## Ustalenia po wykonaniu (`2026-08-22`)

Pełny zapis w `docs/handoffs/RA-026/HANDOFF-01.md`. Tu tylko to, co zmienia plan:

1. **Cztery units, nie siedem.** Acceptance suite, chaos scenarios i isolation suite
   już istnieją i są zielone; zbudowanie drugich byłoby drugim, słabszym zestawem
   dowodów. Praca poszła w **kwestionowanie** dowodów.
2. **Kwestionowanie znalazło trzy realne błędy w mojej własnej macierzy:** cytowana
   nazwa testu, której nie ma; trzy zbyt luźne podłańcuchy przechodzące na złym
   powodzie; §13.7 cytujące tylko Jirę, choć kryterium mówi „webhooki/watch".
3. **Rejestr findingów miał dwie wewnętrzne niespójności**, obie wykryte testem:
   `CTF-002` (`MEDIUM` w tabeli, `LOW` w treści) i `CTF-011` (status czytany przez
   parser jako zamknięty przy otwartym wzorcu).
4. **Dwa kryteria §13 są `PARTIAL`** i nie zaliczam ich milcząco: §13.8 (evidence nie
   utrwalane + `CTF-014`) i §13.9 (ścieżka restore AWS nie ćwiczona).
5. **`PASS` nie jest zgodą na produkcję.** Wyrażone w audycie **i** w
   `infra/cdk/src/config.ts` (`deployable: false`), oba sprawdzane testem.
