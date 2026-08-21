# ADR-0008 — AgentCore Gateway i oficjalne MCP targets: `DEFER` dla wszystkich providerów

- Status: `ACCEPTED`
- Data: `2026-08-21`
- Decyzja właściciela: `2026-08-21`
- Task: `RA-023`
- Dowody: [`docs/research/RA-023-CAPABILITY-MATRIX.md`](../research/RA-023-CAPABILITY-MATRIX.md)
  (weryfikacja oficjalnej dokumentacji dostawców `2026-08-21`)

## Kontekst

RA-023 zakłada, że AgentCore Gateway/Identity jest wart wdrożenia jako managed MCP
boundary dla oficjalnych serwerów providerów, i wymaga (AC1) werdyktu
`ADOPT`/`DEFER`/`REJECT` per provider **z dowodami**.

Plan taska jest kategoryczny co do metody: „werdykt oparty na pamięci modelu jest
bezwartościowy… To praca badawcza z cytowanymi źródłami, nie implementacyjna". Stan
Preview/Beta zmienia się szybko, więc weryfikacja została wykonana przez odczyt
dokumentacji dostawców w dniu decyzji.

Wynik weryfikacji okazał się bardziej jednoznaczny, niż plan zakładał — i podważa
przesłankę zakresu, nie tylko pojedyncze werdykty.

## Decyzja

**`DEFER` dla wszystkich czterech providerów. `REJECT` dla wdrożenia Gateway'a jako
IaC-owej warstwy MCP w zakresie, w jakim opisuje to scope RA-023.** Własne adaptery
(RA-016, RA-017, RA-019, RA-020) pozostają ścieżką produkcyjną.

| Target | Werdykt | Główny powód |
|---|---|---|
| Atlassian / Jira | `DEFER` | template AgentCore przyjmuje **tylko API key**; nasze połączenie jest OAuth z pełnym refresh lifecycle — adopcja byłaby degradacją |
| GitLab | `DEFER` | oficjalny serwer to **„Status: Beta"**; brak template'u w AgentCore; mamy działający adapter z RA-017 |
| Gmail | `DEFER` | **nie znaleziono** oficjalnego serwera MCP ani template'u w AgentCore |
| Calendar | `DEFER` | jak wyżej |
| Slack (opcjonalny) | `DEFER` | template jest znacznie szerszy niż „dodatkowe narzędzie" (`usersProfileSet`, `userGroupsUsersUpdate`), a task wyklucza Slack jako UI systemu |
| Gateway jako warstwa IaC | `REJECT` | built-in templates: **„You can only add an integration provider template as a target through the AWS Management Console and not through the API"** |

`DEFER`, nie `REJECT`, dla providerów — bo powody są **stanem rynku**, nie własnością
architektury. Beta dojrzeje, Google może wydać serwer, Atlassian może dodać OAuth do
template'u. `REJECT` dla warstwy IaC jest mocniejszy, bo dotyczy właściwości usługi
(console-only), która nie zależy od dojrzewania targetów.

## Uzasadnienie

### 1. Dla dwóch najdelikatniejszych providerów nie ma czego adoptować

Gmail i Calendar to jedyne miejsca w systemie z wymogiem braku cross-account leakage
między kontem prywatnym i SonderMind (kryterium systemowe 6 z Master Planu, dowiedzione
w RA-019/RA-020). Dla nich **nie znalazłem** ani oficjalnego serwera MCP Google, ani
template'u w AgentCore. AgentCore ma template Microsoft Exchange z operacjami
mailowymi i kalendarzowymi — to nie zamiennik, nasze konta są Google.

Formułuję ostrożnie: brak dowodu istnienia nie jest dowodem nieistnienia. Skutek dla
decyzji jest jednak identyczny, bo decyzję trzeba podjąć na dostępnych dowodach.

### 2. Dla Jiry adopcja byłaby degradacją, nie ulepszeniem

Template „The Jira Cloud platform" akceptuje wyłącznie API key. RA-016 dał nam OAuth z
`RefreshLease`, fencing tokenem, wykrywaniem `AMBIGUOUS` i pełnym audytem. Zamiana
OAuth na API key oddałaby te właściwości w zamian za managed transport.

Osobno: template wystawia `deleteIssue`, `deleteProject`, `deleteSprint` i
`deleteComment` — operacje, które nasz registry RA-022 klasyfikuje jako **R4**. Gateway
nie zna naszych tierów, więc bez interceptora dawałby modelowi narzędzia usuwania obok
narzędzi czytania.

### 3. Gateway nie zastąpiłby naszej policy — dodałby drugie miejsce

Fine-grained access control w Gateway realizują **interceptory**: kod, który sami
piszemy i wdrażamy w AWS. Dokumentacja mówi to wprost, wraz z zaleceniem „Design
interceptors to deny access by default when authorization cannot be determined" — czyli
fail-closed jest obowiązkiem implementującego.

Konsekwencja: adopcja nie usuwa `packages/policy`, lecz tworzy **dwie** warstwy policy
do utrzymania spójnie. To dokładnie ryzyko „podwójna warstwa policy" z audit focus
RA-023, i jest to koszt stały, nie jednorazowy.

### 4. Scope RA-023 wymagał IaC, którego usługa dla tej ścieżki nie daje

Zakres taska mówi „IaC/spike AgentCore Gateway". Built-in templates są dodawalne
**tylko przez konsolę**, nie przez API — więc target oparty na template nie jest
odtwarzalny z IaC ani z disaster recovery (RA-025). Druga limitacja z tej samej sekcji:
„AgentCore doesn't host any servers natively, so you must set up server hosting
yourself" — template nie zwalnia z hostowania serwera MCP.

### 5. AC5 pozostaje naszym inwariantem, nie gwarancją dostawcy

Dokumentacja outbound auth opisuje wyłącznie ścieżkę, w której **gateway** pobiera
credential (`GetResourceOauth2Token`, `GetResourceApiKey`, `secretsmanager:GetSecretValue`
na roli gatewaya). Architektura jest więc zgodna z „model nie otrzymuje tokenów", ale
**nie znalazłem zdania**, które by to gwarantowało — a uprawnienie do pobrania tokenu
jest zwykłym IAM actionem i można je nadać komukolwiek.

Zapisuję to jako brak dowodu, nie dowód braku. Wniosek praktyczny: AC5 zostaje
wymogiem, który egzekwujemy my.

### 6. Runtime: dokumentacja POTWIERDZA nasze założenie, więc nie ma co zmieniać

`runtime-sessions.html` mówi wprost, że sesja jest domyślnie efemeryczna („persists only
for the compute lifecycle"), ubijana po 15 minutach bezczynności, ograniczona do 8
godzin, oraz — najważniejsze — **„AgentCore does not enforce session-to-user mappings -
your client backend should maintain the relationship between users and their session
IDs"**.

Czyli Postgres jako authority i sesja jako transport/cache to **udokumentowana postawa
dostawcy**, nie nasze obejście. AC6 jest spełnialne dokładnie tak, jak plan zakładał.

## Konsekwencje

### Co z tego wynika dla zakresu RA-023

Units, które budowały boundary dla adopcji, tracą podstawę i **nie są wykonywane**:

| Unit | Los | Powód |
|---|---|---|
| `RA-023-WU-00` | **WYKONANY** | `CTF-001` domknięty; wartość niezależna od werdyktów |
| `RA-023-WU-01` | **ODSTĄPIONY** | target registry dla targetów, których nie adoptujemy |
| `RA-023-WU-02` | **ODSTĄPIONY** | conformance discovery + fallback — fallbackiem są nasze istniejące adaptery, już zaudytowane |
| `RA-023-WU-03` | **ODSTĄPIONY** | opaque OAuth session — nasz refresh lifecycle już to robi; drugi silnik byłby findingiem BLOCKER (punkt 1 „Ustaleń z kodu") |
| `RA-023-WU-04` | **WYKONYWANY** | spike Runtime/Postgres-as-authority (AC6) — wartość niezależna od adopcji |
| `RA-023-WU-05` | **WYKONYWANY, zawężony** | dowód, że Gateway **nie może** poszerzyć naszej policy ani owner/case scope (AC3) |

`WU-05` zostaje, i to jest istotne: guard „zewnętrzna warstwa nie poszerza lokalnej
policy" ma wartość **niezależnie** od tego, czy kiedykolwiek wdrożymy Gateway. Każdy
przyszły managed boundary — Gateway, inny broker, cudzy serwer MCP — napotka ten sam
test. Bez niego przyszła adopcja zaczynałaby od zera.

### Warunki ponownego rozważenia

`DEFER` nie jest wieczny. Wracamy do tej decyzji, gdy **którykolwiek** z warunków
zajdzie:

1. Google wyda oficjalny serwer MCP dla Gmail/Calendar z izolacją per-account.
2. Template Jiry w AgentCore zacznie przyjmować OAuth (nie tylko API key).
3. GitLab MCP przejdzie z Beta do GA.
4. Built-in templates staną się dodawalne przez API (koniec blokady IaC).

Do tego czasu obowiązuje: **żadnego live contract testu i żadnego deploymentu
AgentCore** — weryfikacja wyłącznie przeciwko fake'owi, zgodnie z decyzją właściciela
`2026-08-21`.

### Wpływ na kolejne taski

- **RA-024** (hardening): bez zmian. Nie ma nowej powierzchni AWS do zabezpieczania.
- **RA-025** (AWS deployment/DR): **upraszcza się**. Brak zasobów AgentCore Gateway
  oznacza brak console-only konfiguracji, której nie da się odtworzyć z IaC w ćwiczeniu
  restore. To był realny problem dla DR i przestaje istnieć.
- **RA-026** (final acceptance): AC1 RA-023 jest spełnione przez ten ADR plus matrycę.

## Odrzucone alternatywy

**`ADOPT` dla Jiry, bo template istnieje.** Odrzucone: API key zamiast OAuth to
degradacja modelu uwierzytelnienia, a template wystawia operacje R4 bez znajomości
naszych tierów.

**Zbudować pełny boundary mimo `DEFER`** (wariant rozważany z właścicielem). Odrzucone:
oznaczałoby utrzymywanie drugiej warstwy policy i drugiej ścieżki credentiali dla
targetów, o których właśnie ustaliliśmy, że ich nie adoptujemy. Koszt stały bez
odbiorcy.

**`REJECT` zamiast `DEFER` dla providerów.** Odrzucone: powody są stanem rynku, nie
własnością architektury, a `REJECT` sugerowałby, że decyzja nie wymaga przeglądu.
