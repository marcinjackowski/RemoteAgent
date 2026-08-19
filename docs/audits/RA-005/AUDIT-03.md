# RA-005 — Audit 03

## Metadata

- Task: `RA-005`
- Audytowany handoff: `docs/handoffs/RA-005/HANDOFF-03.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja RA-002–RA-005 pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Wszystkie trzy findingi z AUDIT-02 zostały naprawione w testowanych scenariuszach:
resolver wiąże selection z case grantami i zawęża zwracane scopes, AWS uzgadnia
dokładny AWSCURRENT `versionId`, a kolizja operation ID między różnymi
tożsamościami failuje zamknięcie. Pełna bramka przechodzi: 24/24 pliki i 440/440
testów na realnym PostgreSQL.

`PASS` nadal nie jest dozwolony. Niezależny test wymaganego token-refresh race
odtworzył HIGH-05: dwa równoległe retry TEGO SAMEGO operation ID współdzielą
vault ref; przegrany CAS usuwa credential opublikowany przez zwycięzcę. Dodatkowo
stale grant bez requested target nadal wybiera connection, mimo że przecięcie z
aktualnym connection scope jest puste.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Publiczny model/repository DTO nie zawiera tokenu ani secret value | PASS | Bez regresji; wyłącznie opaque ref i lifecycle. |
| 2. Model-supplied connection/repo ID nie poszerza scope aktualnego case | FAIL | Normalne grants i mixed-alias są zawężone, lecz stale grant + brak targetu nadal selekcjonuje credential-bearing connection. MEDIUM-06. |
| 3. Private i SonderMind mają rozłączne identities i policy context | PASS | Connection wymaga grantu na konkretnym connection ID, a wynik zawiera tylko grant ∩ configured scope. |
| 4. Revoked/expired connection failuje zamknięcie z jasnym health status | PASS | Bez regresji. |
| 5. Canary secret nie pojawia się w logach, błędach ani serialized context | PASS | Bez regresji; callback errors i bare token pozostają redagowane. |
| 6. Kill switch blokuje nowe efekty bez usuwania audit evidence | PASS | Bez regresji; wszystkie poziomy i append-only ledger przechodzą. |

## Findingi

### HIGH-05 — Równoległy retry tego samego intentu usuwa credential zwycięzcy

- Lokalizacja: `packages/policy/src/credential-refresh.ts:237-360`, szczególnie
  `:297-328` i `:355-358`; store methods `recordLifecycle`/status nie zapewniają
  claim/fencing dla jednego wykonawcy operation ID.
- Dowód: niezależny test uruchomił dwa `CredentialRefreshCoordinator.refresh`
  równolegle z identycznym `operationId`, connection/owner/provider/revision i
  stabilnym ref. Oba wykonały `acquire` (`acquireCalls=2`) i doszły do publish.
  Jeden CAS wygrał (`revision=1`, wynik fulfilled), drugi dostał `false`, wykonał
  `#bestEffortRevoke(ref)` i zwrócił conflict. Po zakończeniu
  `publishedRefStillExists=false`, mimo że metadata zwycięzcy wskazuje ten ref.
- Wpływ: poprawnie opublikowane połączenie wskazuje nieistniejący/revoked secret,
  powodując awarię auth. Przy różnych wynikach `acquire` lifecycle opublikowany
  przez zwycięzcę może też nie odpowiadać wartości zapisanej przez drugiego
  wykonawcę. Narusza wymóg token refresh race, AGENTS.md §8 oraz run-safety.
- Wymagana zmiana: zapewnić dokładnie jednego aktywnego wykonawcę na operation ID
  przy zachowaniu crash recovery (durable claim/lease z fencing albo atomowa
  state-machine transition). Równoległy obserwator ma odczytać/uzgodnić wynik,
  nigdy ponownie acquire/write/revoke wspólnego ref. Cleanup po przegranym CAS
  może usuwać tylko ref należący wyłącznie do przegrywającego intentu; dla tego
  samego intentu nie wolno usuwać ref potencjalnego zwycięzcy. Dodać unit i
  real-PostgreSQL concurrency test dokładnie dwóch równoległych refresh tego
  samego operation ID, potwierdzający jeden acquire/write/publish, zachowany
  credential i terminalny status zgodny z CAS.

### MEDIUM-06 — Stale case grant bez targetu nadal selekcjonuje connection

- Lokalizacja: `packages/policy/src/scope.ts:82-103` i `:120-142`.
- Dowód: candidate filter wymaga `grantsByConnection.has`, czyli surowego grantu,
  zanim policzy jego przecięcie z aktualnym `selected.scopes`. Próba z membership
  i stale repository grantem, ale pustym connection scope, bez
  `requestedTarget`, zwróciła connection `conn-a` z `scopes=[]` zamiast
  `ScopeResolutionError`.
- Wpływ: race między odczytami lub błędnie złożony authoritative snapshot może
  udostępnić credential-bearing connection/capability bez żadnego aktualnego
  exact grant. Puste scopes pomagają downstreamowi, ale nie egzekwują fail-closed
  na granicy resolvera i nie chronią operacji account-level/no-target.
- Wymagana zmiana: budować candidates z niepustego przecięcia case grants ∩
  configured scopes, a nie z samej obecności surowego grantu; gdy przecięcie jest
  puste, failować przed wyborem connection. Dodać stale-grant/no-target test.

## Zamknięte findingi z AUDIT-02

- HIGH-01: CLOSED dla normalnego i mixed-alias contextu; wynik scopes jest
  case-filtered.
- HIGH-02: CLOSED; timeout/ResourceExists przechodzą reconciliation, a mismatch
  lub brak exact AWSCURRENT version nie publikuje.
- HIGH-04: CLOSED; identity mismatch dla operation ID failuje przed probe/publish,
  również przy konkurencji na realnym PostgreSQL.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS; 24/24 pliki, 440/440 testów, realny PostgreSQL. |
| `pnpm exec tsx --eval '<same-operation race + stale-grant no-target>'` | 0 | Jeden CAS wygrał, drugi odwołał wspólny ref; po sukcesie vault nie zawierał opublikowanego credentiala. Stale grant wybrał connection ze scopes=[] zamiast fail-closed. |
| `git diff --check` | 0 | Brak błędów whitespace. |

## Wymagane działania po `continue`

1. OpenCode Bedrock implementuje crash-safe single-executor/fencing dla jednego
   credential-refresh operation ID i concurrency tests na local oraz realnym PG.
2. OpenCode Bedrock failuje resolver, gdy case grant ∩ configured scope jest
   pusty, również bez requested target.
3. Implementer uruchamia `RA_REQUIRE_POSTGRES=1 pnpm check`, zapisuje
   `HANDOFF-04.md` i ustawia `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Remediacja AUDIT-02 jest materialnym postępem, lecz HIGH-05 pozostawia po
poprawnym CAS połączenie wskazujące usunięty secret, a MEDIUM-06 nie spełnia
fail-closed no-target. Oba findingi są naprawialne w zakresie RA-005, dlatego
werdykt to `CHANGES_REQUIRED`, nie `BLOCKED`.
