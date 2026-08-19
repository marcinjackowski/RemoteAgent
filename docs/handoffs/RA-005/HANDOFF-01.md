# RA-005 — Handoff 01

## Metadata

- Task: `RA-005`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: Codex / IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: `df5c08450253c336e6058cc8db523746a49231aa`; working tree zawierał zachowane, niezatwierdzone rezultaty zaakceptowanych tasków RA-002–RA-004
- Końcowy commit lub stan working tree: brak nowego commita; zmiany RA-005 oraz zachowany wcześniejszy stan są obecne w working tree

## Wynik

Powstał bezpieczny model połączeń wielokontowych: publiczny kontrakt bez credentiali,
trwałe metadane OAuth i scope allowlisty, lokalny vault oraz adapter AWS Secrets
Manager z customer-managed KMS, deterministyczne wstrzykiwanie scope, fail-closed
health checks, redakcja i append-only kill switche. Private i SonderMind są
rozróżniane przez osobne `connection_id` i alias w policy context.

## Zrealizowany zakres

- Dodano versioned `Connection` contract z aliasem, capabilities, health i scope, bez tokenów, wartości sekretu ani vault reference.
- Dodano migrację 015 z referencją do vaultu, rewizją credentiali, metadanymi OAuth, provider-specific scopes oraz append-only kill-switch evidence.
- Rozszerzono repository o bezpieczne tworzenie/odczyt połączeń, case-scoped resolution, atomową konfigurację scope, CAS rotację credential reference, revoke oraz effective kill-switch lookup.
- Dodano lokalny vault i adapter AWS Secrets Manager tworzący immutable sekrety z jawnym `KmsKeyId`.
- Dodano race-safe coordinator odświeżania tokenu: publikacja nowej referencji przez CAS, cleanup przegranej wersji i zerowanie buforów.
- Dodano deterministic scope resolver oraz guard health/expiry/kill switch.
- Dodano rekurencyjną redakcję logów, błędów i serialized context z canary tests.
- Ustabilizowano istniejący property-test kanonikalizacji, aby permutacja zachowywała własny klucz JSON `__proto__` zamiast uruchamiać legacy setter obiektu.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/contracts/src/connection.ts`, schema registry i snapshot | Bezpieczny kontrakt Connection, alias/health/scope | Jedno runtime-validowane źródło publicznych metadanych bez credentiali |
| `packages/database/migrations/015_connections_security.*.sql` | Lifecycle OAuth, vault ref, resource scopes, kill-switch ledger | Trwałe, fail-closed constraints oraz evidence zachowane po restartach |
| `packages/database/src/repositories/owner.ts` | Connection/scope/CAS/revoke/kill-switch API | Scope i owner/provider są wiązane server-side, nie z deklaracji modelu |
| `packages/policy/src/credential-vault.ts` | Local vault i AWS Secrets Manager/KMS adapter | Credential values pozostają poza DB, DTO, błędami i kontekstem modelu |
| `packages/policy/src/credential-refresh.ts` | Immutable ref + optimistic publish | Tylko jeden refresher może opublikować nową wersję |
| `packages/policy/src/scope.ts` | Deterministyczna selekcja connection/target | Model może zawęzić wybór, ale nie poszerzyć case allowlisty |
| `packages/policy/src/connection-guard.ts` | Health, expiry i trzy poziomy kill switch | Revoked/expired/error oraz operator stop blokują nowe efekty |
| `packages/observability/src/redaction.ts` | Redakcja stringów, struktur, Error i serialization | Canary secret nie trafia do logów, błędów ani context JSON |
| testy `contracts`, `database`, `policy`, `observability` | Unit, property i real-PostgreSQL integration coverage | Dowody dla scope escalation, redaction, vault failure, refresh race i kill switchy |
| `packages/contracts/test/canonical.property.test.ts` | Bezpieczne tworzenie permutowanego klucza `__proto__` | Usunięcie losowego false negative ujawnionego przez pełną bramkę |
| `packages/policy/package.json`, `pnpm-lock.yaml` | Przypięty oficjalny AWS Secrets Manager SDK | Rzeczywisty adapter AWS z KMS zamiast pozornego stubu |

## Decyzje i uzasadnienie

Credential jest identyfikowany w PostgreSQL wyłącznie nieprzezroczystą referencją.
Vault udostępnia bytes tylko w callbacku i czyści kopię po użyciu, dzięki czemu
sekret nie staje się serializowalnym DTO. Odświeżanie zapisuje immutable secret
version przed CAS metadata; przegrany refresher nie może nadpisać zwycięskiego
tokenu i usuwa własną, nieopublikowaną wersję.

Scope jest dwuwarstwowy: `case_connections` z RA-003 ogranicza dozwolone
connection identities, a `connection_scopes` ogranicza zasoby providera. Resolver
wybiera po owner/provider/alias/capability z autorytatywnego case scope i sprawdza
dokładny target. Model-supplied connection albo repo poza allowlistą kończy się
błędem, nie fallbackiem.

Kill switch jest ledgerem zdarzeń enable/disable, nie mutowalną flagą. Bieżący
stan pochodzi z najnowszego eventu na poziomie global/provider/connection, zaś
starsze evidence pozostaje append-only.

Alternatywą dla immutable wersji vaultu było nadpisywanie jednego secret ref, ale
wyścig dwóch refresherów mógłby pozostawić w vaultcie token przegranego procesu po
udanym CAS zwycięzcy. Alternatywą dla ledgeru kill switchy była mutowalna tabela,
ale utraciłaby dowód wcześniejszego zatrzymania.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Publiczny model/repository DTO nie zawiera tokenu ani secret value | PASS | `connection.test.ts`; information-schema assertion w `connections-security.integration.test.ts`; DB ma wyłącznie `credential_secret_ref` |
| 2. Model-supplied connection/repo ID nie poszerza case scope | PASS | `connection-security.test.ts`: foreign connection i repo escalation są odrzucane; `listForCase` korzysta z `case_connections` |
| 3. Private i SonderMind są rozłączne | PASS | kontrakt aliasu, policy test cross-alias i PostgreSQL case-resolution test |
| 4. Revoked/expired failuje zamknięcie z health status | PASS | guard tests dla `REVOKED`, `EXPIRED`, `ERROR` i clock expiry; revoked row odrzuca CAS rotation |
| 5. Canary secret nie występuje w logach, błędach ani serialized context | PASS | `redaction.test.ts`; vault test odrzuca echoed provider error bez zachowania raw `cause` |
| 6. Kill switch blokuje nowe efekty bez usuwania evidence | PASS | unit tests GLOBAL/PROVIDER/CONNECTION; PostgreSQL test enable/disable, history count i append-only mutation rejection |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint, format, typecheck 21/21, 23 test files i 408/408 testów, build 20/20, `workflow:validate OK — 26 tasks` |
| `pnpm exec vitest run packages/policy/test/connection-security.test.ts packages/observability/test/redaction.test.ts` | 0 | 2 pliki, 18/18 testów po finalnym hardeningu |
| `git diff --check` | 0 | brak błędów whitespace |
| skan wzorców kluczy prywatnych/AWS access key | 0 | brak dopasowań poza jawnymi canary fixtures |

Weryfikacja działała na realnym PostgreSQL z `RA_REQUIRE_POSTGRES=1`. Runtime
zgłosił ostrzeżenie engine: repo wymaga Node `24.19.0`, dostępny był Node
`25.2.1`; pnpm miał właściwą wersję `10.26.1`. Nie było błędów kompilacji ani
testów. ESLint zgłasza istniejące ostrzeżenia migracyjne konfiguracji boundaries,
bez naruszeń.

## Snapshoty i artefakty

- Artefakt/ścieżka: `packages/contracts/test/__snapshots__/schema-snapshot.test.ts.snap`
- Czy snapshot się zmienił i dlaczego: tak; dodano oczekiwany JSON Schema nowego publicznego kontraktu `Connection`, nadal z `additionalProperties: false`.

## Bezpieczeństwo i dane

- Dostęp do sekretów: tylko przez `CredentialVault.withCredential`; publiczny contract nie zna vault ref, a persistence przechowuje wyłącznie opaque ref. AWS adapter używa jawnego KMS key id i nie zachowuje surowych błędów SDK.
- Izolacja kont/scope: owner + case membership + provider + alias + capability + exact resource allowlist są sprawdzane deterministycznie poza modelem.
- Side effecty i idempotencja: AWS create używa UUID `ClientRequestToken`; refresh publikuje immutable ref przez CAS, loser cleanup dotyczy wyłącznie nieopublikowanej wersji; kill-switch history jest append-only.
- Dane zewnętrzne traktowane jako niezaufane: runtime schemas i exact allowlisty odrzucają dodatkowe pola/targety; provider error nie jest propagowany jako cause.

## Znane ograniczenia i ryzyka

- Adapter AWS został sprawdzony testem kontraktowym z mockiem klienta (łącznie z `KmsKeyId` i brakiem echoed secret w błędzie), bez live call do AWS, aby nie używać credentiali w testach repo.
- Local vault jest przeznaczony wyłącznie do testów/development i traci zawartość po restarcie; produkcja ma używać adaptera AWS.
- OAuth UI oraz konkretne provider refresh flows pozostają poza zakresem RA-005.
- Pełna bramka została wykonana na Node 25.2.1, nie na przypiętym Node 24.19.0; engine mismatch był jawnym ostrzeżeniem.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: cały zakres RA-005 wraz z migracją up/down, kontraktami, policy/vault/redaction i testami.
- Czego nie robić przed audytem: nie rozpoczynać RA-006 ani RA-007 i nie zmieniać wcześniejszych artefaktów RA-002–RA-004.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: najnowszy `docs/audits/RA-005/AUDIT-NN.md`, następnie testy `packages/policy/test/connection-security.test.ts` oraz `packages/database/test/connections-security.integration.test.ts`.
