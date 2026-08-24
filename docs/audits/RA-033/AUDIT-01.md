# RA-033 — AUDIT-01

- Task: `RA-033` Kontekst zadania dla agenta: issue Jiry w transkrypcie case'a
- Data: `2026-08-24`
- Bazowy commit: `d094e67` (po RA-032)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt w §6.

## 1. Bramka — uruchomiona (Node 24.19.0)

```text
RA_REQUIRE_POSTGRES=1 vitest run   (całe repo)   2434/2434, 184 pliki, DWA przebiegi, exit 0
typecheck --force 38/38 (0 cached)   build --force 26/26 (0 cached)   lint OK   format OK
```

Testy 2430 → **2434** (+3 renderer `jira-issue-context`, +1 nowy `it` idempotencji reconcile).

Środowisko: PG17/5433 zniknął z maszyny; bramkę uruchomiono wobec działającego PG15/5432 przez
override `RA_PG*` (superuser, trust). Migracje aplikują się czysto — patrz WORK_UNITS „Środowisko".

## 2. Kryteria akceptacji — osobno

- **AC1** (atomowy zapis do transkryptu): **spełnione**. `applyIssue`
  (`apps/agent-worker/src/jira-reconcile.ts:138`) woła `CaseMessageRepository.append(tx, …)` w tej
  samej `tx` co `correlateJiraIssueInTransaction`, więc kontekst commit'uje się atomowo z case'em.
- **AC2** (SYSTEM/UNTRUSTED_DATA + mutation): **spełnione**. Wpis ma `role: "SYSTEM"`,
  `trust: "UNTRUSTED_DATA"`. Mutation check `trust → TRUSTED`: test integracyjny RED, przywrócony
  GREEN (§5).
- **AC3** (idempotencja): **spełnione**. `message_id = jira-issue:<eventId>` +
  `ON CONFLICT (message_id) DO NOTHING`. Test „reconcile ×2 tego samego snapshotu → 1 wiersz"
  zielony. Zmiana issue niesie nowy `eventId` (digest korelacji obejmuje `updated`) → świeży wpis.
- **AC4** (bounds + renderer): **spełnione**. `renderJiraIssueContext` przycina status/summary/
  description (256/2 000/8 000); test jednostkowy sprawdza etykiety, puste pola i przycięcie
  gigantycznego opisu (`body.length < 20 000` << 65 536).
- **AC5** (bramka): **spełnione** — §1.

## 3. Diff od bazy — przegląd

Cztery pliki, wszystkie w `apps/agent-worker`:
`src/jira-issue-context.ts` (nowy renderer), `src/jira-reconcile.ts` (+import, +append w `applyIssue`),
`test/jira-issue-context.test.ts` (nowy), `test/jira-reconcile.integration.test.ts` (+asercje
kontekstu, +test idempotencji, +`description` w fixture). `connector-jira` i `packages/database`
nietknięte — zgodnie z zawężeniem.

## 4. Decyzje

Opcja 1 (statyczny kontekst przy reconcile) zamiast Opcji 2 (aktywny brokerowany fetch) — wybór
właściciela `2026-08-24`, po ustaleniu, że oba warianty katalogu narzędzi opierają się na
nieistniejącej infrastrukturze (brak checkoutu dla bare case Jiry; brak żywego `ToolTransport` +
brak per-case grantu `project`). Zapis w `docs/tasks/RA-033.md`.

## 5. Mutation checks (wykonane)

```text
mut1: trust: "UNTRUSTED_DATA" → "TRUSTED"      jira-reconcile.integration  1 failed  (RED)
      przywrócone                              jira-reconcile.integration  2 passed  (GREEN)
mut2: usunięty CaseMessageRepository.append    jira-reconcile.integration  2 failed  (RED)
      przywrócone                              jira-reconcile.integration  2 passed  (GREEN)
```

Marker `UNTRUSTED_DATA` i sama obecność wpisu są load-bearing — obie mutacje czerwienią test.

## 6. Werdykt

Wszystkie AC spełnione z uruchomionym dowodem. SUPERVISOR (który czyta `case_messages`, RA-032)
zobaczy teraz treść issue jako UNTRUSTED kontekst, atomowo i idempotentnie zapisaną przy reconcile.
Świadome zawężenie: aktywne narzędzia/fetch (Opcja 2) i workspace — przyszły task.

- Werdykt: `PASS`
