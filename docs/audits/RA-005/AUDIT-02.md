# RA-005 — Audit 02

## Metadata

- Task: `RA-005`
- Audytowany handoff: `docs/handoffs/RA-005/HANDOFF-02.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja RA-002–RA-005 pozostaje niezatwierdzona w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacja poprawnie zamyka HIGH-03 oraz resource-level część HIGH-01: case grant
jest trwały, jest podzbiorem membership i connection scope, a próba repo A → repo
B jest odrzucana. Pełna bramka repo również przechodzi na realnym PostgreSQL:
24/24 pliki testowe i 421/421 testów.

`PASS` nadal nie jest dozwolony. Alias/policy context pozostaje wejściem spoza
autorytatywnego case scope, a resolver zwraca pełne connection scopes. Ponadto
AWS reconciliation nie potwierdza dokładnego `versionId`, nie klasyfikuje
transport timeout jako wyniku niejednoznacznego w bieżącym przebiegu, a durable
intent nie wiąże ponownego `operationId` z pierwotnym connection/owner/provider.
Niezależne próby odtworzyły wybór kontekstu SonderMind bez case grant, publikację
po mismatched vault version oraz cross-connection publication przy kolizji
idempotency key.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`,
  `docs/workflow/AUDIT_CHECKLIST.md`, `docs/tasks/TASK_INDEX.md`,
  `docs/tasks/RA-005.md`, `docs/handoffs/RA-005/HANDOFF-02.md` i
  `docs/audits/RA-005/AUDIT-01.md`.
- Sprawdzony diff/stan: migracje 016/017 up/down, case-scope repository i
  resolver, local/AWS vault, refresh coordinator i oba intent stores, redakcja,
  eksporty oraz nowe testy unit/integration.
- Sprawdzona oficjalna semantyka AWS: `ClientRequestToken` identyfikuje wersję i
  wspiera idempotencję, natomiast `ResourceExistsException` mówi jedynie, że
  zasób o żądanym ID już istnieje; potwierdzenie właściwej wersji wymaga odczytu
  `VersionIdsToStages`.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Publiczny model/repository DTO nie zawiera tokenu ani secret value | PASS | Kontrakty nadal wystawiają wyłącznie opaque ref/lifecycle; migracja 017 nie przechowuje secret material. |
| 2. Model-supplied connection/repo ID nie poszerza scope aktualnego case | FAIL | Exact requested target jest przecinany z case grantem, lecz brak targetu omija ten warunek, a wynik zwraca pełne scopes wybranego connection. HIGH-01. |
| 3. Private i SonderMind mają rozłączne identities i policy context | FAIL | `alias` nadal jest osobnym argumentem resolvera, a nie autorytatywnym polem case scope. Mixed case może wybrać SonderMind bez grantów tego kontekstu. HIGH-01. |
| 4. Revoked/expired connection failuje zamknięcie z jasnym health status | PASS | Bez regresji; guard i CAS pozostają fail-closed. |
| 5. Canary secret nie pojawia się w logach, błędach ani serialized context | PASS | Wspólny wrapper usuwa raw message/cause, bare `token` jest redagowany, a niezależna inspekcja i testy canary przechodzą. HIGH-03 zamknięty. |
| 6. Kill switch blokuje nowe efekty bez usuwania audit evidence | PASS | Bez regresji; wszystkie poziomy blokują, ledger pozostaje append-only. |

## Findingi

### HIGH-01 — Alias/context nadal nie jest częścią autorytatywnego case scope

- Lokalizacja: `packages/policy/src/scope.ts:41-65`,
  `packages/policy/src/scope.ts:67-74`, `packages/policy/src/scope.ts:92-114`.
- Dowód: `AuthoritativeCaseScope` zawiera connection IDs i resource grants, ale
  nie zawiera dozwolonego aliasu/contextu. `alias` pochodzi z osobnego wejścia i
  wybiera kandydata. Sprawdzenie case grant działa wyłącznie, gdy przekazano
  `requestedTarget`. Niezależna próba z case zawierającym connections private i
  SonderMind, ale grantem tylko private, wywołała resolver z aliasem
  `sondermind` bez targetu; wynik wybrał connection `work` i zwrócił jego pełny
  scope `work/service`.
- Wpływ: caller/model lub zainfekowana treść może wybrać inny account policy
  context w mixed case, a downstream otrzymuje szersze connection scopes mimo
  braku case grant. Narusza AC2/AC3 i Master Plan §3.4/§9.
- Wymagana zmiana: związać dozwolony alias/policy context trwale z case albo
  deterministycznie wyprowadzić go z jego exact grants; resolver ma failować bez
  autorytatywnego contextu i zwracać wyłącznie przecięcie case grants, nie pełne
  connection scopes. Dodać test mixed-case dla aliasu bez `requestedTarget` i
  test kształtu zwracanych scopes.

### HIGH-02 — AWS reconciliation potwierdza istnienie, nie tożsamość wersji

- Lokalizacja: `packages/policy/src/credential-vault.ts:198-244`,
  `packages/policy/src/credential-refresh.ts:215-231`,
  `packages/policy/src/credential-refresh.ts:245-259`,
  `packages/policy/src/credential-refresh.ts:296-311`.
- Dowód 1: AWS `put` zamienia każdy non-`ResourceExistsException`, w tym
  wyczerpany transport timeout po przyjęciu requestu, w
  `CredentialVaultUnavailableError`. Coordinator uzgadnia tylko
  `CredentialWriteAmbiguousError`. Próba `CreateSecret` → `TimeoutError` miała
  wywołania tylko `[CreateSecretCommand]`, bez `DescribeSecretCommand`, bez
  publikacji i z błędem sklasyfikowanym jako pewna niedostępność; intent pozostaje
  `PENDING`, a nie `AMBIGUOUS`.
- Dowód 2: `head` zwraca opcjonalny `versionId`, lecz obie ścieżki coordinatora
  odczytują tylko `.exists`. Fault probe zwracający `exists=true` i inny
  `versionId` doprowadził do `markVaultWritten` oraz publikacji. Dodatkowo AWS
  `head` bierze pierwszy klucz z `VersionIdsToStages`, a `ResourceExistsException`
  jest traktowany jako sukces bez żadnego probe.
- Wpływ: connection może wskazać obiekt, którego dokładnej wersji nie utworzył
  oceniany intent; status unknown write jest niezgodny z run-safety, a automatyczne
  wznowienie może zaakceptować obcy/stary obiekt pod oczekiwanym ref. Narusza
  AGENTS.md §8 i Master Plan §6.2.
- Wymagana zmiana: klasyfikować błędy transportowe/timeout i inne wyniki o
  nieznanym skutku jako ambiguous, uzgadniać je przed oznaczeniem write jako
  potwierdzony oraz wymagać `probe.versionId === intent.versionId`. Tak samo
  potwierdzić exact version po `ResourceExistsException`; brak lub mismatch ma
  pozostać `AMBIGUOUS`, bez publikacji. Dodać testy AWS timeout-after-accept,
  ResourceExists z matching/mismatched version i unordered/multi-version
  `VersionIdsToStages`.

### HIGH-04 — `operationId` nie jest związany z pierwotnym connection scope

- Lokalizacja: `packages/database/src/repositories/credential-refresh-intent.ts:46-74`,
  `packages/policy/src/credential-refresh.ts:187-205`,
  `packages/policy/src/credential-refresh.ts:270-280` oraz analogiczny
  `InMemoryCredentialRefreshIntentStore.begin`.
- Dowód: `ON CONFLICT (operation_id) DO NOTHING` zwraca istniejący intent bez
  sprawdzenia, czy `connectionId`, `ownerId`, `provider` i `expectedRevision`
  odpowiadają nowemu requestowi. Coordinator używa ref/revision z intentu, lecz
  do publishera przekazuje `input.connectionId`. Niezależna próba pozostawiła
  `shared-op` jako `VAULT_WRITTEN` dla `conn-a`, po czym retry tego samego ID dla
  `conn-b` opublikował do `conn-b` ref
  `connections/conn-a/credentials/<version>` i zwrócił go jako sukces.
- Wpływ: kolizja/reuse idempotency key może skrzyżować credential reference między
  połączeniami, ownerami lub aliasami. To bezpośredni cross-account leakage i
  fail-open w głównym zakresie RA-005.
- Wymagana zmiana: fail-closed porównać wszystkie immutable identity fields
  istniejącego intentu z requestem przed jakimkolwiek probe/publish; publisher ma
  używać wyłącznie zweryfikowanej tożsamości intentu. Wzmocnić DB/repository
  conflict path i dodać unit oraz real-PostgreSQL concurrency tests dla kolizji
  operation ID między connection/owner/provider/revision.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS; 24/24 pliki, 421/421 testów, realny PostgreSQL. |
| `pnpm exec tsx --eval '<AWS timeout + version mismatch + alias + operation collision probes>'` | 0 | Timeout: tylko CreateSecret, brak Describe; mismatched version opublikowana; alias bez targetu wybrał work; `conn-b` dostał ref `conn-a`. |
| `git diff --check` | 0 | Brak błędów whitespace. |
| Inspekcja migracji 016/017 i test `migrations.integration` w pełnej bramce | 0 | Up/down/up przechodzi; composite FK dla case-resource grant jest poprawny i fail-closed. |
| `pnpm workflow:validate` przed audytem | 0 | `workflow:validate OK — 26 tasks`. |

Środowisko nadal zgłasza Node `25.2.1` przy pinie `24.19.0` oraz istniejące
ostrzeżenia ESLint boundaries. Nie spowodowały błędu bramki. Oficjalna referencja
AWS użyta do oceny semantyki:
`https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html`.

## Ryzyka przekrojowe

- Security/privacy: HIGH-03 jest zamknięty, ale alias/context i idempotency-key
  collision nadal pozwalają przekroczyć granicę account/connection.
- Idempotencja/recovery: stabilny ref i durable lifecycle są postępem, lecz
  potwierdzenie samego istnienia nie wystarcza do przypisania side effectu do
  konkretnego intentu.
- Współbieżność: DB CAS chroni credential revision, ale nie chroni semantyki
  globalnie kolidującego `operationId`.
- Migracje: 016/017 są addytywne, rollback działa, a case resource FK poprawnie
  usuwa grant po usunięciu membership lub connection scope.

## Wymagane działania po `continue`

1. OpenCode Bedrock wiąże alias/context z autorytatywnym case scope i zwraca
   wyłącznie case-filtered scopes; dodaje no-target/mixed-alias tests.
2. OpenCode Bedrock wymusza exact vault version reconciliation dla AWS i
   poprawnie klasyfikuje timeout/transport ambiguity; dodaje AWS fault tests.
3. OpenCode Bedrock wiąże `operationId` z immutable connection/owner/provider/
   revision identity i failuje kolizje przed publish; dodaje DB concurrency tests.
4. Implementer uruchamia `RA_REQUIRE_POSTGRES=1 pnpm check`, zapisuje
   `HANDOFF-03.md` i ponownie ustawia `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Zielona bramka potwierdza jakość mechaniki, a HIGH-03 i część resource grant
HIGH-01 są rzeczywiście naprawione. Dwa kryteria akceptacji pozostają jednak
niespełnione, a niezależne próby odtwarzają cross-context i cross-connection
credential paths. Findingi są naprawialne w zakresie RA-005, dlatego właściwy
werdykt to `CHANGES_REQUIRED`, nie `BLOCKED`.
