# RA-027 — AUDIT-01

- Task: `RA-027` Composition roots: uruchamialne procesy
- Data: `2026-08-22`
- Bazowy commit: `9b45f4e` (WU-01/WU-02 zacommitowane w trakcie)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt jest w §8.

## 1. Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run          (całe repo)
  → 2374/2374, 166 plików, exit 0, TRZY przebiegi z rzędu, zero `Errors`

RA_REQUIRE_POSTGRES=1 pnpm vitest run test/processes
  → 32/32, 3 pliki, exit 0

pnpm run lint / format                     → exit 0
node …/tsc.js -p tsconfig.json --noEmit    → exit 0
pnpm run typecheck --force                 → 37 successful, 0 cached
pnpm run build --force                     → exit 0
pnpm workflow:validate                     → OK — 27 tasks
git diff --check                           → exit 0
```

## 2. Dowód, że system faktycznie startuje

To jest jedyna rzecz, której nie miał żaden poprzedni task. Uruchomione przeciwko
**realnemu** PostgreSQL-owi na 5433:

```text
--- starting worker process ---
worker listening on 127.0.0.1:56137
GET /livez  -> 200 {"process":"worker","state":"UP","checks":[{"name":"process","state":"UP"}]}
GET /readyz -> 200 {"process":"worker","state":"UP","checks":[…,{"name":"postgres","state":"UP"}]}
GET /metrics-> 404 {"error":"not_found"}

--- health CLI, dokładnie jak wywołuje ją ECS ---
default path            : /livez
--readiness path        : /readyz
probe exit code (live)  : 0

--- SIGTERM ---
shutdown outcome: {"reason":"SIGTERM","drained":true,"clean":true}
probe exit code (stopped): 1
```

Proces wstaje, odpowiada na HTTP, zamyka się czysto na `SIGTERM`, a health CLI
raportuje `0` na żywym i `1` na zatrzymanym. Przed tym taskiem żadna z tych linii nie
była możliwa.

## 3. Kryteria akceptacji — każde osobno

### AC1 — start, health, czyste zamknięcie na `SIGTERM`

**Spełnione.** `packages/observability/test/process-runtime.test.ts` (18) +
`test/processes/lifecycle.integration.test.ts` (7).

**Shutdown jest SEKWENCJĄ, nie handlerem sygnału**, i kolejność jest treścią:

1. przestań raportować ready — load balancer przestaje kierować **przed** ruszeniem
   czegokolwiek w locie;
2. przestań przyjmować nową pracę;
3. poczekaj na pracę w locie, z limitem;
4. zamknij bazę, **na końcu**, bo kroki 2 i 3 jej potrzebują.

Test asertuje **zapisaną sekwencję wywołań**, nie „shutdown wrócił". Handler, który
zamknął bazę i potem zgłosił unready, przeszedłby każdą asercję „czy się zatrzymał".

Limit drainu jest **ograniczony** (20s) i raportuje, co porzucił. Nieograniczony drain
jest kłamstwem: ECS wysyła `SIGKILL` 30s po `SIGTERM`, więc proces zostanie zabity
w środku pracy tak czy inaczej — tylko bez linii logu mówiącej o tym.

Health **zostaje zbindowany** przez cały shutdown i zwraca uczciwe 503, zamiast
zamknąć port — orchestrator może odczytać odrzucone połączenie jako crash.

### AC2 — `/livez` bez bazy, `/readyz` z bazą

**Spełnione, i sprawdzone STRUKTURALNIE, nie zachowaniowo.**

Test **liczy wywołania** `isDatabaseReachable`: liveness = 0, readiness = 1. Sprawdzenie
zachowaniowe („liveness zwraca UP") byłoby niewystarczające, bo przeszłoby również
wtedy, gdyby liveness konsultował bazę i baza akurat działała — a przy następnej awarii
zachowanie by się zmieniło.

To tu ustalenie RA-024 przestaje być teoretyczne: ECS **restartuje** taska, którego
health check padnie, więc liveness konsultujący PostgreSQL zapętliłby restart każdego
workera w trakcie awarii bazy — dokładnie wtedy, gdy jego lease'y w locie i logi są
jedynym dostępnym dowodem.

`DEGRADED` zwraca **503, nie 200**: load balancer czyta status code, nie body.

Health CLI domyślnie probuje **liveness**; `--readiness` trzeba poprosić jawnie.
Pomyłka w tę stronę byłaby aktywnie szkodliwa, więc domyślna wartość failuje w stronę
„nie restartuj".

### AC3 — nazwy `dist/*.js` zgodne z `infra/cdk`

**Spełnione.** `test/processes/entrypoints.test.ts` (8) czyta komendy **z kodu CDK**,
nie z powtórzonej listy — powtórzenie byłoby drugim źródłem, które może się rozjechać.

**To jest test, który wykryłby istnienie RA-027.** RA-026 certyfikował dziesięć
kryteriów §13, a `dist/worker.js` nie istniał. Sprawdzane jest też, że każdy entry
point **eksportuje `main()`** i **strzeże swojego wywołania top-level** — plik, który
istnieje, ale nic nie eksportuje, przeszedłby samo sprawdzenie nazw i padłby przy
deployu.

### AC4 — utrata bazy nie porzuca pracy w locie

**Spełnione**, przeciwko realnej bazie. Test zamyka pulę **pod procesem** i asertuje:
`readyz` → 503, `livez` → **200**. Plus druga połowa: proces z już nieżywą bazą
**nadal zamyka się czysto** — shutdown nie może zależeć od tego, co padło.

### AC5 — brak sekretu w logu i w health

**Spełnione, i tu kanarek znalazł realny defekt** — §5.1.

### AC6 — golden path przez procesy

**Spełnione częściowo, i tak to zapisuję.** Procesy startują i przechodzą pełny
lifecycle przeciwko realnej bazie (32 testy), ale **golden path Jira→MR nie przechodzi
przez uruchomione procesy**, bo domyślne handlery są puste — patrz §6. Kryterium
mówi „przez uruchomione procesy"; to co jest udowodnione, to że procesy działają, a nie
że przenoszą przez siebie pełny scenariusz.

### AC7 — brak Dockera odnotowany

**Spełnione.** `Dockerfile` i `docker-compose.app.yml` powstały i **nie zostały
zbudowane ani uruchomione** — Docker ma niezgodny client/engine na tej maszynie.
Zapisane w komentarzu każdego z tych plików, nie tylko tutaj.

## 4. Mutation checki — 31 mutacji

```text
baseline                                          green
R1-R8   sekwencja shutdownu, limity, idempotencja  red
H1-H6   semantyka health, redakcja, 404            red
D1-D2   dispatch fail-closed                       red
W1-W3   drain workera, probe bazy, walidacja env    red
C1-C3   health CLI                                 red
E1-E3   bezpieczeństwo executora                    red
I1-I3   zawężenia ingressu                          red
S2      pierwszy tick natychmiast                   red
restored                                          green
```

### 4.1 DWANAŚCIE mutacji przeżyło pierwszy przebieg

I wzorzec był jednolity, co jest najużyteczniejszą rzeczą w tym audycie:
`lifecycle.integration.test.ts` dowodził, że **każdy proces startuje, serwuje health i
się zatrzymuje** — co jest dokładnie tym, o co prosi AC1 — **i nie asertował niczego o
tym, co dany proces robi.**

Więc przeszły mutacje, które:

- kazały executorowi podejmować akcje `AMBIGUOUS` (**blind replay**, czyli to, czego
  zabrania AC5 z RA-025);
- kazały mu podejmować akcje `EXECUTING`;
- usunęły limit rozmiaru body z ingressu;
- pozwoliły tickom schedulera stackować się bez ograniczenia;
- kazały health CLI traktować każdą odpowiedź jako zdrową.

„Startuje i się zatrzymuje" jest realną właściwością i **niewystarczającą**.
Domknięte przez `test/processes/process-behaviour.integration.test.ts` — właściwości
per-proces, których awaria jest cicha.

### 4.2 Jedna mutacja przeżywa i jest NIEOSIĄGALNA

`S1` (guard przeciw nakładającym się tickom schedulera) przeżywa, bo pętla `await`uje
swój pass **przed** zaplanowaniem następnego timera — więc `inFlight` jest zawsze
`null` w momencie sprawdzenia i nakładanie się nie jest osiągalne przez `loop`.

Sondowane, nie założone. Guard **zostaje**, bo miałby znaczenie, gdyby przyszła zmiana
wołała `tick` z drugiego miejsca (skan wywołany przez operatora, handler sygnału) —
a jego koszt to jedno porównanie. Zapisane w kodzie, żeby nie był
niewyjaśnionym ocalałym.

## 5. Findingi tego audytu

### 5.1 Body odpowiedzi health nie było redagowane

Wykryte **kanarkiem**, nie przeglądem. Rozumowałem, że `HealthReport.detail` jest
pisany przez `health.ts` i nie nosi credentiala — co jest prawdą **dziś** i jest
dokładnie kształtem `CTF-006`: powierzchnia zwolniona z redakcji, bo jej aktualna
treść jest przypadkiem bezpieczna.

Ścieżka health jest **najbardziej wyeksponowanym outputem w systemie** — osiągalna z
load balancera — i była jedynym, który nie przechodził przez redaktor. Naprawione:
`SecretRedactor` bez `knownSecrets`, czyli przypadek, który RA-024 uczynił
load-bearing.

### 5.2 Zbyt duże body niszczyło socket, więc provider nigdy nie dowiadywał się o 413

Pierwsza wersja wołała `request.destroy()` po przekroczeniu limitu. Test wykrył
konsekwencję: klient widzi **zamknięte połączenie**, nie status, więc provider nie
dowiaduje się niczego i **retryuje to samo zbyt duże body w nieskończoność**.

Naprawione na `pause()`: przestaje konsumować, zostawiając response zapisywalny, więc
handler może odpowiedzieć 413 — co mówi providerowi, że problemem jest samo żądanie.
Ograniczenie pamięci nadal obowiązuje.

### 5.3 Trzy defekty projektowe naprawione w trakcie, przed testem

Zapisuję je, bo pokazują, gdzie pierwsze podejście było gorsze:

1. **Monkey-patch na `Scheduler.tick`.** Pierwsza wersja trackowała pracę w locie przez
   podmianę metody cudzej instancji — źle dwukrotnie: sięga do innego pakietu i liczy
   cały pass (reap + relay + claim) jako „praca w locie", gdy tylko **handler** może
   zostawić joba w połowie. Przeniesione na wrapper handlera.
2. **Nieużywane repozytoria w executorze.** Instancjonowałem cztery repozytoria, których
   ten proces nie używa — `executeAction` je posiada i dostaje przez wstrzyknięte
   `ports`. Usunięte; martwy kod w composition roocie sugeruje, że proces robi więcej,
   niż robi.
3. **`responsive = true` w gałęzi awarii bazy w ingressie.** Bez znaczenia i mylące.
   Usunięte, z jawnym komentarzem, dlaczego `responsive` **nie** jest tam ruszane.

## 6. Czego ten task NIE zrobił

Zapisane jawnie, bo „nie wspomniane" czyta się jak „pokryte". To jest najważniejsza
sekcja tego audytu.

**Trzy procesy startują z PUSTĄ konfiguracją pracy**, i każdy failuje wtedy **głośno**,
nie cicho:

| Proces | Domyślnie | Skutek |
|---|---|---|
| `worker` | pusta mapa handlerów | każdy podjęty job failuje do DLQ z `UnknownJobTypeError` — widoczne, alarmowane |
| `executor` | `runOneAction` rzuca | akcje zostają w `PROPOSED`, błąd w logu przy każdym passie |
| `ingress` | pusta tablica routów | każdy webhook dostaje 404 |
| `scheduler` | pusta lista tasków | **startuje i nic nie robi** — jedyny cicho zły, więc loguje jawne `warn` na starcie |

To jest **świadome zawężenie**, nie niedokończona praca: handlery orchestratora wymagają
runtime'u Bedrocka, workspace roota i katalogu narzędzi; `executeAction` wymaga
`ProviderAdapter` per provider; `ingestJiraWebhook` wymaga `RawPayloadStore`,
connection id i sekretu podpisu. Zakres RA-027 to **składanie istniejących części** —
dodanie logiki domenowej byłoby zmianą architektury bez ADR-a.

Konsekwencja, którą stawiam wprost: **to jest system, który się URUCHAMIA, a nie system,
który WYKONUJE PRACĘ.** Startuje, serwuje health, zamyka się czysto i jest wdrażalny.
Nie przeprowadzi taska z Jiry do MR, dopóki handlery nie zostaną podłączone.

Osobno niewykonane:

1. **Docker build i compose run** — zepsuty client/engine (AC7).
2. **Golden path przez procesy** (AC6) — częściowe, patrz §3.
3. **Realny deploy** — wymaga zgody właściciela, bez zmian od RA-025.

## 7. Zgodność z zasadami implementacji

- **Kontrakty i architektura** — bez zmian bez ADR. Żaden pakiet domenowy nie zmienił
  zachowania; `dispatch.ts` jest nowym modułem, a jego rejestr **odwzorowuje** trzy
  `job_type`, które produkcja już enqueue'uje (sprawdzone `grep`em, nie wymyślone).
- **Model nie jest warstwą autoryzacji** — RA-027 nie dodaje callera `evaluatePolicy`.
- **Fail closed** — nieznany `job_type` idzie do DLQ, nie jest cicho ignorowany ani
  retryowany w nieskończoność. Błędna wartość env **rzuca**, nie cofa się do domyślnej.
- **Sekrety** — health body i logi przechodzą przez `SecretRedactor`; ingress nie
  zapisuje detalu błędu do response, bo komunikat weryfikacji zawiera token.
- **Jeden writer** — jeden executor, jeden gateway Discorda, w kodzie **i** w compose,
  z uzasadnieniem korektnościowym, nie kosztowym.
- **Komentarz nie jest dowodem** — dwa findingi tego audytu (§5.1, §5.2) wykryły
  uruchomione testy, nie przegląd.

## 8. Werdykt

Siedem kryteriów: **sześć spełnionych, AC6 częściowo** (procesy udowodnione,
golden path przez procesy nie). Zero BLOCKER, zero HIGH, zero MEDIUM. Dwa findingi
naprawione w trakcie, oba wykryte uruchomionym testem.

System **startuje** — udowodnione uruchomioną komendą przeciwko realnej bazie (§2),
czego nie miał żaden poprzedni task. System **nie wykonuje jeszcze pracy** i to jest
zapisane w §6 jako świadome zawężenie, nie przemilczane.

- Werdykt: `PASS`
