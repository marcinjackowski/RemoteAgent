# RA-027 — Work units

## Metadata

- Task: `RA-027`
- Plan revision: `1`
- Rola: jedna rola wykonawcza (ADR-0007)
- Plan status: `DONE`
- Base commit: `1c50f40` (stan po domknięciu RA-026)
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/processes` + całe repo

## Zmierzone przy starcie (`2026-08-22`)

Sprawdzone przed rozpisaniem planu, bo trzy ustalenia istotnie zmieniają zakres:

```text
Scheduler.tick/start/stop          ISTNIEJE  (packages/database/src/queue/scheduler.ts)
  — reaping, relay outboxa, bounded retry, pętla produkcyjna
apps/discord-bot runFromEnv()      ISTNIEJE  (parsuje env, otwiera bazę, startuje sesję)
Database.fromEnv()                 ISTNIEJE
serwer HTTP w pakietach            BRAK      — health.ts ma logikę, nic jej nie wystawia
mapowanie job_type -> praca        BRAK
Dockerfile / CI                    BRAK
```

**Konsekwencja:** to task o **wiring i brakującej warstwie HTTP**, nie o budowie
maszynerii. Komentarz w `Scheduler.start()` wprost deleguje observability do „the
scheduler app (later task)" — czyli tutaj.

Pięć z sześciu apps to szkielety `RA-001` (7 linii, zero deps). `discord-bot` jest
wyjątkiem i ma realny composition root.

## Global boundaries

- In scope: **składanie** istniejących pakietów w procesy + serwer health.
- Out of scope: zmiany logiki domenowej. Jeżeli proces nie da się złożyć bez zmiany
  pakietu, to jest **finding**, nie licencja na zmianę — zapisuję i pytam.
- **Docker jest zepsuty na tej maszynie.** `Dockerfile` powstaje, ale nie zostanie
  zbudowany; to musi być odnotowane jawnie, nie przemilczane.
- Żadnego deploymentu.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-027-WU-01` | `DONE` | wspólny bootstrap: sygnały, graceful shutdown, structured logger | — |
| `RA-027-WU-02` | `DONE` | `health.js` — serwer HTTP `/livez` + `/readyz` (AC2) | WU-01 |
| `RA-027-WU-03` | `DONE` | `worker.js` — Scheduler + handler `job_type` → orchestrator | WU-02 |
| `RA-027-WU-04` | `DONE` | `executor.js` — pętla po `external_actions` | WU-02 |
| `RA-027-WU-05` | `DONE` | `ingress.js` — serwer webhooków (podpis → raw_events → enqueue) | WU-02 |
| `RA-027-WU-06` | `DONE` | `discord.js` — `main()` nad `runFromEnv()` | WU-01 |
| `RA-027-WU-07` | `DONE` | `scheduler.js` — ticki renewal/reconciliation | WU-02 |
| `RA-027-WU-08` | `DONE` | test zgodności nazw `dist/*.js` z `infra/cdk` (AC3) | WU-03..WU-07 |
| `RA-027-WU-09` | `DONE` | `Dockerfile` + `docker-compose` dla lokalnego startu | WU-08 |
| `RA-027-WU-10` | `DONE` | golden path przez uruchomione procesy (AC6) | WU-08 |

## Mapowanie kryteriów akceptacji

- **AC1 (start + czyste zamknięcie na SIGTERM)** → `WU-01`; każdy proces dziedziczy
  jeden bootstrap, żeby shutdown nie był implementowany sześć razy różnie.
- **AC2 (`/livez` bez bazy, `/readyz` z bazą)** → `WU-02`; test przy **niedostępnej**
  bazie, nie tylko przy działającej.
- **AC3 (nazwy `dist/*.js` zgodne z `infra/cdk`)** → `WU-08`; rozjazd daje deploy,
  który startuje i natychmiast pada, więc to test, nie przegląd.
- **AC4 (utrata bazy nie porzuca pracy w locie)** → `WU-03`, `WU-04`.
- **AC5 (brak sekretu w logu i w health)** → `WU-01`, `WU-02`; kanarek.
- **AC6 (golden path przez procesy)** → `WU-10`.
- **AC7 (brak Dockera odnotowany)** → `WU-09` + audyt.

## Kolejność i ryzyko

`WU-02` jest przed workerami **celowo**: health jest tym, czego ECS i ALB wymagają do
uznania taska za żywy, więc proces bez niego nie wstanie w deploymencie niezależnie od
tego, czy jego logika działa.

Największe ryzyko tego taska to `WU-03`: mapowanie `job_type` → praca **nie istnieje** i
jest jedyną rzeczą, która nie jest wiringiem. Jeżeli okaże się, że wymaga decyzji
projektowej (jakie typy jobów, jaka obsługa nieznanego typu), to jest pytanie do
właściciela, nie ciche założenie. Domyślnie: **nieznany `job_type` fail-closed do DLQ**,
nigdy cicho pominięty — zgodnie z `CTF-010` finding 4.

## Final task gate

Start/stop każdego procesu z asercją na czystym zamknięciu, test nazw wobec
`infra/cdk`, test `/livez` vs `/readyz` przy padniętej bazie, kanarek sekretów, golden
path przez procesy, całe repo (kilka przebiegów), wszystkie bramki jakościowe,
`pnpm workflow:validate`, `git diff --check`. Brak Dockera odnotowany jawnie.

## Ustalenia po wykonaniu (`2026-08-22`)

Pełny zapis w `docs/handoffs/RA-027/HANDOFF-01.md`. Tu tylko to, co zmienia plan:

1. **Trzy sondy przed planowaniem oszczędziły większość roboty:** `Scheduler` ma już
   `tick`/`start`/`stop`, `discord-bot` ma już `runFromEnv()`, `Database.fromEnv()`
   istnieje. Bez nich rozpisałbym budowę maszynerii, która już jest.
2. **Ryzyko `WU-03` zmaterializowało się inaczej, niż przewidywałem.** Plan ostrzegał, że
   mapowanie `job_type` może wymagać decyzji właściciela. Nie wymagało — `grep` pokazał
   trzy typy, które produkcja **już** enqueue'uje, więc była konwencja do odwzorowania,
   nie do wymyślenia.
3. **DWANAŚCIE z 31 mutacji przeżyło pierwszy przebieg**, wszystkie z jednego powodu:
   testy dowodziły, że procesy startują i się zatrzymują, i nic o tym, co robią.
   Domknięte osobnym plikiem `process-behaviour.integration.test.ts`.
4. **Dwa realne defekty wykryte testami:** body health nie było redagowane;
   `request.destroy()` na zbyt dużym body sprawiał, że provider nigdy nie widział 413.
5. **AC6 częściowe.** Procesy udowodnione przeciwko realnej bazie; golden path Jira→MR
   **nie** przechodzi przez uruchomione procesy, bo domyślne handlery są puste. Zapisane
   w `AUDIT-01` §6 jako świadome zawężenie.
