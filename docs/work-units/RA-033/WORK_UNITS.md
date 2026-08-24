# RA-033 — Work units

Bazowy commit: `d094e67` (po RA-032).

Zmiana jest celowo mała i zlokalizowana w `apps/agent-worker`. `connector-jira` i `packages/database`
pozostają nietknięte: `description` jest już parsowane (RA-016), a `CaseMessageRepository.append`
już istnieje (RA-031) i jest idempotentne na `message_id`.

## WU-01 — Renderer kontekstu issue (czysty, testowalny)

- Rezultat: `apps/agent-worker/src/jira-issue-context.ts` — `renderJiraIssueContext(...)` formatuje
  issue w blok tekstu z etykietami, jawnie oznaczony jako UNTRUSTED, z przycięciem pól
  (`status` 256, `summary` 2 000, `description` 8 000) tak, by body nie zbliżyło się do limitu
  `case_messages` (65 536).
- Allowed paths: `apps/agent-worker/src/jira-issue-context.ts`, `apps/agent-worker/test/jira-issue-context.test.ts`.
- Weryfikacja: `vitest run apps/agent-worker/test/jira-issue-context.test.ts` → 3/3.
- Status: `DONE`.

## WU-02 — Wpięcie w reconciler: issue → case_messages

- Rezultat: `applyIssue` w `apps/agent-worker/src/jira-reconcile.ts` po `correlateJiraIssueInTransaction`
  dokłada — w tej samej `tx` — `case_messages` z `role: SYSTEM`, `trust: UNTRUSTED_DATA`,
  `message_id = jira-issue:<eventId>`, `body = renderJiraIssueContext(...)`. Idempotentne przez
  `ON CONFLICT (message_id)`; nowy `eventId` (issue się zmieniło) = świeży wpis.
- Allowed paths: `apps/agent-worker/src/jira-reconcile.ts`, `apps/agent-worker/test/jira-reconcile.integration.test.ts`.
- Weryfikacja: `RA_REQUIRE_POSTGRES=1 vitest run apps/agent-worker/test/jira-reconcile.integration.test.ts` → 2/2.
  Mutation check: (1) `trust: TRUSTED` → RED, przywrócone GREEN; (2) usunięcie `append` → RED (2/2),
  przywrócone GREEN.
- Status: `DONE`.

## Bramka taska

- `pnpm run typecheck --force` → 38/38 (0 cached).
- `pnpm run build --force` → 26/26 (0 cached).
- `pnpm run lint` → OK (tylko preexistujące ostrzeżenia `boundaries` v5→v6, nie błędy).
- `pnpm run format` → OK.
- `RA_REQUIRE_POSTGRES=1 vitest run` (całe repo) → **2434/2434, 184 pliki, dwa przebiegi**, exit 0.

## Środowisko (istotne dla następnej sesji)

PostgreSQL 17 na `5433` **zniknął** z tej maszyny (brew ma tylko `postgresql@15` uruchomiony na
`5432` oraz zatrzymany `postgresql@18` na `7432`; brak PG17). Bramkę uruchomiono wobec działającego
PG15 na `5432` przez override:
`RA_PGPORT=5432 RA_PGUSER=marcinjackowski RA_PGPASSWORD= RA_PGDATABASE=postgres RA_PGHOST=127.0.0.1`
(superuser, trust auth). Migracje aplikują się czysto na PG15. Docelowo warto odtworzyć PG17 na 5433
albo zaktualizować kontrakt środowiska.
