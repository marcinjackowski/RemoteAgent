# HANDOFF-01 — RA-006 Discord case interface

## Metadata

- Task: RA-006 Discord case interface
- Mode: IMPLEMENTER
- Handoff: HANDOFF-01
- Milestone: M1
- Status change: `IN_PROGRESS` -> `AWAITING_AUDIT`
- Scope: pełna, pierwsza implementacja RA-006 (brak wcześniejszych handoffów/audytów).
- Zmiana kontraktów: TAK (addytywna). Nowy pakiet `@remoteagent/discord`, nowa
  migracja 020, nowe repozytoria w `@remoteagent/database`, nowe zależności
  workspace w `apps/discord-bot`. Żaden zaakceptowany kontrakt RA-001..RA-005 nie
  został zmieniony ani usunięty.

## Zakres wykonany (Scope z RA-006)

- **Bot z owner/guild allowlist i minimalną autoryzacją** — `authorization.ts`
  + `channels.ts`. Autoryzacja jest deterministyczna i wykonywana poza modelem
  (AGENTS.md §6): guild == skonfigurowany guild, user == owner, kanał musi być
  skonfigurowany albo być threadem znanego case.
- **Konfiguracja kanałów z Master Planu** — `ChannelRegistry` z kanałami
  `#jira, #gmail-private, #gmail-sondermind, #calendar-private,
  #calendar-sondermind, #gitlab, #system`; routing provider+alias trzyma konta
  `private`/`sondermind` rozłącznie (Master Plan §3.4).
- **Idempotentne publikowanie root message przez outbox** — `dispatcher.ts`
  konsumuje transactional outbox (RA-004) i zapisuje receipt keyed by `outbox_id`
  pod row-lockiem bindingu; redelivery jest no-opem (criterion 1).
- **Tworzenie, odnajdywanie i ponowne otwieranie threadów** —
  `DiscordGateway.findCaseThread` (reconcile po deterministycznym case tagu) czyni
  tworzenie threadu idempotentnym mimo crashu między side-effectem a commitem;
  archiwalny thread jest odarchiwizowany przed publikacją (criterion 4 / scope).
- **Trwałe mapowanie case <-> channel/thread/message** — migracja 020
  (`discord_case_bindings`) + repozytorium `DiscordBindingRepository`.
- **Odbiór wiadomości, komend, przycisków decision/approval i `/stop`** —
  `intake.ts` (`handleInbound`). `/stop` dotyczy wyłącznie case threadu, w którym
  został wywołany (criterion 6). Przyciski niosą `custom_id` z decision/approval id
  + checkpoint revision (criterion 5, `custom-id.ts`).
- **Pinned/projected case status message** — `status.ts` + gałąź `STATUS_UPSERT`
  dispatchera (create-then-edit, pin idempotentny).
- **Rate-limit handling, retry, sanitizacja długości/formatowania** — `retry.ts`
  (honoruje 429 `retryAfterMs`), `sanitize.ts` (limity 2000/100 znaków, chunking,
  neutralizacja `@everyone/@here` i raw mentions dla UNTRUSTED_DATA).
- **Fake orchestrator do testów bez Bedrocka** — `fakes.ts`
  (`FakeDiscordGateway`, `FakeOrchestrator`).

Out of scope (zgodnie z taskiem): logika modelu, prawdziwe integracje, wykonanie
external actions. `apps/discord-bot` zawiera tylko composition root
(`discordOutboxSink`) — konkretny gateway discord.js jest wstrzykiwany przez
deployment i nie jest częścią RA-006.

## Architektura i decyzje inżynierskie

### Idempotencja (criterion 1)

`discord_dispatch_receipts` to append-only ledger keyed by `dedupe_key`
(`outbox_id`). Dispatcher sprawdza receipt pod `FOR UPDATE` lockiem bindingu
PRZED jakimkolwiek side-effectem, więc at-least-once outbox nigdy nie tworzy
drugiej wiadomości/threadu. Tworzenie threadu dodatkowo reconciluje istniejący
thread po case tagu (`findCaseThread`), co domyka okno crash-po-side-effekcie.

### Ordering (criterion 4) — rozdzielone liczniki assign/deliver

`discord_case_bindings.next_seq` to sekwencja rezerwowana przez PRODUCENTA przy
enqueue (pod row-lockiem), `delivered_seq` to najwyższa dostarczona sekwencja.
Dispatcher dostarcza tylko gdy `seq == delivered_seq + 1`; claim poza kolejnością
(możliwy po retry/reconnect) jest DEFEROWANY (`DiscordDeferredError`, rethrow do
relayu) zamiast reorderowany. Różne case blokują różne wiersze bindingu, więc
pracują równolegle (criterion 3). Unikatowy indeks `(case_id, seq)` gwarantuje
brak duplikatu slotu.

### Autoryzacja i brak wycieku treści (criterion 2, audit focus)

`authorizeInbound` odrzuca zły guild/user/kanał/thread fail-closed; `deniedAudit`
buduje rekord audytu BEZ treści wiadomości (tylko id + reason). Testy weryfikują,
że serializacja denied-audit nie zawiera treści.

### Binding decyzji do id + rewizji (criterion 5)

`custom_id` koduje `(version, kind, decisionId|approvalId, checkpoint_revision,
optionId|choice)` z URI-encodowaniem pól (id z `:` nie sfałszuje pól) i limitem
100 znaków (fail-closed przy przekroczeniu). `decodeInteraction` odrzuca obce/
zmanipulowane id (zwraca `null`). Downstream porówna rewizję z aktualnym
checkpointem (`assertAnswerMatchesRequest` w `@remoteagent/contracts`).

## Pliki

- `packages/database/migrations/020_discord_case_interface.up.sql` / `.down.sql`
- `packages/database/src/repositories/discord.ts` (+ eksport w `index.ts`)
- `packages/discord/**` (nowy pakiet: gateway, channels, authorization, sanitize,
  custom-id, messages, retry, status, dispatcher, intake, fakes, index)
- `apps/discord-bot/src/index.ts` (+ `package.json` zależności)
- `docs/tasks/TASK_INDEX.md` (status RA-006)

## Testy i dowody

- Komenda: `RA_REQUIRE_POSTGRES=1 pnpm check` — exit 0
  (lint + format + typecheck + test + build + workflow:validate).
- Komenda: `RA_REQUIRE_POSTGRES=1 pnpm test` — exit 0; 32 pliki / 503 testy
  (baseline było 24/463; +8 plików / +40 testów RA-006).
- Build: 21/21 (turbo).
- Komenda: `git diff --check` — clean.
- Komenda: `pnpm workflow:validate` — `OK — 26 tasks`.

### Pokrycie acceptance criteria

- **AC1** (idempotencja): `dispatcher.integration` — redelivery root+message →
  `duplicate`, `createThreadCalls == 1`, brak duplikatu wiadomości; reconcile
  istniejącego threadu przy crashu → `createThreadCalls == 1`.
- **AC2** (autoryzacja bez danych): `authorization.test`, `intake.test` — odrzucenie
  wrong_guild/not_owner/unknown_channel/unknown_thread; denied-audit content-free.
- **AC3** (równoległe case): `dispatcher.integration` — dwa case, interleaved
  delivery, osobne thready, brak cross-contamination.
- **AC4** (ordering): `dispatcher.integration` — seq poza kolejnością defer,
  dostarczenie w kolejności producenta po root/seq2/seq3; reconnect (świeży
  gateway) dedupe po receipt; archived thread reopen.
- **AC5** (decision button binding): `custom-id.test`, `intake.test` — encode/decode
  id+revision+option, odrzucenie tamperu/obcego id, limit 100 znaków.
- **AC6** (`/stop` jeden case): `intake.test` — `/stop` w threadzie → dokładnie ten
  case; w kanale → ignored (nigdy broadcast).

### Required verification (RA-006)

- Contract/adapter testy z fake gateway bez sekretów: `FakeDiscordGateway`
  (in-memory, brak sieci/sekretów).
- Reconnect / duplicate delivery / archived thread / rate limit: pokryte w
  `dispatcher.integration`.
- Integration fake event -> thread -> owner response: test „fake event → thread →
  authorized owner response” (outbox relay → dispatcher → `handleInbound`).

## Bezpieczeństwo / izolacja / recovery

- Sekrety: brak. `FakeDiscordGateway` i fixtures są in-memory; konkretny gateway
  discord.js i tokeny są poza zakresem RA-006 (wstrzykiwane w deployment).
- Izolacja kont: routing provider+alias trzyma `private`/`sondermind` rozłącznie
  (test `channels`).
- Idempotencja/recovery: receipt ledger + reconcile threadu + fenced
  `advanceDelivered`; side-effect bez potwierdzonego receiptu nie awansuje
  `delivered_seq` (rollback → retry tego samego slotu).
- Discord limits: 2000 (message), 100 (thread name, custom_id), chunking i
  truncation z markerem.

## Ryzyka i świadome trade-offy

- Dispatcher trzyma krótką transakcję DB otwartą podczas wywołania gateway. Jest
  to poprawne (per-case row-lock serializuje jeden case, różne case równolegle),
  ale zakłada, że pojedynczy send jest krótki; przy dłuższych sieciowych opóźnieniach
  wielo-procesowy worker (późniejszy task) może chcieć krótszego okna lock →
  send → receipt. Świadomy trade-off na rzecz prostej, dowiedlnej idempotencji.
- Okno crash-po-udanym-sendzie-przed-commitem dla `sendThreadMessage` (nie dla
  tworzenia threadu, które reconciluje) może przy redelivery wysłać duplikat
  chunku pojedynczej wiadomości. Zgodne z modelem at-least-once RA-004; dedupe
  całej wiadomości jest po `outbox_id`. Reconcile per-message nie jest możliwy bez
  idempotency key po stronie Discorda.
- Ordering zakłada, że producent rezerwuje gap-free `seq` (robi to
  `FakeOrchestrator`; realni producenci użyją `reserveSeq` bindingu). Brakująca
  sekwencja deferuje delivery (retry), nie reorderuje.

## Kolejny krok

RA-006 czeka na niezależny audyt. RA-007 i RA-010 (również zlecone przez
użytkownika) NIE zostały rozpoczęte — reguła jednego taska na przebieg.
