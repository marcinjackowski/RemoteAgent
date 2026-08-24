# Local bring-up — stan na `2026-08-23`

Ten dokument jest po to, żeby wstać na **nowej maszynie** bez historii czatu. Opisuje, co
działa dziś, czego jeszcze nie ma, i dokładne komendy.

Wszystkie 28 tasków jest `DONE`. Ten dokument nie dotyczy planu pracy, tylko **uruchamiania
systemu lokalnie i testowania integracji po kolei**.

## Stan w jednym akapicie

Discord działa: bot łączy się z gatewayem, identyfikuje się z privileged intentem
`MESSAGE_CONTENT` i odpowiada na `/livez` + `/readyz`. Lokalna baza `remoteagent` jest
zmigrowana (32 migracje, 44 tabele). Worker wykonuje pracę end-to-end (RA-028), ale nie ma
jeszcze katalogu narzędzi, więc agent nie edytuje workspace'u. Jira jest **przygotowana, nie
uruchomiona** — skrypt polla istnieje i przechodzi bramki, brakuje tylko credentiali.

## Wymagania na nowej maszynie

### 1. Toolchain

```bash
. scripts/dev/env.sh      # ustala node (po majorze z .nvmrc), pnpm przez corepack, sprawdza PostgreSQL na 5433
```

**Node musi być `24.19.0`** (`.nvmrc`/`engines`). Node 25 po cichu łamie podsystem
procesów/timeoutów — 22 faile w pełnej suicie (`CTF-019`). `env.sh` wybiera node po majorze i
**ostrzega**, jeśli zgodnego nie ma. Instalacja bez sudo (arm64), jeśli `env.sh` ostrzega:

```bash
mkdir -p $HOME/.local/opt
curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz | tar -xz -C $HOME/.local/opt
# ponów: . scripts/dev/env.sh  → powinno raportować node v24.19.0
```

`env.sh` znajdzie tę instalację automatycznie. Uwaga: brew `node@24` na tej maszynie rozwiązuje
się do v25 — nie polegaj na nim.

Znane realne breakage tej maszyny (`2026-08-20`): Homebrew `node` nie ładuje
`libllhttp.9.3.dylib` i przesłania działający `/usr/local/bin/node`; Docker ma niezgodny
client/engine i zwraca `500`. **Docker nie jest do niczego potrzebny** — PostgreSQL 17 działa
lokalnie na `5433`, co jest domyślną wartością w `packages/database/src/config.ts`.

`env.sh` kończy się linią `pg up on 127.0.0.1:5433`. Jeżeli jej nie ma, Postgres nie stoi.

### 2. PostgreSQL

Potrzebna jest rola i baza `remoteagent` na porcie `5433`:

```bash
psql -h 127.0.0.1 -p 5433 -d postgres -c "SELECT rolname FROM pg_roles WHERE rolname='remoteagent';"
psql -h 127.0.0.1 -p 5433 -d postgres -c "SELECT datname FROM pg_database WHERE datname='remoteagent';"
```

Jeżeli brakuje:

```sql
CREATE ROLE remoteagent LOGIN;
CREATE DATABASE remoteagent OWNER remoteagent;
```

### 3. Migracje — łatwe do przeoczenia

**Baza `remoteagent` startuje z 0 tabelami.** Testy tworzą własne bazy `ra_test_*`, więc
pełna bramka przechodzi na zielono, a baza deweloperska pozostaje pusta i bot nie wstaje.

```bash
pnpm run build --force
node -e '
const { Database, migrateUp, migrationStatus } = await import("./packages/database/dist/index.js");
const db = Database.fromEnv();
console.log("applied:", (await migrateUp(db)).applied.length);
console.log("pending:", (await migrationStatus(db)).filter((s) => !s.applied).length);
await db.close();
' --input-type=module
```

Oczekiwane: `applied: 32`, `pending: 0`, potem 44 tabele w `public`.

## Discord — DZIAŁA

### Setup w Developer Portal

1. [discord.com/developers/applications](https://discord.com/developers/applications) → New Application → **Bot** → token
2. **Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT: ON**

Punkt 2 jest obowiązkowy. `MESSAGE_CONTENT` jest privileged; bez niego gateway zamyka
połączenie kodem `4014`, sesja słusznie się nie ponawia, a przyczyna nie wynika z komunikatu.

### Zaproszenie bota

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=326417591296
```

`326417591296` to policzone minimum z `apps/discord-bot/src/intents.ts`: VIEW_CHANNEL,
SEND_MESSAGES, MANAGE_MESSAGES, READ_MESSAGE_HISTORY, MANAGE_THREADS, CREATE_PUBLIC_THREADS,
SEND_MESSAGES_IN_THREADS. Intents bitfield: `33281`.

### Siedem OSOBNYCH kanałów tekstowych

`jira`, `gmail-private`, `gmail-sondermind`, `calendar-private`, `calendar-sondermind`,
`gitlab`, `system`

Muszą mieć różne id — `ChannelRegistry` rzuca `ChannelConfigError`, gdy jedno id jest
zmapowane do dwóch kluczy logicznych.

### Zmienne środowiskowe (11 wymaganych)

```bash
export DISCORD_BOT_TOKEN='...'                  # Developer Portal → Bot
export DISCORD_GUILD_ID='...'                   # prawy klik na serwer → Copy Server ID
export DISCORD_OWNER_ID='...'                   # prawy klik na SWÓJ nick → Copy User ID
export DISCORD_BOT_USER_ID='...'                # prawy klik na bota → Copy User ID
export DISCORD_CHANNEL_JIRA='...'
export DISCORD_CHANNEL_GMAIL_PRIVATE='...'
export DISCORD_CHANNEL_GMAIL_SONDERMIND='...'
export DISCORD_CHANNEL_CALENDAR_PRIVATE='...'
export DISCORD_CHANNEL_CALENDAR_SONDERMIND='...'
export DISCORD_CHANNEL_GITLAB='...'
export DISCORD_CHANNEL_SYSTEM='...'
# opcjonalne: DISCORD_GATEWAY_URL (domyślnie wss://gateway.discord.gg)
```

Developer Mode: Ustawienia użytkownika → Advanced → Developer Mode: ON.

`DISCORD_OWNER_ID` to jedyna tożsamość, od której system przyjmuje polecenia i zatwierdzenia.
Wiadomość albo klik od kogokolwiek innego jest odrzucany z wpisem w audit logu.

### Preflight — zanim uruchomisz bota

```bash
pnpm tsx scripts/dev/discord-preflight.ts
```

12 checków, **wszystkie read-only** (`GET`): kontrakt env, unikalność 7 kanałów, ważność
tokenu, zgodność `DISCORD_BOT_USER_ID` z tokenem, członkostwo w guildzie, oraz każdy kanał
osobno (istnienie, właściwa guilda, typ tekstowy). Nic nie wysyła i nic nie tworzy.

Powód istnienia: bez tego pierwszy start debuguje się przez kody zamknięcia WebSocketa.

Stan zmierzony `2026-08-23`: **12/12 PASS** (guild `RemoteAgentServer`, bot `RemoteAgent`).

### Uruchomienie

```bash
node apps/discord-bot/dist/discord.js
```

Potwierdzony output:

```text
{"message":"discord.gateway.connect","fields":{"url":"wss://gateway.discord.gg"}}
{"message":"discord started","fields":{"port":8080}}
{"message":"discord ready","fields":{"port":8080}}
{"message":"discord.gateway.open"}
{"message":"discord.gateway.identify","fields":{"intents":33281}}
{"message":"discord.gateway.ready"}
```

`gateway.identify` → `gateway.ready` oznacza, że Discord przyjął privileged intent.

Health (w drugiej karcie):

```bash
curl -s localhost:8080/livez   # {"process":"discord","state":"UP",...}
curl -s localhost:8080/readyz  # ... {"name":"postgres","state":"UP"}
```

### Czego bot NIE zrobi — i to jest poprawne

Wiadomość napisana w `#jira` albo dowolnym z 7 kanałów daje
`ignored: message_outside_case_thread`. **Nie dostaniesz odpowiedzi.**

Rozmowa toczy się wyłącznie w **wątku case'a**, a case powstaje ze zdarzenia z Jiry. Wątków
nie tworzy się ręcznie. Discord jest kanałem kontrolnym — potrzebuje case'a, żeby mieć o czym
mówić. To zachowanie z `packages/discord/src/intake.ts`, nie awaria.

## Jira — PRZYGOTOWANA, nie uruchomiona

### Dlaczego poll, a nie webhook

Ścieżka webhookowa wymaga rzeczy, których nie ma: routów ingressu (**pusta tablica**, każdy
webhook dostaje 404), `RawPayloadStore`, weryfikacji JWT i publicznie osiągalnego URL-a.

`reconcileJiraIssues` nie wymaga niczego z tego. Odpytuje Jirę przez JQL z watermarkiem
(„co się zmieniło od ostatniego razu") po zwykłym REST. To **audytowany produkcyjny
reconciler**, ten sam, który zawoła tick schedulera — nie obejście.

### Credentials

Token: [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

```bash
export JIRA_ORIGIN='https://twoja-domena.atlassian.net'
export JIRA_EMAIL='twoj@email'
export JIRA_API_TOKEN='...'
export JIRA_PROJECT_KEY='MOBL'      # WIELKIE litery: ^[A-Z][A-Z0-9_]{0,127}$
```

### Uruchomienie

```bash
pnpm tsx scripts/dev/jira-poll.ts            # przyrostowo
pnpm tsx scripts/dev/jira-poll.ts --reset    # zapomnij watermark, przeczytaj od nowa
```

Pierwszy przebieg nie ma watermarku, więc czyta projekt od początku i wypisuje klucz, status
i tytuł każdego issue. Potem **zmień coś na boardzie i uruchom ponownie** — pojawi się tylko
to, co się zmieniło. To jest test „czy system wychwytuje zmiany na boardzie".

Skrypt zasiewa idempotentnie `owner-local` i `connection-local-jira`, bo reconciler waliduje
scope wobec realnego wiersza `connections`.

### Dwie rzeczy warte wiedzenia

**Jira nie dostaje żadnego zapisu.** Jedyny call to `GET /rest/api/3/search/jql`. Lokalnie
zapisuje się watermark i wiersz `connections`.

**Basic auth jest w skrypcie, nie w pakiecie.** `JiraRestClient` wysyła
`Authorization: Bearer`, co jest poprawne dla OAuth 3LO na ścieżce produkcyjnej; osobisty API
token wymaga `Basic base64(email:token)`. Transport w skrypcie podmienia nagłówek, a klient
nadal pilnuje allow-listy originów, walidacji ścieżki, odrzucania przekierowań i klasyfikacji
retry. Audytowany kod nie został osłabiony dla wygody dev-skryptu.

## Produkcyjna pętla Jira → Discord (RA-030)

Od RA-030 pętla działa przez **uruchomione procesy**, nie dev-skrypt. Model auth: personal API
token + Basic (ADR-0010, system jednego właściciela). Uruchamiasz **trzy procesy** z tym samym
środowiskiem:

```bash
. scripts/dev/env.sh
pnpm run build --force

# Env (poza DISCORD_* z sekcji Discord — te same kanały):
export JIRA_ORIGIN='https://twoja-domena.atlassian.net'
export JIRA_EMAIL='twoj@email'
export JIRA_API_TOKEN='...'
export JIRA_PROJECT_KEY='KAN'                  # scheduler enqueue'uje reconcile dla tego projektu
export RA_SCHEDULER_INTERVAL_MS='15000'        # szybciej niż domyślna minuta, do testów

node apps/discord-bot/dist/discord.js   &      # relay discord_case → Discord
node apps/agent-worker/dist/worker.js   &      # wykonuje jira.reconcile: reconcile→correlate→outbox
node apps/scheduler/dist/scheduler.js   &      # enqueue'uje jira.reconcile co tick
```

Przepływ: scheduler enqueue'uje job `jira.reconcile` → worker odpytuje Jirę (Basic), tworzy case
i wiersz outbox `discord_case` → discord-bot relayuje go do `#jira` jako wątek. Zmień coś na
boardzie, poczekaj tick + chwilę na indeks Jiry, zobacz wątek na Discordzie.

Bez `JIRA_API_TOKEN` worker **nie rejestruje** handlera, a bez `JIRA_PROJECT_KEY` scheduler **nie
rejestruje** taska (fail-closed, głośny log) — nic nie idzie po cichu do DLQ. Worker idempotentnie
zasiewa `owner-local`/`connection-local-jira` (te same, których używa poll).

Wciąż odroczone: OAuth 3LO (świadomie, ADR-0010), deploy schedulera do CDK (krok AWS).

## Co działa, a co nie — tabela

| Proces | Startuje | Wykonuje pracę | Czego brakuje |
|---|---|---|---|
| `discord` | **tak** | **tak** — relayuje `discord_case` do Discorda (RA-029) | katalog narzędzi do rozmowy w wątku |
| `worker` | **tak** | **tak** — `jira.reconcile` + role (RA-028/030) | katalog narzędzi: agent nie edytuje jeszcze workspace'u |
| `scheduler` | **tak** | **tak** — enqueue `jira.reconcile` gdy `JIRA_PROJECT_KEY` (RA-030) | inne taski (renewal) wciąż nie wpięte |
| `executor` | tak | **nie** | brak `ProviderAdapter` → `runOneAction` rzuca |
| `ingress` | tak | **nie** | pusta tablica routów → każdy webhook 404 |

## Następne kroki, w kolejności wartości

1. **Uruchomić poll Jiry** — brakuje tylko credentiali. Najmniejszy krok do zobaczenia
   integracji na żywo.
2. **`correlateJiraIssue`** — zamienia issue w **case**, co jest warunkiem, żeby Discord miał
   wątek i żeby dało się w nim rozmawiać. To domyka pętlę Jira → Discord.
3. **Katalog narzędzi dla roli workera** — `runStructuredCompletion` już przyjmuje
   `tools`/`execute`; brakuje podłączenia `implementation-tools` i MCP brokera. To zamienia
   „wykonuje pracę" w „przeprowadza task z Jiry do MR".
4. **`ProviderAdapter` per provider** dla executora, potem **routy ingressu**, potem **taski
   schedulera**.

## Defekt naprawiony w trakcie bring-upu

`runFromEnv()` w `apps/discord-bot/src/env.ts` **nie przekazywał loggera** do sesji gatewaya,
mimo że `createDiscordBotFromEnv` przyjmuje go od zawsze.

Skutek: proces wypisywał `discord ready` i milczał. Wszystkie linie `gateway.connect`,
`gateway.identify`, `gateway.ready` — nie istniały. Przy wyłączonym `MESSAGE_CONTENT` gateway
zamykał się fatalnie kodem `4014`, sesja słusznie się nie ponawiała, i **nic tego nie
raportowało**: bot wyglądał na zdrowego, do którego nikt nie pisze.

Naprawione: `runFromEnv(env, { logger })`, a `main()` przekazuje logger procesu.
Bramka po naprawie: 2398/2398, 168 plików, lint/format/tsc na zero.
