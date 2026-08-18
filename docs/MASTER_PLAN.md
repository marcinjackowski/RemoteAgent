# RemoteAgent — Master Plan

## 1. Cel produktu

RemoteAgent jest prywatnym systemem pracy sterowanym z Discorda. Łączy zdarzenia
z Jira, dwóch kont Gmail, dwóch kont Google Calendar oraz wybranych repozytoriów
GitLab. Najważniejszym przepływem jest pełny engineering loop:

```text
task -> rozmowa -> decyzje -> plan -> kod -> testy/snapshoty -> review
     -> poprawki -> commit/push -> Merge Request -> pipeline -> dalsza rozmowa
```

System ma przetrwać restart i utratę sesji modelu bez utraty kontekstu oraz bez
niekontrolowanego powtórzenia side effectów.

## 2. Wyniki użytkowe

1. Zdarzenie integracji pojawia się w odpowiednim prywatnym kanale Discord.
2. Jedna sprawa ma jeden trwały Discord thread i może łączyć Jira issue, branch,
   GitLab MR, pipeline, e-mail albo wydarzenie.
3. W różnych sprawach agenci mogą pracować równolegle.
4. W jednej sprawie jest najwyżej jeden implementer zapisujący kod.
5. Agent potrafi przerwać pracę i zadać właścicielowi pytanie decyzyjne.
6. Odpowiedź właściciela wznawia nowy, one-shot run z trwałego checkpointu.
7. Każdy krok ma audytowalny intent, rezultat, test evidence i receipt.
8. Agent tworzy branch, commity, push i GitLab Merge Request w dozwolonym repo.
9. Merge, force-push, produkcyjne wdrożenie i destrukcyjne operacje pozostają
   osobnymi, jawnymi decyzjami właściciela.

## 3. Decyzje bazowe

### 3.1 Repozytorium

- Monorepo TypeScript używające `pnpm` workspaces i lekkiej orkiestracji tasków.
- Wersje Node, pnpm i zależności muszą być przypięte w repozytorium.
- Aplikacje są osobno wdrażalne mimo wspólnego repozytorium.
- TypeScript działa w trybie strict; kontrakty runtime są walidowane schematami.

Planowana struktura:

```text
apps/
  ingress-api/
  discord-bot/
  scheduler/
  event-worker/
  agent-worker/
  action-executor/

packages/
  contracts/
  database/
  event-envelope/
  connector-jira/
  connector-gmail/
  connector-calendar/
  connector-gitlab/
  bedrock-runtime/
  agent-orchestrator/
  workspace-runner/
  mcp-tool-broker/
  policy/
  observability/

infra/
  cdk/
```

### 3.2 Dane i kolejki

- PostgreSQL jest autorytatywnym źródłem stanu biznesowego.
- Każda integracja ma logicznie oddzielony append-only raw event log, ale nie
  osobną fizyczną bazę na początku.
- Transactional outbox łączy zmiany DB z publikacją do kolejek i Discorda.
- Worker używa trwałych leases z timeoutem i fencing tokenem.
- W AWS kolejki mogą być realizowane przez SQS z DLQ; lokalnie adapter może
  działać na PostgreSQL. Semantyka musi pozostać taka sama.

### 3.3 Modele i Bedrock

- Pierwszy runtime używa Amazon Bedrock `Converse`/`ConverseStream`.
- Historia rozmowy i stan taska są składane przez aplikację; pamięć modelu nie
  jest źródłem prawdy.
- Każdy model call zapisuje intent przed wywołaniem i completion po walidacji.
- Wyniki ról używają versioned JSON Schema.
- AgentCore Runtime jest opcjonalnym hostem izolowanych runnerów w późniejszej
  fazie, nie magazynem operacyjnego stanu.
- AgentCore Gateway jest docelowym kandydatem na zarządzaną bramę MCP i OAuth.

### 3.4 Discord

Prywatny serwer zawiera co najmniej:

```text
#jira
#gmail-private
#gmail-sondermind
#calendar-private
#calendar-sondermind
#gitlab
#system
```

`#system` przechowuje alerty, DLQ, błędy odnowienia watchy i status systemu.
Konto prywatne oraz SonderMind nie mogą współdzielić kontekstu ani narzędzi przez
samą decyzję modelu.

### 3.5 Multi-agent

Jedna sprawa ma logicznego `Case Supervisor`, który jako jedyny komunikuje się z
właścicielem. Supervisor uruchamia w razie potrzeby role:

- Planner — read-only analiza i plan;
- Implementer — jedyny writer workspace;
- Reviewer — niezależne review bez edycji;
- Verification Agent — interpretuje deterministyczne wyniki testów;
- Specialist — opcjonalna rola uruchamiana przez reguły zakresu.

Role są one-shot. Ich ciągłość zapewniają kontrakty i checkpointy.

## 4. Architektura przepływu

```text
Jira webhook ─────────┐
Gmail Pub/Sub x2 ─────┤
Calendar watch x2 ────┼─> ingress -> raw event -> normalize -> enrich
GitLab webhooks ──────┘                              |
                                                     v
                                         case/entity resolver
                                                     |
                                             Postgres + outbox
                                                     |
                                      Discord channel + case thread
                                                     |
                                  command/event -> per-case durable queue
                                                     |
                       context builder -> Supervisor -> role work units
                                                     |
                      workspace tools / MCP broker / policy / approvals
                                                     |
                      receipts + checkpoint + Discord progress message
```

Ingress odpowiada szybko po bezpiecznym zapisaniu zdarzenia. Parsowanie, API
enrichment i agent work nie odbywają się w request handlerze webhooka.

## 5. Kluczowe kontrakty

### 5.1 EventEnvelope

Minimalne pola:

```text
event_id
schema_version
provider
connection_id
external_event_id
event_type
occurred_at
received_at
actor
entity_ref
correlation_keys
dedupe_key
payload_ref
trace_id
sensitivity
```

Raw payload jest przechowywany osobno, szyfrowany, objęty retencją i wskazywany
przez `payload_ref`. Normalized event nie kopiuje bez potrzeby pełnej treści maila.

### 5.2 Case

`Case` jest jednostką rozmowy, współbieżności i checkpointu. Może posiadać wiele
powiązanych `ExternalEntity`, np. Jira issue + GitLab branch + MR + pipeline.

Wymagane pola:

```text
case_id, owner_id, status, integration_scope, discord_thread_id,
active_run_id, checkpoint_revision, created_at, updated_at
```

### 5.3 CaseCheckpoint

```text
case_id
revision
goal
current_phase
summary
plan_revision
completed_work[]
decisions[]
assumptions[]
evidence[]
open_questions[]
next_actions[]
blockers[]
pending_approvals[]
workspace_state
branch_state
test_runs[]
snapshot_changes[]
review_findings[]
merge_request_state
external_state_versions
last_event_id
last_run_id
updated_at
```

JSON w DB jest źródłem prawdy. Markdown oraz przypięta wiadomość Discord są
projekcjami do odczytu przez człowieka i agenta.

### 5.4 AgentCompletion

Każdy model run kończy się jednym statusem:

```text
CONTINUE
WAITING_FOR_USER
BLOCKED
COMPLETED
FAILED
CANCELLED
```

Completion zawiera podsumowanie, wykonane kroki, evidence, propozycję patcha
checkpointu, następne akcje i opcjonalny `DecisionRequest`.

### 5.5 DecisionRequest

```text
decision_id
question
why_now
options[{id, label, consequences}]
recommendation
blocked_scope
checkpoint_revision
expires_at?
```

Odpowiedź właściciela jest związana z `decision_id` i rewizją checkpointu.
Stara odpowiedź nie może zostać zastosowana do zmienionego pytania.

### 5.6 ExternalAction

```text
action_id
case_id
tool_name
target_scope
canonical_payload
action_digest
risk_tier
policy_decision
approval_id?
idempotency_key
status
external_receipt
```

Model proponuje, policy decyduje, deterministic executor wykonuje.

## 6. State machines

### 6.1 Case

```text
NEW -> TRIAGED -> PLANNING -> WAITING_FOR_USER -> PLANNING
                    |
                    v
              IMPLEMENTING -> VERIFYING -> REVIEWING -> FIXING
                    ^                         |
                    +-------------------------+
                                              v
                                      READY_FOR_MR -> MR_OPEN
                                              |
                                   DONE | BLOCKED | CANCELLED
```

### 6.2 Run safety

Każdy model call, tool call i side effect ma:

```text
PLANNED -> INTENT_RECORDED -> STARTED -> SUCCEEDED | FAILED | AMBIGUOUS
```

Po restarcie:

- potwierdzony completion jest rekonstruowany bez ponownego wywołania;
- idempotentny odczyt może zostać powtórzony;
- niepotwierdzony write jest uzgadniany z systemem zewnętrznym;
- brak możliwości uzgodnienia daje `AMBIGUOUS` i zatrzymuje automatyczny replay.

## 7. Workspace i coding loop

Każdy coding case posiada izolowany workspace:

```text
case_id -> repo allowlist entry -> base SHA -> worktree/container -> branch
```

Runner zapewnia:

- filesystem ograniczony do workspace;
- kontrolowane command execution z timeoutem i limitami zasobów;
- network deny-by-default z allowlistą zależną od fazy;
- brak sekretów w środowisku widocznym dla modelu;
- tree digest przed i po operacji;
- artefakty testów i logi poza promptem, z kontrolowanymi excerptami;
- możliwość odtworzenia workspace z Git + checkpointu.

Kolejność engineering loop:

1. repository discovery i instrukcje repo;
2. analiza Jira i linked context;
3. pytania decyzyjne;
4. wersjonowany plan;
5. utworzenie brancha;
6. implementacja małymi krokami;
7. deterministyczne testy;
8. ocena snapshotów;
9. niezależny review;
10. fix loop z limitem iteracji;
11. lokalne commity;
12. push i draft MR;
13. pipeline/review feedback;
14. dalsze poprawki albo zakończenie.

## 8. Integracje ingress

### Jira

- webhooki filtrowane do ustalonego zakresu;
- scheduler odnawia dynamiczne rejestracje przed wygaśnięciem;
- parser obsługuje issue, comment, status i changelog;
- enrichment pobiera autorytatywny stan issue;
- issue key jest głównym correlation key dla coding case.

### Gmail x2

- osobny OAuth connection dla `private` i `sondermind`;
- Gmail watch -> Pub/Sub -> `history.list`;
- watch odnawiany przez scheduler;
- okresowy reconciliation chroni przed utraconym push;
- parser buduje thread-centric event, bez niepotrzebnego kopiowania załączników.

### Calendar x2

- osobny OAuth connection dla każdego konta;
- osobny watch dla obserwowanych kolekcji;
- notification jest sygnałem do incremental sync przez `syncToken`;
- wygaśnięcie tokenu powoduje kontrolowany full resync;
- recurring events i cancelled instances mają jawne kontrakty.

### GitLab

- allowlista projektów jest ustalana poza modelem;
- webhooki obsługują MR, issue, note, push, pipeline i job;
- podpis, timestamp i idempotency są weryfikowane przed przetwarzaniem;
- branch/MR/pipeline są korelowane z istniejącym case;
- tworzenie MR jest idempotentne względem case i brancha.

## 9. MCP i narzędzia

MCP nie służy do odbierania eventów. Jest warstwą narzędzi używanych podczas
agent runów.

`McpToolBroker`:

- odkrywa narzędzia, ale wystawia modelowi wyłącznie dozwolony podzbiór;
- server-side wstrzykuje owner, connection i repo scope;
- nigdy nie ufa identyfikatorom scope przekazanym przez model;
- normalizuje i ogranicza output;
- loguje intent, wynik, latency i correlation IDs;
- oddziela read tools od proponowania write actions;
- prowadzi circuit breaker i rate limits per provider.

Oficjalne zdalne MCP Jira, Google Workspace, GitLab i opcjonalnie Slack będą
podłączane dopiero po przejściu testów capability, auth, prompt injection i
revocation. Preview/Beta zawsze ma fallback w postaci własnego, wąskiego adaptera.

## 10. Policy i approval

Proponowane risk tiers:

| Tier | Przykład | Domyślne zachowanie |
|---|---|---|
| R0 | odczyt issue, mail thread, event, MR | automatyczne w scope case |
| R1 | lokalny patch, test, branch, commit | automatyczne w sandboxie |
| R2 | push case branch, draft MR, draft mail | scope grant właściciela |
| R3 | wysłanie maila, zmiana Jira, Calendar, komentarz zewnętrzny | exact approval albo jawna reguła |
| R4 | merge, force-push, delete, prod deploy, permissions | zawsze exact approval |

Approval jest owner-scoped, krótkotrwałe, związane z dokładnym action digestem i
konsumowane jeden raz. Policy jest sprawdzane przy propozycji i tuż przed
wykonaniem.

## 11. Observability i privacy

Wymagane:

- trace od external event do Discord message, runu, tool call i receipt;
- metryki backlogu, lease expiry, retry, DLQ, kosztu/tokens Bedrock i rate limitów;
- redakcja sekretów oraz danych wrażliwych przed logowaniem;
- szyfrowanie transportu i storage;
- retencja osobna dla raw payload, normalized events, audit i artefaktów;
- eksport/usunięcie danych per connection;
- alerty odnowienia webhook/watch;
- kill switch globalny, per provider, per connection i per case.

## 12. Strategia dostarczenia

Najpierw powstaje golden path Jira -> Discord -> Bedrock -> workspace -> GitLab
MR. Gmail i Calendar są dodawane dopiero po udowodnieniu trwałości coding loop.

Każdy task z `docs/tasks/TASK_INDEX.md` przechodzi osobną bramkę audytową. Task
jest zakończony dopiero po `PASS`.

## 13. Systemowe kryteria końcowe

System jest gotowy do pierwszego produkcyjnego użycia, gdy:

1. dwa Jira taski pracują równolegle w izolowanych workspace;
2. restart w każdej fazie nie traci checkpointu ani eventu;
3. niejednoznaczny write nie jest automatycznie powtarzany;
4. właściciel może odpowiedzieć na trwałe pytanie decyzyjne przez Discord;
5. branch, commity, test evidence, review i MR są powiązane z jednym case;
6. konta private i SonderMind nie przeciekają między kontekstami;
7. webhooki/watch są odnawiane i okresowo uzgadniane;
8. wszystkie R3/R4 mają policy evidence, approval i receipt;
9. backup/restore oraz kill switch zostały sprawdzone ćwiczeniem;
10. końcowy audyt bezpieczeństwa i niezawodności ma werdykt PASS.

## 14. Lokalne źródła wzorców

Podczas implementacji wolno adaptować koncepcje, ale nie kopiować bez audytu:

- `../Wizard` — Discord, event envelope, policy, approval, audit;
- `../EngineeringLoop` — pending intent, completion envelope, recovery i role;
- `../board/src/lib/orchestrator/llm.ts` — klient Bedrock i tool loop;
- `../Agent` oraz `../Test` — wyłącznie pomocnicze wzorce DAG/concurrency.

Każdy import kodu wymaga sprawdzenia licencji, zależności, sekretów i dopasowania
do kontraktów RemoteAgent.

