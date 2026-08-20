# RA-025 — Work units

## Metadata

- Task: `RA-025`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES` (RA-024 niedokończony).
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `pnpm --filter <cdk package> test` + CDK synth/diff;
  dokładna komenda do ustalenia przy starcie

## Global boundaries

- In scope: powtarzalne, least-privilege środowiska AWS (CDK) oraz **udowodniony**
  backup, restore, rollback i bezpieczne wznowienie pracy.
- Out of scope: automatyczne wdrożenie do produkcji bez zgody właściciela.
- **`real deploy` wyłącznie do jawnie autoryzowanego konta/środowiska.** Koordynator
  nie autoryzuje tego sam; sandbox smoke test dopiero po jawnej zgodzie właściciela.
- **Po restore żaden ambiguous write nie może być automatycznie powtórzony** (AC5) —
  ta sama zasada, która obowiązuje w RA-012, RA-017, RA-021 i RA-022.

## Ustalenia przed planowaniem (2026-08-20)

1. **`infra/cdk` istnieje jako szkielet** — `package.json`, `tsconfig.json` i
   `src/index.ts`. Stacki do napisania. `pnpm-workspace.yaml` obejmuje `infra/*`, a
   `eslint.config.mjs` ma element type `infra` z regułą `infra → package`.
2. **`docker-compose.yml` istnieje** (lokalny PostgreSQL na porcie 5433, zgodnie z
   ADR-0002 — credentiale w nim to jawnie nie-sekretne wartości lokalne). Nie jest
   to wzór dla produkcji, ale definiuje lokalny kontrakt portu i bazy.
3. **Docker jest niedostępny w tym środowisku** (odnotowane w handoffie
   transferowym). Testy wymagające budowania obrazów muszą to jawnie uwzględnić albo
   zostać oznaczone jako wymagające innego środowiska — nie udawać, że przeszły.
4. **Migracje są już kontrolowanym mechanizmem:** `packages/database/src/migrate.ts`
   z `migrateUp`/`migrateDown`, advisory lockiem migratora i wykrywaniem checksum
   drift. AC6 (rollback nie cofa destrukcyjnie danych/migracji) buduje na tym —
   trzeba jawnie rozstrzygnąć, że rollback aplikacji **nie** uruchamia
   `migrateDown` automatycznie.
5. **AC4 wymaga, by restore „bezpiecznie uzgadniał jobs".** Reconciliation po
   restore musi używać istniejących mechanizmów (outbox, leases, watermarks), nie
   nowego. Kolejność recovery (AC7) obejmuje Discord, watches/webhooks i secrets —
   każdy z nich ma już własny renewal/reconciliation z RA-006/RA-016/RA-019/RA-020.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-025-WU-01` | `DRAFT` | CDK: network + KMS/Secrets + IaC state protection | RA-024 DONE |
| `RA-025-WU-02` | `DRAFT` | CDK: PostgreSQL z PITR + S3 lifecycle | WU-01 |
| `RA-025-WU-03` | `DRAFT` | CDK: webhook ingress na skalowalnym HTTP boundary | WU-01 |
| `RA-025-WU-04` | `DRAFT` | CDK: worker/Discord compute + action executor isolation | WU-01 |
| `RA-025-WU-05` | `DRAFT` | CDK: queues/DLQ, Bedrock access, observability | WU-01 |
| `RA-025-WU-06` | `DRAFT` | IAM per component, least privilege, policy checks w synth | WU-02..WU-05 |
| `RA-025-WU-07` | `DRAFT` | migracje jako kontrolowany deployment step + rollback safety | WU-02 |
| `RA-025-WU-08` | `DRAFT` | deploy/rollback runbook bez ręcznych niewersjonowanych kroków | WU-06, WU-07 |
| `RA-025-WU-09` | `DRAFT` | restore drill do odrębnego środowiska + reconciliation | WU-07, WU-08 |
| `RA-025-WU-10` | `DRAFT` | re-registration/renewal integracji po restore + recovery order | WU-09 |

## Wymagania do rozdzielenia na units

- **AC1 (synth/diff deterministyczny, przechodzi security policy checks)** →
  `WU-06`; determinizm oznacza brak zależności od czasu/losowości w synth.
- **AC2 (IAM per component, bez szerokich wildcardów bez ADR)** → `WU-06`; każdy
  wildcard wymaga ADR, nie komentarza.
- **AC3 (fresh environment z repo i udokumentowanych prerequisites)** → `WU-08`.
- **AC4 (restore odtwarza cases/checkpoints/audit i uzgadnia jobs)** → `WU-09`;
  game day, nie deklaracja.
- **AC5 (po restore żaden ambiguous write nie jest powtórzony)** → `WU-09`;
  **kluczowe** — restore jest najbardziej niebezpiecznym momentem dla blind replay;
  test z zapisanym stanem `AMBIGUOUS` przed backupem.
- **AC6 (rollback nie cofa destrukcyjnie danych/migracji)** → `WU-07`; jawna zasada,
  że rollback aplikacji nie uruchamia `migrateDown`.
- **AC7 (Discord, watches/webhooks, secrets mają udokumentowany recovery order)** →
  `WU-10`.

## Final task gate

Koordynator uruchamia CDK synth/diff i testy, policy scanning, całe repo bez
regresji, `pnpm workflow:validate`, `git diff --check`, oraz osobno weryfikuje
siedem kryteriów akceptacji — w szczególności determinizm synth, brak szerokich
wildcardów IAM, brak automatycznego `migrateDown` przy rollbacku i brak blind
replay po restore. **Sandbox smoke test oraz jakikolwiek real deploy wykonywany
dopiero po jawnej, odrębnej zgodzie właściciela.** Brak Dockera w środowisku musi
być jawnie odnotowany, jeśli blokuje którąkolwiek weryfikację — nie pomijany
milczeniem. Następnie handoff i niezależny audyt.
