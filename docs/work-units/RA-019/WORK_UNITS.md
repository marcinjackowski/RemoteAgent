# RA-019 — Work units

## Metadata

- Task: `RA-019`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES`. Zależności `DONE`:
  RA-002, RA-003, RA-004, RA-005, RA-006. Niedokończona: RA-018.
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-gmail/test`

## Global boundaries

- In scope: read-only odbiór zmian z dwóch kont Gmail (`private`, `sondermind`),
  cursor/watch lifecycle, reconciliation i routing do Discorda.
- Out of scope: automatyczne wysyłanie maili, produkcyjne Google MCP (RA-021).
  **Zero write do Gmaila i zero write do Discorda w tym tasku** — routing przez
  outbox, nie bezpośredni send.
- Treść maili jest `UNTRUSTED_DATA` i jest wektorem prompt injection.
- **Żadne dane konta `private` nie mogą trafić do kontekstu ani kanału
  `sondermind` i odwrotnie.**

## Ustalenia z kodu przed planowaniem (2026-08-20)

1. **`packages/connector-gmail` to sam szkielet z RA-001** (`src/index.ts` z
   `packageName`). Cała domena do napisania.
2. **Aliasy kont już istnieją w kontrakcie:**
   `packages/contracts/src/connection.ts` definiuje `PRIVATE: "private"` i
   `SONDERMIND: "sondermind"` oraz `connectionAliasSchema`, a `connection` ma pole
   `alias`. Kanały `#gmail-private` / `#gmail-sondermind` są w `MASTER_PLAN.md §3.4`.
   Alias **musi pochodzić z trusted config**, nigdy z payloadu notyfikacji.
3. **Wzorce z RA-016 do ponownego użycia, nie duplikowania:** verified webhook
   ingress + durable raw payload + dedupe (`connector-jira/src/webhook/`),
   `putIfNewer` dla out-of-order, watermarks dla reconciliation
   (migracja `026_jira_reconciliation_watermarks`), oraz wzorzec leased tokenu z
   `token.fill(0)` (`connector-jira/src/rest/client.ts`).
4. **Numer migracji:** `026` zajęte, `027` bierze RA-012; RA-013/014/015/017 wezmą
   kolejne. RA-019 bierze następny wolny **po ponownym sprawdzeniu**.
5. **Konflikt allowed paths z RA-020.** Oba taski są semantycznie niezależne
   (`TASK_INDEX.md` §Dependency rationale), ale ich units dotykające migracji i
   `packages/database/src/repositories/index.ts` **muszą być serializowane przez
   koordynatora** — to konflikt zapisu, nie zależność domenowa. Nie kodować go jako
   fałszywej zależności w tabeli kolejki.

## Korekty po red-teamie (z preflightu, do utrzymania)

Te punkty były wynikiem wcześniejszej analizy adwersarialnej i muszą przetrwać
w planie:

1. **`historyId` traktować jako opaque string**, nie liczbę. Google nie gwarantuje
   monotonicznej semantyki numerycznej użytecznej dla porównań; arytmetyka na nim
   jest błędem.
2. **Cursor advancement i event receipt w JEDNEJ transakcji.** Rozdzielenie ich
   daje albo utracone zmiany (cursor przesunięty bez receiptu), albo duplikaty.
3. **Body i attachments sparse by default.** Pobieranie tylko gdy potrzebne, z
   provenance i privacy limits (AC6).
4. **Channel z trusted config**, nie z payloadu.
5. **Zero Gmail/Discord write w tym tasku.**

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-019-WU-01` | `DRAFT` | contracts/config dla dwóch kont + alias boundary | RA-018 DONE |
| `RA-019-WU-02` | `DRAFT` | durable Gmail state: watch, cursor, generation, dedupe | WU-01 |
| `RA-019-WU-03` | `DRAFT` | watch + verified Pub/Sub ingress i renewal | WU-02 |
| `RA-019-WU-04` | `DRAFT` | strict thread/message parser + privacy boundary | WU-01 |
| `RA-019-WU-05` | `DRAFT` | history reconciliation, full resync, read-only routing | WU-03, WU-04 |
| `RA-019-WU-06` | `DRAFT` | final two-account integration proof | WU-05 |

## Wymagania do rozdzielenia na units

- **AC1 (notyfikacja z samym history ID odtwarza zmiany)** → `WU-03` + `WU-05`;
  `history.list` od zapisanego cursora; `historyId` jako opaque.
- **AC2 (duplicate/out-of-order nie duplikują)** → `WU-02` + `WU-05`; dedupe po
  durable kluczu; wzór `putIfNewer`; **cursor + receipt w jednej transakcji**.
- **AC3 (watch odnawiany niezależnie per konto, health status)** → `WU-03`; dwa
  niezależne lifecycle; awaria jednego nie blokuje drugiego.
- **AC4 (lost notification odnaleziona przez reconciliation)** → `WU-05`; wzór
  watermarks z RA-016.
- **AC5 (brak cross-account leakage w obie strony)** → `WU-01`, `WU-04`, `WU-06`;
  **test adwersarialny w obu kierunkach**, nie tylko jednym; alias z trusted config.
- **AC6 (attachment/body nie pobierane ani logowane bez potrzeby i provenance)** →
  `WU-04`; sparse by default; użyć `SecretRedactor` z `packages/observability`.
- **AC7 (invalid cursor → kontrolowany resync bez utraty audit trail)** → `WU-05`;
  staged resync; audit trail zachowany, nie skasowany.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, sondę przecięcia eksportów, skan sekretów w fixtures, oraz
osobno weryfikuje siedem kryteriów akceptacji — w szczególności cross-account
leakage w **obu** kierunkach, atomowość cursor+receipt (mutation test:
rozdzielenie transakcji musi wywalić test) i odporność parsera na prompt injection
w treści maila. Następnie handoff i niezależny audyt.
