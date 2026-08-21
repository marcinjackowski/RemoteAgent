# RA-023 — AUDIT-01

- Task: `RA-023` AgentCore Gateway and official MCP targets
- Data: `2026-08-21`
- Bazowy commit: `2c05ca3` (stan po domknięciu RA-022)
- Rola: jedna rola wykonawcza (ADR-0007)
- Rozstrzygnięcie zakresu: [ADR-0008](../../decisions/ADR-0008-agentcore-gateway-verdicts.md),
  decyzja właściciela `2026-08-21`

Werdykt jest w §8.

## 1. Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/policy/test
  → 239/239, 9 plików, exit 0

RA_REQUIRE_POSTGRES=1 pnpm vitest run          (całe repo)
  → 1793/1793, 141 plików, exit 0, DWA przebiegi, zero `Errors`

pnpm turbo run typecheck --force  → 36 successful, 0 cached
pnpm run build --force            → 26 successful, 0 cached
eslint + prettier (policy)        → czysto
git diff --check                  → exit 0
```

Sonda przecięcia eksportów, wartościowa **i** type-level: brak nowych kolizji, a
`CredentialRefreshConflictError`, `CredentialRefreshIdentityError` i
`RefreshIntentStatus` **zniknęły z obu list** — to bezpośredni dowód domknięcia
`CTF-001`, nie deklaracja.

**Żadnego wywołania AWS.** Zgodnie z decyzją właściciela `2026-08-21` i wymogiem taska
(„contract tests live tylko po jawnej autoryzacji właściciela") cała weryfikacja
przeciwko fake'om in-process.

## 2. Zmiana zakresu — dlaczego jest uzasadniona, a nie wygodna

To najważniejsza rzecz do oceny w tym audycie, więc stawiam ją wprost: **trzy z sześciu
units nie zostały wykonane.** Gdyby to była decyzja implementacyjna, byłby to finding
BLOCKER (zakres bez zgody właściciela). Nie jest — jest to wykonanie AC1.

AC1 wymaga werdyktu `ADOPT`/`DEFER`/`REJECT` **z dowodami**, a plan wymaga świeżej
weryfikacji dokumentacji, bo „werdykt oparty na pamięci modelu jest bezwartościowy".
Weryfikacja została wykonana (`docs/research/RA-023-CAPABILITY-MATRIX.md`) i dała wynik,
który podważa przesłankę zakresu:

- **Google**: nie znaleziono oficjalnego serwera MCP dla Gmail/Calendar ani template'u w
  AgentCore. To dwa najdelikatniejsze providery systemu (brak cross-account leakage).
- **GitLab**: oficjalny serwer to dosłownie „Status: Beta", bez template'u.
- **Jira**: template istnieje, ale **tylko API key** — adopcja obniżyłaby nasz OAuth z
  RA-016 i wystawiła operacje R4 (`deleteIssue`, `deleteProject`) bez znajomości tierów.
- **Blokada IaC**: „You can only add an integration provider template as a target
  through the AWS Management Console and not through the API" — zakres mówił „IaC".

Decyzja należała do właściciela i została podjęta `2026-08-21`. Odstąpione units
(`WU-01`, `WU-02`, `WU-03`) budowały boundary, drugi silnik credentiali i fallback dla
targetów, o których właśnie ustalono, że ich nie adoptujemy. `WU-03` byłby wprost
findingiem BLOCKER według punktu 1 „Ustaleń z kodu" planu (drugi silnik refresh nad tymi
samymi credentialami).

Sprawdziłem osobno, że odstąpienie **nie zostawia luki**: fallbackiem dla każdego
providera jest istniejący, zaudytowany adapter (RA-016, RA-017, RA-019, RA-020), a nie
brak ścieżki.

## 3. Kryteria akceptacji — każde osobno

### AC1 — każdy provider ma werdykt i dowody → **spełnione**

`ADR-0008` + matryca. Cztery providery plus opcjonalny Slack, każdy z werdyktem,
cytatem źródła i datą weryfikacji. Zapisane też warunki ponownego rozważenia, żeby
`DEFER` nie stał się cichym „nigdy".

### AC2 — Preview/Beta target ma działający, testowany fallback → **spełnione inaczej niż planowano**

Jedyny target o potwierdzonym statusie Beta to GitLab. Jego fallback to
`packages/connector-gitlab` z RA-017 — **istniejący, zaudytowany i pokryty testami**,
nie nowy kod. Kryterium mówi „działający, testowany fallback"; adapter spełnia to
mocniej niż deterministyczny przełącznik do niewdrożonego Gateway'a.

### AC3 — Gateway policy nie poszerza lokalnej policy ani owner/case scope → **spełnione**

`containExternalManifest` + `assertNoWidening`, 34 testy. Boundary nie może: obniżyć
tieru, wprowadzić connectiona poza scope, **zadeklarować ownera w ogóle**, zadeklarować
decyzji policy, wprowadzić narzędzia poza registry, przekroczyć limitu manifestu,
zdublować narzędzia, ani przemycić narzędzia obcego providera.

Odrzucanie ownera i decyzji **na obecność, nie na wartość** — sprawdziłem to celowo,
bo zaakceptowanie zgodnej wartości byłoby subtelnym oddaniem władzy.

### AC4 — OAuth revoke i schema drift wykrywane, fail-closed → **nie dotyczy w tym zakresie**

Kryterium dotyczy wykrywania na granicy Gateway'a. Bez adopcji nie ma tej granicy.
Mechanizmy, które by je realizowały, istnieją i są zaudytowane po naszej stronie: revoke
przez `ConnectionRepository.revoke` + `assertConnectionEffectAllowed` (RA-005),
a „drift" schematu narzędzia jest u nas niereprezentowalny, bo registry jest zamknięty i
`Object.freeze`d (RA-022), a nieznane narzędzie to `UNKNOWN_ACTION`.

Odnotowuję to jawnie jako **nie spełnione, bo nie ma czego spełniać** — nie jako
spełnione. Przy ewentualnej adopcji kryterium wraca w pełni.

### AC5 — model nie otrzymuje refresh/access tokenów → **spełnione, z zastrzeżeniem**

Nasza strona: `CredentialVault` i refresh lifecycle nigdy nie wystawiają sekretu do
powierzchni model-facing (RA-005, zaudytowane). Nowe moduły tego nie zmieniają: ani
`external-boundary.ts`, ani `runtime-session.ts` nie mają pola na token.

Zastrzeżenie zapisane w matrycy i ADR: w dokumentacji AWS **nie znalazłem zdania**
gwarantującego, że token nigdy nie wraca do wołającego. Architektura jest zgodna
(uprawnienia są na roli gatewaya), ale to nasz inwariant do egzekwowania, nie gwarancja
dostawcy. Zapisuję brak dowodu jako brak dowodu.

### AC6 — Runtime restart nie traci case state → **spełnione**

12 testów przeciwko prawdziwemu PostgreSQL. Stan odzyskiwany z Postgresa po odrzuceniu
wszystkiego, co było w pamięci; trzy cykle bez dryfu; sesja przed/za rewizją odrzucana
osobnymi kodami; fencing token bez trwałego lease odrzucany.

Dokumentacja dostawcy **potwierdza** postawę: „AgentCore does not enforce
session-to-user mappings - your client backend should maintain the relationship".

## 4. Audit focus taska

- **Vendor lock-in** — najmocniej zaadresowany możliwym sposobem: nie wchodzimy w
  zależność. `ADR-0008` zapisuje warunki powrotu, więc decyzja jest odwracalna.
- **Maturity usług** — zmierzona, nie oszacowana; jedyny potwierdzony status to Beta
  GitLaba, cytat dosłowny.
- **OAuth isolation dla dwóch kont Google** — nietknięta, bo nie ma czego adoptować.
  Uważam to za najlepszy dostępny wynik: żaden nowy element nie wchodzi między dwa konta
  Google, których izolacja jest już dowiedziona.
- **Podwójna warstwa policy** — zidentyfikowana jako realny koszt (interceptory to nasz
  kod) i **uniknięta** przez `DEFER`. `WU-05` zostawia guard na wypadek przyszłej
  adopcji.
- **Audit completeness** — każda odmowa boundary'a i sesji ma własny kod, nie klasę.
- **Jakość fallbacków** — fallbackiem są zaudytowane adaptery, nie nowy kod bez
  historii.

## 5. Findingi sond adwersarialnych — 3, wszystkie naprawione

| Unit | Finding | Severity | Naprawa |
|---|---|---|---|
| `WU-05` | case scoped na `jira` dostawał tools Gmail/Calendar/GitLab, bo provider sprawdzano **tylko gdy boundary go zadeklarował** | **HIGH** | provider derywowany z nazwy narzędzia |
| `WU-05` | manifest 20 000 ofert bez limitu | MEDIUM | `MAX_BOUNDARY_OFFERS = 64`, odrzucenie całościowe |
| `WU-05` | duplikaty dawały wielokrotne capability | LOW | dedup + `DUPLICATE_OFFER` |
| `WU-00` | `this.name` z literału → subklasa raportowała nazwę rodzica | LOW | `new.target.name` |

Pierwszy jest wart zapamiętania poza tym taskiem: **pominięcie było obejściem.**
Najbezpieczniej wyglądająca oferta — nic nie deklarująca — była tą, która przechodziła.
To `CTF-010` finding 4 o poziom wyżej: nie „brak deklaracji = zgoda", lecz „brak
deklaracji = brak kontroli".

## 6. Mutation check — 30 mutacji, wszystkie łapane

`WU-00` 3, `WU-05` 15, `WU-04` 8, plus 4 na drugich asercjach. Żadna nie przeżyła.

Odnotowuję kontrast z RA-022 (dziewięć przeżyło pierwszy przebieg), bo jest
diagnostyczny, a nie chwalebny: wzorzec „mutacja przeżywa tam, gdzie warstwa wyżej
sprawdza to samo wcześniej" był już znany z poprzedniego taska, więc testy od początku
celowały w fence bezpośrednio. To dowód, że zapis w rejestrze działa — nie że kod jest
lepszy.

## 7. Findingi tego audytu

**Brak findingów BLOCKER, HIGH ani MEDIUM.** Wszystkie findingi sond naprawione w
trakcie taska i pokryte regresją.

Dwie rzeczy odnotowane jawnie, żeby nie zginęły:

1. **AC4 nie jest spełnione — nie ma czego spełniać.** Wraca w pełni przy adopcji.
2. **AC5 opiera się na naszym inwariancie, nie na gwarancji dostawcy.** Każdy nowy
   caller `evaluatePolicy` musi podawać `now` z zegara bazy, inaczej luka wraca.

`CTF-001` zamknięty — potwierdzony sondą, nie deklaracją. Nowa preexistująca kolizja
`RefreshIntentStatus` została **domknięta razem z nim** (była tym samym defektem).

## 8. Werdykt

AC1, AC3, AC5 i AC6 spełnione i zweryfikowane osobno. AC2 spełnione istniejącymi
adapterami. AC4 jawnie nie dotyczy w tym zakresie, z zapisanym warunkiem powrotu.
Zmiana zakresu wynika z wykonania AC1 i została rozstrzygnięta przez właściciela.
Bramka uruchomiona, mutation check per mechanizm, sonda adwersarialna per unit, brak
otwartych findingów BLOCKER/HIGH/MEDIUM.

- Werdykt: `PASS`
