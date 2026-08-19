# HANDOFF-06 — RA-005 Connections, secrets and scope isolation

## Metadata

- Task: RA-005 Connections, secrets and scope isolation
- Mode: IMPLEMENTER
- Handoff: HANDOFF-06
- Milestone: M0
- Status change: `IN_PROGRESS` -> `AWAITING_AUDIT`
- Scope: remediacja findingów AUDIT-05 HIGH-10, HIGH-11 oraz MEDIUM-12.
- Zmiana kontraktów: TAK. Publiczne interfejsy `CredentialMetadataPublisher`
  i `CredentialRefreshIntentStore` w `@remoteagent/policy` uległy zmianie
  (patrz sekcja „Zmiany kontraktów”). Dodano addytywną migrację 019.

## Sprostowanie MEDIUM-12 (jawna korekta HANDOFF-05)

HANDOFF-05 zawierał trzy stwierdzenia rozbieżne z kodem. Prostuję je jawnie
(HANDOFF-05 jest append-only i nie był edytowany):

1. „Bez zmian kontraktów i architektury” — BŁĘDNE. HANDOFF-05 wprowadził realnie
   zmienione publiczne interfejsy store (`acquireLease`/`renewLease`/
   `releaseLease`, lease/fencing) oraz publishera (`reconcile`). Handoff powinien
   był to zadeklarować. Obecny HANDOFF-06 kontynuuje te zmiany interfejsów i
   deklaruje je wprost.
2. „`PUBLISHED_OTHER` nie kontynuuje revoke” — BŁĘDNE. Kod
   `credential-refresh.ts` w gałęzi `PUBLISHED_OTHER` wykonuje
   `#bestEffortRevoke(ref)` na WŁASNYM, unikatowo kluczowanym i
   nieopublikowanym refie, następnie `markAborted` i rzuca
   `CredentialRefreshConflictError`. Revoke własnego, nieopublikowanego obiektu
   nie może usunąć credentiala zwycięzcy.
3. „`NOT_PUBLISHED` daje niejednoznaczne przejście” — BŁĘDNE. `NOT_PUBLISHED`
   ma dwie deterministyczne ścieżki zależne od tego, czy `publish()` rzucił, czy
   zwrócił `false` (patrz tabela outcome → status → cleanup poniżej).

### Tabela outcome → status → cleanup (publikacja metadanych)

`#reconcilePublish` (po `publish()` throw = `thrown≠undefined`, po `publish()`
== false = `thrown=undefined`):

| Wejście | Status końcowy | Cleanup vault | Wynik dla wołającego |
|---|---|---|---|
| brak `reconcile` (adapter niezgodny) | `AMBIGUOUS` | brak revoke | rzut `CredentialWriteAmbiguousError` |
| `reconcile` rzuca | `AMBIGUOUS` | brak revoke | rzut `CredentialWriteAmbiguousError` |
| `PUBLISHED_THIS` | `PUBLISHED` | brak revoke (zachowany) | zwraca `ref` (sukces) |
| `PUBLISHED_OTHER` | `ABORTED` | revoke WŁASNEGO nieopublikowanego refu | rzut `CredentialRefreshConflictError` |
| `NOT_PUBLISHED`, `thrown≠undefined` (publish rzucił) | pozostaje `VAULT_WRITTEN` | brak revoke | rethrow oryginalnego błędu (retry re-publikuje) |
| `NOT_PUBLISHED`, `thrown=undefined` (publish false) | `ABORTED` | revoke WŁASNEGO nieopublikowanego refu | rzut `CredentialRefreshConflictError` |
| `UNKNOWN` | `AMBIGUOUS` | brak revoke | rzut `CredentialWriteAmbiguousError` |

### Tabela outcome → status → cleanup (takeover ACQUIRING)

`#resumeAcquiring` (nigdy nie powtarza `input.acquire()`):

| Wejście | Status końcowy | Cleanup | Wynik |
|---|---|---|---|
| `vault.head` rzuca (probe niedostępny) | `AMBIGUOUS` | brak revoke | rzut `CredentialWriteAmbiguousError` |
| brak obiektu / mismatch wersji / brak lifecycle | `AMBIGUOUS` | brak revoke | rzut `CredentialWriteAmbiguousError` |
| dokładna wersja + zapisany lifecycle | `VAULT_WRITTEN` | brak | wznowienie publish bez re-acquire |

## Zmiany kontraktów

- `CredentialMetadataPublisher.reconcile` jest teraz OBOWIĄZKOWĄ metodą
  kontraktu (usunięto `?`). Value-free reconciliation nie może być dobrowolną
  funkcją adaptera — bezpieczeństwo runu nie zależy od opcjonalnej metody
  (AUDIT-05 HIGH-10).
- `CredentialRefreshIntentStore.markAcquiring(operationId, lease)` — nowa,
  fenced mutacja zapisująca trwały stan `ACQUIRING` PRZED `input.acquire()`.
- `RefreshIntentStatus` (policy i database) zyskał wartość `ACQUIRING`.

## Remediation

### HIGH-10 — obowiązkowa value-free reconciliation, brak destrukcyjnego fallbacku

- `credential-refresh.ts`: `reconcile` wymagane w interfejsie; usunięto gałąź
  fallbacku, która przy braku reconcilera wykonywała `revoke` + `markAborted` +
  `Conflict` (dokładne odtworzenie HIGH-07). Pozostawiono defensywny runtime
  guard: gdy `reconcile === undefined` (adapter niezgodny) LUB `reconcile`
  rzuca — coordinator bezwarunkowo `markAmbiguous`, bez revoke i bez replay.
- Wszystkie adaptery/mocki zaktualizowane: real-PG publishery
  (`case-scope-and-refresh.integration.test.ts`) mają exact-ref/current-revision
  `reconcile`; unit mocki dostały bezpieczny `reconcile` (`NOT_PUBLISHED`
  helper) lub realistyczny `PUBLISHED_OTHER`. `FakeMetadataPublisher` już
  implementował `reconcile`.

### HIGH-11 — trwały ACQUIRING, bezpieczny takeover, atomowy renewal, latch heartbeat

- Migracja `019_credential_refresh_acquiring` (addytywna nad 017/018): rozszerza
  named CHECK `credential_refresh_intents_status_check` o `ACQUIRING`; down
  zawęża constraint z powrotem do zbioru 017 (poprawny fail-closed reversal,
  weryfikowany przez migrations up/down/up round-trip). 017 i 018 nie są
  edytowane.
- Coordinator zapisuje `ACQUIRING` pod aktualnym fenced lease PRZED
  `input.acquire()`. Tylko świeży `PENDING` może rozpocząć acquire.
  `VAULT_WRITTEN` wznawia publish. Takeover wygasłego `ACQUIRING` NIGDY nie
  ponawia OAuth acquire: `#resumeAcquiring` robi value-free vault probe —
  dokładna wersja + lifecycle → wznów publish; wszystko inne → `AMBIGUOUS`
  (manual reconciliation), bez revoke.
- Crash windows: crash między `markAcquiring` a `acquire` (obiekt nie istnieje)
  oraz między `acquire` a zapisem vault (obiekt nie istnieje) → takeover kończy
  `AMBIGUOUS` (konserwatywnie bezpieczne, bo OAuth acquire jest
  nieidempotentny i nie da się dowieść, że nie nastąpił). Crash między
  `vault.put` a `markVaultWritten` (obiekt z dokładną wersją + lifecycle) →
  takeover wznawia publish bez re-acquire.
- `renewLease` (DB i InMemory) atomowo wymaga `lease_expires_at > now()`
  (DB: `AND lease_expires_at > now()`; InMemory: `expiresAt > now()`). Wygasłego
  lease nie da się wskrzesić; peer przejmuje autorytatywnie.
- Heartbeat: nieudane/utracone renewal jest LATCHOWANE (`Heartbeat.lost()`).
  Coordinator sprawdza `#assertLeaseHeld` przed każdym external side effectem
  (`markAcquiring`, `acquire`, `vault.put`, `publish`) i fenced mutacją.
  Heartbeat pozostaje optymalizacją liveness — realne bezpieczeństwo daje fenced
  durable mutation (zero rows → `CredentialRefreshLeaseLostError`).

## Tests

- unit (`packages/policy/test/connection-security.test.ts`, 53 testy):
  - HIGH-10: publisher bez `reconcile` przy `publish` throw → `AMBIGUOUS`, ref
    NIE revokowany; publisher bez `reconcile` przy `publish=false` → `AMBIGUOUS`,
    ref NIE revokowany (dawniej revoke).
  - HIGH-11: takeover wygasłego `ACQUIRING` bez obiektu vault → `AMBIGUOUS`,
    `acquireCalls=0`, `publishCalls=0`, wynik terminalny (brak auto-replay);
    takeover `ACQUIRING` z ocalałym dokładnym zapisem → wznów publish,
    `acquireCalls=0`; renewal po deadline → `false`, peer przejmuje; przepisano
    test heartbeat tak, by renewal następował PRZED deadline (renewal po
    deadline musi przegrać).
  - happy paths (idempotencja, single-winner, HIGH-02/04/05/07/08) bez regresji.
- real PG (`packages/database/test/case-scope-and-refresh.integration.test.ts`):
  - odmowa renewal wygasłego lease + autorytatywny takeover peera;
  - takeover wygasłego `ACQUIRING` bez obiektu vault → `AMBIGUOUS`,
    `acquireCalls=0`, `publishCalls=0`, brak rotacji połączenia;
  - `reconcile` (exact-ref/current-revision) dla commit-then-lost i
    markPublished-failure bez regresji.

### Evidence

- Komenda: `RA_REQUIRE_POSTGRES=1 pnpm check` — exit 0
  (lint + format + typecheck + test + build + workflow:validate).
- Komenda: `RA_REQUIRE_POSTGRES=1 pnpm test` — exit 0; 24 pliki / 463 testy
  (było 456; +7 nowych).
- Build: 20/20 (turbo).
- Komenda: `git diff --check` — clean.
- Komenda: `pnpm workflow:validate` — `OK — 26 tasks`.

## Risks

- Konserwatywny `AMBIGUOUS` przy takeover `ACQUIRING` bez ocalałego zapisu może
  wymagać ręcznej reconciliacji nawet, gdy OAuth acquire faktycznie nie nastąpił
  (nieodróżnialne od „acquire wysłany, crash przed zapisem”). Świadomy trade-off
  na rzecz braku powtórzenia nieidempotentnego side effectu.
- Down 019 zakłada brak wierszy `ACQUIRING` w chwili downgrade’u (fail-closed);
  to poprawne dla reversalu schematu.
- Heartbeat latch bazuje na zaplanowanych tickach; przy `renewIntervalMs<=0`
  (single-process/tests) `lost()` zawsze `false`, a bezpieczeństwo zapewniają
  fenced mutacje. Latch nie zastępuje fencingu — jest warstwą dodatkową.
