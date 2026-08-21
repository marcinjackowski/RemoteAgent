# RA-024 — AUDIT-01

- Task: `RA-024` Security, privacy and observability hardening
- Data: `2026-08-21`
- Bazowy commit: `03b252a` (stan po domknięciu RA-023)
- Rola: jedna rola wykonawcza (ADR-0007)
- Audit focus taska: **przekrojowy**, nie tylko wobec kodu tego taska

Werdykt jest w §9.

## 1. Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run          (całe repo)
  → 2164/2164, 155 plików, exit 0, TRZY przebiegi z rzędu, zero `Errors`

RA_REQUIRE_POSTGRES=1 pnpm vitest run test/security
  → 266/266, 9 plików, exit 0

pnpm run lint                              → exit 0   (było: 3 errors, exit 1)
pnpm run format                            → exit 0
node …/tsc.js -p tsconfig.json --noEmit    → exit 0   (było: RangeError, exit 1)
pnpm run typecheck --force                 → 36 successful, 0 cached
pnpm run build --force                     → 26 successful, 0 cached
git diff --check                           → exit 0
```

Trzy przebiegi, nie jeden, bo `CTF-012` czynił pojedynczy przebieg
nierozstrzygającym. **Ten task go zdiagnozował i naprawił** — patrz §4 — więc liczba
przebiegów jest teraz argumentem, a nie zaklęciem.

Zmiana bazy dowodowej całego repozytorium, zmierzona:

```text
baseline (03b252a):   1793 testy, 141 plików, exit 0
w trakcie (przed CTF-012):  2086 testów, 1 failed  ← flake przechwycony
końcowa:              2164 testy, 155 plików, 0 failed, 3 przebiegi
```

**Dwie bramki repozytorialne były czerwone na `main` przed tym taskiem** i obie
zreprodukowałem na czystym drzewie bazowym przed zmianą czegokolwiek. To nie jest
detal proceduralny: `RA-026` AC1/AC2 opiera dowodowość na zielonych bramkach, więc
RA-026 zaczynałby od dwóch czerwonych.

## 2. Sonda kolizji eksportów (`CTF-002`) — type-level, nie wartościowa

Wymóg z `CTF-002`: dopóki guardrail `CTF-002-U1` nie istnieje, final task gate musi
uruchamiać sondę **type-level**. Uruchomiona (`ts.Program` +
`checker.getExportsOfModule`, z rozwijaniem aliasów, żeby legalny re-eksport tej samej
deklaracji nie dawał fałszywego alarmu), 19 pakietów:

```text
ModelIdentity      <- agent-orchestrator, bedrock-runtime
OperationRecord    <- implementation-tools, workspace-runner
RetryPolicy        <- bedrock-runtime, connector-jira
RuntimeOptions     <- agent-orchestrator, bedrock-runtime
ToolManifest       <- agent-orchestrator, mcp-tool-broker
WorkspaceFence     <- agent-orchestrator, workspace-runner
packageName        <- 7 pakietów                        (znane, CTF-002)
```

**Sześć z tych siedmiu nie było odnotowanych.** Zapisane jako `CTF-015` z decyzją
`accept` dla nazw i `fix` dla mechanizmu. Sprawdziłem osiągalność, nie założyłem:
skan konsumentów importujących kolidującą parę jest **pusty**, wspólnego barrela nie
ma. Więc nieosiągalne — dokładnie jak `packageName`.

Żadna z sześciu nie powstała w tym tasku (wszystkie z RA-007..RA-021). Wartość
findingu jest inna: to najmocniejszy dotychczasowy argument za `CTF-002-U1`, bo sześć
kolizji przeszło przez wszystkie zwykłe bramki w pięciu taskach.

## 3. Kryteria akceptacji — każde osobno

### AC1 — threat model obejmuje każdą zewnętrzną granicę i data flow

**Spełnione.** `docs/security/THREAT_MODEL.md` + rejestr maszynowy
`packages/observability/src/trust-boundaries.ts`, jedenaście granic: pięć providerów
(kompletność sprawdzana wobec enuma `Provider`, więc szósty łamie build) plus Bedrock,
MCP, workspace, PostgreSQL, artifacts i secret storage.

Dowód: `test/security/threat-model.test.ts`, 10 testów, sprawdzenie w obie strony.

**Najwartościowsza asercja tego unitu wykryła realny defekt w samym rejestrze:** test
wymaga, by każda cytowana kontrola była **plikiem, który istnieje**, i **cztery
cytowane ścieżki były błędne** (`connector-gitlab/src/allowlist.ts`,
`connector-jira/src/webhook-ingress.ts`, `git-lifecycle/src/publish.ts` oraz dwie
ścieżki katalogowe bez pliku). Bez tego testu model zagrożeń wskazywałby kontrole w
miejscach, w których ich nie ma — a to czyta się **tak samo autorytatywnie** jak
ścieżka prawdziwa.

Nie zaliczam tego jako „dokument napisany". Zaliczam, bo dokument jest **sprawdzany
komendą**, która już raz go poprawiła.

### AC2 — canary secrets/PII nie pojawiają się w logs, traces ani model context

**Spełnione, sprawdzone dla trzech sinków OSOBNO** (plus czwarty: output komendy).
`test/security/canary.test.ts`, 111 testów, 16 kanarków × 4 powierzchnie.

Sinki ćwiczone przez **realne wejścia** — `StructuredLogger`, `TraceRecorder`,
`compactContextFragments`, `redactCommandOutput` — a nie przez wywołanie wspólnej
tabeli. To rozróżnienie jest istotne: że tabela działa, dowodzi
`packages/observability/test/secret-patterns.test.ts`; ten plik musi dowieść, że każdy
sink do niej **dociera**.

Jeden przypadek używa `ya29.` (Google access token), kształtu, którego **nie miała
żadna** z trzech pierwotnych tabel. Sink trzymający własną kopię wyglądałby na
zredagowany dla starych kształtów i przepuściłby ten — więc jest to test na to, czy
`CTF-006` jest domknięty **mechanizmem**, a nie tylko w trzech miejscach naraz.

Asercje na **zabronionych podłańcuchach**, nie na „output się zmienił": wzorzec, który
dopasował, ale zamienił za mało, i tak zmienia string, przepuszczając materiał.

Przypadki przeciwne też są: `case_id`, liczniki tokenów i ścieżki relatywne
**muszą przeżyć**. Redaktor, który zjada wszystko, zostanie wyłączony przez pierwszego
operatora, który będzie musiał coś zdebugować — i to jest gorszy wynik niż wąski.

### AC3 — cross-account/repo prompt injection ograniczone przez policy

**Spełnione.** `test/security/cross-account.test.ts` (20) +
`test/security/injection.test.ts` (38).

Przesłanką suite jest, że **injection SIĘ UDAŁ**. Detekcja jawnie nie jest kontrolą
(zapisane w threat modelu jako out of scope), więc pytaniem nie jest „czy da się
rozpoznać wrogi tekst", lecz „co wrogi tekst dostaje, gdy mu uwierzono".

Oba kierunki dla obu par kont (private↔SonderMind, Gmail i Calendar), zgodnie z
wymogiem planu. Plus cross-repo w wariancie realistycznym: **jedno** connection,
którego token sięga obu repozytoriów — więc containment **nie może** pochodzić z
credentiala i musi pochodzić z per-case grantu.

Każda odmowa asertowana na **konkretnym kodzie/komunikacie**, nigdy na „rzuciło"
(`CTF-010`, finding 1).

Jeden test **zapisuje lukę zamiast ją ukrywać**: wygasły credential jest odrzucony, a
**backdated** zegar go dopuszcza. To wynik sondy RA-022-WU-03, i asertowanie obu połów
utrzymuje wymóg widocznym — `now` musi pochodzić z zegara bazy, a czysty evaluator nie
może się obronić sam.

### AC4 — alerty: DLQ, renewal failure, stale lease, cost anomaly

**Spełnione.** Cztery jawne klasy w `packages/observability/src/alerts.ts`, 26 testów.

Alerty są **kodem, nie konfiguracją dashboardu**, i to jest decyzja projektowa z
uzasadnieniem: próg na dashboardzie nie da się mutation-testować i musiałby być
odtwarzany po każdym restore drillu, więc `RA-026` „dowiedzione ćwiczeniem" by go nie
objęło.

`assertAllAlertClassesImplemented` **wysterowuje** syntetyczny snapshot trypujący
wszystko, zamiast porównywać listę z enumem — lista dowodziłaby tylko, że stała nadal
istnieje, nie że jakaś ścieżka kodu do niej dochodzi.

Progi celowo niskie: DLQ = 1, bo job trafia do DLQ **po wyczerpaniu wszystkich
retry**, więc reprezentuje pracę definitywnie porzuconą, a DLQ nikt nie odpytuje.

Cost anomaly jest `CRITICAL` przy **pustej** kolejce i `WARNING` przy zapchanej:
wydatek rosnący bez pracy do pokazania to pętla, wydatek pod obciążeniem to
obciążenie. Oba alarmują; tylko jedno wymaga kogoś **teraz**.

### AC5 — retention/delete nie niszczy minimalnych audit receipts bez reguły

**Spełnione, i to jest unit z najpoważniejszym findingiem.**

Sonda przeciwko realnej bazie wykazała, że **udokumentowany mechanizm retencji był
strukturalnie niemożliwy**: migracja 002 dała `raw_events` kolumnę `retain_until` i
indeks z komentarzem „hot path for the retention job", a na tej samej tabeli
bezwarunkowy trigger append-only.

```text
DELETE expired raw_event          rows=1  REFUSED (P0100)
UPDATE raw payload_bytes -> NULL  rows=1  REFUSED (P0100)
```

Nie „nie był zaplanowany" — **nie mógł się uruchomić**. To `CTF-010` w SQL-u.

Migracja `032` czyni to możliwym, wąsko. Append-only zostaje domyślną zasadą i **nie**
jest rozluźnione; retencja dostaje jeden autoryzowany wyjątek, w osobnej funkcji
triggera, bo `ra_deny_mutation` pilnuje piętnastu innych tabel i poszerzenie go
przyznałoby wyjątek wszystkim naraz.

AC5 jest **strukturalne**, nie jest sprawdzeniem po stronie wywołującego:
`audit_log`, `receipts`, `external_actions` i `approvals` są nieosiągalne, bo **nie
istnieje funkcja**, która by ich dotknęła. Test asertuje to wobec `pg_proc`, więc
dodanie trzeciej funkcji `ra_retention%` jest czerwonym testem, nie uwagą z review.

Sonda adwersarialna na oczywisty bypass — ustaw flagę transakcyjną samodzielnie i
zrób UPDATE ręcznie. Trigger sprawdza **kolumny**, więc przepisanie digestu,
wydłużenie `retain_until`, obniżenie `sensitivity`, wpisanie bajtów z powrotem i
usunięcie wiersza są nadal odrzucone (P0101/P0100). Sama flaga nie kupuje nic.

**Uwaga metodologiczna, którą zapisuję, bo prawie wyprodukowała fałszywy finding:**
pierwsza wersja sondy raportowała `DELETE FROM audit_log: ALLOWED`. Było to błędne —
tabela była **pusta**, a trigger `FOR EACH ROW` nie odpala się przy zerowej liczbie
wierszy, więc sonda mierzyła „nie usunęła nic". Każdy test retencji wstawia teraz
wiersz przed asercją, a kilka asertuje, że wiersz **nadal tam jest**. Jeden z moich
własnych testów potem padł z dokładnie tego powodu w bloku z pustym `raw_events` —
złapany tą samą regułą, dlatego jest ona wpisana w plik.

### AC6 — kill switch zatrzymuje effects, zachowując odczyt i dowody

**Spełnione. Drill, nie deklaracja.** `test/security/kill-switch-drill.test.ts`, 13
testów przeciwko **realnemu** `executeAction` i **realnemu** PostgreSQL-owi.

Trzy właściwości, każda osobno:

1. **Effects stop.** Adapter providera **nie jest wywołany** — asercja na liczniku
   wywołań, nie na zwróconym outcome. Odmowa, która i tak wysłała request, wygląda z
   wartości zwrotnej **identycznie**, i to jest awaria, której ten test ma zapobiec.
   Sprawdzone dla wszystkich trzech poziomów (`GLOBAL`, `PROVIDER`, `CONNECTION`).
2. **Reads survive.** Audit log, akcje, approvals i historia switcha są **czytelne**
   w trakcie stopu, i audit log jest nadal **zapisywalny** — inaczej sam drill i
   wszystko, co operator robi w jego trakcie, byłoby nieudokumentowane.
3. **Evidence preserved.** Zgoda właściciela **nie jest zużyta** (`consumed = false`),
   akcja **nie** przechodzi w `EXECUTING` (inaczej operator czytałby to jako „może w
   locie" i mógłby to powtórzyć po zdjęciu stopu), a event switcha jest append-only.

Najtrudniejszy przypadek jest TOCTOU: switch przestawiony **po** grancie i **po**
evaluacji proposal-time, czyli w sekundach, które człowiek spędza na czytaniu
wiadomości Discorda.

Osobno sprawdzone, że stop jest **odwracalny** — bo stop, którego nie da się zdjąć,
sprawia, że operatorzy boją się go użyć — i że **stale** evaluacja z przed stopu jest
odrzucona **po** zdjęciu (`POLICY_CHANGED`), mimo że decyzja jest ta sama.

### AC7 — kontrolowany backpressure zamiast przeciążenia providerów

**Spełnione.** `packages/observability/src/backpressure.ts`, 24 testy.

Zapobiegana awaria jest konkretna i nie jest „provider zwalnia": to **pętla
amplifikacji** — provider zwraca 429, retry klasyfikuje to jako transient, retry
dokłada obciążenia, i odpowiedzią systemu na przeciążenie jest **większe**
przeciążenie. Kończy się banem albo unieważnionym credentialem, czyli awarią, którą
sami zadaliśmy i z której nie da się wyretryować.

Trzy mechanizmy, każdy na inne pytanie: concurrency (ile teraz w locie), token bucket
(czy przekraczamy opublikowaną **stawkę** — czego cap współbieżności nie umie), i
circuit breaker (czy provider **sam** już powiedział „stop").

Wszystkie trzy **odmawiają**, nie kolejkują. To decyzja: praca, która nie może iść
teraz, jest **już** trwale zapisana jako job z leasem i harmonogramem retry, więc
odmowa zwraca ją tam, gdzie ma być trzymana. Kolejka w pamięci (a) gubi pracę przy
restarcie i (b) **ukrywa** przeciążenie przed metrykami — queue depth wyglądałby
zdrowo, gdy w workerze rośnie nieograniczona tablica.

Scenariusz AC7 end-to-end: 500 requestów naraz → liczba docierająca do providera jest
**ograniczona** (≤ burst capacity), reszta odmówiona i **policzona w metryce**.

Czas **wstrzykiwany** wszędzie. Rate limiter testowany zegarem ściennym to flaky test,
a to repozytorium wydało trzy findingi przekrojowe na flake'i — dodanie czwartego w
suite, której zadaniem jest dowodzenie stabilności, byłoby własnym defektem.

## 4. `CTF-012` — zdiagnozowany i naprawiony

Rejestr nosił ten flake jako „**niezdiagnozowany, nie udało się przechwycić
komunikatu**" przez ~15 przebiegów, z jawną uwagą, żeby nie zgadywać. Przechwycony w
bramce tego taska:

```text
duplicate key value violates unique constraint "workspaces_case_id_key"
  at WorkspaceRepository.recordIntent (workspace.ts:39)
```

`workspaces` ma **dwa** unique constrainty — `workspace_id` i `UNIQUE (case_id)`
(inwariant single-writer) — a `recordIntent` absorbował konflikty przez
`ON CONFLICT (workspace_id)`, pokrywając tylko pierwszy. Insert, który przegrał wyścig
na `case_id`, uciekał jako surowy `23505`.

Reprodukował się **wyłącznie** w pełnym przebiegu, bo potrzebuje dwóch insertów
faktycznie w locie: solo 5/5 zielone.

Test regresyjny **wymusza** wyścig ośmioma współbieżnymi insertami zamiast liczyć na
zaobserwowanie go — flake odtworzony przypadkiem nie jest testem regresyjnym.
Asercja na **typie** błędu, bo poprzednie zachowanie **też** rzucało; dokładnie
dlatego wyglądało to na szum przez piętnaście przebiegów.

Mutation check: przywrócenie `ON CONFLICT (workspace_id)` → 2 failed, exit 1;
przywrócone → 5 passed, exit 0.

## 5. Mutation checki — wymóg dla każdego mechanizmu bezpieczeństwa

`AGENTS.md` wymaga mutation checku dla **każdego** mechanizmu bezpieczeństwa.
Uruchomione **36** mutacji w sześciu modułach, każda przebudowana przed przebiegiem,
bo `test/security` importuje `dist` (`CTF-011`):

```text
secret-patterns (7):   wzorce host-path / provider-token / PEM / JWT,
                       flaga `g`, containsSecretShape→false, mask→identity
alerts (8):            każda z 4 reguł, próg DLQ, severity, budżet input-only,
                       zwracanie tylko pierwszego alertu
metrics (3+3):         agregacja gauge (max/first/last/zero), suma licznika, guardy
tracing (8):           4 ścieżki redakcji, redaktor child, łańcuch przyczynowy ×3
health (3):            liveness↔DB, readiness↔DB, kill switch↔readiness
boundaries (3):        puste kontrole, zła ścieżka kontroli, usunięta granica
CTF-012 (1):           przywrócenie węższego ON CONFLICT
```

Wszystkie czerwone, wszystkie przywrócone do zielonego.

**Dwie mutacje początkowo PRZEŻYŁY, i obie ujawniły słaby test, nie słaby kod:**

1. `Math.max` → last-wins na gauge'ach przeszło, bo `[0, 7]` przypadkiem umieściło
   najgorszą wartość **na końcu**, a iteracja idzie po kolejności wstawiania;
2. potem `[0, 7]` **i** `[7, 0]` razem nadal przechodziły mutację „pierwszy
   niezerowy wygrywa", bo `7` było jedyną niezerową wartością w obu.

Teraz trzy **różne** niezerowe wartości w trzech kolejnościach, co wyklucza
averaging, first-wins i last-wins. Konsekwencją pomyłki tutaj jest zdrowy provider
maskujący zepsutego — czyli **ciche porzucenie DLQ**.

Zapisuję to, bo jest to najużyteczniejsza rzecz z tego audytu o wartości mutation
testingu: pierwsza wersja obu testów **przechodziła** i **wyglądała** na dokładną.

## 6. Findingi tego audytu

Znalezione **testami, nie przeglądem** — i to jest rozstrzygające, bo trzy z nich
mieszkały w kodzie zaakceptowanym.

### `.env.local` nie był ścieżką chronioną — **naprawione w tym tasku**

`isProtectedPath` dopasowywał `.env` jako **dokładny** segment, więc `.env` było
odrzucane, a `.env.local`, `.env.production` i `.env.development.local` **nie** —
podczas gdy to one są konwencjonalnymi nazwami pliku, który realnie trzyma
credentiale. Chroniona była najmniej interesująca nazwa z rodziny.

`repository-planner/src/discovery-policy.ts` miał to **poprawnie**
(`name === ".env" || name.startsWith(".env.")`), co czyni to tą samą klasą rozjazdu co
`CTF-006`: dwie granice z dwiema wersjami jednej reguły, i słabsza jest ta
model-facing. **Żaden istniejący test tego nie pokrywał.**

Naprawione opt-in listą prefiksów, trzymaną osobno od dopasowań dokładnych, bo reguła
prefiksowa nad `credentials` pochłonęłaby też `credentials-guide.md`.

### `CTF-014` — push brancha case'a nie przechodzi przez `ACTION_REGISTRY`

**LOW, decyzja `defer`, wymaga ADR.** Komentarz w rejestrze mówi, że `R2` obejmuje
„case-branch pushes", ale **takiego klucza nie ma**, a ścieżka pushu nigdy nie wywołuje
`evaluatePolicy`. Znów `CTF-010`.

Nie oceniam na HIGH, bo push jest zatrzymany trzema innymi warstwami, sprawdzonymi w
kodzie: `writes_enabled` domyślnie wyłączone, zamknięta allowlista projektów, i
allowlista argv w `git-lifecycle` dopuszczająca dziewięć subkomend — więc
`push --force` ani `branch -D` **nie da się złożyć**.

Ryzykiem jest **brak policy evidence dla realnego zapisu**, nie eskalacja. Domknięcie
zmienia zaakceptowany kontrakt RA-022, więc wymaga ADR-a; hardening nie jest miejscem
na to.

### `CTF-015` — sześć nieodnotowanych kolizji type-level

**LOW, decyzja `accept` dla nazw, `fix` dla mechanizmu.** Opisane w §2.

### Cztery błędne ścieżki kontroli w rejestrze granic — **naprawione**

Opisane w §3/AC1. Warte odnotowania jako klasa: cytat bez weryfikacji jest **gorszy**
od braku cytatu, bo brzmi jak dowód.

## 7. Czego ten task NIE zrobił

Zapisane jawnie, bo „nie wspomniane" czyta się jak „pokryte".

1. **Dependency/container/IaC scanning** — zakres taska wymieniał „dependency,
   container i IaC scanning oraz SBOM". Dostarczony jest **SBOM** (deterministyczny,
   z lockfile'a, CycloneDX 1.5, 270 komponentów z hashami integralności).
   **Scanning nie**, i to jest świadome: `pnpm audit` wymaga sieci i zwraca inną
   odpowiedź każdego dnia, więc nie może być bramką — build padający, bo w nocy
   opublikowano advisory, nie jest buildem odtwarzalnym. Container scanning wymaga
   Dockera, który na tej maszynie jest zepsuty (`AGENTS.md`), a IaC scanning wymaga
   stacków, które powstają w `RA-025`. **Wszystkie trzy należą do `RA-025`**, gdzie
   niedeterministyczny wynik jest akceptowalny, bo nie blokuje artefaktu.
2. **Dashboardy** — zakres wymieniał „alerts, dashboards, health/readiness".
   Dostarczone: alerty (kod), health i readiness. Dashboard jest artefaktem
   konkretnego backendu telemetrii, a wybór backendu należy do `RA-025`.
3. **Eksporter OpenTelemetry** — `@opentelemetry/api` jest zadeklarowaną zależnością,
   ale SDK, eksporter i sampling to konfiguracja deploymentu. Podłączenie prawdziwego
   `TracerProvider` nie wymaga zmiany żadnego call site.
4. **`CTF-004` w połowie** — połowa src-vs-dist jest rozstrzygnięta (i była
   **blokerem** dla `CTF-013`), ale `tsconfig.test.json` dla sześciu pakietów
   pozostaje otwarte.
5. **`CTF-009`** bez zmian — mechanizm domknięty lokalnie w RA-012, wzorzec otwarty.
6. **`PolicyEvaluation.evidence` NIE jest zapisywane do `audit_log`** — i to jest
   zawężenie **mojego własnego planu**, więc stawiam je wprost, zamiast liczyć na to,
   że nikt nie porówna. Rewizja `2` planu wymieniała to jako rezultat `WU-05`.

   Powód zawężenia: wymaga nowego wywołania **wewnątrz** `executeAction`
   (`packages/policy`, `DONE` po RA-022), czyli zmiany zaakceptowanej ścieżki
   wykonania efektu zewnętrznego — w tej samej transakcji, w której mieszkają consume
   approvala i fencing na rewizji. Trzeba przy tym rozstrzygnąć, **co** audytować przy
   odmowie, nie tylko przy sukcesie. To zmiana kontraktu wykonania, nie doczepka do
   hardeningu.

   Co jest w zamian: `audit_log` ma **udowodnioną** append-only trwałość i jest
   zapisywalny w trakcie kill switcha (dwa testy), a `evidence` niesie już wszystkie
   pola. Brakuje jednego wywołania i decyzji o jego kształcie.

   **Nie klasyfikuję tego jako finding MEDIUM**, bo nie jest to defekt istniejącego
   mechanizmu — `evidence` jest produkowane i porównywane (`policyEvaluationsAgree`),
   więc TOCTOU jest zamknięte. Brakuje **trwałości dowodu po restarcie**, co jest luką
   w dowodowości, a nie w autoryzacji. Wpisane jako wejściowe ustalenie dla RA-026,
   bo dotyka jego AC8 razem z `CTF-014`.

## 8. Zgodność z zasadami implementacji

- **Kontrakty i architektura** — bez zmian bez ADR-a. Migracja `032` jest
  **additive** i nie edytuje żadnej istniejącej; `ACTION_REGISTRY` **nietknięty**
  (dlatego `CTF-014` jest deferred, nie „naprawiony po drodze").
- **Model nie jest warstwą autoryzacji** — wzmocnione, nie osłabione: żaden nowy
  caller `evaluatePolicy` nie powstał, a drill dowodzi, że tier i decyzja nadal
  pochodzą z rejestru.
- **`PolicyInput.now` z zegara bazy** — nie dodałem nowego callera; wymóg jest
  **zapisany jako test** w `cross-account.test.ts` (obie połowy: odmowa i backdated).
- **Sekrety** — nic nie ujawnione w promptach, logach, fixtures ani dokumentach.
  Kanarki w testach są syntetyczne (`CANARY7d77c1e9`), nie prawdziwymi wartościami.
- **Idempotencja** — `ra_retention_purge_raw_payload` jest idempotentna
  (drugi przebieg = 0 wierszy), sprawdzone testem.
- **Jeden writer na workspace** — **umocnione** przez naprawę `CTF-012`.
- **Komentarz nie jest dowodem** — trzy findingi tego audytu to dokładnie ten wzorzec
  (`retain_until`, „case-branch pushes", cztery ścieżki kontroli), wszystkie wykryte
  uruchomioną komendą.

## 9. Werdykt

Wszystkie siedem kryteriów akceptacji spełnione, każde z uruchomioną komendą i
podanym exit code. Bramki repozytorialne, które były czerwone na `main` przed tym
taskiem, są zielone. Pozostałe findingi: dwa LOW (`CTF-014` `defer` z ADR-em,
`CTF-015` `accept`), zero BLOCKER, zero HIGH, zero MEDIUM.

Trzy findingi HIGH/MEDIUM zamknięte i potwierdzone dowodem: `CTF-006` (HIGH),
`CTF-013` (MEDIUM), plus `CTF-008` i `CTF-012` (LOW).

- Werdykt: `PASS`
