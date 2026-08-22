# RA-028 — Work units

## Metadata

- Task: `RA-028`
- Plan revision: `1`
- Rola: jedna rola wykonawcza (ADR-0007)
- Plan status: `DONE`
- Base commit: `88001ea` (stan po domknięciu RA-027)
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run` + bramki jakościowe

## Zmierzone przy starcie (`2026-08-22`)

Sześć sond przed rozpisaniem planu. Pełny zapis w `docs/tasks/RA-028.md`; tu tylko to,
co zmienia plan:

```text
RuntimeRole.invoke      = jedna funkcja  → handler dowodliwy BEZ AWS
PgRuntimeStore          = 199 linii realnego SQL w pliku testowym → PROMOCJA, nie pisanie
agent-orchestrator      NIE zależy od database → adapter idzie do appki
FakeTransport           eksportowany z barrela → produkcja i test dzielą jedną ścieżkę
```

**Konsekwencja:** to task o **promocji istniejącego adaptera i wstrzyknięciu transportu**,
nie o budowie warstwy persystencji. Największe ryzyko nie jest w ilości kodu, a w tym,
że promowany kod był pisany pod jeden test, nie pod produkcyjny recovery.

## Global boundaries

- In scope: promocja adaptera, trzy handlery, wstrzykiwany transport, golden path.
- Out of scope: `ProviderAdapter`, routy ingressu, taski schedulera, realny call do
  Bedrocka, deploy.
- Zmiana pakietu domenowego jest **findingiem**, nie licencją — zapisuję i pytam.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-028-WU-01` | `DONE` | promocja `PgRuntimeStore` → `apps/agent-worker/src/persistence.ts` + testy per metoda | — |
| `RA-028-WU-02` | `DONE` | wstrzykiwany transport modelu: `FakeTransport` w testach, `AwsBedrockTransport` w prod (AC6) | WU-01 |
| `RA-028-WU-03` | `DONE` | handler `case.resume` → `recover()` + `pumpOnce()` (AC1) | WU-01, WU-02 |
| `RA-028-WU-04` | `DONE` | handler `agent.implementer` z writer lease (AC3) | WU-03 |
| `RA-028-WU-05` | `DONE` | handler `jira.webhook.renewal` → `JiraWebhookRenewalService` | WU-01 |
| `RA-028-WU-06` | `DONE` | odporność handlerów: throw → bounded retry/DLQ, `AMBIGUOUS` bez replayu (AC4, AC5) | WU-03..WU-05 |
| `RA-028-WU-07` | `DONE` | golden path przez uruchomiony proces workera (AC7) | WU-06 |

## Mapowanie kryteriów akceptacji

- **AC1** → `WU-03`; asercja na **zawartości bazy po passie**, nie na tym, że pass wrócił.
- **AC2** → `WU-03`; test z czwartym, nieznanym typem — podłączenie trzech nie może
  otworzyć cichej ścieżki. To regresja na `RA-027` `D1`/`D2`.
- **AC3** → `WU-04`; dwa równoległe joby na tym samym `case_id`.
- **AC4** → `WU-06`; handler, który rzuca.
- **AC5** → `WU-06`; `markAmbiguous` i brak replayu przy `recover()`.
- **AC6** → `WU-02`; test **strukturalny** — liczy wywołania transportu, nie tylko
  sprawdza, że wynik jest poprawny.
- **AC7** → `WU-07`.

## Kolejność i ryzyko

`WU-01` jest pierwsze, bo wszystkie handlery od niego zależą, i bo jest **najbardziej
ryzykowne**: promuje kod pisany pod jeden test integracyjny. Każda promowana metoda
dostaje własną mutację — nie dlatego, że to nowy kod, ale dlatego, że zmienia się kontekst
jego użycia z „harness ustawił stan" na „recovery po awarii".

`WU-02` przed handlerami, bo inaczej pierwszy handler zaszyje transport i drugi go
odziedziczy.

Wprost odnotowane ostrzeżenie z `RA-027` §4.1: **„startuje i się zatrzymuje" jest realną
właściwością i niewystarczającą.** Analogiczna pułapka tutaj to test, który dowodzi, że
handler został **wywołany**, i nic o tym, co zapisał. Asercje idą na stan bazy.

## Final task gate

Całe repo z realnym PostgreSQL-em (kilka przebiegów), mutacje dla każdej promowanej
metody i każdego mechanizmu AC2–AC5, wszystkie bramki jakościowe z `--force`,
`pnpm workflow:validate`, `git diff --check`.

## Ustalenia po wykonaniu (`2026-08-22`)

Pełny zapis w `docs/handoffs/RA-028/HANDOFF-01.md` i `docs/audits/RA-028/AUDIT-01.md`.
Tu tylko to, co zmienia plan:

1. **Ryzyko planu zmaterializowało się dokładnie tam, gdzie je zapisałem.** Plan ostrzegał, że
   największym ryzykiem jest **promocja kodu testowego**, bo `PgRuntimeStore` był pisany pod
   jeden test, nie pod produkcyjny recovery. Tak było: trzy artefakty (zaszyte timestampy,
   obejście audytowanej ścieżki completion, `provider` z mapy testu) plus zbyt szerokie
   `listCaseIds`. Każdy z nich to realny defekt produkcyjny, nie różnica stylu.
2. **Znaleziona luka STARSZA niż ten task.** `cases.active_run_id` nie było ustawiane przez
   żaden kod produkcyjny — tylko czyszczone. Luka od RA-003, przeżyła każdy audyt, bo żaden nie
   uruchomił pełnej ścieżki bez fixture'u ustawiającego tę kolumnę ręcznie. To jest argument za
   testem end-to-end przez uruchomiony proces, nie za kolejnym testem jednostkowym.
3. **Mutacja obaliła mój własny komentarz.** Twierdziłem, że jawne `recover()` przed
   `pumpOnce()` jest wymagane; usunięcie go nie zepsuło żadnego testu, bo `pumpOnce()` sam
   woła `recover()`. Realną wartością jest heartbeat. Zasada 9 `AGENTS.md` w działaniu.
4. **`pumpOnce()` nie rzuca — i to musi wiedzieć każdy przyszły handler.** Łapie błąd unitu i
   raportuje `ambiguous`/`blocked`. Handler, który to zignoruje, mówi `Scheduler`owi „udało
   się" i job nigdy nie jest ponawiany. Każdy następny handler nad runtime'em musi sprawdzać
   wynik passu, nie tylko to, że pass wrócił.
5. **Zamrożony zegar w teście PROCESU jest pułapką**, bo `bootstrapWorker` buduje własny
   `JobStore` z `productionRuntime()`. Dwa źródła czasu dają flake widoczny raz na dziewięć
   pełnych przebiegów. Testy procesów używają realnego zegara; deterministyczne zostają id.
6. **`CTF-004` wraca przy każdym nowym teście root-level**, który podaje harnessową bazę do
   kodu z `apps/`. Wzorzec obejścia: jeden udokumentowany cast na granicy, jak w
   `test/golden-path`.
