# RemoteAgent

RemoteAgent będzie prywatnym, Discord-first systemem wspierającym codzienną
pracę: odbiera zdarzenia z Jira, Gmaila, Google Calendar i GitLaba, prowadzi
trwałe sprawy, rozmawia z właścicielem i realizuje pełny engineering loop przy
użyciu Amazon Bedrock.

Docelowy przepływ dla pracy programistycznej:

```text
Jira -> Discord thread -> decyzje -> plan -> branch/workspace -> implementacja
     -> testy i snapshoty -> niezależne review -> poprawki -> commity
     -> GitLab Merge Request -> pipeline -> dalsza rozmowa
```

## Start pracy

Agent rozpoczynający lub wznawiający pracę musi zacząć od `AGENTS.md`.

Codex otrzymuje nadrzędne instrukcje z `AGENTS.md`. `CLAUDE.md` pozostaje
wyłącznie bootstrapem legacy i przekierowuje `continue` do Sol.

- Plan systemu: `docs/MASTER_PLAN.md`
- Kolejka tasków: `docs/tasks/TASK_INDEX.md`
- Protokół wykonania i audytu: `docs/workflow/EXECUTION_AND_AUDIT.md`
- Implementer GPT-5.6 Luna: `docs/workflow/LUNA_IMPLEMENTER.md`
- Legacy worker Bedrock Opus 4.8: `docs/workflow/BEDROCK_WORKER.md`
- Plany małych work units: `docs/work-units/`
- Handoffs: `docs/handoffs/`
- Audyty: `docs/audits/`
- Decyzje architektoniczne: `docs/decisions/`

## Najprostszy cykl użytkownika

1. Napisz Solowi `continue`, aby rozpocząć ciągły przebieg.
2. Sol wybiera makro-task, rozpisuje lub aktualizuje skupione work units i
   uruchamia Lunę dla jednego unit naraz.
3. Sol po każdym unit sprawdza diff i test, a po całym tasku sam wykonuje
   niezależny audyt.
4. Po `PASS` Sol oznacza task jako `DONE`, odblokowuje zależności i automatycznie
   rozpoczyna kolejny task.

Przebieg trwa do jawnego polecenia pauzy, Decision Request wymagającego decyzji
właściciela albo realnej zewnętrznej blokady.

Luna nie otrzymuje komendy `continue`, całego makro-taska ani roli audytora.

## Rozwój (foundation)

Wymagania: Node `24.19.0` (przypięte w `engines.node` i `.nvmrc`) oraz `pnpm`
przez Corepack. Package manager jest przypięty polem `packageManager`
(`pnpm@10.26.1`); ta sama wersja Node jest używana w CI
(`node:24.19.0-bookworm-slim`).

Instalacja z czystego checkoutu jednym poleceniem:

```bash
pnpm install --frozen-lockfile
```

Deterministyczne komendy z roota:

```bash
pnpm run lint            # ESLint (flat config) + granice zależności
pnpm run typecheck       # tsc dla narzędzi + turbo run typecheck per workspace
pnpm run test            # Vitest (unit + guardrails + workflow)
pnpm run build           # turbo run build per workspace
pnpm run workflow:validate  # spójność docs/tasks/TASK_INDEX.md
pnpm run format          # Prettier --check
pnpm run check           # wszystkie powyższe po kolei
```

Lokalna infrastruktura (opcjonalnie): `docker compose up -d postgres`.

### Lokalny PostgreSQL i persistence (RA-003)

PostgreSQL jest autorytatywnym źródłem stanu (Master Plan §3.2). Compose publikuje
go na **porcie 5433** (host `5433` → kontener `5432`), aby nie kolidować z lokalnie
zainstalowanym Postgresem na 5432. Domyślna konfiguracja pakietu
`@remoteagent/database` (`config.ts`) jest zestrojona z tym portem, więc
`db:up`→`migrate` działa bez ręcznego ustawiania `RA_PGPORT`:

```bash
pnpm --filter @remoteagent/database db:up      # start + czekaj aż healthy
pnpm --filter @remoteagent/database db:smoke    # up -> health -> migrate up
pnpm --filter @remoteagent/database migrate up  # migracje na działającym serwerze
pnpm --filter @remoteagent/database db:down     # stop
```

Testy integracyjne wymagają prawdziwego PostgreSQL (kryterium akceptacji 6). W
bramce/CI ustaw `RA_REQUIRE_POSTGRES=1` — brak działającej bazy jest wtedy twardym
błędem, a nie cichym `skip` z exit 0. Preflight:

```bash
pnpm --filter @remoteagent/database gate       # fail-closed sprawdzenie połączenia
RA_REQUIRE_POSTGRES=1 pnpm run test            # integ. testy failują bez bazy
```

Połączenie pochodzi wyłącznie z env (`RA_DATABASE_URL` albo `RA_PG*`/`PG*`);
wartości w `docker-compose.yml` to jawne, nie-sekretne domyślne dane lokalne.

Struktura workspace jest zdefiniowana w `pnpm-workspace.yaml`:

- `apps/*` — osobno wdrażalne usługi (na tym etapie szkielety bez logiki);
- `packages/*` — współdzielone biblioteki domenowe (szkielety);
- `infra/*` — infrastruktura (CDK, szkielet).

Granice zależności: `apps` nie importują `apps`, `packages` nie importują `apps`,
`infra` zależy tylko od `packages`. Reguła jest egzekwowana przez ESLint i
chroniona celowo failującym fixture w `test/guardrails`. Wybory toolingowe i
przypięte wersje opisuje `docs/decisions/ADR-0001-foundation-tooling.md`.

Repozytorium poza fundamentem zawiera plan wykonania i kontrakt współpracy. Kod
produktowy powstaje w kolejnych, audytowanych taskach.
