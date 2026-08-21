# RA-024 — Work units

## Metadata

- Task: `RA-024`
- Plan revision: `1`
- Rola: jedna rola wykonawcza (ADR-0007). Nagłówek rewizji `1` wskazywał ADR-0005
  i rozdział koordynator/implementer — **to jest historyczne i nie obowiązuje**.
- Plan status: `DRAFT`, ale task jest **`READY`** — wszystkie zależności `DONE`
  (RA-018, RA-019, RA-020, RA-021, RA-022, RA-023 domknięte `2026-08-21`).
  Plan wymaga rewizji przy starcie: powstał `2026-08-20`, przed RA-021/022/023.
- Base commit/tree: do zapisania przy starcie

## Co zmieniło się od napisania tego planu (`2026-08-21`)

Przeczytaj to przed rewizją planu — trzy ustalenia są nieaktualne:

1. **`CTF-001` jest ZAMKNIĘTY** (RA-023-WU-00). Klasy `CredentialRefresh*Error` i
   `RefreshIntentStatus` mają jedną definicję w `packages/contracts`. Jeżeli
   którykolwiek unit zakłada duplikat — jest nieaktualny.
2. **`CTF-006` nadal OTWARTY i nadal należy tutaj.** Doszło **trzecie** miejsce z
   własnym zestawem wzorców: `redactCommandOutput` w
   `packages/implementation-tools/src/command.ts` (RA-012-WU-05). Zakres domknięcia
   obejmuje zwinięcie wszystkich trzech, nie dwóch.
3. **Powstała powierzchnia, której ten plan nie zna:** `packages/policy` ma teraz
   policy engine, approval ingestion, action executor i containment zewnętrznego
   boundary (RA-022, RA-023). `PolicyEvaluation.evidence` niesie już wszystko,
   czego potrzebuje audit log (tool, case, connection, id-ki eventów kill switcha),
   ale **nic tego nie zapisuje do `audit_log`** — to zakres RA-024.
4. **AgentCore NIE jest wdrażany** ([ADR-0008](../../decisions/ADR-0008-agentcore-gateway-verdicts.md)),
   więc nie ma nowej powierzchni AWS do hardeningu. Jeżeli plan zakładał inaczej —
   ten fragment jest bezprzedmiotowy.
5. **`PolicyInput.now` musi pochodzić z zegara BAZY.** Sonda RA-022-WU-03
   dowiodła, że backdated `now` zamienia wygasły credential w dozwoloną akcję.
   Każdy nowy caller `evaluatePolicy` musi użyć `ports.now(tx)`.
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/security`

## Global boundaries

- In scope: przekrojowe hardening przed wdrożeniem — threat model, prompt
  injection/exfiltration suite, least privilege, retention, telemetry, alerty,
  backpressure, SBOM i kill switch drill.
- Out of scope: docelowy AWS production deployment i disaster restore drill
  (RA-025).
- **Audyt tego taska jest przekrojowy, nie tylko wobec jego kodu** (audit focus).

## Ustalenia przed planowaniem (2026-08-20)

1. **`SecretRedactor` istnieje** (`packages/observability/src/redaction.ts`) i jest
   już używany w kilku miejscach. Suite kanarkowa RA-024 ma weryfikować **całą
   pipeline telemetrii** przez ten mechanizm, nie tworzyć drugiego.
   **Ale jest niekompletny — zob. `CTF-006`.** Sonda koordynatora
   (`2026-08-20`) wykazała, że przepuszcza absolutne host paths, `glpat-`, `AKIA`,
   klucze prywatne i JWT, podczas gdy prywatna funkcja `unsafeString` w
   `packages/repository-planner/src/profile.ts` **ma** wszystkie te wzorce.
   RA-024 jest właścicielem domknięcia tego findingu: ujednolicić zestaw wzorców w
   jednym miejscu (naturalnie `packages/observability`), zachowując różnicę
   polityki — `unsafeString` odrzuca wartość, `SecretRedactor` ją maskuje.
   **Bez tego AC2 przeszłoby na niekompletnym mechanizmie**, co jest gorsze niż
   brak redakcji, bo daje fałszywą pewność. Uwaga: `repository-planner` jest
   `DONE`, więc zmiana jego kodu wymaga pełnego cyklu audytowego.
2. **Wzorce kanarków już istnieją w testach:** `runtime.integration.test.ts` (RA-016)
   ma `expectRedacted` sprawdzający listę markerów (`Bearer …`, payload ref, sekret
   webhooka); fixtures e2e zawierają celowe kanarki injection (`@everyone`, `<@…>`,
   zero-width space jako escape). RA-024 rozszerza to na cały system.
3. **`packages/observability` ma tylko `redaction.ts` i `index.ts`** — OpenTelemetry
   traces, metryki i structured logs są do zbudowania.
4. **Rejestr `CROSS_TASK_FINDINGS.md` jest wejściem tego taska.** RA-024 jest
   naturalnym miejscem domknięcia `CTF-004` (typecheck dla `test/**`) i
   ewentualnie `CTF-003` (flake `process-runner`), bo oba dotyczą jakości bramek w
   całym repozytorium.
5. **Testy w `test/security/`**, nie w pakiecie — suite jest przekrojowa, a katalog
   `test/**` jest już objęty `vitest.config.ts` (wzór: `test/guardrails/`).

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-024-WU-01` | `DRAFT` | threat model + trust-boundary diagrams (dokument) | RA-023 DONE |
| `RA-024-WU-02` | `DRAFT` | prompt injection/exfiltration/redaction suite z kanarkami | WU-01 |
| `RA-024-WU-03` | `DRAFT` | least privilege review wszystkich scopes (dokument + testy) | WU-01 |
| `RA-024-WU-04` | `DRAFT` | retention/export/delete/backup classification per data class | WU-01 |
| `RA-024-WU-05` | `DRAFT` | OpenTelemetry traces event→case→run→tool→action→receipt | WU-01 |
| `RA-024-WU-06` | `DRAFT` | metryki, alerty, health/readiness, dashboards | WU-05 |
| `RA-024-WU-07` | `DRAFT` | load/backpressure/rate-limit tests | WU-06 |
| `RA-024-WU-08` | `DRAFT` | dependency/container/IaC scanning + SBOM | WU-01 |
| `RA-024-WU-09` | `DRAFT` | kill switch drill + incident evidence preservation | WU-06 |

`WU-01` i `WU-03` mają jako rezultat dokument — to legalne, bo pojedynczy work unit
może jawnie wskazać plik dokumentacji jako swój rezultat (`AGENTS.md`, zasada 12).

## Wymagania do rozdzielenia na units

- **AC1 (threat model obejmuje każdą zewnętrzną granicę i data flow)** → `WU-01`;
  granice do pokrycia: Jira, GitLab, dwa Gmaile, dwa Calendary, Discord, Bedrock,
  MCP/Gateway, workspace filesystem, PostgreSQL, S3/artifacts.
- **AC2 (canary secrets/PII nie pojawiają się w logs, traces ani model context)** →
  `WU-02` + `WU-05`; **trzy miejsca, nie jedno** — logi, traces i kontekst modelu.
- **AC3 (cross-account/repo prompt injection ograniczone przez policy)** → `WU-02`;
  test adwersarialny w obu kierunkach dla obu par kont.
- **AC4 (alerty: DLQ, renewal failure, stale lease, cost anomaly)** → `WU-06`;
  cztery jawne klasy alertu.
- **AC5 (retention/delete nie niszczy minimalnych audit receipts bez reguły)** →
  `WU-04`; test, że po retencji receipt audytowy zostaje.
- **AC6 (kill switch zatrzymuje effects, zachowując odczyt i dowody)** → `WU-09`;
  drill, nie deklaracja.
- **AC7 (kontrolowany backpressure zamiast przeciążenia providerów)** → `WU-07`.

## Final task gate

Koordynator uruchamia suite bezpieczeństwa, całe repo bez regresji, wszystkie
bramki jakościowe, `pnpm workflow:validate`, `git diff --check`, oraz — zgodnie z
audit focus — przeprowadza audyt **przekrojowy**: authorization, leakage, injection,
retention, luki telemetrii, pętle kosztowe i operacyjną możliwość zatrzymania
systemu. Skan kanarkowy musi objąć logi, traces i kontekst modelu osobno.
Następnie handoff i niezależny audyt.
