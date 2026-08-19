# RA-005 — Handoff 02

## Metadata

- Task: `RA-005`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: OpenCode Bedrock / IMPLEMENTER
- Data: 2026-08-19
- Poprzedni audyt: `docs/audits/RA-005/AUDIT-01.md` (`CHANGES_REQUIRED`, HIGH-01/02/03)
- Stan: brak nowego commita; zmiany RA-005 oraz zachowany wcześniejszy stan RA-002–RA-004 pozostają w working tree

## Zakres

Wyłącznie remediacja trzech findingów HIGH z AUDIT-01. Nie zmieniano zaakceptowanych
migracji RA-002–RA-004 ani kontraktów spoza RA-005. Nowe artefakty są addytywne
(migracje 016/017, addytywne pola resolvera i intent store).

## HIGH-01 — case-scoped resource allowlist

- Dodano migrację `016_case_resource_scope` z tabelą `case_connection_scopes`,
  której composite FK wiąże `(case_id, connection_id)` z `case_connections` oraz
  `(connection_id, kind, value)` z `connection_scopes`. Grant nie może więc
  poszerzyć ani case membership, ani scope połączenia — jest ich przecięciem.
- `AuthoritativeCaseScope` niesie teraz `resourceScopes: CaseResourceGrant[]`
  (`packages/policy/src/scope.ts:41`). `resolveConnectionScope` honoruje
  `requestedTarget` tylko gdy jest grantem TEGO case na wybranym połączeniu
  (`scope.ts:96`) ORAZ nadal skonfigurowanym scope połączenia (defence in depth,
  `scope.ts:103`); inaczej `ScopeResolutionError`.
- Alias jest częścią autorytatywnego wyboru kandydata (owner+provider+alias+
  capability, `scope.ts:68`), więc case z oboma aliasami nie wybierze cudzego
  kontekstu przez osobny argument.
- Reprodukcja HIGH-01 (case repo-a → repo-b na jednym połączeniu) jest teraz
  odrzucana; dodano testy cross-repo i cross-alias.

## HIGH-02 — durable intent + reconciliation dla vault write

- Dodano migrację `017_credential_refresh_intents` i `CredentialRefreshIntentStore`
  (`credential-refresh.ts:71`) z trwałym intentem per `operationId`.
- `begin` jest idempotentny na `operationId`: retry reużywa tego samego
  `versionId`/`ref` zamiast tworzyć nowy obiekt (`credential-refresh.ts:87`).
- Lifecycle jest zapisywany PRZED `put` (`credential-refresh.ts:241`), a status
  przechodzi `PENDING→VAULT_WRITTEN→PUBLISHED` (albo `ABORTED`/`AMBIGUOUS`).
- Timeout/crash po create jest uzgadniany value-free probe `vault.head`
  (`credential-refresh.ts:220`, `:297`); nieznany wynik zostaje `AMBIGUOUS` i NIE
  jest auto-replayowany (AGENTS.md §8). AWS adapter dostał `head`
  (`DescribeSecret`) i idempotentny `put` (`ResourceExistsException` → sukces,
  `ClientRequestToken=versionId`).
- `LocalCredentialVault` dostał `timeoutAfterNextWrite`/`failNext("head")` do
  fault injection. Dodano testy timeout-before, timeout-after-create,
  crash-przed-CAS i recovery po restarcie.

## HIGH-03 — zamknięte kanały wycieku sekretu

- Callback error jest opakowywany w `CredentialUsageError` bez raw message ani
  `cause`, wspólnie dla local i AWS przez `runWithSecret`
  (`credential-vault.ts:26`, `:69`); zachowywana jest tylko bezpieczna nazwa klasy.
- Redaktor traktuje bare/suffixed `token` jako sensitive
  (`redaction.ts:14`), świadomie wyłączając metryki (`tokens`, `max_tokens`,
  `prompt_tokens`), więc `{token: canary}` jest redagowane bez rejestracji wartości.
- Dodano canary testy: callback error lokalnego vaultu, `{token: canary}`,
  stack/cause i output serializera.

## Decyzje i alternatywy

- Case scope jako osobna tabela z composite FK zamiast kolumny `case_id` w
  `connection_scopes`: pozwala jednemu połączeniu służyć wielu case bez współdzielenia
  resource allowlisty i wymusza przecięcie deterministycznie w DB.
- Intent store z reużywanym `versionId` zamiast nowego UUID na retry: eliminuje
  osierocone wersje i daje stabilną tożsamość idempotencji do reconciliation.
- Odrzucono redagowanie po wartości sekretu (rejestracja): nie chroni przed
  sekretem nieznanym redaktorowi; wybrano redakcję po kształcie klucza.

## Zmienione pliki

- `packages/database/migrations/016_case_resource_scope.{up,down}.sql` (nowe)
- `packages/database/migrations/017_credential_refresh_intents.{up,down}.sql` (nowe)
- `packages/policy/src/scope.ts` — case-scoped grant intersection
- `packages/policy/src/credential-refresh.ts` — durable intent + reconciliation
- `packages/policy/src/credential-vault.ts` — `head`, idempotent `put`, sanitized `CredentialUsageError`
- `packages/observability/src/redaction.ts` — bare `token` key
- `packages/database/src/repositories/owner.ts` — case resource scope + intent persistence
- testy: `packages/policy/test/connection-security.test.ts`,
  `packages/observability/test/redaction.test.ts`,
  `packages/database/test/case-scope-and-refresh.integration.test.ts`

## Test evidence

| Komenda | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck 24/24, 421/421 testów, build, `workflow:validate OK`; realny PostgreSQL |

Engine warning bez zmian: repo pinuje Node `24.19.0`, uruchomiony `25.2.1`; pnpm
`10.26.1`. Brak błędów kompilacji/testów; istniejące ESLint boundaries warnings.

## Ryzyka i ograniczenia

- AWS adapter nadal weryfikowany kontraktowo z mockiem klienta (bez live call),
  łącznie z `head`/idempotent create/KmsKeyId i brakiem echoed secret.
- Local vault pozostaje test/dev only i traci stan po restarcie.
- Reconciliation zakłada, że lifecycle intentu jest zapisany przed write; obiekt
  bez zapisanego lifecycle celowo kończy jako `AMBIGUOUS` (ręczne uzgodnienie).

## Audit focus

- AC2/AC3: przecięcie case membership ∧ case resource grant ∧ configured scope;
  cross-repo i cross-alias na jednym połączeniu.
- AC5: canary w callback error, `{token: canary}`, stack/cause, serializer.
- HIGH-02: brak osieroconych wersji, stabilna idempotencja, `AMBIGUOUS` bez
  auto-replay, recovery po restarcie.

## Otwarte pytania

- Brak. Decision Request nie jest wymagany.
