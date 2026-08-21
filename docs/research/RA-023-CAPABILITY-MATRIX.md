# RA-023 — AgentCore Gateway i oficjalne MCP targets: matryca zdolności

- Data weryfikacji: `2026-08-21`
- Metoda: odczyt **oficjalnej dokumentacji dostawców** (`WebFetch`), nie pamięci modelu.
  Plan RA-023 wymaga tego wprost: „werdykt oparty na pamięci modelu jest bezwartościowy".
- Zakres: AC1 taska (werdykt `ADOPT`/`DEFER`/`REJECT` per provider z dowodami).

Ten dokument zawiera **dowody**. Werdykty i ich konsekwencje są w
[ADR-0008](../decisions/ADR-0008-agentcore-gateway-verdicts.md).

## 1. AgentCore Gateway — co usługa faktycznie daje

Źródło: `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html`
oraz `gateway-outbound-auth.html`, `gateway-fine-grained-access-control.html`,
`gateway-supported-targets.html`, `gateway-target-integrations.html`.

| Zdolność | Stan według dokumentacji |
|---|---|
| Rola | „fully managed AI gateway… single, secure entry point for agentic traffic" |
| Protokół | konwertuje OpenAPI/Smithy/Lambda na tools MCP; MCP targets w trybie agregacji |
| Inbound auth | OAuth authorization server albo AWS IAM |
| Outbound auth | brak / gateway service role (SigV4) / caller IAM / OAuth 2LO / OAuth 3LO / token exchange / token passthrough / API key |
| Credential storage | AgentCore Identity + **AWS Secrets Manager** (`secretArn` zwracany przy tworzeniu providera) |
| Fine-grained policy | **interceptory** (REQUEST) albo resource-based policies (Cedar) |
| Tool discovery | `tools/list` agregowany; „capability synchronization" po stronie MCP targets |
| Observability | wbudowana, „built-in observability and auditing" |

### 1.1 Outbound auth — czy model widzi token? (AC5)

Dokumentacja outbound auth opisuje wyłącznie ścieżkę, w której **gateway** pobiera
credential i podpisuje żądanie do targetu. Wymagane uprawnienia roli gateway'a to
`bedrock-agentcore:GetResourceOauth2Token`, `GetResourceApiKey` i
`secretsmanager:GetSecretValue` — czyli **rola gatewaya**, nie kod agenta.

Wniosek dla AC5: architektura Gateway jest **zgodna** z „model nie otrzymuje
tokenów", o ile agent nie wywołuje `GetResourceOauth2Token` samodzielnie. To znaczy,
że AC5 pozostaje **naszym** wymogiem do wyegzekwowania, nie gwarancją dostawcy —
uprawnienie do pobrania tokenu jest zwykłym IAM actionem i można je nadać komukolwiek.

**Nie znalazłem** w dokumentacji zdania wprost gwarantującego, że token nigdy nie
wraca do wołającego. Zapisuję to jako brak dowodu, nie jako dowód braku.

### 1.2 Fine-grained access control — druga warstwa policy (audit focus)

Cytat: „Gateway interceptors provide the most flexible way to implement fine-grained
access control. REQUEST interceptors execute before the gateway makes a call to the
target". Poziomy: gateway / tool / operation / parameter.

To jest dokładnie ryzyko z audit focus RA-023 („podwójna warstwa policy"):
interceptor jest **kodem, który my piszemy i wdrażamy w AWS**, a nie deklaratywną
polityką. Konsekwencja: przyjęcie Gateway'a nie zdejmuje z nas policy — dokłada
**drugie miejsce**, w którym policy trzeba utrzymać spójnie z `packages/policy`.

Best practice z tej samej strony: „Implement fail-safe defaults - Design interceptors
to deny access by default when authorization cannot be determined." Czyli sam dostawca
mówi, że fail-closed jest po stronie implementującego.

### 1.3 Blokada IaC dla built-in templates

Cytat z `gateway-target-integrations.html`, sekcja „Key considerations and
limitations": **„You can only add an integration provider template as a target through
the AWS Management Console and not through the API."**

To bezpośrednio kłóci się z zakresem RA-023 („IaC/spike AgentCore Gateway"). Target
oparty na built-in template **nie jest** odtwarzalny z IaC.

Druga limitacja z tej samej sekcji: „Amazon Bedrock AgentCore doesn't host any servers
natively, so you must set up server hosting yourself." Czyli built-in template nie
zwalnia z hostowania serwera MCP.

## 2. Providery wymagane przez task

### 2.1 Atlassian / Jira

| Wymiar | Ustalenie | Źródło |
|---|---|---|
| Oficjalny remote MCP | tak — Atlassian Rovo MCP Server, „securely connects Jira, Confluence and more" | `atlassian.com/platform/remote-mcp-server` |
| Maturity | strona **nie podaje** GA/Beta/Preview wprost; dostępny publicznie i udokumentowany | jak wyżej |
| Auth | „OAuth authentication and granular permission controls"; akcje w uprawnieniach użytkownika | jak wyżej |
| Rate limit | Free 500/h; Standard 1 000/h; Premium/Enterprise 1 000/h + 20 na użytkownika, max 10 000/h | jak wyżej |
| Ograniczenie | **„The MCP server does not currently support FedRAMP or HIPAA requirements."** | jak wyżej |
| AgentCore built-in template | tak, „The Jira Cloud platform" | `gateway-target-integrations.html` |
| Outbound auth tego template | **wyłącznie API key** | jak wyżej |

Uwaga istotna dla nas: template Jira w AgentCore akceptuje **tylko API key**, a nie
OAuth. Nasze RA-016 połączenie Jira jest OAuth-owe z pełnym refresh lifecycle
(`credential-refresh.ts`). Przyjęcie template'u oznaczałoby **degradację** modelu
uwierzytelnienia, nie ulepszenie.

Osobno: template obejmuje `deleteIssue`, `deleteProject`, `deleteSprint`,
`deleteComment` — operacje, które nasza policy klasyfikuje jako **R4**. Gateway nie zna
naszych tierów, więc bez interceptora dawałby modelowi narzędzia usuwania obok
narzędzi czytania.

### 2.2 GitLab

| Wymiar | Ustalenie | Źródło |
|---|---|---|
| Oficjalny MCP server | tak | `docs.gitlab.com/user/model_context_protocol/mcp_server/` |
| Maturity | **„Status: Beta"** (cytat dosłowny) | jak wyżej |
| Auth | OAuth 2.0 Dynamic Client Registration | jak wyżej |
| Zakres | project info, issues, merge request data | jak wyżej |
| AgentCore built-in template | **BRAK** — GitLaba nie ma na liście integration providers | `gateway-target-integrations.html` |

Beta + brak template'u w AgentCore. Zgodnie z zakresem taska („Preview/Beta zawsze ma
fallback w postaci własnego, wąskiego adaptera") GitLab wymagałby fallbacku — który
**już mamy** z RA-017.

### 2.3 Google Gmail / Calendar

| Wymiar | Ustalenie |
|---|---|
| Oficjalny first-party MCP server dla Gmail/Calendar | **nie znalazłem** żadnego w dokumentacji Google |
| Sprawdzone URL-e | `developers.google.com/workspace/mcp` → HTTP 404; `cloud.google.com/agentspace/docs/mcp` → 301 → 404 |
| AgentCore built-in template | **BRAK** — na liście jest Microsoft (Exchange/OneDrive/SharePoint/Teams), **nie ma Google** |

Formułuję to ostrożnie: **nie znalazłem** oficjalnego serwera, co nie jest tym samym
co dowód, że nie istnieje. Ale skutek dla decyzji jest identyczny — nie ma czego
`ADOPT`ować dla dwóch kont Google, a to właśnie one są najdelikatniejszą częścią
systemu (`RA-019`/`RA-020` i wymóg braku cross-account leakage).

Zwracam uwagę: AgentCore ma template Microsoft Exchange z operacjami mailowymi i
kalendarzowymi. **To nie jest zamiennik** — nasze konta są Google, a nie Microsoft.

### 2.4 Slack (opcjonalny)

| Wymiar | Ustalenie |
|---|---|
| AgentCore built-in template | tak, „Slack Web" |
| Outbound auth | **wyłącznie API key** |
| Zakres | `chat.postMessage`, `conversations.*`, `files.*`, `search.all`, `usergroups.*`, `reminders.add`, `users.profile.set` |

Zakres template'u jest znacznie szerszy niż „dodatkowe narzędzie": zawiera
`usersProfileSet` i `userGroupsUsersUpdate`, czyli modyfikację profili i grup. Task
mówi „opcjonalny Slack MCP wyłącznie jako dodatkowe narzędzie, nie UI systemu" — ten
template nie jest wąski.

## 3. AgentCore Runtime — spike dla `WorkspaceRunner` (AC6)

Źródło: `runtime-sessions.html`.

| Wymiar | Ustalenie (cytaty) |
|---|---|
| Domyślna trwałość | „By default, the compute (microVM) associated with a session is ephemeral. Any data stored in memory or written to disk persists only for the compute lifecycle." |
| Długość sesji | „Sessions last up to 8 hours for each lifecycle on microVMs, or up to 14 days on Instances." |
| Idle timeout | „inactivity (default 15 minutes)" |
| Terminacja | „After session completion, the entire microVM is terminated and memory is sanitized" |
| Trwały filesystem | opcjonalny „session storage" przetrwa stop/resume |
| Mapowanie user↔session | **„AgentCore does not enforce session-to-user mappings - your client backend should maintain the relationship"** |

To **potwierdza wprost** założenie AC6 i punkt 3 „Ustaleń z kodu": sesja Runtime jest
transportem/cache, nigdy authority. Domyślnie efemeryczna, ubijana po 15 minutach
bezczynności, a mapowanie tożsamości jest jawnie **naszym** obowiązkiem. Checkpoint
musi zostać w Postgresie — co już jest prawdą (`packages/database`, RA-003/RA-008).

Dobra wiadomość dla AC6: `StopRuntimeSession` + „The session transitions back to Active
on the next invocation and a new compute is provisioned" to dokładnie kształt
stop/resume, którego wymaga Required verification — i nasz `WorkspaceRunner` ma już
fencing i recovery (RA-010).

## 4. Zestawienie dla decyzji

| Target | Oficjalny MCP | Maturity | AgentCore template | Outbound auth template'u | Mamy własny adapter? |
|---|---|---|---|---|---|
| Jira | tak (Rovo) | nieokreślona | tak | **tylko API key** | tak (RA-016, OAuth) |
| GitLab | tak | **Beta** | **brak** | — | tak (RA-017) |
| Gmail | nie znaleziono | — | **brak** | — | tak (RA-019) |
| Calendar | nie znaleziono | — | **brak** | — | tak (RA-020) |
| Slack | — | — | tak | **tylko API key** | nie (i nie jest wymagany) |

Wspólny mianownik: **dla każdego providera, którego ten system faktycznie używa, mamy
już działający, zaudytowany adapter, a AgentCore nie oferuje dla niego ścieżki lepszej
niż ta, którą mamy.** Dla dwóch z czterech nie oferuje żadnej.
