# RA-006 — Handoff 05

## Metadata

- Task: `RA-006`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: OpenCode, rola IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja w working tree
- Zakres: remediacja `AUDIT-04` (HIGH-19, HIGH-20, MEDIUM-21, MEDIUM-22)

## Wynik

Zamknięto wszystkie cztery findingi `AUDIT-04` bez zmiany zakresu innych tasków.
Gateway Resume zawsze niesie liczbowy applied sequence (także po READY i dla
pierwszego handler failure); transport rejection typu `unknown` jest normalizowany
fail-closed do allowlistowanego błędu bez dowolnych pól; realny holder owner tokenu
zapisuje prawdziwy terminal po observer expiry, a wynik każdej terminal transition
jest sprawdzany; migracja 022 deterministycznie obsługuje legacy STARTED z 021.

## Zrealizowany zakres i uzasadnienie

- HIGH-19 (`gateway-session.ts`): watermark `lastProcessedSeq` jest seedowany z
  sekwencji `READY` (świeża sesja), więc pierwszy event aplikacyjny, który padnie,
  resume'uje od realnej liczby (Discord odtwarza eventy PO niej — czyli ten padły),
  nigdy `seq: null`. `RESUMED` traktowany jak ramka kontrolna (nie domenowy
  dispatch). `#resume()` jest fail-closed: bez liczbowego watermarku dropuje sesję
  i robi Identify zamiast wysyłać niepoprawny Resume.
- HIGH-20 (`rest-gateway.ts`): `redactError` zastąpiony przez
  `normalizeTransportError`, który buduje ŚWIEŻY, allowlistowany błąd niosący tylko
  bezpieczną klasę (`DiscordRateLimitError`/`DiscordUnavailableError` zostają
  retry-safe; każdy inny rejection — string/object/array/custom/unknown — kolapsuje
  do nie-retry `DiscordTransportError`) i redagowany message. Żadne pole oryginału
  (`cause`, `detail`, custom enumerable) nie jest kopiowane, więc credential nie
  przeżywa w `String`/message/stack/`JSON`/detail.
- MEDIUM-21 (`repositories/discord.ts`, `dispatcher.ts`): `markRetryable` i
  `markAmbiguous` fencowane teraz na `owner_token = $ AND status <> 'SUCCEEDED'`
  (nie na `STARTED`), więc prawdziwy holder tokenu nadpisuje observer-expiry
  `AMBIGUOUS` swoim realnym terminalem (`succeed` już to robił). Dispatcher
  sprawdza rezultat każdej transition: `markRetryable=false` lub `succeed=false`
  (przejęcie przez nowy attempt) → halt jako `DiscordAmbiguousError` zamiast
  fałszywego sukcesu; provably-not-delivered write ląduje jako `RETRYABLE`.
- MEDIUM-22 (`022_*.up.sql`/`*.down.sql`): po dodaniu kolumn migracja robi
  deterministyczny, idempotentny backfill `UPDATE ... SET status='AMBIGUOUS'`
  dla legacy `STARTED` (in-flight bez ownera/lease = unknown outcome →
  konserwatywny terminal, halt replay). SUCCEEDED/AMBIGUOUS/RETRYABLE nietknięte
  (RETRYABLE re-ownuje `takeForRetry`). Down odwraca schemat; jednokierunkowa
  transition bezpieczeństwa jest udokumentowana i nieodwracana.

## Zmiany

| Ścieżka | Co | Finding |
|---|---|---|
| `apps/discord-bot/src/gateway-session.ts` | READY seed watermarku, RESUMED kontrolny, fail-closed `#resume` | HIGH-19 |
| `apps/discord-bot/src/rest-gateway.ts` | `normalizeTransportError` (allowlist, drop pól) | HIGH-20 |
| `packages/database/src/repositories/discord.ts` | fence terminali `owner_token + <> SUCCEEDED` | MEDIUM-21 |
| `packages/discord/src/dispatcher.ts` | sprawdzanie rezultatu terminal transition, fail-closed | MEDIUM-21 |
| `packages/database/migrations/022_*.up.sql/.down.sql` | backfill legacy STARTED → AMBIGUOUS | MEDIUM-22 |

## Kryteria akceptacji

| Kryterium | Status | Dowód |
|---|---|---|
| 1. Brak duplikatów | PASS | brak regresji (owner-fenced intent, exact marker) |
| 2. Nieautoryzowany bez danych | PASS | brak regresji |
| 3. Dwa cases równolegle | PASS | brak regresji |
| 4. Kolejność po retry/reconnect | PASS | HIGH-19: resume z liczbowym seq odtwarza padły event |
| 5. Decision button ID/rev | PASS | bez zmian |
| 6. `/stop` tylko wskazany case | PASS | bez zmian |

## Testy i kontrole

| Komenda | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS (realny PG) |
| `RA_REQUIRE_POSTGRES=1 pnpm test` | 0 | 39/39 plików, 577/577 testów |
| `pnpm build` | 0 | 21/21 (turbo) |
| `pnpm workflow:validate` | 0 | `OK — 26 tasks` |
| `git diff --check` | 0 | clean |

Nowe testy: `gateway-session` (HIGH-19: exact numeric `d.seq`=1 po READY+failure,
przejście przez INVALID_SESSION i recovery przez Identify); `rest-gateway.contract`
(HIGH-20: string/custom-enumerable/plain-object+array/nested rejection + zachowanie
klasy Unavailable/RateLimit, zero tokenu w String/message/stack/JSON/detail);
`dispatcher.integration` (MEDIUM-21: expiry + safe failure → RETRYABLE; expiry +
success → SUCCEEDED, jeden send); `migrations.integration` (MEDIUM-22: 021→022 z
danymi dla każdego statusu, STARTED→AMBIGUOUS, kolumny NULL dla legacy).

## Bezpieczeństwo i dane

- Sekrety: transport rejection normalizowany do świeżego błędu bez pól oryginału;
  testy negatywne dla string/object/array/nested/custom potwierdzają brak tokenu.
- Idempotencja/recovery: realny owner zawsze zapisuje prawdziwy terminal; brak
  fałszywego AMBIGUOUS dla provably-not-delivered; resume zawsze z liczbowym seq.
- Migracja 022 additive + deterministyczny backfill; down odwraca schemat.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Gotowe: pełna remediacja AUDIT-04, cała bramka zielona na realnym PG.
- Nie robić przed audytem: nie zaczynać kolejnego taska, nie zmieniać implementacji.
- Po `continue` (gdyby audyt zażądał zmian): findingi nowego audytu i wskazane
  ścieżki gateway-session/rest-gateway/dispatcher/repozytorium/migracja 022.
