# RA-005 — Audit 01

## Metadata

- Task: `RA-005`
- Audytowany handoff: `docs/handoffs/RA-005/HANDOFF-01.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Implementacja ma solidne podstawy: publiczny contract nie zawiera credentiali,
migracja up/down działa na realnym PostgreSQL, owner/provider/connection są
wiązane constraintami, refresh metadata używa CAS, a kill-switch evidence jest
append-only. Pełna bramka repo przechodzi: 23 pliki testowe i 408/408 testów.

`PASS` nie jest jednak dozwolony. Niezależne próby negatywne odtworzyły trzy
findingi HIGH: scope zasobu nie jest związany z aktualnym case, AWS vault write
nie ma bezpiecznej semantyki po timeout/crash, a canary secret może pojawić się w
błędzie lokalnego vaultu i w serialized context pod zwykłym kluczem `token`.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`,
  `docs/workflow/AUDIT_CHECKLIST.md`, `docs/tasks/TASK_INDEX.md`,
  `docs/tasks/RA-005.md`, `docs/handoffs/RA-005/HANDOFF-01.md`.
- Sprawdzony diff/stan: kontrakt `Connection`, schema snapshot, migracja 015
  up/down, connection/kill-switch repositories, local/AWS vault, refresh
  coordinator, scope resolver, connection guard, redaction i wszystkie testy
  RA-005 oraz istotne kontrakty `Case`/`case_connections` z RA-003.
- Uruchomione kontrole: pełne `RA_REQUIRE_POSTGRES=1 pnpm check` na realnym
  PostgreSQL oraz cztery niezależne próby negatywne opisane niżej.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Publiczny model/repository DTO nie zawiera tokenu ani secret value | PASS | `connectionContract` odrzuca dodatkowe credential fields; `ConnectionRow` ma wyłącznie opaque `credential_secret_ref`; schema/DB tests przechodzą. |
| 2. Model-supplied connection/repo ID nie poszerza scope aktualnego case | FAIL | Resolver przecina tylko `connectionIds`; resource scopes są globalne dla connection. Próba case repo A → repo B na tym samym connection została zaakceptowana. HIGH-01. |
| 3. Private i SonderMind mają rozłączne identities i policy context | FAIL | Identities/alias są osobne, lecz `AuthoritativeCaseScope` nie niesie autorytatywnego aliasu ani resource policy. Case zawierający oba connection IDs może wybrać alias podany osobnym argumentem. HIGH-01. |
| 4. Revoked/expired connection failuje zamknięcie z jasnym health status | PASS | Guard sprawdza `REVOKED`, `EXPIRED`, `ERROR` i wall-clock expiry; DB nie pozwala CAS-rotate revoked row. |
| 5. Canary secret nie pojawia się w logach, błędach ani serialized context | FAIL | `LocalCredentialVault.withCredential` propaguje callback error z sekretem; redactor nie traktuje zwykłego klucza `token` jako sensitive bez wcześniejszej rejestracji wartości. HIGH-03. |
| 6. Kill switch blokuje nowe efekty bez usuwania audit evidence | PASS | Guard blokuje GLOBAL/PROVIDER/CONNECTION; DB ledger zachowuje enable/disable i odrzuca UPDATE/DELETE. |

## Findingi

### HIGH-01 — Resource allowlista jest connection-scoped, nie case-scoped

- Lokalizacja: `packages/policy/src/scope.ts:27`,
  `packages/policy/src/scope.ts:38`, `packages/policy/src/scope.ts:72`,
  `packages/database/migrations/015_connections_security.up.sql:41`.
- Dowód: `AuthoritativeCaseScope` zawiera tylko `caseId`, `ownerId` i
  `connectionIds`. `requestedTarget` jest sprawdzany przeciw pełnej liście
  `selected.scopes`, a `connection_scopes` nie ma `case_id`. Niezależny test
  utworzył connection z repo A i repo B, case nazwany `case-repo-a` z tym
  connection oraz zażądał repo B; wynik zawierał
  `selectedTarget={kind:"repository",value:"owner/repo-b"}`. Analogicznie case
  nie ma autorytatywnego aliasu policy context — alias jest osobnym wejściem
  resolvera.
- Wpływ: model lub zainfekowana treść w case repo A może wybrać inne repo,
  calendar, project albo Discord target dopuszczony dla tego samego połączenia.
  Przy case zawierającym connections obu aliasów może też wybrać niewłaściwy
  context. Narusza AC2, AC3, Master Plan §7 (`case_id -> repo allowlist entry`)
  i zasadę server-side scope injection.
- Wymagana zmiana: dodać trwały, autorytatywny case-level resource/policy scope
  (co najmniej alias/context oraz exact account/repository/calendar/project/
  Discord targets) albo deterministycznie wyprowadzać go z trwałej encji case.
  Resolver musi przecinać request jednocześnie z case connection membership i
  case resource scope. Dodać negatywne testy: dwa repo na jednym connection,
  dwa aliasy jednego ownera i próby cross-repo/cross-alias.

### HIGH-02 — Credential write może pozostać osierocony i niejednoznaczny po timeout/crash

- Lokalizacja: `packages/policy/src/credential-refresh.ts:64`,
  `packages/policy/src/credential-refresh.ts:67`,
  `packages/policy/src/credential-refresh.ts:73`,
  `packages/policy/src/credential-vault.ts:119`.
- Dowód: coordinator generuje nowy losowy ref, wykonuje `vault.put`, a dopiero
  potem publikuje metadata. Cleanup jest uruchamiany tylko po potwierdzonym
  sukcesie `put`. Próba vaultu, który wykonał create i następnie zwrócił timeout,
  zakończyła się `created=[ref]`, `revoked=[]`. Crash między liniami 68 i 75 ma
  ten sam skutek. AWS adapter spłaszcza wszystkie błędy `CreateSecret` do
  `CredentialVaultUnavailableError`, bez reconciliation statusu; następny run
  generuje inny UUID/ref.
- Wpływ: secret material może pozostać w AWS bez trwałego intentu, DB reference,
  jednoznacznego statusu ani gwarantowanego cleanup. Retry tworzy kolejne wersje
  zamiast uzgodnić poprzedni side effect. Narusza AGENTS.md §8 oraz run-safety
  Master Planu, a także utrudnia revoke/retencję sekretów.
- Wymagana zmiana: zapisać durable refresh/vault intent przed write i używać
  stabilnego operation/ref/version ID przy retry; odróżniać wynik potwierdzony od
  `AMBIGUOUS`; dla timeout-after-create uzgadniać AWS przez bezpieczny read
  (`Describe/Get` + version identity/digest bez ujawniania wartości) przed
  retry/cleanup. Dodać fault-injection tests dla timeout-before, timeout-after i
  crash po vault write/przed CAS oraz recovery po restarcie.

### HIGH-03 — Canary secret może wyciec przez error i serialized context

- Lokalizacja: `packages/policy/src/credential-vault.ts:54`,
  `packages/observability/src/redaction.ts:4`,
  `packages/observability/src/redaction.ts:85`.
- Dowód: `LocalCredentialVault.withCredential` zeruje bytes w `finally`, ale
  propaguje wyjątek callbacku bez sanitizacji. Niezależna próba callbacku
  rzucającego `Error("provider echoed audit-canary-secret")` zwróciła dokładnie
  ten sekret w `String(error)`. Osobno
  `new SecretRedactor().serialize({token:"audit-canary-secret"})` zwrócił sekret
  bez redakcji, bo `SENSITIVE_KEY` nie obejmuje generycznego `token`.
- Wpływ: błąd adaptera/providera może przenieść credential do logu, checkpointu
  lub kontekstu modelu. Local adapter jest częścią wymaganego zakresu, a
  serialized context jest wprost objęty AC5.
- Wymagana zmiana: ujednolicić bezpieczne opakowanie błędów callbacku dla local i
  AWS vault bez raw message/cause, rozszerzyć redakcję o generyczne nazwy tokenów
  i zapewnić centralne użycie redaktora przed log/error/context serialization.
  Dodać canary tests dokładnie dla callback error lokalnego vaultu, `{token:
  canary}`, stack/cause oraz outputu docelowych serializerów.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS; 23/23 pliki, 408/408 testów, realny PostgreSQL. |
| `pnpm exec tsx --eval '<case repo-a requests repo-b on same connection>'` | 0 | Resolver zaakceptował repo B i zwrócił je jako `selectedTarget`; reprodukcja HIGH-01. |
| `pnpm exec tsx --eval '<vault create succeeds then throws timeout>'` | 0 | `created` zawierało nowy ref, `revoked` było puste; reprodukcja HIGH-02. |
| `pnpm exec tsx --eval '<LocalCredentialVault callback throws canary>'` | 0 | Wynik błędu zawierał `audit-canary-secret`; reprodukcja HIGH-03. |
| `pnpm exec tsx --eval '<SecretRedactor serializes token key>'` | 0 | Wynik `{"token":"audit-canary-secret"}`; reprodukcja HIGH-03. |
| Inspekcja migracji 015 up/down i schema snapshot | read-only | Rollback jest kompletny, migration lifecycle oraz fail-closed DB constraints przechodzą. |

Środowisko zgłasza przypięty Node `24.19.0` kontra uruchomiony `25.2.1` oraz
istniejące ostrzeżenia migracyjne ESLint boundaries. Nie spowodowały błędów
bramki, lecz nie kompensują brakujących scenariuszy bezpieczeństwa.

## Ryzyka przekrojowe

- Security/privacy: potwierdzone cross-case resource widening oraz dwa kanały
  ujawnienia canary secret.
- Idempotencja/recovery: AWS secret create nie ma trwałego intentu ani
  reconciliation dla wyniku niejednoznacznego.
- Współbieżność: DB CAS wybiera jednego zwycięzcę po potwierdzonym write, lecz
  nie rozwiązuje crash/timeout przed CAS.
- Observability: append-only kill-switch evidence jest poprawne; vault cleanup
  failure oraz ambiguous create nie mają trwałego, actionable evidence.
- Kompatybilność: kontrakt Connection i snapshot są spójne; migracja up/down
  przechodzi, ale wymagany case-level scope może wymagać addytywnego kontraktu i
  nowej migracji, nie edycji zaakceptowanych migracji.

## Wymagane działania po `continue`

1. OpenCode Bedrock implementuje trwały case-level resource/alias scope i
   wymusza jego przecięcie w resolverze; dodaje cross-repo/cross-alias tests.
2. OpenCode Bedrock dodaje durable intent, stabilną idempotency identity i
   reconciliation dla AWS credential writes oraz fault-injection/restart tests.
3. OpenCode Bedrock zamyka oba kanały wycieku sekretu i dodaje end-to-end canary
   coverage błędów oraz serialized context.
4. Implementer uruchamia `RA_REQUIRE_POSTGRES=1 pnpm check`, zapisuje
   `HANDOFF-02.md` i ponownie ustawia `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Zielona bramka potwierdza jakość istniejących ścieżek, ale testy nie obejmują
trzech odtworzonych scenariuszy z `Audit focus`: cross-account/resource leakage,
secret lifetime po niejednoznacznym write oraz canary w błędzie/context. Dwa
kryteria akceptacji są niespełnione, a trzeci policy context nie jest trwale
związany z case. Ponieważ findingi są naprawialne w zakresie RA-005, właściwy
werdykt to `CHANGES_REQUIRED`, nie `BLOCKED`.

