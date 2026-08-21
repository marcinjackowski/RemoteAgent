# RA-025 — Work units

## Metadata

- Task: `RA-025`
- Plan revision: `2`
- Rola: jedna rola wykonawcza (ADR-0007). Rewizja `1` była pisana pod ADR-0005 i
  rozdział koordynator/implementer — **to jest historyczne i nie obowiązuje**.
- Plan status: `DONE` — zależność `RA-024` domknięta `2026-08-21` (`AUDIT-01` `PASS`).
- Base commit: `d461958` (stan po domknięciu RA-024)
- Full-task verification: `pnpm vitest run infra` + `pnpm --filter @remoteagent/infra-cdk synth`

## Zmierzone przy starcie (`2026-08-21`)

Sprawdzone, nie założone:

```text
aws-cdk-lib@2.266.0 + constructs        zainstalowane, 5 pakietów
sonda synth BEZ credentiali AWS         24 zasoby, exit 0
  (AWS_PROFILE= AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY=)
```

**To jest kluczowe ustalenie dla całego taska:** `app.synth()` z jawnym `env`
(account + region) **nie potrzebuje** credentiali ani sieci, więc AC1 (determinizm
synth) i AC2 (IAM per component) są w pełni weryfikowalne na tej maszynie. Testy
asertują na **wygenerowanym CloudFormation template**, nie na wywołaniach AWS.

**Docker jest nadal zepsuty** (`AGENTS.md`), więc nic w tym tasku nie może zależeć od
budowania obrazów. Konsekwencja: compute jest modelowany jako ECS Fargate z
**referencją** do obrazu, a nie z `DockerImageAsset` — inaczej `synth` przestałby
działać na tej maszynie i AC1 stałoby się nieweryfikowalne.

## Co zmieniło się od rewizji `1`

1. **`CTF-013` i `CTF-008` ZAMKNIĘTE** (RA-024-WU-00), więc `pnpm run lint`, root
   `tsc` i `typecheck --force` są zielone i mogą być bramką tego taska.
2. **`CTF-012` ZAMKNIĘTY** — bramka „całe repo zielone" jest stabilna (155 plików,
   2164 testy, trzy przebiegi).
3. **Powstała powierzchnia telemetrii, której rewizja `1` nie znała:**
   `packages/observability` ma `tracing.ts`, `metrics.ts`, `alerts.ts`, `health.ts`,
   `backpressure.ts`. RA-025 **konsumuje** to (progi, eksporter, alarmy), nie buduje
   drugiego zestawu. Cztery klasy alertu AC4 z RA-024 muszą mieć odpowiednik jako
   CloudWatch alarm.
4. **Migracja `032` wprowadziła `ra.retention_purge` i `SECURITY DEFINER`.** Jeżeli
   ten task tworzy role bazodanowe, `ra_retention_purge_raw_payload` musi pozostać
   jedyną ścieżką retencji — test w `test/security/retention.test.ts` asertuje wobec
   `pg_proc`, że są dokładnie dwie funkcje `ra_retention%`.
5. **`liveness` NIE MOŻE zależeć od PostgreSQL-a** (RA-024, test strukturalny). ECS
   health check musi używać liveness, a target group health — readiness. Pomylenie
   ich zapętli restart każdego workera przy awarii bazy.
6. **SBOM istnieje** (`scripts/security/sbom.ts`), a dependency/container/IaC
   **scanning** został jawnie przekazany do tego taska (`AUDIT-01` RA-024 §7).

## Global boundaries

- In scope: powtarzalne, least-privilege środowiska AWS (CDK) oraz **udowodniony**
  backup, restore, rollback i bezpieczne wznowienie pracy.
- Out of scope: automatyczne wdrożenie do produkcji bez zgody właściciela.
- **`real deploy` wyłącznie do jawnie autoryzowanego konta/środowiska.** Nie
  autoryzuję tego sam; sandbox smoke test dopiero po jawnej zgodzie właściciela.
- **Po restore żaden ambiguous write nie może być automatycznie powtórzony** (AC5).
- **Brak Dockera musi być jawnie odnotowany**, jeśli blokuje weryfikację — nie
  pomijany milczeniem.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-025-WU-01` | `DONE` | environments/naming/tagging + IaC state protection | — |
| `RA-025-WU-02` | `DONE` | network stack (VPC, egress, endpoints) | WU-01 |
| `RA-025-WU-03` | `DONE` | data stack: PostgreSQL PITR, S3 lifecycle, KMS/Secrets | WU-02 |
| `RA-025-WU-04` | `DONE` | queues/DLQ + Bedrock access + observability alarmy | WU-02 |
| `RA-025-WU-05` | `DONE` | compute: worker/Discord + action executor isolation | WU-03, WU-04 |
| `RA-025-WU-06` | `DONE` | webhook ingress na skalowalnym HTTP boundary | WU-02, WU-03 |
| `RA-025-WU-07` | `DONE` | IAM per component + policy checks w synth (AC1, AC2) | WU-03..WU-06 |
| `RA-025-WU-08` | `DONE` | migracje jako kontrolowany deployment step + rollback safety | WU-03 |
| `RA-025-WU-09` | `DONE` | restore drill + reconciliation + brak blind replay (AC4, AC5) | WU-08 |
| `RA-025-WU-10` | `DONE` | recovery order + runbook + dependency scanning (AC3, AC7) | WU-09 |

## Mapowanie kryteriów akceptacji

- **AC1 (synth/diff deterministyczny, przechodzi security policy checks)** → `WU-07`;
  determinizm oznacza **brak** zależności od czasu, losowości i środowiska.
  Weryfikowane przez dwukrotny synth i porównanie bajt-w-bajt.
- **AC2 (IAM per component, bez szerokich wildcardów bez ADR)** → `WU-07`; każdy
  wildcard to czerwony test, nie komentarz.
- **AC3 (fresh environment z repo i udokumentowanych prerequisites)** → `WU-10`.
- **AC4 (restore odtwarza cases/checkpoints/audit i uzgadnia jobs)** → `WU-09`; drill
  przeciwko realnemu PostgreSQL-owi, nie deklaracja.
- **AC5 (po restore żaden ambiguous write nie jest powtórzony)** → `WU-09`;
  **kluczowe** — restore jest najniebezpieczniejszym momentem dla blind replay.
- **AC6 (rollback nie cofa destrukcyjnie danych/migracji)** → `WU-08`; jawna zasada,
  że rollback aplikacji **nie** uruchamia `migrateDown`, plus test tej zasady.
- **AC7 (Discord, watches/webhooks, secrets mają udokumentowany recovery order)** →
  `WU-10`.

## Final task gate

Synth (dwukrotny, porównanie bajt-w-bajt), testy `infra`, policy checks, całe repo bez
regresji (kilka przebiegów), `pnpm run lint`, root `tsc`, `typecheck --force`,
`build --force`, `pnpm workflow:validate`, `git diff --check`. Brak Dockera odnotowany
jawnie tam, gdzie ma znaczenie. **Żadnego deploymentu.**

## Ustalenia po wykonaniu (`2026-08-22`)

Pełny zapis w `docs/handoffs/RA-025/HANDOFF-01.md`. Tu tylko to, co zmienia plan:

1. **Sonda „synth bez credentiali" była pierwszą rzeczą uruchomioną** i
   zdeterminowała projekt: żadnego `DockerImageAsset`, obrazy przez tag. Bez tego
   AC1/AC2 byłyby nieweryfikowalne na tej maszynie.
2. **Cztery cykle cross-stack**, dwie „oczywiste" naprawy przesunęły cykl. W CDK
   `grant*` jest dwustronny.
3. **`exactOptionalPropertyTypes` wyłączony dla `infra/cdk`** — niekompatybilność
   `aws-cdk-lib`, nie nasz błąd. Uzasadnienie w tsconfigu.
4. **Dwa nowe findingi, oba zamknięte tutaj:** `CTF-016` (`hookTimeout`),
   `CTF-017` (`process-runner`). Plus defekt `DeletionPolicy` sekretu bazy, znaleziony
   własnymi policy checkami.
5. **Trzy elementy zakresu niewykonane, z uzasadnieniami** (`AUDIT-01` §7):
   container scanning (Docker), region failure simulation (poziom runbooka), realny
   deploy (zgoda właściciela).
