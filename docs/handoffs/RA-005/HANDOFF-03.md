# RA-005 — Handoff 03

## Metadata

- Task: `RA-005`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: OpenCode Bedrock / IMPLEMENTER
- Data: 2026-08-19
- Poprzedni audyt: `docs/audits/RA-005/AUDIT-02.md` (`CHANGES_REQUIRED`, HIGH-01/02/04)
- Stan: brak nowego commita; zmiany RA-005 oraz zachowany wcześniejszy stan
  RA-002–RA-004 pozostają w working tree (untracked, zgodnie z HANDOFF-02)

## Zakres

Wyłącznie remediacja trzech findingów HIGH z AUDIT-02. Nie zmieniano
zaakceptowanych migracji ani kontraktów spoza RA-005. Zmiany są addytywne i
logicznie zawężające (fail-closed); nie dodano nowej migracji, bo wymagane
inwarianty egzekwuje istniejący composite FK migracji 017 oraz warstwa
repozytorium/koordynatora.

## HIGH-01 — alias/policy context związany z autorytatywnym case scope

Problem: `alias` był niezależnym wejściem selekcji, brak `requestedTarget`
omijał sprawdzenie grantu, a resolver zwracał pełne connection scopes. W mixed
case (private + sondermind) można było wybrać kontekst SonderMind bez grantu tego
case i otrzymać jego szerszy scope.

Zmiana (`packages/policy/src/scope.ts`):

- Grants case (`resourceScopes`) są teraz AUTORYTATYWNYM policy context. Połączenie
  jest kandydatem tylko, gdy case ma na nim co najmniej jeden grant
  (`grantsByConnection.has(...)`, `scope.ts:112-121`). Alias nie może więc sięgnąć
  połączenia, którego kontekstu case nie autoryzował — mixed-alias case z grantem
  tylko na private nie wybierze aliasu sondermind.
- Brak `requestedTarget` NIE omija autorytatywności: wybór wymaga istnienia grantu,
  a wynik zawiera wyłącznie case-filtered scopes.
- `ResolvedConnectionScope.scopes` jest teraz przecięciem grantów case i aktualnie
  skonfigurowanych scope połączenia (defence in depth), nigdy pełnej listy
  połączenia (`scope.ts:123-141`).
- `requestedTarget` musi należeć do case-authorised scopes, inaczej
  `ScopeResolutionError`.

Testy (`packages/policy/test/connection-security.test.ts`): brak-grantu fail-closed,
kształt zwracanych scopes bez targetu (tylko granted repo), cross-alias bez targetu
(HIGH-01), zaktualizowany cross-alias z targetem, zachowany defence-in-depth stale
grant i cross-repo.

## HIGH-02 — dokładna reconciliation wersji i klasyfikacja timeout

Problem: AWS `put` zamieniał każdy non-ResourceExists (w tym transport timeout po
przyjęciu requestu) w `CredentialVaultUnavailableError`; koordynator uzgadniał
tylko `CredentialWriteAmbiguousError`. `head` czytał tylko `.exists`, a
`ResourceExistsException` był traktowany jako sukces bez potwierdzenia wersji.

Zmiana (`packages/policy/src/credential-vault.ts`):

- AWS `put`: `ResourceExistsException` → `CredentialWriteAmbiguousError` (nie
  „sukces”), bo istniejący obiekt może mieć inną wersję. Tylko jawne błędy
  pre-write (walidacja/auth/KMS: `DEFINITE_WRITE_FAILURE_NAMES`) → `Unavailable`.
  Każdy inny wynik (timeout/transport/throttling/5xx/unknown) →
  `CredentialWriteAmbiguousError` (`credential-vault.ts:198-238`).
- AWS `head`: zwraca wersję staged jako `AWSCURRENT` niezależnie od kolejności
  kluczy `VersionIdsToStages`; brak AWSCURRENT → brak `versionId` (tożsamość
  niepotwierdzona) (`currentVersionId`, `credential-vault.ts:340-354`).

Zmiana (`packages/policy/src/credential-refresh.ts`):

- Obie ścieżki reconciliation wymagają teraz `probe.versionId === intent.versionId`;
  mismatch (obcy/stary obiekt) → `markAmbiguous` + `CredentialWriteAmbiguousError`,
  bez publikacji (`credential-refresh.ts` mayHavePriorWrite i
  `#reconcileAfterAmbiguousWrite`).

Testy: AWS timeout-after-accept → ambiguous; definite failure → unavailable;
ResourceExists → ambiguous; unordered/multi-version AWSCURRENT; brak AWSCURRENT;
koordynator: matching version publikuje, mismatched zostaje AMBIGUOUS bez publish;
AWS ResourceExists matching → konwerguje, mismatched → AMBIGUOUS bez publish.

## HIGH-04 — operationId związany z immutable connection/owner/provider/revision

Problem: `ON CONFLICT (operation_id) DO NOTHING` zwracał istniejący intent bez
sprawdzenia tożsamości, a koordynator publikował z `input.connectionId`. Reuse
operationId dla innego połączenia krzyżował credential reference między
połączeniami (cross-account leakage).

Zmiana:

- `CredentialRefreshCoordinator.refresh` po `begin` weryfikuje tożsamość
  (`assertSameIntentIdentity`) i publikuje z ZWERYFIKOWANEJ tożsamości intentu
  (`intent.connectionId`/`intent.expectedRevision`), nigdy z surowego requestu
  (`credential-refresh.ts`).
- `InMemoryCredentialRefreshIntentStore.begin` i repozytorium DB
  (`packages/database/src/repositories/credential-refresh-intent.ts` →
  `assertRowIdentity`) failują zamknięcie na mismatch connection/owner/provider/
  expectedRevision PRZED jakimkolwiek probe/publish.
- Nowy błąd `CredentialRefreshIdentityError` w policy oraz
  `packages/database/src/errors.ts` (eksport w `packages/database/src/index.ts`).
  `version_id`/`credential_secret_ref` celowo NIE są porównywane (to wartości
  reużywane przez retry).

Testy: unit (reuse na inne połączenie nie publikuje conn-a na conn-b; owner/
provider/revision mismatch), real-PostgreSQL integration (reuse innego
connection/owner/provider/revision → `CredentialRefreshIdentityError`) oraz
real-PostgreSQL concurrency (dwie równoległe `begin` z tym samym operationId i
różnym connection → dokładnie jedna wygrywa, druga fail-closed).

## Decyzje i alternatywy

- Kontekst policy wyprowadzony z exact grants (a connection wymaga grantu, by być
  kandydatem) zamiast nowej kolumny „allowed alias” na case: deterministyczne,
  fail-closed, nie duplikuje źródła prawdy i realizuje wprost wskazówkę AUDIT-02.
- ResourceExists jako AMBIGUOUS (a nie sukces): AWS potwierdza tylko istnienie
  nazwy, nie tożsamość wersji; jedyne bezpieczne jest uzgodnienie exact version.
- Brak nowej migracji: composite FK `(connection_id, owner_id, provider)` z 017
  już wiąże intent z realnym połączeniem; binding tożsamości operationId jest
  regułą aplikacyjną fail-closed, nie zmianą schematu.
- Domyślna klasyfikacja błędu write = AMBIGUOUS; tylko wąska lista pewnych błędów
  pre-write = definite failure. Pomyłka w stronę AMBIGUOUS jest bezpieczna
  (probe + brak auto-replay), w stronę „definite” — nie.

## Zmienione pliki

- `packages/policy/src/scope.ts` — autorytatywny kontekst z grantów, case-filtered scopes
- `packages/policy/src/credential-vault.ts` — klasyfikacja błędów AWS, AWSCURRENT version
- `packages/policy/src/credential-refresh.ts` — exact-version reconciliation, identity binding, `CredentialRefreshIdentityError`
- `packages/database/src/repositories/credential-refresh-intent.ts` — `assertRowIdentity` fail-closed
- `packages/database/src/errors.ts` — `CredentialRefreshIdentityError`
- `packages/database/src/index.ts` — eksport błędu
- testy: `packages/policy/test/connection-security.test.ts`,
  `packages/database/test/case-scope-and-refresh.integration.test.ts`

## Test evidence

| Komenda | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck, test 24/24 plików i 440/440 testów, build 20/20, `workflow:validate OK — 26 tasks`; realny PostgreSQL |
| `RA_REQUIRE_POSTGRES=1 pnpm --filter @remoteagent/policy exec vitest run` | 0 | 37/37 testów policy |
| `RA_REQUIRE_POSTGRES=1 pnpm --filter @remoteagent/database exec vitest run case-scope-and-refresh` | 0 | 8/8 testów integration/concurrency |
| `git diff --check` | 0 | brak błędów whitespace |

Engine warning bez zmian: repo pinuje Node `24.19.0`, uruchomiony `25.2.1`; pnpm
`10.26.1`. Istniejące ESLint boundaries warnings (spoza zakresu) bez błędu bramki.

## Ryzyka i ograniczenia

- AWS adapter nadal weryfikowany kontraktowo z mockiem klienta (bez live call),
  łącznie z timeout/ResourceExists/AWSCURRENT selection i brakiem echoed secret.
- Local vault pozostaje test/dev only i traci stan po restarcie.
- Wybór kontekstu wymaga grantu case na połączeniu; połączenie bez grantu jest
  celowo nieselekcjonowalne (fail-closed). Downstreamy RA-006+ muszą zasilać
  `resourceScopes` z autorytatywnego `loadCaseScope`.

## Audit focus

- AC2/AC3: alias/context wyłącznie z autorytatywnego case scope; no-target i
  mixed-alias fail-closed; zwracane scopes = wyłącznie case grants ∩ configured.
- HIGH-02: klasyfikacja timeout/transport jako AMBIGUOUS, exact-version match przed
  publish, ResourceExists reconciliation, unordered VersionIdsToStages.
- HIGH-04: reuse operationId między connection/owner/provider/revision fail-closed
  przed probe/publish; publish z tożsamości intentu; concurrency na realnym PG.

## Otwarte pytania

- Brak. Decision Request nie jest wymagany.
