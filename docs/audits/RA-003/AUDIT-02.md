# RA-003 — Audit 02

## Metadata

- Task: `RA-003`
- Audytowany handoff: `docs/handoffs/RA-003/HANDOFF-02.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacje atomowości checkpointu, obowiązkowej bazy w CI i lokalnego portu są
skuteczne. Migracja 010 blokuje część wcześniej odtworzonych cross-owner writes,
ale nie domyka granic deklarowanych w handoffie. Case scope można unieważnić
późniejszą zmianą connection, istniejące wadliwe scope przechodzą migrację 010,
a kilka nadal niezabezpieczonych FK pozwala tworzyć cross-provider i cross-case
powiązania. Werdykt pozostaje `CHANGES_REQUIRED`.

## Zakres audytu

- Przeczytane: dokumenty obowiązkowe, checklist audytora, AUDIT-01, HANDOFF-02,
  ADR-0002 oraz cały zmieniony kod/migracje/testy RA-003.
- Sprawdzone: migracja 010 up/down, transaction brand i checkpoint API,
  PostgreSQL gate/CI, Compose/config/README, testy scope i pełny diff.
- Wykonane: testy DB/full/typecheck/workflow oraz niezależne negatywne próby
  INSERT/UPDATE i migracji na izolowanym PostgreSQL.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| Migracje zero/up/down/up | PASS | 001-010 przechodzą lifecycle test |
| Dedupe provider event | PASS | test repository PASS |
| Jeden zwycięzca rewizji checkpointu | PASS | concurrency PASS; branded transaction usuwa partial state |
| Brak cross-owner entity/connection ordinary write | FAIL | connection update ponownie tworzy cross-owner case scope; patrz HIGH-01 |
| Append-only bez publicznego update/delete | PASS | API + P0100 |
| Testy na realnym PostgreSQL | PASS | 25/25; brak PG z `RA_REQUIRE_POSTGRES=1` kończy się non-zero |
| Transakcja przerwana bez partial state | PASS | błąd drugiego kroku zostawia revision=0 i 0 checkpointów |

## Findingi

### HIGH — Case integration scope nie zachowuje integralności w czasie ani podczas migracji

- Lokalizacja: `packages/database/migrations/010_scope_referential_integrity.up.sql:153-206`.
- Dowód: po poprawnym INSERT case A→connection A zwykłe
  `UPDATE connections SET owner_id='B'` zostało zaakceptowane, pozostawiając
  case A z connection ownera B. Analogicznie zaakceptowano zmianę providera;
  DELETE connection także nie ma reverse FK z JSON scope. Ponadto audyt cofnął
  DB do wersji 9, zapisał wadliwy scope A→connection B i ponownie uruchomił
  migrację 010 — migracja zakończyła się sukcesem, bo nowy trigger nie waliduje
  istniejących wierszy.
- Wpływ: kryterium 4 można ominąć zwykłą mutacją parent row, a upgrade może
  utrwalić już istniejący cross-owner scope mimo deklaracji fail-closed.
- Wymagana zmiana: użyć znormalizowanej relacji case↔connection z composite FK
  (preferowane) albo dodać kompletne reverse enforcement dla UPDATE/DELETE
  connection. Migracja musi jawnie zwalidować/backfillować wszystkie istniejące
  scopes i atomowo przerwać się na pierwszym naruszeniu. Dodać testy insert,
  connection owner/provider update, delete oraz upgrade 009→010 z wadliwymi
  danymi.

### HIGH — Nadal istnieją niezabezpieczone provider/case scoped edges

- Lokalizacja: `packages/database/migrations/001_extensions_owners_connections.up.sql:40-50`,
  `002_events.up.sql:11-26`, `003_cases_entities.up.sql:36-52`,
  `004_runs_checkpoints.up.sql:75-82`, `005_decisions.up.sql:27-38`.
- Dowód: PostgreSQL zaakceptował: raw event `provider=jira` przez connection
  `provider=gmail`; external entity z takim samym mismatch; checkpoint case A
  z `last_run_id` runa case B; answer case A wskazujący decision case B.
  Migracja 010 nie obejmuje tych relacji mimo deklaracji „all scoped edges”.
- Wpływ: provider routing/provenance oraz recovery/decision state mogą przekroczyć
  connection lub case/owner boundary. Model/aplikacja ponownie stają się jedyną
  warstwą pilnującą scope.
- Wymagana zmiana: composite key/FK musi wiązać provider z connection dla raw
  events, normalized events i external entities; związać `(last_run_id, case_id)`
  checkpointu z runem oraz `(decision_id, case_id)` answer z decision. Wykonać
  systematyczny przegląd pozostałych redundantnych refs (m.in. active_run,
  trigger_event, last_event, approval/action digest) i albo wymusić wspólny
  scope, albo usunąć redundantną kolumnę. Każdy edge ma dostać negatywny test.

### LOW — Handoff zawiera twierdzenia szersze niż implementacja

- Lokalizacja: `docs/handoffs/RA-003/HANDOFF-02.md`.
- Dowód: handoff deklaruje „all scoped edges” i że publiczny append sam otwiera
  transakcję; kod obejmuje tylko wybraną listę, a append wymaga branded handle.
  Handoff twierdzi też, że `.claude/settings.local.json` był nietknięty, choć
  `format:write` musiał go sformatować, aby późniejszy root format przeszedł.
- Wpływ: audyt i przyszły handoff mogą oprzeć się na nieprecyzyjnym evidence.
- Wymagana zmiana: kolejny handoff ma opisywać dokładny mechanizm i rzeczywiste
  ścieżki; dodać lokalne settings do ignore formatowania, aby ich więcej nie
  modyfikować.

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 25/25 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 282/282 PASS |
| `RA_PGPORT=65432 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 1 | fail-closed PASS |
| `pnpm run typecheck` | 0 | 21/21 PASS |
| `pnpm run workflow:validate` | 0 | 26 tasks PASS |
| Negatywne UPDATE/provider/case probes | 0 | wszystkie cztery wadliwe zapisy zaakceptowane |
| Upgrade 009→010 z wadliwym scope | 0 | migracja błędnie zaakceptowała dane |

## Ryzyka przekrojowe

- Security/privacy: HIGH — owner/provider/case scope nadal ma obejścia.
- Idempotencja/recovery: checkpoint CAS jest już atomowy, lecz `last_run_id`
  może wskazywać obcy case.
- Współbieżność: CAS i rollback testy poprawne.
- Operacyjność: CI PostgreSQL gate i port 5433 poprawione.
- Kompatybilność: upgrade migracji nie waliduje istniejącego JSON scope.

## Wymagane działania po `continue`

1. Zapewnić trwałą, dwukierunkową integralność case↔connection i walidację danych
   istniejących przed/ podczas migracji.
2. Domknąć provider↔connection i wszystkie udowodnione cross-case refs.
3. Dodać negatywne testy aktualizacji/usunięcia parent rows oraz upgrade z
   istniejącymi naruszeniami.
4. Skorygować dokumentację/handoff i ochronić lokalne settings przed formatterem.
5. Ponowić up/down/up, pełny PostgreSQL suite i pinned clean-room.

## Uzasadnienie werdyktu

Trzy findingi z AUDIT-01 są zamknięte, ale security-critical owner/connection
finding pozostaje reprodukowalny, a dalsze cross-case/provider edges przeczą
deklarowanej integralności. Przy unresolved HIGH `PASS` jest niedozwolony.
