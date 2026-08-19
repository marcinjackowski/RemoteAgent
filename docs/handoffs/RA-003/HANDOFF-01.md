# RA-003 — Handoff 01

## Metadata

- Task: `RA-003`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: `main` po RA-002 `AUDIT_PASSED`
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`
  (nowy pakiet persistence, migracje, testy DB, docs)

## Wynik

Pełny zakres RA-003 (PostgreSQL persistence) zaimplementowany zgodnie z
ADR-0002. PostgreSQL 8.16.3 z ręcznymi, transakcyjnymi migracjami 001-009.
Repozytoria z domenowymi błędami zweryfikowane realnym harnessem PostgreSQL.
Sekwencja migracji up/down/up przechodzi PASS. Clean-room na przypiętym
Node 24.19.0 / pnpm 10.26.1: `pnpm run check` PASS (exit 0), 267/267 testów,
DB 10/10, build/typecheck 20/20, workflow 26.

## Zrealizowany zakres

- Migracje transakcyjne 001-009 (up/down) obejmujące pełny schemat tabel z
  taska: events, cases, jobs, checkpoints, connections, owners oraz tabele
  powiązane wg specyfikacji RA-003.
- Composite FK owner/connection wymuszające izolację scope na poziomie schematu.
- Deduplikacja eventów po naturalnym kluczu (idempotentny append).
- CAS checkpoint (compare-and-set) chroniący przed lost update.
- Triggery append-only na tabelach event/audit (blokada UPDATE/DELETE).
- Indeksy pod ścieżki dostępu + polityka retencji.
- Repozytoria + domenowe klasy błędów (mapowanie błędów PG na typy domenowe).
- Realny harness PostgreSQL do testów integracyjnych repozytoriów.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/persistence/migrations/001-009` | transakcyjne up/down dla pełnego schematu | ADR-0002, schemat z taska |
| `packages/persistence/src` | repozytoria + domenowe błędy + composite FK/CAS/dedupe | kontrakty persistence RA-003 |
| `packages/persistence/test` | realny harness PostgreSQL + testy repo/migracji | dowód FK/dedupe/CAS/append-only |

## Decyzje i uzasadnienie

- **Ręczne transakcyjne migracje zamiast frameworka.** Zgodnie z ADR-0002 pełna
  kontrola nad DDL, deterministyczny up/down, każda migracja w jednej
  transakcji — brak stanu częściowo zaaplikowanego.
- **Izolacja scope na poziomie schematu (composite FK owner/connection).** Model
  nie jest warstwą autoryzacji; FK deterministycznie uniemożliwia powiązanie
  encji z cudzym ownerem/connection.
- **Dedupe + CAS + append-only triggery.** Side effecty idempotentne: powtórny
  append eventu jest no-op po naturalnym kluczu, checkpoint chroniony CAS,
  event/audit niemutowalne przez trigger.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Pełny schemat tabel utrwalony | PASS | migracje 001-009, testy DB |
| Composite FK owner/connection | PASS | testy FK w harnessie PostgreSQL |
| Dedupe eventów idempotentny | PASS | testy repo events |
| CAS checkpoint | PASS | testy repo checkpoints |
| Append-only triggery | PASS | testy UPDATE/DELETE odrzucone |
| Indeksy + retencja | PASS | migracje + testy |
| Migracje up/down/up | PASS | sekwencja migracji PASS |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| clean-room `pnpm run check` (node:24.19.0, pnpm 10.26.1) | 0 | 267/267; build/typecheck 20/20; workflow 26 |
| testy DB (harness PostgreSQL, port 5433) | 0 | 10/10 |
| migracje up/down/up | 0 | PASS |

Clean-room: świeża kopia working tree bez `.git`, `node_modules`, `dist`,
`.turbo` i lokalnego, gitignored `.claude/settings.local.json` (wykluczony z
clean-room); pnpm 10.26.1 przez `corepack prepare`; Node 24.19.0.

## Snapshoty i artefakty

- Migracje `packages/persistence/migrations/001-009` (up/down).
- Realny harness PostgreSQL wymaga uruchomionego Postgresa na porcie 5433.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak w handoffie; `.claude/settings.local.json`
  nietknięty i wykluczony z clean-room.
- Izolacja kont/scope: composite FK owner/connection egzekwuje izolację na
  poziomie schematu; model nie jest warstwą autoryzacji.
- Side effecty i idempotencja: dedupe eventów, CAS checkpoint, append-only
  triggery — powtórzenia bezpieczne, mutacje eventów zablokowane.
- Dane zewnętrzne: traktowane jako `UNTRUSTED_DATA` zgodnie z kontraktami.

## Znane ograniczenia i ryzyka

- Testy integracyjne wymagają działającego PostgreSQL na porcie 5433.
- Audyt powinien niezależnie zweryfikować: composite FK, indeksy, API
  repozytoriów i poprawność rollbacku (down) migracji.
- Zmiany nie są zacommitowane (zgodnie z regułami: brak commita/pusha).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: pełny RA-003, migracje 001-009, repozytoria + błędy domenowe,
  clean-room `pnpm run check` PASS 267/267, status `AWAITING_AUDIT`.
- Czego nie robić przed audytem: nie commitować, nie pushować, nie zaczynać
  RA-004/RA-005.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian:
  `packages/persistence/src`, `packages/persistence/migrations`,
  `packages/persistence/test`.
