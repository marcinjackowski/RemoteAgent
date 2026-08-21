# RA-023 — Work units

## Metadata

- Task: `RA-023`
- Plan revision: `2`
- Rola: jedna rola wykonawcza (ADR-0007). Rewizja `1` była pisana pod ADR-0005;
  ta rewizja usuwa rozdział koordynator/implementer i zapisuje wynik badania AC1.
- Plan status: `DONE` — wszystkie zależności `DONE` (RA-010, RA-016, RA-021, RA-022).
- Base commit: `2c05ca3` (stan po domknięciu RA-022)
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test`

## ROZSTRZYGNIĘCIE ZAKRESU — [ADR-0008](../../decisions/ADR-0008-agentcore-gateway-verdicts.md)

Badanie AC1 (`docs/research/RA-023-CAPABILITY-MATRIX.md`, weryfikacja
`2026-08-21`) podważyło przesłankę zakresu, a właściciel rozstrzygnął
`2026-08-21`: **`DEFER` dla wszystkich providerów, `REJECT` dla Gateway'a jako
warstwy IaC.** Weryfikacja wyłącznie przeciwko fake'om — żadnych wywołań AWS.

Konsekwencja dla units: `WU-01`, `WU-02` i `WU-03` **odstąpione** (budowały
boundary i drugi silnik credentiali dla targetów, których nie adoptujemy).
Wykonane: `WU-00`, `WU-04`, `WU-05` (zawężony).

## Global boundaries

- In scope: weryfikacja i — **tylko gdzie bezpieczne** — wdrożenie AgentCore
  Gateway/Identity jako managed MCP boundary, plus capability matrix i fallbacki.
- Out of scope: usunięcie własnych ingress connectorów i przeniesienie source of
  truth do AgentCore. **Postgres pozostaje authority.**
- **Model nie otrzymuje refresh ani access tokenów** (AC5).
- **Brak live contract testów i brak jakiegokolwiek deploymentu bez jawnej
  autoryzacji właściciela** (AC z Required verification: „contract tests live tylko
  po jawnej autoryzacji właściciela").

## Ustalenia z kodu przed planowaniem (2026-08-20)

1. **KRYTYCZNE: refresh/credential lifecycle JUŻ ISTNIEJE.**
   `packages/policy/src/credential-refresh.ts` zawiera `RefreshLease`,
   `RefreshedCredential`, `RefreshIntent`, `BeginRefreshIntentInput`,
   `CredentialRefreshIntentStore`, `CredentialMetadataPublisher`,
   `assertSameIntentIdentity`, plus typed błędy (`CredentialRefreshConflictError`,
   `CredentialRefreshIdentityError`, `CredentialRefreshLeaseLostError`).
   `packages/policy/src/credential-vault.ts` zawiera `CredentialVault`,
   `CredentialWriteAmbiguousError`, `CredentialUsageError`.
   **RA-023 NIE może zbudować drugiego silnika tokenów** — ma się oprzeć na tym
   lifecycle. Duplikat byłby findingiem BLOCKER: dwa niezależne mechanizmy refresh
   nad tymi samymi credentialami to gwarantowany wyścig i utrata tokenu.
2. **`CTF-001` dotyczy dokładnie tej granicy.** `packages/policy` i
   `packages/database` definiują dwie różne klasy `CredentialRefreshConflictError`
   i `CredentialRefreshIdentityError`; `instanceof` między nimi zwraca `false`.
   RA-023 spina te warstwy, więc **`CTF-001` powinien być domknięty przed tym
   taskiem** albo jako jego pierwszy unit.
3. **`packages/workspace-runner` ma już fencing i recovery**
   (`fencing.ts`, `recovery.ts`, `WorkspaceFence`). Spike AgentCore Runtime musi
   traktować sesję jako **transport/cache**, nie authority — checkpoint zostaje w
   Postgresie (AC6).
4. **Werdykty `ADOPT/DEFER/REJECT`, maturity i capabilities wymagają świeżej
   weryfikacji oficjalnej dokumentacji.** Preflight z handoffu transferowego wprost
   to zaznacza. Stan Preview/Beta zmienia się szybko; werdykt oparty na pamięci
   modelu jest bezwartościowy. To praca badawcza z cytowanymi źródłami, nie
   implementacyjna.

## Korekty po red-teamie (z preflightu, do utrzymania)

1. **Opaque OAuth/credential session boundary oparta na ISTNIEJĄCYM refresh
   lifecycle — bez drugiego silnika tokenów.**
2. **One-shot AgentCore Runtime/session handoff:** Postgres/checkpoint pozostaje
   authority, sesja jest tylko transportem/cache.
3. **Werdykty i capabilities wymagają świeżej weryfikacji oficjalnej dokumentacji.**
4. **Bez live contract testów i bez deploymentu bez jawnej autoryzacji właściciela.**

## Unit index (DRAFT)

| Unit | Status | Result | Komenda weryfikacyjna |
|---|---|---|---|
| `RA-023-WU-00` | **`DONE`** | `CTF-001` domknięty — jedna definicja `CredentialRefresh*Error` + `RefreshIntentStatus` w `contracts` | `pnpm vitest run packages/policy/test/credential-error-identity.test.ts` → `10/10`, exit `0` |
| `RA-023-WU-01` | **`ODSTĄPIONY`** | target registry dla targetów, których nie adoptujemy (ADR-0008) | — |
| `RA-023-WU-02` | **`ODSTĄPIONY`** | fallbackiem są istniejące, zaudytowane adaptery RA-016/017/019/020 | — |
| `RA-023-WU-03` | **`ODSTĄPIONY`** | drugi silnik tokenów byłby findingiem BLOCKER (punkt 1 „Ustaleń z kodu") | — |
| `RA-023-WU-04` | **`DONE`** | sesja runtime jako transport, Postgres jako authority (AC6) | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test/runtime-session.integration.test.ts` → `12/12`, exit `0` |
| `RA-023-WU-05` | **`DONE`** (zawężony) | containment: zewnętrzny boundary może ZAWĘŻAĆ, nigdy POSZERZAĆ (AC3) | `pnpm vitest run packages/policy/test/external-boundary.test.ts` → `34/34`, exit `0` |

Osobno, jako praca badawcza koordynatora (nie work unit implementera):
**capability/status matrix i ADR z werdyktami `ADOPT/DEFER/REJECT`** dla Atlassian
Rovo MCP, Google Gmail/Calendar MCP, GitLab MCP i opcjonalnego Slack MCP — oparte
na świeżo zweryfikowanej oficjalnej dokumentacji, z cytatami i datą weryfikacji.
Implementer nie wykonuje research; koordynator nie deleguje decyzji architektonicznej.

## Stan wykonania (`2026-08-21`)

Ustalenia z uruchomionych komend i sond. To jedyny nośnik pamięci między sesjami.

### `WU-00` — `CTF-001` domknięty

Jedna definicja w `packages/contracts/src/credential-refresh-errors.ts`; `database` i
`policy` re-eksportują. **Rekomendacja rejestru (policy importuje z database) jest
niewykonalna** — `database` devDependuje na `policy`, więc krawędź w tę stronę czyni
graf turbo cyklicznym (zmierzone w RA-022-WU-01). Wariant „różne nazwy" też odrzucony:
semantyka jest identyczna, więc dwie nazwy na jedno znaczenie utrwaliłyby duplikat.

`PersistenceError` **nie** został odtworzony jako baza: refresh conflict to wynik
domenowy, nie awaria persystencji, a nic w repo nie łapie tych klas przez
`PersistenceError` (sprawdzone).

Sonda (7 sond) potwierdziła zachowanie: **komunikaty obu pakietów są bajtowo
identyczne** z poprzednimi, więc żaden runbook ani regex alertu się nie psuje.
Finding: `this.name` z literału powodował, że **subklasa raportowała nazwę rodzica** —
naprawione na `new.target.name`.

Osobno: `turbo run typecheck --force` wyłapał fixture testowy podający trzy pola,
których `assertSameIntentIdentity` nie przyjmuje (`TS2353`), a transform vitesta to
przepuszczał. To `CTF-004` i tu bramka zarobiła na siebie.

### `WU-04` — sesja to transport, Postgres to authority (AC6)

`packages/policy/src/runtime-session.ts`: `reconcileSession` porównuje deklarację sesji
z trwałym stanem i zwraca **zawsze stan DURABLE**, nawet na ścieżce sukcesu — żeby
caller nie mógł przypadkiem rozpropagować przekonania sesji.

Rozróżnienie, które trzeba utrzymać: **`STALE_REVISION` (za sesją) i
`UNCOMMITTED_AHEAD` (przed) to różne awarie.** Pierwsza znaczy „przeładuj i kontynuuj",
druga „praca została utracona, ktoś powinien spojrzeć". Jeden kod `MISMATCH` ukryłby
drugą — a to ta groźna.

Dokumentacja AWS **potwierdza** to założenie wprost: sesja domyślnie efemeryczna,
ubijana po 15 minutach bezczynności, i „AgentCore does not enforce session-to-user
mappings". Postgres jako authority jest udokumentowaną postawą dostawcy, nie obejściem.

### `WU-05` — containment: zawężać wolno, poszerzać nie (AC3)

`packages/policy/src/external-boundary.ts`. Pięć rzeczy, których zewnętrzny boundary
nie może: obniżyć tieru, wprowadzić connectiona poza scope case'a, **zadeklarować
ownera w ogóle**, zadeklarować decyzji policy, wprowadzić narzędzia poza registry.

Owner i decyzja policy są odrzucane **na obecność, nie na wartość**. Zaakceptowanie
zgodnego ownera implikowałoby, że zewnętrzna deklaracja może być autorytatywna, gdy
akurat się zgadza — a w dniu, w którym się nie zgodzi, porównanie jest jedyną obroną.

Fake jest **wrogi**, nie kooperatywny: kooperatywny dowodzi tylko happy patha, a ryzyko
to boundary przypisujący sobie władzę.

### Sondy adwersarialne — 3 findingi przy zielonych testach

| Sonda | Finding | Naprawa |
|---|---|---|
| `WU-05` PROBE 9 | case scoped na `jira` dostawał `gmail.draft.create`, `calendar.event.*`, `gitlab.*` — bo provider był sprawdzany **tylko gdy boundary go zadeklarował**, więc oferta bez deklaracji pomijała kontrolę | provider **derywowany z nazwy narzędzia** (fakt server-owned), nie z deklaracji |
| `WU-05` PROBE 3 | manifest 20 000 ofert → 20 000 dopuszczonych, bez limitu | `MAX_BOUNDARY_OFFERS = 64` (jak `MAX_MANIFEST_TOOLS` w RA-021), odrzucany **całościowo**, nie ucinany |
| `WU-05` PROBE 2 | trzy identyczne oferty → trzy capability | dedup, `DUPLICATE_OFFER` |

**Najważniejsza nauka:** w PROBE 9 **pominięcie BYŁO obejściem** — najbezpieczniej
wyglądający manifest (nic nie deklarujący) był tym, który przechodził. To `CTF-010`
finding 4 o poziom wyżej: nie „brak deklaracji = zgoda", ale „brak deklaracji = brak
kontroli".

Limit odrzuca manifest **całościowo**, bo ucięcie do pierwszych 64 oddałoby wybór
„które 64" temu, kto kontroluje kolejność — czyli boundary'emu.

Sondy bez findingu (sprawdzone, fail-closed): nazwy z prototypu
(`constructor`, `__proto__`), owner strukturalnie nieosiągalny z deklaracji sesji,
fencing token nie-liczbowy, rewizja ujemna/`MAX_SAFE_INTEGER`.

### Mutation check — 30 mutacji, wszystkie łapane

`WU-00` 3, `WU-05` 15, `WU-04` 8, plus 4 na drugich asercjach
(`assertNoWidening`, `assertSessionCarriesNoAuthority`, `assertEveryToolHasProvider`).
Żadna nie przeżyła — w odróżnieniu od RA-022, gdzie przeżyło dziewięć. Powód jest
prawdopodobnie ten, że wzorzec „mutacja przeżywa tam, gdzie warstwa wyżej sprawdza to
samo wcześniej" był już znany i testy pisałem od razu celując w fence bezpośrednio.

### Uruchomione bramki

```text
packages/policy/test                      239/239, 9 plików, exit 0
całe repo                                 1793/1793, 141 plików, 2 przebiegi
turbo run typecheck --force               36 successful, 0 cached
pnpm run build --force                    26 successful, 0 cached
eslint + prettier                         czysto
sonda wartościowa i type-level            brak nowych kolizji; `CredentialRefresh*` znikły
git diff --check                          exit 0
```

## Wymagania do rozdzielenia na units

- **AC1 (każdy provider ma udokumentowany werdykt i dowody)** → praca badawcza
  koordynatora + ADR; nie unit implementera.
- **AC2 (Preview/Beta target ma działający, testowany fallback)** → `WU-02`;
  fallback deterministyczny, nie „spróbuj i zobacz".
- **AC3 (Gateway policy nie poszerzy lokalnej policy ani owner/case scope)** →
  `WU-01` + `WU-05`; podwójna warstwa policy jest w audit focus — test
  adwersarialny, w którym Gateway zwraca szerszy scope niż lokalny.
- **AC4 (OAuth revoke i schema drift wykrywane, fail-closed)** → `WU-02` + `WU-03`;
  mocked revoke i drift.
- **AC5 (model nie otrzymuje refresh/access tokenów)** → `WU-03`; wzór
  `token.fill(0)` z RA-016; test, że token nie występuje w żadnej powierzchni
  model-facing.
- **AC6 (Runtime restart nie traci case state — odtwarza z Postgresa)** → `WU-04`;
  test stop/resume z zewnętrznym checkpointem.

## Final task gate

Koordynator uruchamia pełną suite, całe repo bez regresji,
typecheck/build/scoped lint/format, `pnpm workflow:validate`, `git diff --check`,
sondę przecięcia eksportów, oraz osobno weryfikuje sześć kryteriów akceptacji — w
szczególności brak drugiego silnika refresh (przegląd kodu, nie tylko testy),
Gateway próbujący poszerzyć scope, oraz restart Runtime bez utraty state.
**Żaden live contract test ani deployment nie jest wykonywany bez jawnej
autoryzacji właściciela.** Następnie handoff i niezależny audyt.
