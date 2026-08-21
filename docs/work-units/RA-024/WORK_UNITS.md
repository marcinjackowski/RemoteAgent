# RA-024 — Work units

## Metadata

- Task: `RA-024`
- Plan revision: `2`
- Rola: jedna rola wykonawcza (ADR-0007). Rewizja `1` była pisana pod ADR-0005 i
  rozdział koordynator/implementer — **to jest historyczne i nie obowiązuje**.
- Plan status: `IN_PROGRESS` — wszystkie zależności `DONE` (RA-018, RA-019, RA-020,
  RA-021, RA-022, RA-023 domknięte `2026-08-21`).
- Base commit: `03b252a` (stan po domknięciu RA-023)
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/security packages/observability`

## Stan bazowy zmierzony przy starcie (`2026-08-21`)

Nie przepisane z rewizji `1` — uruchomione:

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run   -> 141 plików, 1793 testy, exit 0
pnpm run lint                            -> 3 errors, exit 1   (CTF-008 REPRODUKUJE)
node …/tsc.js -p tsconfig.json --noEmit  -> RangeError, exit 1  (CTF-013 REPRODUKUJE)
```

Oba czerwone gate'y są **preexistujące** i potwierdzone na czystym drzewie bazowym.
`RA-026` AC1/AC2 opiera dowodowość na zielonych bramkach repozytorialnych, więc oba
należą do zakresu tego taska (`WU-00`), nie do RA-026 — inaczej RA-026 zaczyna od
dwóch czerwonych bramek.

## Co zmieniło się od rewizji `1` (`2026-08-21`)

1. **`CTF-001` jest ZAMKNIĘTY** (RA-023-WU-00). Klasy `CredentialRefresh*Error` i
   `RefreshIntentStatus` mają jedną definicję w `packages/contracts`.
2. **`CTF-006` nadal OTWARTY i należy tutaj.** **Trzy** miejsca z własnym zestawem
   wzorców, nie dwa: `SecretRedactor` (`packages/observability`), `unsafeString`
   (`packages/repository-planner`) i `redactCommandOutput`
   (`packages/implementation-tools/src/command.ts`, RA-012-WU-05). Domknięcie
   obejmuje wszystkie trzy.
3. **Powstała powierzchnia, której rewizja `1` nie znała:** `packages/policy` ma
   policy engine, approval ingestion, action executor i containment zewnętrznego
   boundary (RA-022, RA-023). `PolicyEvaluation.evidence` niesie już wszystko,
   czego potrzebuje audit log, ale **nic tego nie zapisuje do `audit_log`** — to
   zakres `WU-05`.
4. **AgentCore NIE jest wdrażany**
   ([ADR-0008](../../decisions/ADR-0008-agentcore-gateway-verdicts.md)), więc nie ma
   nowej powierzchni AWS do hardeningu.
5. **`PolicyInput.now` musi pochodzić z zegara BAZY.** Sonda RA-022-WU-03
   dowiodła, że backdated `now` zamienia wygasły credential w dozwoloną akcję.
   Każdy nowy caller `evaluatePolicy` musi użyć `ports.now(tx)`.
6. **`packages/observability` ma tylko `redaction.ts` i `index.ts`** — traces,
   metryki i structured logs są do zbudowania. Dodana zależność
   `@opentelemetry/api` (tylko API, bez SDK: pakiet ma zostać bibliotekowy, a wybór
   exportera należy do RA-025).

## Global boundaries

- In scope: przekrojowe hardening przed wdrożeniem — threat model, prompt
  injection/exfiltration suite, least privilege, retention, telemetry, alerty,
  backpressure, SBOM i kill switch drill.
- Out of scope: docelowy AWS production deployment i disaster restore drill
  (RA-025). Wybór konkretnego exportera/backendu telemetrii — RA-025.
- **Audyt tego taska jest przekrojowy, nie tylko wobec jego kodu** (audit focus).
- Testy przekrojowe w `test/security/`, nie w pakiecie (wzór: `test/guardrails/`).

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-024-WU-00` | `DONE` | zielone bramki repozytorialne: `CTF-008` + `CTF-013` | — |
| `RA-024-WU-01` | `DONE` | jeden zestaw wzorców sekretów; `CTF-006` domknięty | WU-00 |
| `RA-024-WU-02` | `DONE` | threat model + trust-boundary diagramy (dokument) | — |
| `RA-024-WU-03` | `DONE` | prompt injection/exfiltration/redaction suite z kanarkami | WU-01, WU-02 |
| `RA-024-WU-04` | `DONE` | least privilege review wszystkich scopes (dokument + test) | WU-02 |
| `RA-024-WU-05` | `DONE` | OpenTelemetry traces event→case→run→tool→action→receipt + audit log policy | WU-01 |
| `RA-024-WU-06` | `DONE` | metryki, cztery klasy alertów, health/readiness | WU-05 |
| `RA-024-WU-07` | `DONE` | retention/export/delete/backup classification per data class | WU-05 |
| `RA-024-WU-08` | `DONE` | load/backpressure/rate-limit tests | WU-06 |
| `RA-024-WU-09` | `DONE` | kill switch drill + incident evidence preservation | WU-06 |
| `RA-024-WU-10` | `DONE` | dependency scanning + SBOM | WU-00 |

`WU-02` i `WU-04` mają jako rezultat dokument — legalne (`AGENTS.md`, zasada 12), ale
oba dostają też test wykonywalny, żeby dokument nie rozjechał się z kodem.

## Mapowanie kryteriów akceptacji

- **AC1 (threat model obejmuje każdą zewnętrzną granicę i data flow)** → `WU-02`;
  granice: Jira, GitLab, dwa Gmaile, dwa Calendary, Discord, Bedrock, MCP,
  workspace filesystem, PostgreSQL, artifacts. Test `WU-02` wymusza, że każdy
  `Provider` z kontraktów ma wpis w modelu — dokument nie może się cicho rozjechać.
- **AC2 (canary secrets/PII nie pojawiają się w logs, traces ani model context)** →
  `WU-01` + `WU-03` + `WU-05`; **trzy miejsca osobno**, nie jedno.
- **AC3 (cross-account/repo prompt injection ograniczone przez policy)** → `WU-03`.
- **AC4 (alerty: DLQ, renewal failure, stale lease, cost anomaly)** → `WU-06`.
- **AC5 (retention/delete nie niszczy minimalnych audit receipts bez reguły)** →
  `WU-07`; test, że po retencji receipt audytowy zostaje.
- **AC6 (kill switch zatrzymuje effects, zachowując odczyt i dowody)** → `WU-09`.
- **AC7 (kontrolowany backpressure zamiast przeciążenia providerów)** → `WU-08`.

## Units

### `RA-024-WU-00` — zielone bramki repozytorialne

Rezultat: `pnpm run lint` i root `tsc` zielone. Domyka `CTF-008` i `CTF-013`.
Allowed paths: `packages/bedrock-runtime/**`, `eslint.config.mjs`, `tsconfig.json`,
`package.json`.
Weryfikacja: `pnpm run lint` oraz `node node_modules/typescript/lib/tsc.js -p tsconfig.json --noEmit`.

### `RA-024-WU-01` — jeden zestaw wzorców sekretów (`CTF-006`)

Rezultat: `packages/observability/src/secret-patterns.ts` jako jedno źródło prawdy;
`SecretRedactor` maskuje, `unsafeString` odrzuca, `redactCommandOutput` deleguje.
Allowed paths: `packages/observability/**`, `packages/repository-planner/**`,
`packages/implementation-tools/**`.
Weryfikacja: `pnpm vitest run packages/observability packages/repository-planner packages/implementation-tools`.

### `RA-024-WU-02` — threat model

Rezultat: `docs/security/THREAT_MODEL.md` + maszynowo sprawdzalny rejestr granic w
`packages/observability/src/trust-boundaries.ts`.
Weryfikacja: `pnpm vitest run test/security/threat-model.test.ts`.

### `RA-024-WU-03` — suite adwersarialna

Rezultat: `test/security/` — prompt injection, exfiltration, cross-account,
cross-repo, kanarki w logach/traces/kontekście modelu.
Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/security`.

### `RA-024-WU-04` — least privilege

Rezultat: `docs/security/LEAST_PRIVILEGE.md` + rejestr scope'ów z testem, że żaden
scope nie jest szerszy niż użycie.
Weryfikacja: `pnpm vitest run test/security/least-privilege.test.ts`.

### `RA-024-WU-05` — traces i audit log

Rezultat: `packages/observability/src/tracing.ts` (correlation IDs, redakcja w
warstwie exportu) i zapis `PolicyEvaluation.evidence` do `audit_log`.
Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/observability packages/policy`.

### `RA-024-WU-06` — metryki, alerty, health

Rezultat: `packages/observability/src/metrics.ts`, `alerts.ts`, `health.ts`; cztery
jawne klasy alertu (DLQ, renewal failure, stale lease, cost anomaly).
Weryfikacja: `pnpm vitest run packages/observability`.

### `RA-024-WU-07` — retention

Rezultat: klasyfikacja per data class + reguła minimalnych audit receipts, migracja
jeżeli potrzebna.
Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database`.

### `RA-024-WU-08` — backpressure

Rezultat: `packages/observability/src/backpressure.ts` + test, że przeciążenie daje
kontrolowaną odmowę, nie zalanie providera.
Weryfikacja: `pnpm vitest run test/security/backpressure.test.ts`.

### `RA-024-WU-09` — kill switch drill

Rezultat: drill dowodzący, że switch zatrzymuje effects, zachowując odczyt i dowody.
Weryfikacja: `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/security/kill-switch-drill.test.ts`.

### `RA-024-WU-10` — SBOM

Rezultat: `scripts/security/sbom.ts` generujący SBOM z lockfile'a + audyt zależności.
Weryfikacja: `pnpm vitest run test/security/sbom.test.ts`.

## Final task gate

Pełna suite repozytorium (kilka przebiegów, bo `CTF-012` czyni jeden przebieg
nierozstrzygającym), `pnpm run lint`, root `tsc`, `turbo run typecheck --force`,
`pnpm run build --force`, sonda type-level kolizji eksportów (`CTF-002`),
`pnpm workflow:validate`, `git diff --check`. Potem audyt **przekrojowy**:
authorization, leakage, injection, retention, luki telemetrii, pętle kosztowe i
operacyjna możliwość zatrzymania. Skan kanarkowy obejmuje logi, traces i kontekst
modelu **osobno**.
