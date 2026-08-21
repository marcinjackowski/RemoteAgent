# RemoteAgent — known limitations

- Task: `RA-026-WU-04`
- Ustalone: `2026-08-22`
- Bramka: `pnpm vitest run test/acceptance`

## Dlaczego ten dokument istnieje osobno

`RA-026` AC3 wymaga, by **każde znane ryzyko miało ownera i decyzję**
`accept/fix/defer`. Decyzje maszynowo sprawdzalne są w
`scripts/acceptance/criteria.ts`; ten dokument tłumaczy je na język, w którym można
podjąć decyzję go/no-go.

Zasada: **„nie wspomniane" czyta się jak „pokryte".** Każdy punkt poniżej jest tu,
bo ktoś mógłby założyć coś, co nie jest prawdą.

## 1. Dwa kryteria §13 są CZĘŚCIOWE, nie spełnione

To najważniejsza sekcja tego dokumentu.

### §13.8 — „wszystkie R3/R4 mają policy evidence, approval i receipt"

Spełnione dla **approval i receipt**; częściowe dla **policy evidence**.

`PolicyEvaluation.evidence` jest **produkowane i porównywane** — `executeAction`
wycenia policy dwukrotnie i wymaga zgodności (`policyEvaluationsAgree`), więc TOCTOU
jest zamknięte i to jest dowiedzione testami. Ale evidence **nie jest utrwalane** w
`audit_log`, więc po restarcie procesu w bazie nie ma zapisu, na jakim snapshocie
wykonano akcję.

**Decyzja: `defer`.** Domknięcie wymaga wywołania **wewnątrz** `executeAction` — w
tej samej transakcji, która zużywa approval i fencuje na rewizji — plus decyzji, co
audytować przy **odmowie**, nie tylko przy sukcesie. To zmiana zaakceptowanego
kontraktu wykonania, więc ADR i osobny task.

Osobno **`CTF-014`**: push brancha case'a **jest** zapisem zewnętrznym i **nie ma**
wpisu w `ACTION_REGISTRY`, mimo że komentarz rejestru twierdzi, że `R2` go obejmuje.
Nie jest R3/R4, więc kryterium nie jest naruszone literalnie — ale audytor musi
wiedzieć, że to zapis poza rejestrem. Zatrzymany trzema warstwami: `writes_enabled`
domyślnie wyłączone, zamknięta allowlista projektów, allowlista argv dopuszczająca
dziewięć subkomend git (`push --force` nie da się złożyć).

### §13.9 — „backup/restore oraz kill switch sprawdzone ćwiczeniem"

**Kill switch: w pełni ćwiczony.** 13 testów przeciwko realnemu `executeAction` i
realnemu PostgreSQL-owi, ze switchem przestawianym w oknie TOCTOU, z asercją na
**liczniku wywołań** adaptera providera, nie na zwróconym wyniku.

**Restore: ćwiczony dla części decydującej o duplikacie zapisu**, też przeciwko
realnej bazie. **Sam mechanizm AWS — PITR snapshot do świeżego konta — NIE.** Żadne
wywołanie AWS nie miało miejsca w `RA-025`.

**Decyzja: `defer`, wymaga zgody właściciela.** Wykonanie realnego restore drillu
oznacza `cdk deploy` i `restore-db-instance` na koncie AWS, co jest jawnie
zastrzeżone do osobnej zgody.

## 2. Czego system nie robi — świadomie

Nie braki, lecz granice projektowe. Każda jest zapisana, bo brak wzmianki
sugerowałby, że funkcja istnieje.

| Rzecz | Dlaczego nie |
|---|---|
| **Wysyłanie maila** | `gmail.message.send` **nie jest** zarejestrowaną akcją, więc rozwiązuje się do `R4` i jest odrzucana. To kontrola kompensująca over-grantu `gmail.compose` — Google nie ma scope'u „tylko draft" |
| **Merge bez zgody** | `gitlab.mr.merge` jest `R4` i **nigdy** nie może być auto-allowed; stwierdzone dwoma niezależnymi mechanizmami, bo awaria tego kryterium jest nieodwracalna |
| **Wykrywanie prompt injection** | Świadomie **nie** polegamy na detekcji. Obrona jest strukturalna: model nie ma autoryzacji, więc udany injection nie daje uprawnień |
| **Automatyczny retry niejednoznacznego zapisu** | Nigdy. `AMBIGUOUS` rozstrzyga `reconcileAmbiguousAction`, który **czyta** providera |
| **AgentCore Gateway** | Odrzucony ([ADR-0008](../decisions/ADR-0008-agentcore-gateway-verdicts.md)) po weryfikacji dokumentacji dostawcy. Postgres pozostaje authority |
| **Ochrona przed złośliwym właścicielem** | Właściciel jest w modelu zaufania. Chronimy go przed **pomyłką** (approval, kill switch, audit), nie przed sobą |
| **Ochrona po kompromitacji hosta** | Jeżeli atakujący wykonuje kod jako proces RemoteAgent, żadna kontrola nie obowiązuje |

## 3. Bramki, które nie są bramkami — i dlaczego

| Rzecz | Status | Powód |
|---|---|---|
| `pnpm audit` | **świadomie nie jest bramką** | Wymaga sieci i zwraca inną odpowiedź każdego dnia. Build padający, bo w nocy opublikowano advisory, nie jest buildem odtwarzalnym. Zamiast tego `dependency-audit.ts` sprawdza właściwości decydowalne z lockfile'a |
| container scanning | **niewykonane** | Docker na maszynie deweloperskiej jest zepsuty (`AGENTS.md`). SBOM istnieje (275 komponentów, wszystkie z hashami) |
| IaC scanning | **wykonane inaczej** | Nie zewnętrznym skanerem, lecz `policy-checks.ts` nad zsyntetyzowanym template. Ta forma ma zaletę: sprawdza to, co CloudFormation dostanie, nie to, co autor napisał |
| region/service failure simulation | **niewykonane** | Poziom runbooka, nie ćwiczone |
| `CTF-002-U1` guardrail | **niewykonany** | Ręczna sonda type-level jest jedyną rzeczą, która kiedykolwiek wyłapała tę klasę kolizji, i uruchamia się tylko wtedy, gdy plan o niej pamięta. Decyzja `defer` |

## 4. Otwarte findingi przekrojowe

Siedem, wszystkie `LOW`, wszystkie z decyzją. Pełne uzasadnienia w
`scripts/acceptance/criteria.ts` (`OPEN_FINDING_DECISIONS`) — tu skrót:

| ID | Decyzja | Jednym zdaniem |
|---|---|---|
| `CTF-002` | `accept` nazwy / `defer` mechanizm | Kolizje nieosiągalne; guardrail nadal potrzebny |
| `CTF-004` | `defer` | Połowa zamknięta (była blokerem `CTF-013`); `tsconfig.test.json` dla 6 pakietów wymaga rozstrzygnięcia src-vs-dist naraz |
| `CTF-009` | `accept` | Świadomy **podział** polityki, nie defekt: planner **musi** czytać instrukcje, warstwa model-facing ma własną bramkę |
| `CTF-010` | `accept` | Nie defekt — zapisany **wzorzec**, adresowany procesowo. Zamknięcie wpisu wyrzuciłoby najużyteczniejszą diagnostykę tego rejestru |
| `CTF-011` | `defer` | Mechanizm zamknięty dla RA-018; wzorzec otwarty — RA-024/RA-025 dodały pięć suite opierając się na dyscyplinie |
| `CTF-014` | `defer`, wymaga ADR | Push brancha to zapis poza `ACTION_REGISTRY` |
| `CTF-015` | `accept` nazwy / `defer` mechanizm | Sześć kolizji type-level, nieosiągalne |

## 5. Ograniczenia release manifestu

Dwa pola są `unknown`, **z podanym powodem**, nie pominięte:

- **model** — tożsamość modelu **zmieniła się** w trakcie budowy (ADR-0004 →
  ADR-0005), więc jedna wersja byłaby fałszem dla większości opisywanej historii.
  Zapisanie wymaga, by runtime utrwalał rozwiązane `model_id` per agent run.
- **prompts** — prompty są składane z definicji ról i fragmentów kontekstu **w
  czasie wykonania** i nigdy nie są wersjonowane jako całość. Ten sam commit może
  dać różne prompty, gdy zmieni się treść repozytorium — co jest **zamierzone**
  (kontekst **jest** repozytorium), ale znaczy, że „wersja promptu" nie jest
  właściwością, którą ten system ma.

Reszta jest odtwarzalna: schema `32`, tools `13`, IaC = commit (bo `buildApp` jest
czystą funkcją), node `24.19.0`, pnpm `10.26.1`, 275 zależności z lockfile `9.0`.

## 6. Środowisko deweloperskie

Zapisane, bo wpłynęło na projekt, nie tylko na wygodę:

- **Homebrew `node` jest zepsuty** i przesłania działający `/usr/local/bin/node`.
  `scripts/dev/env.sh` to obchodzi.
- **Docker ma niezgodny client/engine.** Dlatego `infra/cdk` **nie** używa
  `DockerImageAsset` — obrazy są referowane przez tag. To okazało się lepszym
  kształtem: build i deploy stają się osobnymi krokami, a `synth` przestaje zależeć
  od lokalnego cache.
- **PostgreSQL 17 działa lokalnie na 5433**, co jest domyślną wartością repozytorium.
  Docker nie jest do niczego potrzebny.
