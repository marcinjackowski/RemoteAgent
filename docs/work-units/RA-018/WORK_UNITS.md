# RA-018 — Work units

## Metadata

- Task: `RA-018`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES`. Zależności `DONE`:
  RA-009, RA-010, RA-011, RA-016. Niedokończone: RA-012, RA-013, RA-014, RA-015,
  RA-017. Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/golden-path`

## Global boundaries

- In scope: spięcie M0–M3 **bez pomijania publicznych kontraktów**, dwa równoległe
  taski, decision/resume, restart/fault matrix i zebrane evidence.
- Out of scope: Gmail, Calendar (RA-019/RA-020), ogólne MCP write tools (RA-021),
  produkcyjny deployment (RA-025).
- **To pełna bramka milestone M3.** Audyt sprawdza system end-to-end, nie zielony
  test. Zielona suite nie jest tu wystarczającym dowodem.
- **Każdy send na Discord dopiero po jawnej zgodzie właściciela.** Domyślnie fake
  transport; manual acceptance jest osobnym, ręcznym krokiem.

## Ustalenia z kodu przed planowaniem (2026-08-20)

1. **Nie pisać czwartego harnessu.** Istnieją już trzy wzorce, na których RA-018 ma
   się oprzeć, nie duplikować:
   - `packages/connector-jira/test/jira-e2e.integration.test.ts` (RA-016-WU-08F) —
     pełna ścieżka webhook → normalized event → snapshot → case/entity → Discord
     outbox, z asercjami na realnym stanie DB, plus scope isolation i restart;
   - `packages/database/test/harness.ts` — `createTestDatabase()` tworzy izolowaną,
     zmigrowaną bazę per suite;
   - `packages/agent-orchestrator/src/supervisor/writer-lease.ts` —
     `WriterLeaseGuard`, `WRITER_JOB_TYPE`, `WorkspaceFence`.
2. **AC2 (nigdy dwóch writerów na case) jest już wymuszane kontraktem i leasem** —
   `ROLE_CAN_WRITE_WORKSPACE` (`IMPLEMENTER: true`, reszta `false`) plus
   `WriterLeaseGuard`. Unit ma to **udowodnić przy realnym overlapie**, nie
   zaimplementować od nowa.
3. **AC4 (crash przy niepotwierdzonym write → reconciliation/`AMBIGUOUS`)** ma już
   dwie realizacje do wykorzystania: `AMBIGUOUS` w `ToolResult` z RA-012 oraz
   `externalAction` + `externalReceipt` z `packages/contracts/src/external-action.ts`
   (z `superRefine` przeliczającym `canonicalDigest`). Nie wprowadzać trzeciej
   taksonomii stanu niejednoznacznego.
4. **Wzorzec dowodu realnego overlapu jest ustalony w RA-016-WU-08G:** opóźniony
   fake (`setTimeout`) + wystartowanie wszystkich promise'ów przed `Promise.all` +
   licznik faktycznych wywołań. AC1 wymaga **barier potwierdzających overlap**, więc
   test bez wymuszonego przeplotu nie jest dowodem — to najbardziej prawdopodobne
   miejsce fałszywie zielonego wyniku w tym tasku.
5. **Znane ryzyko infrastrukturalne:** `CTF-003` — flake `process-runner` w pełnym
   przebiegu repo. RA-018 opiera się na bramce „całe repo zielone", więc `CTF-003`
   powinien być domknięty **przed** finalnym gate'em tego taska, inaczej jego
   evidence jest chwiejny.

## Decyzje architektoniczne do potwierdzenia przy starcie

1. **Testy w `test/golden-path/`, nie w pakiecie.** Golden path spina wiele
   pakietów; umieszczenie go w którymkolwiek z nich złamałoby granice zależności
   (`eslint.config.mjs`, element type `package`). Katalog `test/**` jest już objęty
   `vitest.config.ts`.
2. **Fake providers, nie live.** Jira i GitLab jako deterministyczne fake'i
   (wzór `FakeJira` z RA-016). Live sandbox tylko przy jawnej zgodzie właściciela.
3. **Evidence bundle jako artefakt**, oparty na artifact store z RA-013 — nie ad-hoc
   pliki w repo.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-018-WU-01` | `DRAFT` | golden path harness (jeden case, pełna ścieżka) | RA-017 DONE |
| `RA-018-WU-02` | `DRAFT` | two-case concurrency z barierami dowodzącymi overlap | WU-01 |
| `RA-018-WU-03` | `DRAFT` | fault/reconciliation matrix (kill w każdej granicy) | WU-01 |
| `RA-018-WU-04` | `DRAFT` | decision/resume proof — `continue` wznawia właściwy case | WU-01 |
| `RA-018-WU-05` | `DRAFT` | manual Discord acceptance script + runbook | WU-02, WU-03, WU-04 |
| `RA-018-WU-06` | `DRAFT` | final evidence bundle i porównanie ledger/Git/receipts | WU-05 |

## Wymagania do rozdzielenia na units

- **AC1 (dwa taski realnie równolegle, bez współdzielenia zmian)** → `WU-02`;
  bariery wymuszające przeplot; asercja, że workspace jednego case nie widzi
  zmian drugiego (tree digest przed/po).
- **AC2 (nigdy dwóch writerów na case)** → `WU-02`; przez `WriterLeaseGuard`; test
  próby przejęcia lease'a przy aktywnym writerze.
- **AC3 (restart nie traci decyzji/planu/diffu/testów/MR mappingu)** → `WU-03`;
  restart z zachowaniem wyłącznie DB + artifact store, jak w restart teście RA-016.
- **AC4 (crash przy niepotwierdzonym write → reconciliation/`AMBIGUOUS`)** →
  `WU-03`; **nigdy blind replay**; wykorzystać `AMBIGUOUS` z RA-012 i
  `externalReceipt` z RA-017.
- **AC5 (każdy MR wskazuje task, decyzje, testy, review, commit SHA)** → `WU-06`;
  weryfikacja treści MR wobec realnych receiptów, nie deklaracji.
- **AC6 (`continue` wznawia właściwy case, nie inny thread)** → `WU-04`; test
  adwersarialny z dwoma otwartymi pytaniami jednocześnie — odpowiedź musi trafić
  do właściwego case.
- **AC7 (ponowne dostarczenie wszystkich eventów nie tworzy duplikatów)** →
  `WU-03`; replay całego strumienia, nie pojedynczego eventu.

## Final task gate

Bramka milestone M3. Koordynator uruchamia pełny golden path na prawdziwym
PostgreSQL, całe repo bez regresji (po domknięciu `CTF-003`),
typecheck/build/scoped lint/format, `pnpm workflow:validate`, `git diff --check`,
oraz osobno weryfikuje siedem kryteriów akceptacji. Dodatkowo — zgodnie z audit
focus taska — sprawdza **system, nie tylko test**: porównuje DB ledger, historię
Git, receipty Discord i GitLab, oraz potwierdza, że dowód overlapu w `WU-02` jest
realny (mutation test: usunięcie bariery musi wywalić test). Manual Discord
acceptance wykonywany dopiero po jawnej zgodzie właściciela. Następnie handoff i
niezależny audyt.
