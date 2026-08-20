# RA-016 — Work units

## Metadata

- Task: `RA-016`
- Plan revision: `11`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `ACTIVE`
- Base commit/tree: `d2cf056c07f90a6093400011a5dc4c1a734ef4a7`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test`

## Global boundaries

- In scope: read-only Jira Cloud ingress, normalization, enrichment, correlation,
  webhook lifecycle i reconciliation.
- Out of scope: agent-authored Jira mutations, Atlassian MCP writes i GitLab.
- Connection, owner, project allowlist i routing są autorytatywne poza payloadem.
- Jira text pozostaje `UNTRUSTED_DATA`; credential values nie wchodzą do kontraktów.
- Sol weryfikuje aktualne zachowanie Jira Cloud wyłącznie w oficjalnej
  dokumentacji Atlassian przed units dotykającymi auth/webhook/REST.
- Luna nie edytuje planu, statusów, handoffów, audytów ani decyzji.

## Zweryfikowany kontrakt Jira Cloud — 2026-08-20

- Docelowy wariant to OAuth 2.0 dynamic webhooks z `POST /rest/api/3/webhook`,
  zgodny z wymaganym przez Master Plan cyklem odnowienia. Admin webhook/HMAC nie
  jest domyślnym fallbackiem i wymagałby jawnej zmiany konfiguracji/decyzji.
- OAuth webhook niesie bearer JWT w `Authorization`, podpisany client secretem
  aplikacji. WU-02 używa sprawdzonej biblioteki i secret-ref/vault boundary;
  token ani client secret nie wchodzą do publicznej konfiguracji lub logów.
- Dynamiczne webhooks wygasają po 30 dniach i są przedłużane przez
  `PUT /rest/api/3/webhook/refresh`; limit OAuth to 5 webhooks na
  app/user/tenant. Scheduler odnawia przed deadline, nie po stałym założeniu.
- Jira zaleca szybką odpowiedź i asynchroniczne enqueue. Delivery jest best
  effort, dlatego reconciliation z WU-07 pozostaje obowiązkowe.
- JQL ogranicza dynamiczne issue/comment webhooks server-side, ale lokalny
  project allowlist nadal jest twardą granicą przed enrichment.
- WU-04 używa wyłącznie `GET /rest/api/3/issue/{issueIdOrKey}` z jawnym
  allowlistem pól oraz `GET /rest/api/3/search/jql` dla tokenowej paginacji.
  Wycofywane endpointy `/rest/api/3/search` nie są dozwolone.
- Enhanced JQL zwraca token `nextPageToken`; klient ogranicza liczbę stron,
  elementów i powtórzenie tokenu. Jira zaznacza, że search może być opóźniony,
  więc reconciliation nie traktuje odpowiedzi search jako nowszej od snapshotu
  issue tylko z powodu czasu pobrania.
- Odpowiedź `429` jest ponawiana wyłącznie w ograniczonym budżecie i respektuje
  `Retry-After`; także `503` może nieść ten nagłówek. Opóźnienie, clock i jitter
  są wstrzykiwane, żeby testy nie spały ani nie zależały od zegara ściennego.
- Źródła: [Atlassian Jira Cloud webhooks](https://developer.atlassian.com/cloud/jira/software/webhooks/)
  oraz [Jira REST v3 webhooks](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/).

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-016-WU-01` | `ACCEPTED` | wersjonowane kontrakty i bezsekretowa konfiguracja | — |
| `RA-016-WU-02` | `ACCEPTED` | zweryfikowany durable webhook ingress i dedupe | WU-01 |
| `RA-016-WU-03` | `ACCEPTED` | parser i scoped normalization eventów Jira | WU-01, WU-02 |
| `RA-016-WU-04` | `ACCEPTED` | read-only REST client i stale-safe enrichment | WU-03 |
| `RA-016-WU-05A` | `RUNNING` | bounded Jira-to-Discord projection | WU-03, WU-04 |
| `RA-016-WU-05B` | `BLOCKED` | scoped correlation lookup i durable receipt | WU-05A |
| `RA-016-WU-05C` | `BLOCKED` | atomic case/entity/binding/outbox correlation | WU-05B |
| `RA-016-WU-06` | `BLOCKED` | webhook registration health i renewal | WU-02, WU-04, WU-05C |
| `RA-016-WU-07` | `BLOCKED` | bounded reconciliation utraconych eventów | WU-04, WU-06 |
| `RA-016-WU-08` | `BLOCKED` | Jira-to-case-to-Discord proof | WU-05C, WU-07 |

## `RA-016-WU-01` — Connector contracts and configuration

- Result: wersjonowane runtime contracts eventów/snapshotów oraz bezsekretowa,
  server-authoritative konfiguracja connection/project scope.
- Allowed paths: `packages/connector-jira/package.json`, `pnpm-lock.yaml`,
  `packages/connector-jira/src/types.ts`, `contracts.ts`, `errors.ts`, `index.ts`,
  `packages/connector-jira/test/contracts.test.ts`.
- Context pack: `docs/tasks/RA-016.md`,
  `packages/contracts/src/{event-envelope,external-entity,trust,common}.ts`.
- Acceptance: config nie przyjmuje tokenu/sekretu; project allowlist jest
  niepusty i przypisany do owner/connection; każdy Jira text ma literalne
  `UNTRUSTED_DATA` i contract version.
- Verification: `pnpm vitest run packages/connector-jira/test/contracts.test.ts`.
- Out of scope: HTTP, webhook verification, DB i parsing surowego payloadu.
- Sol gate: runtime negative tests odrzucają dodatkowe credential fields i
  provider-controlled scope.

## `RA-016-WU-02` — Verified durable webhook ingress

- Result: OAuth dynamic webhook bearer JWT jest zweryfikowany, body limitowany i
  szybko zapisany z trwałym dedupe przed dalszym processingiem.
- Allowed paths: `src/webhook/verify.ts`, `webhook/ingress.ts`,
  `test/webhook-ingress.integration.test.ts`, `package.json`, `src/index.ts`,
  konieczne repozytorium database i jego test.
- Context pack: WU-01, oficjalny Jira webhook security contract, RA-003
  `EventRepository`, RA-004 outbox/idempotency.
- Acceptance: invalid authenticity/body limit failuje bez zapisu; retry daje
  jeden durable fact; response path nie wykonuje enrichment/model call.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test/webhook-ingress.integration.test.ts`.
- Out of scope: event semantics i REST enrichment.
- Sol gate: exact replay, tampered payload i concurrent duplicate na real-PG.

## `RA-016-WU-03` — Parsing, ordering and scoped normalization

- Result: `jira:issue_created/updated/deleted` oraz
  `comment_created/updated/deleted`, wraz z changelogiem `issue_updated`, są
  parsowane do EventEnvelope i odrzucane przed enrichment, gdy projekt lub
  owner/connection są poza scope.
- Allowed paths: `src/contracts.ts`, `src/types.ts`, `src/parser.ts`,
  `src/normalize.ts`, `src/scope.ts`, `test/parser.test.ts`, `test/scope.test.ts`,
  `test/fixtures/**`, `src/index.ts`.
- Context pack: WU-01/02, `EventEnvelope`, sanitized fixtures i Jira event types.
- Acceptance: sześć dokładnych typów webhooków ma bounded, versioned parser;
  changelog jest dozwolony wyłącznie w `jira:issue_updated`; routingowe
  owner/connection i `payload_ref` pochodzą wyłącznie z trusted ingress context;
  project key z payloadu przechodzi autorytatywny allowlist check przed
  normalizacją; out-of-order/stale event ma deterministyczny ordering key z
  provider timestamp oraz stabilnego raw-event id.
- Verification: `pnpm vitest run packages/connector-jira/test/parser.test.ts packages/connector-jira/test/scope.test.ts`.
- Out of scope: HTTP i case creation.
- Sol gate: permutacje delivery order i fixture scan na PII/sekrety.

## `RA-016-WU-04` — REST client and stale-safe enrichment

- Result: read-only Jira service paginuje, respektuje retry/rate limit i pobiera
  autorytatywny issue snapshot bez nadpisania nowszej wersji.
- Allowed paths: `src/rest/client.ts`, `rest/transport.ts`, `src/enrichment.ts`,
  `test/rest-client.test.ts`, `test/enrichment.test.ts`, `src/index.ts`.
- Context pack: WU-01/03, oficjalne REST pagination/rate/auth semantics,
  RA-005 connection secret boundary.
- Acceptance: transport przyjmuje wyłącznie `GET`, dokładnie allowlisted origin
  i stałe ścieżki Jira v3; redirect, dowolny URL, write method i obce pole są
  odrzucane przed requestem. Credential jest pobierany przez callback secret
  boundary na czas requestu i nie jest przechowywany, zwracany ani logowany.
  `getIssue` żąda wyłącznie `id,key,project,summary,description,status,updated`;
  provider text pozostaje bounded `UNTRUSTED_DATA`. Enhanced JQL używa
  `nextPageToken`, wykrywa cykl i ma limity stron/elementów. `429` oraz transient
  `503` z `Retry-After` mają typed, bounded retry z injected delay/clock/jitter;
  brak albo przekroczenie dozwolonego delay failuje jawnie. Snapshot ma
  provenance connection/issue/source timestamp, a jego monotoniczną wersją jest
  poprawnie sparsowany epoch-ms pola Jira `fields.updated`; odpowiedź o wersji
  `<=` bieżącej nie mutuje stanu.
- Verification: `pnpm vitest run packages/connector-jira/test/rest-client.test.ts packages/connector-jira/test/enrichment.test.ts`.
- Out of scope: Jira writes i webhook renewal.
- Sol gate: stale response po nowszym webhooku niczego nie mutuje; testy
  odrzucają redirect/foreign origin/write method, pagination-token cycle,
  oversized result i sekret w error/log representation; retry nie używa real
  sleep.

## `RA-016-WU-05A` — Bounded Discord projection

- Result: czysty formatter buduje bezpieczny root/thread payload Jira dla
  istniejących kontraktów Discord.
- Allowed paths: `src/projection.ts`, `test/projection.test.ts`, `src/index.ts`,
  `package.json`, `pnpm-lock.yaml`.
- Context pack: WU-03/04, `packages/discord/src/{messages,sanitize}.ts`.
- Acceptance: wejście przechodzi strict contract; output zawiera wyłącznie
  issue key, status i summary z literalną etykietą `UNTRUSTED Jira`; nie zawiera
  description/comment/raw body/credential. Root title/body i thread body używają
  istniejących Discord sanitizers/contracts, neutralizują mentions, mają stabilny
  server-owned case/seq/owner/provider/alias i twarde limity.
- Verification: `pnpm vitest run packages/connector-jira/test/projection.test.ts`.
- Out of scope: DB, IDs, channel lookup i outbox.
- Sol gate: oversize/mentions/empty sparse payload oraz scan outputu na pola
  description/comment/token/secret.

## `RA-016-WU-05B` — Scoped lookup and durable projection receipt

- Result: DB repo daje exact scoped entity lookup oraz durable event receipt z
  canonical input digestem.
- Allowed paths: `packages/database/migrations/024_jira_projection_receipts.{up,down}.sql`,
  `packages/database/src/repositories/jira-correlation.ts`,
  `packages/database/src/repositories/case.ts`, `repositories/index.ts`,
  `packages/database/test/jira-correlation.integration.test.ts`.
- Context pack: WU-05A, external entity/case/outbox schema i DB error patterns.
- Acceptance: lookup wymaga owner+connection+provider=jira+kind=JIRA_ISSUE+issue;
  receipt jest keyed event id i wiąże owner/connection/issue/case/entity/outbox z
  canonical digestem; exact replay jest idempotentny, różny digest/zakres
  conflict, DB FK odrzuca foreign scope. Repo nie tworzy case/outbox.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/jira-correlation.integration.test.ts`.
- Out of scope: Discord payload i pełna transakcja correlation.
- Sol gate: concurrent exact insert, conflicting replay i dwa owners/connections
  z tym samym issue key.

## `RA-016-WU-05C` — Atomic correlation transaction

- Result: issue key wiąże się idempotentnie z entity/case i projektuje do
  autorytatywnego kanału `#jira`/thread.
- Allowed paths: `src/correlation.ts`, `test/correlation.integration.test.ts`,
  `src/index.ts`, `package.json`, `pnpm-lock.yaml` oraz wyłącznie konieczne
  publiczne exporty/adapters `packages/discord`.
- Context pack: WU-05A/B, RA-003 entity/case repositories, RA-006 routing/outbox.
- Acceptance: całość działa w jednej transakcji po per-connection/issue advisory
  lock. Durable receipt jest keyed exact normalized `event_id`, zawiera canonical
  digest inputu i wynik case/entity/outbox; exact retry zwraca ten sam wynik,
  conflicting retry failuje, a dwa concurrent eventy tego samego issue nie
  tworzą dwóch cases/entities. Lookup external entity jest dokładnie scoped przez
  owner+connection+provider+kind+issue key; foreign scope nie koreluje i DB FK
  pozostaje drugą granicą. Nowy issue tworzy case, Jira external entity,
  autorytatywny Discord binding do skonfigurowanego `#jira`, rezerwuje seq i
  enqueueuje `discord.root_thread`; kolejny event używa tego samego case i
  enqueueuje `discord.thread_message`. Alias pochodzi z trusted connection, nie
  payloadu. Projekcja zawiera wyłącznie bounded issue key, status i summary z
  jawną etykietą untrusted; bez description/comment/raw body/credential. Title i
  body przechodzą istniejące Discord sanitizers/contracts, IDs są server-owned.
  Receipt, entity/case/binding/seq i outbox commitują albo rollbackują atomowo.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test/correlation.integration.test.ts`.
- Out of scope: Jira mutation i GitLab branch.
- Sol gate: real-PG duplicate i concurrent race, injected rollback po każdym
  zapisie, conflicting same-event digest oraz dwa owners/connections o tym samym
  issue key nie współdzielą case/entity/binding/outbox.

## `RA-016-WU-06` — Webhook lifecycle and renewal

- Result: trwały registration health/expiry tworzy idempotentny renewal job oraz
  alert po wyczerpaniu bounded retry.
- Allowed paths: `src/webhook/registration.ts`, `webhook/renewal.ts`,
  `test/webhook-renewal.integration.test.ts`, `src/index.ts`, konieczne migracje i
  repozytorium database.
- Context pack: WU-02/04, oficjalny Jira registration/expiry contract, RA-004
  scheduler/DLQ/outbox.
- Acceptance: deadline jest trwały; jeden logical renewal ma jeden job;
  terminal failure generuje jeden redacted system alert.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test/webhook-renewal.integration.test.ts`.
- Out of scope: manual admin UI.
- Sol gate: crash przed/po remote registration ma reconciliation zamiast blind replay.

## `RA-016-WU-07` — Lost-event reconciliation

- Result: bounded poll watermark odnajduje utracony webhook bez cofnięcia nowszego stanu.
- Allowed paths: `src/reconciliation.ts`, `test/reconciliation.integration.test.ts`,
  `src/index.ts`, konieczne repozytorium database.
- Context pack: WU-04/06, event dedupe, monotonic issue version i scheduler.
- Acceptance: watermark zapisuje się atomowo; utracony event przechodzi ten sam
  normalize pipeline; retry nie duplikuje projekcji.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test/reconciliation.integration.test.ts`.
- Out of scope: pełny Jira backup.
- Sol gate: fault injection przed/po watermark commit.

## `RA-016-WU-08` — End-to-end Jira proof

- Result: fake Jira przechodzi verified ingress → normalized event → enrichment
  → case/entity → Discord, wraz z duplicate, sparse i lost-event paths.
- Allowed paths: `test/jira-e2e.integration.test.ts`, `test/fake-jira.ts`,
  `src/runtime.ts`, `src/index.ts`.
- Context pack: wszystkie zaakceptowane public APIs RA-016 i RA-003/004/006.
- Acceptance: każde kryterium RA-016 ma test; dwa connection scopes pozostają
  rozłączne; restart nie duplikuje normalized event ani projection.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test/jira-e2e.integration.test.ts`.
- Out of scope: live tenant write.
- Sol gate: pełna macierz acceptance i sanitized artifact scan.

## Final task gate

Sol uruchamia pełny pakiet na real PostgreSQL, typecheck/build/lint, sprawdza
oficjalne Jira Cloud contracts, dedupe, stale ordering, scope, renewal i
reconciliation. Następnie tworzy handoff i niezależny audyt.
