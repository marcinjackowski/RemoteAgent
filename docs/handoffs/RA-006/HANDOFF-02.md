# HANDOFF-02 — RA-006 Discord case interface (remediacja AUDIT-01)

## Metadata

- Task: RA-006 Discord case interface
- Mode: IMPLEMENTER
- Handoff: HANDOFF-02
- Milestone: M1
- Status change: `IN_PROGRESS` -> `AWAITING_AUDIT`
- Zakres: remediacja wszystkich findingów `AUDIT-01` (HIGH-01, HIGH-02, HIGH-03,
  MEDIUM-04, MEDIUM-05, MEDIUM-06). Bez zmiany zaakceptowanych kontraktów
  RA-001..RA-005.
- Zmiana kontraktów: TAK (addytywna). Nowa migracja `021`, nowe repozytorium
  `DiscordSendIntentRepository` + kolumna `last_status_revision`, nowy produkcyjny
  adapter Discord w `apps/discord-bot`. Nic z RA-001..RA-005 nie zostało zmienione
  ani usunięte.

## Mapowanie findingów AUDIT-01 na zmiany i testy

### HIGH-01 — automatyczny replay niepotwierdzonego Discord write

- Zmiana: trwały per-side-effect intent ledger. Migracja
  `021_discord_send_intents.up.sql` dodaje `discord_send_intents`
  (`idempotency_key = <outbox_id>:<step>`, status `STARTED|SUCCEEDED|AMBIGUOUS`)
  realizujący maszynę run-safety z Master Plan §6.2. Repozytorium
  `DiscordSendIntentRepository` (`packages/database/src/repositories/discord.ts:233`,
  `begin/find/succeed/clear/markAmbiguous`).
- `dispatcher.ts:481 #durableSideEffect`: commit `STARTED` PRZED każdym
  nieodwracalnym write (chunki root i thread message), po sukcesie `SUCCEEDED`.
  Odzyskany `STARTED` o nieznanym wyniku → `markAmbiguous` +
  `DiscordAmbiguousError` (halt replay, dead-letter do `#system`). Tylko dowodliwie
  bezpieczny błąd (`isSafeToRetry`) czyści intent i pozwala na czysty retry
  (`dispatcher.ts:521-536`).
- Adapter klasyfikuje wynik konserwatywnie (`rest-gateway.ts:197-216`): 429 →
  `DiscordRateLimitError` (retry), transport-level pre-response → `DiscordUnavailableError`
  (safe), każdy inny non-2xx → `DiscordApiError` (UNKNOWN, brak auto-replay).
- Testy: `packages/discord/test/dispatcher.integration.test.ts` (13 testów) —
  response-lost / crash-po-side-effekcie / awaria między chunkami → AMBIGUOUS bez
  duplikatu; `rest-gateway.contract.test.ts` (7) — klasyfikacja 429/5xx/transport.

### HIGH-02 — routing niezwiązany z autorytatywnym bindingiem case

- Zmiana: routing jest server-side i fail-closed. `#assertAuthoritativeRoute`
  (`dispatcher.ts:583`) porównuje `binding.owner_id` i `binding.channel_id` z trasą
  wyliczoną z payloadu — przed `ensure` i ponownie pod row-lockiem
  (`dispatcher.ts:210`, `:225`). `ensure` ustawia kanał wyłącznie przy pierwszym
  utworzeniu; niezgodność → `DiscordRoutingError` (non-retryable), więc replay/
  altered payload nie opublikuje treści w cross-account kanale.
- Testy: `dispatcher.integration.test.ts` — mismatch private↔SonderMind i istniejący
  binding bez threadu (real-PG); `packages/discord/test/channels.test.ts` (4) —
  rozłączny routing provider+alias.

### HIGH-03 — brak produkcyjnego adaptera i uruchamialnego bota

- Zmiana: dodano produkcyjny adapter REST + gateway lifecycle w `apps/discord-bot`:
  - `rest-gateway.ts` — `DiscordRestGateway implements DiscordGateway` z
    wstrzykiwanym `RestTransport` (produkcja: `fetch-transport.ts`; testy: recorded,
    zredagowane fixtures bez sieci i tokenu);
  - `gateway-session.ts` — `DiscordGatewaySession`: pełna maszyna WS
    Hello→Identify/Resume→Heartbeat→Dispatch z bounded-backoff reconnect i resume;
    token nigdy nie trafia do loggera;
  - `intents.ts` — zadeklarowane minimalne intents (`GUILDS`, `GUILD_MESSAGES`,
    `MESSAGE_CONTENT`) i permissions (least-privilege, poza modelem);
  - `lifecycle.ts` + `index.ts` (`createDiscordBot`) — composition root inbound/
    outbound, mapowanie surowych dispatchy na `InboundInteraction`.
- Testy: `apps/discord-bot/test/rest-gateway.contract.test.ts` (7),
  `gateway-session.test.ts` (1), `lifecycle.test.ts` (5) — wszystkie bez sieci/tokenu.

### MEDIUM-04 — denied inbound jako trwały audyt

- Zmiana: `packages/discord/src/inbound-audit.ts` (`processInbound`) zapisuje
  content-free denial do append-only audit logu (`AuditLogRepository.record`) PRZED
  zwrotem, niezależnie od ścieżki ack. `DeniedAudit.detail` niesie wyłącznie id +
  reason (brak body/komponentów). Wpięte w produkcyjny inbound przez
  `lifecycle.ts:97 createInboundDispatchHandler`.
- Testy: `packages/discord/test/inbound-audit.integration.test.ts` (real-PG) —
  content-free denial row bez body/sekretu; `authorization.test.ts` (4),
  `intake.test.ts` (6).

### MEDIUM-05 — spóźniony status cofa pinned projection

- Zmiana: monotoniczny revision gate pod row-lockiem. Migracja `021` dodaje
  `discord_case_bindings.last_status_revision`; `advanceStatusRevision`
  (`repositories/discord.ts:207`) awansuje tylko gdy `revision` jest ściśle większa.
  `dispatcher.ts:368 #deliverStatus` cały status upsert wykonuje pod jednym
  lockiem: starsza-lub-równa rewizja to deterministyczny no-op z receiptem, nowsza
  atomowo edytuje pinned message i awansuje rewizję.
- Testy: `dispatcher.integration.test.ts` — delivery 2→1 nie cofa projekcji;
  reconnect/duplicate; `packages/discord/test/status.test.ts` (2).

### MEDIUM-06 — root body >2000 znaków cicho obcinane

- Zmiana: `#deliverRootThread` sanityzuje pełną treść (`sanitizeMessage`), anchor
  niesie pierwszy chunk, a dalsze chunki są wysyłane jako continuation przez
  `#sendChunks`/`#durableSideEffect` (`dispatcher.ts:264-274`), każdy za trwałym
  intentem — nic nie ginie. Analogicznie thread message (`dispatcher.ts:332-343`).
- Testy: `dispatcher.integration.test.ts` — body >2000 znaków dostarczone w wielu
  chunkach; `packages/discord/test/sanitize.test.ts` (6).

## Kluczowe elementy wymienione przez zlecenie

- Migracja `021`: `packages/database/migrations/021_discord_send_intents.{up,down}.sql`
  (intent ledger + `last_status_revision`, addytywna nad `020`, ADR-0002).
- Adapter REST / gateway lifecycle: `apps/discord-bot/src/{rest-gateway,fetch-transport,
  gateway-session,lifecycle,intents,index}.ts`.
- Trwały denied audit: `packages/discord/src/inbound-audit.ts` +
  `lifecycle.ts` composition, dowód real-PG w `inbound-audit.integration.test.ts`.

## Testy i dowody

- Komenda: `RA_REQUIRE_POSTGRES=1 pnpm test` — 36 plików / 524 testy passed
  (baseline HANDOFF-01: 32/503; +4 pliki / +21 testów remediacji).
- Komenda: `pnpm build` — 21/21 successful (turbo).
- Komenda: `pnpm workflow:validate` — `OK — 26 tasks`, exit 0.
- Komenda: `git diff --check` — clean, exit 0.

## Bezpieczeństwo / izolacja / recovery

- Sekrety: token trzymany w adapterze REST/gateway, dołączany jako
  `Authorization`; nigdy nie logowany ani nie zwracany do modelu. Fixtures i fake są
  in-memory, bez sekretów.
- Izolacja kont: fail-closed authoritative route (HIGH-02) uniemożliwia cross-account
  publikację; routing provider+alias rozłączny.
- Recovery/idempotencja: intent ledger + reconcile threadu/status message + fenced
  `advanceDelivered`/`advanceStatusRevision`. Niepotwierdzony write → `AMBIGUOUS`
  (halt), nie `SUCCESS` (Master Plan §6.2, zasady dowodowe).

## Ryzyka i świadome trade-offy

- Status upsert biegnie w całości pod per-case row-lockiem (bounded, pojedyncza
  edycja). Przy długich sieciowych opóźnieniach wielo-procesowy worker mógłby chcieć
  krótszego okna locka — świadomy trade-off na rzecz atomowego monotonic gate.
- `AMBIGUOUS` zatrzymuje automatyczny replay i wymaga interwencji operatora
  (`#system`); to celowe fail-closed zachowanie zamiast ryzyka duplikatu write.
- Reconcile per-message (poza thread/status) nie jest możliwy bez idempotency key po
  stronie Discorda; dlatego pojedyncze chunki są chronione trwałym intentem, a nie
  reconcile — zgodne z modelem at-least-once RA-004.

## Kolejny krok

RA-006 czeka na niezależny audyt remediacji. Żaden następny task nie został
rozpoczęty (reguła jednego taska na przebieg).
