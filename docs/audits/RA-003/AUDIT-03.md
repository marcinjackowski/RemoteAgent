# RA-003 — Audit 03

## Metadata

- Task: `RA-003`
- Audytowany handoff: `docs/handoffs/RA-003/HANDOFF-03.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Migracja 010 skutecznie usuwa wszystkie cztery reprodukcje wskazane w
AUDIT-02 oraz poprawnie przerywa upgrade na wadliwych danych. Nadal nie tworzy
jednak deklarowanej, autorytatywnej granicy connection scope: case-scoped entity
i action mogą użyć connection tego samego ownera spoza allowlisty case, a zwykły
DML może rozłączyć JSON od `case_connections`. Niezabezpieczone pozostają też
jawnie wskazane wcześniej wskaźniki recovery oraz exact approval digest.
Dlatego audyt wymaga kolejnej rundy zmian.

## Zakres audytu

- Przeczytane: dokumenty obowiązkowe, checklist audytora, RA-003, AUDIT-02,
  HANDOFF-03, ADR-0002, migracje 001-010, repozytoria i testy integracyjne.
- Sprawdzone niezależnie: pełny diff, lifecycle migracji, scoped FK, trigger
  synchronizacji, CAS checkpointu, PostgreSQL gate i workflow.
- Próby wykonano na osobnej bazie utworzonej od zera i usuniętej po audycie.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| Migracje zero/up/down/up | PASS | lifecycle 001-010 i niezależne `migrate up` |
| Dedupe provider event | PASS | test repository PASS |
| Jeden zwycięzca rewizji checkpointu | PASS | concurrency + rollback drugiego kroku PASS |
| Brak cross-owner entity/connection ordinary write | PASS/PARTIAL | cross-owner jest blokowany, lecz case connection allowlista nie jest egzekwowana; HIGH-01 |
| Append-only bez publicznego update/delete | PASS | API + P0100 |
| Testy na realnym PostgreSQL | PASS | 36/36; fail-closed bez PG kończy się exit 1 |
| Transakcja przerwana bez partial state | PASS | branded transaction + integration test |

## Findingi

### HIGH — `case_connections` nie jest autorytatywną granicą scope

- Lokalizacja: `packages/database/migrations/010_scope_referential_integrity.up.sql:136-180,187-226`, `packages/database/migrations/003_cases_entities.up.sql:33-53`.
- Dowód: dla case A ze scope `[cA]` PostgreSQL zaakceptował external entity oraz
  external action przez drugie connection `cA2` tego samego ownera, mimo że
  `cA2` nie występuje w `integration_scope.connection_ids`. Ponadto zwykłe
  `DELETE FROM case_connections` pozwoliło następnie zmienić ownera `cA`,
  pozostawiając JSON case wskazujący obcy connection. Bezpośredni INSERT do
  `case_connections` poszerzył znormalizowany edge bez zmiany JSON.
- Wpływ: allowlista connection per case może zostać ominięta przez zwykły zapis;
  istnieją dwa modyfikowalne źródła prawdy, a tabela nazywana autorytatywną nie
  jest używana przez najważniejsze case-scoped children.
- Wymagana zmiana: external entities i external actions muszą mieć composite FK
  do membership konkretnego case w `case_connections`, nie tylko do connection
  tego samego ownera. Bezpośredni DML nie może desynchronizować tabeli od JSON
  (np. odrębna rola/uprawnienia albo deterministyczny guard dopuszczający wyłącznie
  synchronizację przez case trigger). Dodać negatywne testy entity/action przez
  same-owner connection spoza scope oraz direct INSERT/DELETE/UPDATE membership.

### HIGH — Wskaźniki recovery nadal przekraczają case/owner scope

- Lokalizacja: `packages/database/migrations/003_cases_entities.up.sql:7-24`,
  `packages/database/migrations/004_runs_checkpoints.up.sql:8-25,75-82` oraz brak
  odpowiednich constraints w migracji 010.
- Dowód: PostgreSQL zaakceptował `caseA.active_run_id = runB`, gdzie runB należy
  do caseB; run caseA z `trigger_event_id=evB`, gdzie event należy do ownera B;
  oraz checkpoint caseA z `last_event_id=evB`. Handoff stwierdza, że takie
  powiązania nie umożliwiają cross-scope, ale każda próba zwróciła zapisany wiersz.
- Wpływ: wznowienie, aktywny run i provenance checkpointu mogą załadować stan
  innego case lub ownera, czyli dokładnie dane używane po restarcie.
- Wymagana zmiana: związać `active_run_id` z tym samym `case_id`; związać
  `trigger_event_id` i `last_event_id` z ownerem case (composite FK z
  deterministycznie utrzymywanym ownerem albo równoważne trwałe enforcement).
  Migracja ma walidować istniejące dane, a każdy edge dostać negatywny test.

### HIGH — Approval nie jest związany z exact action digest

- Lokalizacja: `packages/database/migrations/008_actions_approvals_receipts.up.sql:8-70`, `packages/database/migrations/010_scope_referential_integrity.up.sql:153-156`.
- Dowód: w case A utworzono approval dla digestu `sha256:aa...`, po czym baza
  zaakceptowała action o digest `sha256:bb...`, statusie `APPROVED` i tym samym
  `approval_id`. FK sprawdza wyłącznie `(approval_id, case_id)`; osobny UNIQUE na
  action digest nie wiąże obu wartości.
- Wpływ: approval udzielony dla jednej dokładnej operacji może autoryzować inną,
  co łamie kontrakt exact approval i granicę R3/R4.
- Wymagana zmiana: composite FK ma obejmować co najmniej approval, case i
  `action_digest`; istniejące dane muszą zostać zwalidowane. Dodać test mismatch
  digest oraz pozytywny test exact match.

### MEDIUM — Persistowany `integration_scope` nie egzekwuje kontraktu runtime

- Lokalizacja: `packages/contracts/src/case.ts:82-87`,
  `packages/database/migrations/010_scope_referential_integrity.up.sql:187-217`,
  `packages/database/src/repositories/case.ts:45-64`.
- Dowód: kontrakt wymaga co najmniej jednego providera i connection, ale zwykły
  INSERT case z `{"providers":[],"connection_ids":[]}` został zaakceptowany.
  Repozytorium polega na typie TypeScript i nie wykonuje runtime parse; trigger
  sprawdza tylko, czy wartości są tablicami.
- Wpływ: niepoprawne dane runtime mogą ominąć znormalizowane FK (zero membership)
  i osłabić reverse guard; zewnętrzne/modelowe dane nie mogą polegać na typach TS.
- Wymagana zmiana: egzekwować w write path/DB zamknięty kształt, min/max i
  dozwolone providery zgodne z kontraktem; dodać negatywne testy pustych,
  nieznanych i źle typowanych wartości.

### LOW — HANDOFF-03 ponownie zawiera fałszywe uzasadnienie integralności

- Lokalizacja: `docs/handoffs/RA-003/HANDOFF-03.md:53-62,80-86`.
- Dowód: handoff twierdzi, że active run/event refs nie umożliwiają cross-scope
  oraz że trigger utrzymuje oba źródła w spójności. Niezależne DML probes
  wykazały przeciwieństwo.
- Wymagana zmiana: kolejny handoff ma opisywać faktyczne gwarancje i dowody bez
  zastępowania composite constraint samym uzasadnieniem opisowym.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 36/36 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 293/293 PASS |
| `RA_PGPORT=65432 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 1 | fail-closed PASS |
| `pnpm run typecheck && pnpm run build && pnpm run workflow:validate` | 0 | PASS; 26 tasks |
| AUDIT-02 negative probes | — | owner/provider mutation, delete, cross-provider i cross-case decision/run są teraz odrzucane |
| Nowe scope/recovery/approval probes | — | wszystkie siedem niepoprawnych zapisów zaakceptowane |

## Uzasadnienie werdyktu

Remediacja AUDIT-02 jest materialna i testy regresji są zielone, ale pozostają
trzy odtworzone findingi HIGH oraz jeden MEDIUM w deterministycznej warstwie
autoryzacji i recovery. Przy takim stanie `PASS` jest niedozwolony.

## Wymagane działania po `continue`

1. Uczynić case connection membership jedyną, niemodyfikowalną poza sync granicą
   i podpiąć do niej entity/action.
2. Domknąć active run oraz owner scope eventów używanych przez run/checkpoint.
3. Związać approval z dokładnym action digestem.
4. Egzekwować runtime contract `integration_scope` i dodać wszystkie negatywne
   testy oraz test upgrade'u z wadliwymi istniejącymi relacjami.
5. Ponowić migration up/down/up, real PostgreSQL, fail-closed i pinned clean-room.
