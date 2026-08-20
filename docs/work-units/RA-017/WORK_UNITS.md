# RA-017 — Work units

## Metadata

- Task: `RA-017`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES`. Zależności `DONE`:
  RA-002, RA-003, RA-004, RA-005, RA-006. Niedokończone: RA-013, RA-014, RA-015.
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-gitlab/test`

## Global boundaries

- In scope: read-only GitLab REST, signed webhook ingress, korelacja z case oraz
  **sandbox-only** push brancha i idempotentny draft MR.
- Out of scope: merge MR, force-push, produkcyjny deploy, ogólny approval engine
  (RA-022).
- **Real writes disabled by default.** Push i create MR wymagają skonfigurowanego
  sandbox project/scope grant. Live write wymaga jawnej zgody właściciela —
  koordynator nie udziela jej sam.
- Token GitLab nigdy nie trafia do modelu, command outputu ani logu remote URL.
- Treść GitLab (opisy MR, notatki, logi pipeline) jest `UNTRUSTED_DATA`.

## Ustalenia z kodu przed planowaniem (2026-08-20)

Sprawdzone w repozytorium, nie założone:

1. **`packages/connector-gitlab` to sam szkielet z RA-001** — `src/index.ts`
   eksportuje tylko `packageName`. Cała domena jest do napisania.
2. **`ExternalAction` już istnieje i jest mocny:**
   `packages/contracts/src/external-action.ts` ma `externalAction` z
   `target_scope`, `canonical_payload`, `action_digest`, `risk_tier`,
   `policy_decision`, `approval_id`, `idempotency_key`, `status`,
   `external_receipt`, oraz `superRefine`, który **przelicza** `canonicalDigest`
   payloadu i fail-closed przy niezgodności. Push i create MR muszą przechodzić
   przez ten kontrakt — nie tworzyć własnego intent/receipt.
3. **Wzorzec obsługi credentiali jest ustalony w RA-016** —
   `packages/connector-jira/src/rest/client.ts`: `getAccessToken()` zwraca leased
   bufor, token żyje jako `Uint8Array`, jest dekodowany tylko do nagłówka i
   **zerowany w `finally` przez `token.fill(0)`**. Dodatkowo: allowlista originów,
   wymóg `https://`, odrzucenie redirectu (`response.redirected !== false`),
   walidacja prefiksu ścieżki. RA-017 musi powtórzyć ten wzorzec dla GitLaba —
   zwłaszcza **zakaz umieszczania tokenu w remote URL** (AC3), co jest naturalną
   pokusą przy `git push https://oauth2:TOKEN@host/...`.
4. **Redakcja sekretów istnieje:** `SecretRedactor` w
   `packages/observability/src/redaction.ts`. Test redakcji Git URL/errors ma go
   użyć, nie tworzyć drugiego.
5. **Git push nie istnieje w `workspace-runner`** — `git.ts` ma tylko
   `ensureMirror`, `verifyCommit`, `addWorktree`, `worktreeHead`. Push to nowa
   zdolność i musi być wąska. Uwaga: `runGit` używa `execFile` z tablicą argumentów
   (dobrze), ale ma `maxBuffer: 1024 * 1024`.
6. **Wzorzec webhook ingress jest gotowy w RA-016:** `connector-jira/src/webhook/`
   (`ingress.ts`, `payload.ts`) plus durable raw payload i dedupe. AC5
   (replay/stary timestamp odrzucony i audytowany) ma naśladować ten wzorzec.
7. Numer migracji: `026` zajęte, `027` bierze RA-012; RA-013/014/015 wezmą kolejne.
   RA-017 musi wziąć następny wolny **po ponownym sprawdzeniu**.

## Decyzje architektoniczne do potwierdzenia przy starcie

1. **Push i draft MR jako `ExternalAction`**, z durable intent → receipt →
   reconciliation. Timeout po możliwym wykonaniu daje `AMBIGUOUS`, nigdy blind
   replay. To ta sama zasada, która obowiązuje w RA-012 dla patcha.
2. **Credential broker niewidoczny dla modelu.** Token rozwiązywany
   deterministycznie po stronie serwera; model nie widzi go w żadnym toolu, logu
   ani błędzie. Push wykonywany tak, by token nie wszedł do argv ani URL-a
   (np. przez ephemeryczny credential helper albo `http.extraHeader`), co należy
   jawnie rozstrzygnąć i uzasadnić w pierwszym unicie.
3. **Feature flag write** jest server-owned i domyślnie wyłączony; jego test
   negatywny (write przy wyłączonej fladze jest odrzucony) jest obowiązkowy.
4. **Uwaga na kolizję nazw eksportów** — patrz finding w
   `docs/work-units/RA-012/WORK_UNITS.md`.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-017-WU-01` | `DRAFT` | contracts/config/allowlist + decyzja o transporcie tokenu | RA-015 DONE |
| `RA-017-WU-02` | `DRAFT` | read-only REST client (origin/redirect/token hygiene) | WU-01 |
| `RA-017-WU-03` | `DRAFT` | signed webhook ingress z replay/timestamp protection | WU-01 |
| `RA-017-WU-04` | `DRAFT` | normalize/enrichment/correlation branch-MR-pipeline → case | WU-02, WU-03 |
| `RA-017-WU-05` | `DRAFT` | sandbox push + idempotentny draft MR jako `ExternalAction` | WU-04 |
| `RA-017-WU-06` | `DRAFT` | final integration proof + macierz negatywna | WU-05 |

## Wymagania do rozdzielenia na units

- **AC1 (repo/project spoza allowlisty nieczytelne i niezmienialne)** → `WU-01` +
  `WU-02`; allowlista server-owned, test negatywny dla read **i** write.
- **AC2 (ponowienie push/create MR nie tworzy duplikatu)** → `WU-05`; oparte na
  `idempotency_key` z `externalAction`; test równoległego i sekwencyjnego retry.
- **AC3 (token nie trafia do modelu, command outputu ani remote URL logu)** →
  `WU-02` + `WU-05`; wzorzec `token.fill(0)` z RA-016; **jawny test, że token nie
  występuje w argv procesu, w remote URL ani w komunikacie błędu**; użyć
  `SecretRedactor`.
- **AC4 (pipeline event aktualizuje właściwy case i commit SHA)** → `WU-04`;
  ordering pipeline events musi być odporny na dostawę nie po kolei (wzór
  `putIfNewer` z RA-016).
- **AC5 (webhook replay/stary timestamp odrzucony i audytowany)** → `WU-03`; wzór
  z `connector-jira/src/webhook/`; audyt przez `audit-log` repository.
- **AC6 (draft MR zawiera prawdziwe test/review evidence i unresolved risks)** →
  `WU-05`; wymaga `TestRun` z RA-013 i `ReviewReport` z RA-015 — stąd zależności.
  Opis MR nie może twierdzić „testy przeszły" bez receiptu.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, sondę przecięcia eksportów, skan sekretów w fixtures, oraz
osobno weryfikuje sześć kryteriów akceptacji — w szczególności brak tokenu w argv i
remote URL, duplicate push/MR, replay webhooka i write przy wyłączonej fladze.
**Żaden live write nie jest wykonywany bez jawnej zgody właściciela.** Następnie
handoff i niezależny audyt.
