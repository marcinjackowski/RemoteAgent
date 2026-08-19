# RA-006 — Handoff 04

## Metadata

- Task: `RA-006`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: OpenCode, rola IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja w working tree
- Zakres: remediacja `AUDIT-03` (HIGH-13, HIGH-14, HIGH-15, MEDIUM-16, MEDIUM-17, MEDIUM-18)

## Wynik

Zamknięto wszystkie findingi `AUDIT-03` bez zmiany zakresu innych tasków. Gateway
nie połyka błędu handlera ani nie commituje applied sequence przed sukcesem;
markery są bounded, collision-resistant i exact-match; żaden bot/interaction token
nie trafia do error/log/detail; intent ma realny owner/fence + lease; markery
mieszczą się w limitach; socket lifecycle jest once/generation-fenced.

## Zrealizowany zakres i uzasadnienie

- HIGH-13 (`gateway-session.ts`): dispatch przeniesiony do kolejki drenowanej
  szeregowo; watermark `lastProcessedSeq` (dedupe + punkt resume) rośnie DOPIERO po
  sukcesie durable handlera. Wyjątek handlera → `halt`, wyczyszczenie kolejki,
  `#forceResume()` (close→reconnect), a RESUME startuje od ostatnio APPLIED seq,
  więc Discord odtwarza nieprzetworzony event i kolejny nie wyprzedza go.
- HIGH-14 (`markers.ts`, `rest-gateway.ts`): marker = `RA-CASE:`/`RA-STATUS:` +
  24-hex SHA-256 pełnego case ID (stała długość niezależnie od 512-char ID,
  collision-resistant). Dopasowanie exact: `bodyHasMarker` (równość całej linii
  subtext), `nameHasMarker` (token `[marker]`), nigdy substring.
- HIGH-15 (`rest-gateway.ts`, `lifecycle.ts`): `#request` redaguje bot token i
  per-call sekrety (interaction token) z message/stack/cause każdego błędu oraz z
  path w `DiscordApiError`; callback używa `redactedPath`. ACK logger emituje tylko
  bezpieczną klasę + status, nigdy message.
- MEDIUM-16 (`repositories/discord.ts`, `dispatcher.ts`, migracja 022): intent ma
  `owner_token` + `lease_expires_at`. Terminale (`succeed`/`markAmbiguous`/
  `markRetryable`) fencowane na owner tokenie; loser widzący aktywnego winnera NIE
  mutuje jego intentu (halt), a tylko provably-abandoned STARTED (wygasły lease)
  jest przez `expireToAmbiguous` (fence po expiry) przenoszony do AMBIGUOUS.
  `succeed` fencowane na owner tokenie + `<> SUCCEEDED`, więc realny wykonawca
  zawsze wygrywa mimo wyścigu.
- MEDIUM-17 (`sanitize.ts`, `dispatcher.ts`, `rest-gateway.ts`): `sanitizeMessage`
  ma `firstLimit`, więc anchor rezerwuje miejsce na marker przed chunkowaniem;
  status renderuje się do `2000 - overhead` przed dodaniem markera; adapter
  `clampToLimit` egzekwuje końcowy limit body (2000) i nazwy wątku (100).
- MEDIUM-18 (`gateway-session.ts`, `ws-factory.ts`): każdy connect ma generację;
  callbacki starego socketu są ignorowane. `#onClose` bumpuje generację (drugi
  close z error+close jest stale), planuje najwyżej jeden reconnect timer; drugi
  `start()` jest no-op. Factory dodatkowo coalesce'uje error+close (once-guard).

## Zmiany

| Ścieżka | Co | Finding |
|---|---|---|
| `apps/discord-bot/src/gateway-session.ts` | kolejka dispatch, watermark po sukcesie, halt+resume, generacje/once, single reconnect | HIGH-13/MEDIUM-18 |
| `apps/discord-bot/src/ws-factory.ts` | once-guard error+close | MEDIUM-18 |
| `apps/discord-bot/src/rest-gateway.ts` | exact marker match, redakcja sekretów, clamp body/name | HIGH-14/15/MEDIUM-17 |
| `apps/discord-bot/src/lifecycle.ts` | ACK logger tylko klasa/kod | HIGH-15 |
| `packages/discord/src/markers.ts` | bounded/hashed/exact markery + helpery | HIGH-14/MEDIUM-17 |
| `packages/discord/src/sanitize.ts` | `firstLimit`, `clampToLimit` | MEDIUM-17 |
| `packages/discord/src/dispatcher.ts` | owner/fence token + lease, rezerwa markera | MEDIUM-16/17 |
| `packages/discord/src/fakes.ts` | hook `onBeforeSendThreadMessage` (winner-in-flight) | test MEDIUM-16 |
| `packages/database/src/repositories/discord.ts` | owner_token/lease, `expireToAmbiguous`, fence terminali | MEDIUM-16 |
| `packages/database/migrations/022_*.sql` | dodanie `owner_token`+`lease_expires_at` (additive) | MEDIUM-16 |

## Kryteria akceptacji

| Kryterium | Status | Dowód |
|---|---|---|
| 1. Brak duplikatów | PASS | exact marker + owner-fenced intent; winner-in-flight test |
| 2. Nieautoryzowany bez danych | PASS | brak regresji (content-free audit) |
| 3. Dwa cases równolegle | PASS | prefix markery rozłączne (case-1 vs case-10) |
| 4. Kolejność po retry/reconnect | PASS | HIGH-13: retry tego samego eventu przed następnym |
| 5. Decision button ID/rev | PASS | strict custom ID (bez zmian) |
| 6. `/stop` tylko wskazany case | PASS | intake z bieżącego threadu (bez zmian) |

## Testy i kontrole

| Komenda | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS (realny PG) |
| `RA_REQUIRE_POSTGRES=1 pnpm test` | 0 | 39/39 plików, 568/568 testów |
| `pnpm build` | 0 | 21/21 (turbo) |
| `pnpm workflow:validate` | 0 | `OK — 26 tasks` |
| `git diff --check` | 0 | clean |

Nowe testy: `markers.test.ts` (prefix/length/exact); `dispatcher.integration`
(winner-in-flight, lease→AMBIGUOUS, boundary 2000/2001, status boundary, 512-char);
`rest-gateway.contract` (marker collision, 512-char name, redakcja non-2xx +
transport error + bot token); `gateway-session` (transient failure→retry→next,
error+close, stale close, double start); `lifecycle` (ACK redakcja).

## Bezpieczeństwo i dane

- Sekrety: bot i interaction token redagowane z message/stack/cause/path; ACK log
  tylko klasa+kod; testy negatywne potwierdzają brak tokenu.
- Idempotencja/recovery: owner/fence + bounded lease; unknown outcome → AMBIGUOUS
  (halt); handler failure → resume/replay, nie połknięcie.
- Migracja 022 additive; down odwraca dokładnie (brak edycji zaaplikowanej).

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Gotowe: pełna remediacja AUDIT-03, cała bramka zielona na realnym PG.
- Nie robić przed audytem: nie zaczynać kolejnego taska, nie zmieniać implementacji.
- Po `continue` (gdyby audyt zażądał zmian): findingi nowego audytu i wskazane
  ścieżki gateway/markers/rest-gateway/dispatcher/repozytorium.
