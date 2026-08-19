# RA-003 — Audit 05

## Metadata

- Task: `RA-003`
- Audytowany handoff: `docs/handoffs/RA-003/HANDOFF-05.md`
- Audytor: Codex, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `PASS`

## Podsumowanie

Finding AUDIT-04 został usunięty. Migracja 011 poprawnie przechodzi z wersji 10
zawierającej istniejący checkpoint, backfilluje ownera i odtwarza append-only
guard przed commitem. Przy późniejszym błędzie migracji transakcyjny rollback
przywraca schemat v10 wraz z aktywnym guardem. Wszystkie wcześniejsze findingi
AUDIT-01..03 pozostają zamknięte. Brak unresolved BLOCKER/HIGH/MEDIUM.

## Niezależna weryfikacja findingu AUDIT-04

1. Utworzono osobną bazę od zera, zastosowano 001-011 i cofnięto do wersji 10.
2. Zapisano poprawnego ownera, connection, case z revision 1 i checkpoint v1.
3. `migrate up` zastosował 011; checkpoint otrzymał `owner_id='A'`.
4. Trigger `case_checkpoints_append_only` istniał po upgrade, a próba UPDATE
   została odrzucona SQLSTATE `P0100`.
5. Ponownie cofnięto do v10, dodano wadliwy pusty legacy scope i uruchomiono 011.
   Migracja została atomowo odrzucona, `schema_migrations` pozostało na 10,
   trigger append-only nadal istniał, a DELETE checkpointu zwrócił `P0100`.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód |
|---|---|---|
| Empty DB migrate zero/up/down/up | PASS | lifecycle 001-011 + test migracji |
| Provider-event dedupe | PASS | repository integration |
| Jeden zwycięzca CAS checkpointu | PASS | concurrency integration |
| Owner/connection/case scope | PASS | composite/member FK, tamper guard, 41 scope tests i niezależne probes |
| Append-only bez publicznej mutacji | PASS | P0100 przed/po upgrade i po rollbacku |
| Real PostgreSQL, nie mock | PASS | 56/56 DB na PostgreSQL 17.2 |
| Brak partial state po przerwaniu transakcji | PASS | checkpoint rollback + migration rollback |
| Bezpieczna przyszła migracja | PASS | istniejący checkpoint v10 przechodzi do v11; wadliwe legacy dane fail-closed |

## Testy audytora

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 56/56 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` | 0 | 313/313 PASS |
| `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run build && pnpm run workflow:validate` | 0 | PASS; workflow 26 tasks |
| `RA_PGPORT=65432 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 1 | oczekiwany fail-closed |
| ręczny upgrade v10→v11 z checkpointem | 0 | applied 11, owner backfilled, P0100 aktywne |
| ręczny abort v10→v11 z wadliwym scope | non-zero | version 10, trigger zachowany, P0100 aktywne |

## Bezpieczeństwo i ryzyka

- Izolacja owner/connection/provider i per-case allowlista są wymuszane w DB.
- Recovery pointers oraz approval digest mają composite constraints.
- Runtime scope jest walidowany w repozytorium i niezależnie w DB.
- Kontrolowane wyłączenie triggera występuje wyłącznie w transakcji migracji;
  zarówno success, jak i rollback kończą się aktywnym guardem.
- Pozostaje zwykłe ryzyko operacyjne wymagania dostępnego PostgreSQL w testach;
  CI failuje zamknięcie zamiast pomijać suite.

## Uzasadnienie werdyktu

Wszystkie kryteria RA-003 są spełnione, wymagane komendy zostały uruchomione
niezależnie, a wszystkie findingi klasy BLOCKER, HIGH i MEDIUM są zamknięte.
