# RA-020 — Work units

## Metadata

- Task: `RA-020`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES`. Zależności `DONE`:
  RA-002, RA-003, RA-004, RA-005, RA-006. Niedokończona: RA-018.
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-calendar/test`

## Global boundaries

- In scope: read-only synchronizacja dwóch kont Google Calendar, watch lifecycle,
  sync token semantics, recurrence i routing do Discorda.
- Out of scope: automatyczne tworzenie/usuwanie wydarzeń, produkcyjne Google MCP
  (RA-021). **Zero write do Calendara i zero bezpośredniego write do Discorda** —
  routing przez outbox.
- Treść wydarzeń (tytuły, opisy, zaproszenia) jest `UNTRUSTED_DATA`.
- **Private i SonderMind rozdzielone w DB, kontekście i Discordzie.**

## Ustalenia z kodu przed planowaniem (2026-08-20)

1. **`packages/connector-calendar` to sam szkielet z RA-001.** Cała domena do
   napisania.
2. **Aliasy `private`/`sondermind` i `connectionAliasSchema` już istnieją** w
   `packages/contracts/src/connection.ts`. Alias z trusted config, nie z payloadu.
3. **Wzorce z RA-016 do ponownego użycia:** verified ingress + durable raw payload,
   `putIfNewer` dla ordering, watermarks dla reconciliation, leased token z
   `token.fill(0)`.
4. **Numer migracji:** `026` zajęte, `027` bierze RA-012. RA-020 bierze następny
   wolny **po ponownym sprawdzeniu**.
5. **Konflikt allowed paths z RA-019** — oba taski są semantycznie niezależne, ale
   ich units dotykające migracji i `repositories/index.ts` muszą być serializowane
   przez koordynatora. To konflikt zapisu, nie zależność domenowa.

## Korekty po red-teamie (z preflightu, do utrzymania)

1. **Cursor jest per owner/connection/account/calendar** — nie jeden globalny.
   Kolekcja i konto mają własny lifecycle (AC2).
2. **`syncToken` i `pageToken` mają RÓŻNE lifecycle.** `pageToken` żyje w obrębie
   jednej paginowanej odpowiedzi; `syncToken` jest trwałym kursorem. Pomieszanie ich
   to klasyczny błąd tej integracji — traktować jako osobne pojęcia w kontrakcie.
3. **Channel token i sync token NIE mogą być model-facing.** To materiał
   uwierzytelniający/kursorowy, nie dane dla modelu.
4. **HTTP 410 → staged resync**, audytowalny, bez mieszania danych (AC3).
5. **Notyfikacje są bodyless** — służą wyłącznie jako trigger, nigdy jako źródło
   danych o zmianie (AC1).
6. **Normalizacja recurrence/timezone/cancellation musi być czystą funkcją** —
   testowalną bez sieci i bez bazy. DST i cancellation to najgęstsze miejsce na
   błędy.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-020-WU-01` | `DRAFT` | contracts + privacy boundary | RA-018 DONE |
| `RA-020-WU-02` | `DRAFT` | durable schema/repositories (cursor per kolekcja) | WU-01 |
| `RA-020-WU-03` | `DRAFT` | read-only Calendar OAuth client | WU-01 |
| `RA-020-WU-04` | `DRAFT` | verified bodyless notification ingress | WU-02 |
| `RA-020-WU-05` | `DRAFT` | watch lifecycle i renewal z bezpiecznym overlapem | WU-04 |
| `RA-020-WU-06` | `DRAFT` | czysta normalizacja recurrence/timezone/cancellation | WU-01 |
| `RA-020-WU-07` | `DRAFT` | atomic incremental/full sync + staged resync po 410 | WU-03, WU-05, WU-06 |
| `RA-020-WU-08` | `DRAFT` | read-only Discord routing przez outbox | WU-07 |
| `RA-020-WU-09` | `DRAFT` | final two-account E2E i recovery proof | WU-08 |

Dziewięć units to więcej niż w innych taskach, celowo: recurrence/timezone i
watch overlap to niezależne zachowania z odrębnymi bramkami testowymi, a łączenie
ich złamałoby limit „jeden rezultat, najwyżej trzy kryteria".

## Wymagania do rozdzielenia na units

- **AC1 (bodyless notification → właściwy incremental sync)** → `WU-04` + `WU-07`.
- **AC2 (każda kolekcja/konto ma własny cursor i watch lifecycle)** → `WU-02`,
  `WU-05`.
- **AC3 (HTTP 410 → audytowalny full resync bez mieszania danych)** → `WU-07`.
- **AC4 (overlap stary/nowy watch nie tworzy duplikatów)** → `WU-05`; test z
  jednoczesnym aktywnym starym i nowym kanałem.
- **AC5 (recurring instance update/cancel → właściwy series/event case)** →
  `WU-06` + `WU-07`; testy DST i cancellation.
- **AC6 (private i SonderMind rozdzielone w DB, context, Discordzie)** → `WU-01`,
  `WU-08`, `WU-09`; **test adwersarialny w obu kierunkach**.
- **AC7 (utracona notification wykrywana przez reconciliation)** → `WU-07`.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, sondę przecięcia eksportów, skan sekretów, oraz osobno
weryfikuje siedem kryteriów akceptacji — w szczególności cross-account leakage w
obu kierunkach, brak `syncToken`/channel token w powierzchni model-facing, overlap
watch bez duplikatów oraz recurrence/DST/cancellation. Następnie handoff i
niezależny audyt.
