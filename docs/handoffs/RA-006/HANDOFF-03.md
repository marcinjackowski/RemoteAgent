# RA-006 — Handoff 03

## Metadata

- Task: `RA-006`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: OpenCode, rola IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja w working tree
- Końcowy stan working tree: remediacja `AUDIT-02` (HIGH-07, HIGH-08, MEDIUM-10, MEDIUM-11, MEDIUM-12)

## Wynik

Zamknięto wszystkie findingi `AUDIT-02`. Produkcyjny adapter Discord ma teraz
deterministyczną recovery/idempotencję, atomowy fencing claimu send intentu,
uporządkowany i deduplikowany gateway reconnect, uruchamialny bot interakcji z
ACK oraz append-only evidence ledger. AC1 i AC4 są ponownie spełnione bez
regresji pozostałych kryteriów.

## Zrealizowany zakres

- HIGH-07: transport-level failure po starcie requestu klasyfikowany jako
  UNKNOWN/AMBIGUOUS (brak auto-replay bez dowodu braku delivery); root creation z
  trwałym deterministycznym markerem i recovery obejmującą orphan anchor + oba
  POST-y z paginowanym lookupem; `createRootThread` propaguje `caseTag`;
  status message ma własny trwały intent, jednoznaczny marker + author identity i
  recovery także przed pinem.
- HIGH-08: claim intentu zwraca atomowo, czy bieżąca transakcja wstawiła rekord
  (insert-do-nothing z rozróżnionym rezultatem); przejścia terminalne (`succeed`,
  `markAmbiguous`) mają fencing na oczekiwany stan/token właściciela — tylko
  zwycięzca wykonuje write.
- MEDIUM-10: dispatch serializowany w kolejności `s`, deduplikacja zastosowanych
  sequence po resume, obsługa HEARTBEAT_ACK/zombie detection oraz klas close code
  (fatal stop, non-resumable identify, resumable resume).
- MEDIUM-11: konkretna produkcyjna fabryka WebSocket + env/composition
  entrypoint; `INTERACTION_CREATE` zachowuje interaction id/token i wysyła
  wymagany defer/ACK w limicie.
- MEDIUM-12: bezpieczny błąd zachowuje retryable/failed-safe stan i attempt
  evidence (append-only) zamiast `DELETE`; wszystkie nieidempotentne write objęte
  intentem; handoff/runbook skorygowane do realnego DLQ/operator notification.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `apps/discord-bot/src/fetch-transport.ts`, `rest-gateway.ts` | UNKNOWN dla utraty odpowiedzi; caseTag w thread body; paginowany reconcile | HIGH-07 |
| `packages/discord/src/dispatcher.ts` | intent dla root/status; author-marker reconcile; fenced terminale | HIGH-07/08/12 |
| `packages/database/src/repositories/discord.ts` | atomowy claim insert-do-nothing; fencing; append-only attempt evidence | HIGH-08/12 |
| `apps/discord-bot/src/gateway-session.ts` | serializacja+dedupe sequence; ACK/zombie; close codes | MEDIUM-10 |
| `apps/discord-bot/src/{index,lifecycle}.ts` | produkcyjna socket factory; interaction ACK/defer | MEDIUM-11 |

## Decyzje i uzasadnienie

Utrata odpowiedzi transportu jest fail-closed jako AMBIGUOUS zgodnie z zasadami
dowodowymi (side effect bez receiptu nie jest SUCCESS). Fencing claimu oparto na
atomowym insert zamiast find+upsert, by dwa równoległe claimy nie uznały się oba
za świeże. Gateway serializuje dispatch, bo fire-and-forget odwracał kolejność.
Evidence ledger jest append-only zamiast DELETE, by operator miał pełną historię
retry/AMBIGUOUS.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Ten sam outbox event nie tworzy duplikatów | PASS | atomowy claim + intent dla root/status + reconcile (HIGH-07/08) |
| 2. Nieautoryzowany ignorowany i audytowany bez danych | PASS | content-free denied audit (bez regresji) |
| 3. Dwa cases równolegle | PASS | per-case binding locks |
| 4. Kolejność po retry/reconnect | PASS | serializacja+dedupe sequence (MEDIUM-10) |
| 5. Decision button związany z decision ID i revision | PASS | strict custom ID |
| 6. `/stop` tylko wskazany case | PASS | intake z bieżącego threadu |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS; realny PostgreSQL |
| `pnpm test` | 0 | 38/38 plików, 548/548 testów passed |
| `pnpm build` | 0 | 21/21 successful (turbo) |
| `pnpm workflow:validate` | 0 | `OK — 26 tasks` |
| `git diff --check` | 0 | clean |

## Snapshoty i artefakty

- Artefakt/ścieżka: brak nowych snapshotów poza kodem RA-006.
- Czy snapshot się zmienił i dlaczego: nie.

## Bezpieczeństwo i dane

- Dostęp do sekretów: token wyłącznie w adapterze REST/gateway; nigdy nie
  logowany ani nie zwracany do modelu; fixtures in-memory bez sekretów.
- Izolacja kont/scope: fail-closed authoritative route uniemożliwia
  cross-account publikację.
- Side effecty i idempotencja: intent ledger + fenced claim/terminale +
  reconcile threadu/status; niepotwierdzony write → AMBIGUOUS (halt).
- Dane zewnętrzne: payloady Discord traktowane jako UNTRUSTED_DATA.

## Znane ograniczenia i ryzyka

- Status upsert biegnie pod per-case row-lockiem (bounded) — świadomy trade-off
  na rzecz atomowego monotonic gate.
- AMBIGUOUS wymaga interwencji operatora (DLQ/`#system`) zamiast auto-replay.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: pełna remediacja AUDIT-02, wszystkie testy zielone.
- Czego nie robić przed audytem: nie rozpoczynać kolejnego taska, nie zmieniać
  implementacji.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: findingi nowego audytu i
  wskazane ścieżki adaptera/dispatchera/repozytorium.
