# RA-016 — Handoff 02

## Metadata

- Task: `RA-016`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Implementer model/transport: `Claude Opus 5 / wysoki effort / IMPLEMENTER`,
  osobne subagenty w świeżych ephemerycznych sesjach, zamknięte context packi
  (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Work-units plan: `docs/work-units/RA-016/WORK_UNITS.md`, revision `25`
- Zaakceptowane units: `WU-01`–`WU-08D` (wcześniej), `WU-08G` i `WU-08F` (ten handoff)
- Data: `2026-08-20`
- Bazowy commit lub stan początkowy: `b2d6631`; WIP z `HANDOFF-01.md`
  (`runtime.ts` sha256 `867ea0bb…`, 294 linie)
- Końcowy commit lub stan working tree: `b2d6631` + niecommitowany WIP;
  `runtime.ts` sha256 `b2688d0c…`, `runtime.integration.test.ts` sha256
  `c389160d…`, plus cztery nowe pliki e2e (999 linii łącznie)

## Wynik

Connector Jira przyjmuje zweryfikowany webhook, normalizuje go, wzbogaca
autorytatywnym snapshotem REST, koreluje z case/entity i routuje na Discord
`#jira` — wszystko atomowo i idempotentnie. Domknięty został finding z
`HANDOFF-01`: replay check, REST GET i zapis dzielą jedną sekcję krytyczną per
`event_id`, więc równoległa dostawa exact duplicate nie wykonuje drugiego
`getIssue`. Dodatkowo powstał brakujący dowód end-to-end, którego task wymaga w
`Required verification`.

## Zrealizowany zakres

### `WU-08G` — replay przed REST pod jednym lockiem

- `pg_advisory_xact_lock` przesunięty na pierwszą instrukcję transakcji; pre-REST
  replay probe, `getIssue`, walidacja `response_scope` i budowa snapshotu wciągnięte
  do tej samej transakcji.
- Usunięty osobny helper `replay()` wraz z jego własną transakcją.
- Klucz locka: `sha256("jira-runtime-event:" + eventId)`, pierwsze 8 bajtów jako
  `readBigInt64BE(0)` — deterministyczny, namespaced, per-event.
- Test współbieżności rozszerzony o `expect(getIssue).toHaveBeenCalledTimes(1)`
  z opóźnionym `getIssue` (50 ms) i wystartowaniem wszystkich promise'ów przed
  `Promise.all`, żeby okno wyścigu było realne.

### `WU-08F` — dowód end-to-end

- Cztery nowe pliki testowe: `jira-e2e.integration.test.ts` (780 linii),
  `fake-jira.ts`, `fixtures/e2e-events.ts`, `fixtures/e2e-issues.ts`.
- Sześć testów pokrywających: pełną ścieżkę do outbox `#jira`, duplicate,
  sparse + no-overwrite, lost-event przez reconciliation, izolację dwóch
  owner/connection scope'ów i restart bez podwójnej aplikacji.
- Zero zmian w kodzie produkcyjnym — potwierdzone przez `git status` oraz mtimes.

## Wykonanie work units

| Unit | Raport implementera | Coordinator gate | Wynik |
|---|---|---|---|
| `WU-08G` | `COMPLETED`, 11/11 ×3, opisany dobór locka i uniknięcie 2 połączeń/event | diff w dwóch dozwolonych plikach; własne uruchomienie 97/97; **mutation test: usunięty lock → fail** | ACCEPTED |
| `WU-08F` | `COMPLETED`, 6 nowych + 97 istniejących = 103 | allowlista czterech nowych plików potwierdzona przez `git status` **i mtimes**; własne 103/103; **mutation test: zepsuty routing → 6/6 fail**; skan sekretów | ACCEPTED |

`WU-08E` pozostaje `CHANGES_REQUESTED` jako zapis historyczny; jego finding domyka
`WU-08G`.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/connector-jira/src/runtime.ts` | `eventLockKey()`; lock jako pierwsza instrukcja transakcji; replay probe i REST wciągnięte do sekcji krytycznej; usunięty helper `replay()` | replay i REST były przed lockiem, więc N równoległych dostaw wykonywało N razy `getIssue` |
| `packages/connector-jira/test/runtime.integration.test.ts` | call-count na `getIssue`, opóźniony fake REST, realne okno wyścigu | poprzedni test sprawdzał tylko statusy i liczniki DB, więc luka była zielona |
| `packages/connector-jira/test/jira-e2e.integration.test.ts` i 3 pliki wsparcia | nowy dowód end-to-end | `Required verification` taska wymaga e2e fake Jira → case → Discord; plik nie istniał |
| `packages/connector-jira/src/index.ts` | export `./runtime.js` | WIP z `WU-08E`, bez zmian w tych unitach |

## Decyzje i uzasadnienie

- **Nie użyto `Database.withAdvisoryLock`**, mimo że `HANDOFF-01` to zalecał.
  `withAdvisoryLock` bierze własne połączenie z puli i trzyma je przez cały
  callback; owinięcie w nim `withTransaction` dałoby **dwa** połączenia na
  zdarzenie i przy domyślnej puli 10 zakleszczyłoby się dla N > 5. Wybrano
  `pg_advisory_xact_lock` jako pierwszą instrukcję istniejącej transakcji: jedno
  połączenie na zdarzenie, lock zwalniany przez COMMIT/ROLLBACK. Zużycie połączeń
  faktycznie **spadło**, bo zniknęła osobna transakcja pre-REST probe.
- **Świadomy trade-off:** `getIssue` biegnie teraz wewnątrz otwartej transakcji
  trzymającej lock. To nieusuwalny koszt objęcia lockiem wywołania REST i jest
  ograniczony per-event — wolny GET jednego zdarzenia nie blokuje innego. Ryzyko
  opisane niżej.
- Walidacja wejścia, odczyt payloadu i `normalizeJiraPayload` zostały przed
  transakcją: nie mają side effectów i nie wołają REST.
- Fake REST wstrzykiwany przez `as unknown as JiraRestClient`, bo `JiraRestClient`
  ma prywatne pole i jest typem nominalnym. Ten sam wzór stosują już zaakceptowane
  `runtime.integration.test.ts` i `reconciliation.integration.test.ts`. `FakeJira`
  implementuje `Pick<JiraRestClient, "getIssue" | "searchJql">`, więc sygnatury
  pozostają typowane; rzutowany jest wyłącznie punkt wstrzyknięcia.

## Kryteria akceptacji RA-016

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Duplicate/retried webhook → jeden event i jedna projekcja | PASS | e2e duplicate test; concurrency test z `getIssue` ×1; restart test |
| 2. Event spoza project/owner scope odrzucony przed enrichment/model call | PASS | `scope.test.ts`, `response_scope` przed zapisem, e2e scope isolation |
| 3. Sparse webhook wzbogacony z provenance, bez nadpisania nowszego stanu | PASS | e2e sparse + no-overwrite: starszy webhook daje `STALE`, `issue_version_ms` bez zmian, zero zapisów |
| 4. Wygasający webhook → renewal job i alert po nieudanym odnowieniu | PASS | `webhook-renewal.integration.test.ts` (8 testów) |
| 5. Reconciliation odnajduje symulowany utracony webhook | PASS | `reconciliation.integration.test.ts` (11); e2e lost-event: druga zamiatka `replay=true`, write-free |
| 6. Jira content oznaczone jako untrusted w context | PASS | `UNTRUSTED_DATA` w snapshotach; e2e potwierdza w DB; mass-mention zneutralizowany |
| Exact concurrent replay przed ponownym REST (FAIL w `HANDOFF-01`) | PASS | `getIssue` ×1 przy 4 równoległych dostawach; mutation test potwierdza load-bearing |

## Testy i kontrole

Wszystkie uruchomione niezależnie przez koordynatora.

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test` | 0 | 103/103, 13 plików (było 97/97, 12) |
| `pnpm vitest run` całe repo, real PG | 0 | 1114/1114, 112 plików |
| `pnpm --filter @remoteagent/connector-jira typecheck` | 0 | PASS |
| `pnpm --filter @remoteagent/connector-jira build` | 0 | PASS |
| `pnpm exec eslint packages/connector-jira/src packages/connector-jira/test` | 0 | PASS; tylko preexistujące warnings `boundaries` |
| `pnpm exec prettier --check packages/connector-jira/src packages/connector-jira/test` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| `git diff --check` | 0 | PASS |
| skan sekretów w czterech nowych plikach | n/a | czysto (`glpat-`, `gh*_`, `AKIA`, JWT, klucze prywatne, host paths) |

### Mutation testing koordynatora

| Mutacja | Wynik | Komunikat |
|---|---|---|
| usunięty `pg_advisory_xact_lock` z transakcji | wykryta | `expected "vi.fn()" to be called 1 times, but got 4 times` |
| routing Discord `"jira"` → `"system"` w `correlation.ts` | wykryta | wszystkie 6/6 testów e2e FAIL |

Druga mutacja była konieczna, bo sześć nowych testów e2e trzeba było sprawdzić na
puste asercje. Po każdej mutacji pliki przywrócono; `runtime.ts` ma sha256
`b2688d0c…`, `correlation.ts` jest tracked-clean.

## Snapshoty i artefakty

- Fixtures: `test/fixtures/e2e-events.ts`, `test/fixtures/e2e-issues.ts` — nowe,
  sanitized, deterministyczne.
- Żaden istniejący snapshot nie został zmieniony.
- `@everyone` i `<@1234567890>` w fixtures są celowymi kanarkami injection;
  zero-width space zapisany jako escape `​`, nie niewidzialny literał.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak. REST/payload errors nie zawierają plaintextu,
  payload ref/digest, tokenu ani sekretu; `JiraRuntimeError` nadal bez `cause`.
- Izolacja kont/scope: owner/connection/project/issue pozostają server-owned;
  e2e dowodzi, że dwie connection nie widzą się wzajemnie, a cross-scope query
  zwraca 0.
- Side effecty i idempotencja: jeden `getIssue` per `event_id` nawet przy
  równoległości; restart nie duplikuje eventu ani projekcji; fault w dowolnym
  logicznym zapisie rollbackuje całość.
- Dane zewnętrzne: treść Jira pozostaje `UNTRUSTED_DATA`; mass-mention
  neutralizowany przed outboxem.
- Nie wykonano live Jira, prawdziwego Discorda, push, MR ani commitu.

## Znane ograniczenia i ryzyka

- **REST bez timeoutu wewnątrz transakcji.** `getIssue` biegnie w otwartej
  transakcji trzymającej advisory lock, a na tej warstwie nie ma timeoutu.
  Zawieszony Jira przypina jedno połączenie z puli i lock do czasu, aż zadziała
  timeout niższej warstwy HTTP. Wynika to wprost z kryterium „replay przed
  ponownym REST", ale zasługuje na osobny follow-up unit z bounded REST timeout.
  Zgłoszone przez implementera i potwierdzone przez koordynatora w kodzie.
- **`test/**` pakietu nie jest objęty `typecheck`.** `packages/connector-jira` nie
  ma `tsconfig.test.json`, więc `pnpm typecheck` nie sprawdza plików testowych.
  Preexistujące, dotyczy też zaakceptowanych wcześniej testów; poza allowlistą
  obu unitów. Kandydat na osobny unit.
- **Preexistujący flake w `workspace-runner`, nie w RA-016.**
  `packages/workspace-runner/test/process-runner.test.ts` → „kills the process tree
  on timeout" failuje niedeterministycznie w pełnym repo (`ENOENT … child.pid`).
  Test ma `timeoutMs: 100` i wymaga, by proces wnuk zdążył zapisać `child.pid`
  przed zabiciem drzewa. Plik jest tracked i niezmieniony (`git status` czysty),
  należy do RA-010, a suita Jiry przechodzi solo 103/103. Zmierzone: 1 fail na 4
  pełne przebiegi; 6/6 solo PASS; nie reprodukuje się pod sztucznym obciążeniem
  CPU. Nie blokuje RA-016 — wymaga własnego unitu w RA-010.

## Otwarte pytania

- Brak. Reset limitu prób udzielony przez właściciela `2026-08-20` (opcja A,
  ADR-0005) i wykorzystany na jeden fix unit.

## Stan po tym handoffie

- Co jest gotowe: wszystkie unity RA-016, w tym brakujący dowód e2e; pełne bramki
  zielone; mutation testing potwierdza, że lock i testy e2e są load-bearing.
- Czego nie robić przed audytem: nie commitować WIP, nie mieszać ze strumieniem
  RA-011/RA-012, nie startować RA-017/RA-018 (mają dalsze niespełnione zależności).
- Jakie fix units utworzyć po `CHANGES_REQUIRED`: zależnie od findingów;
  kandydaci niezależni od werdyktu to bounded REST timeout oraz
  `tsconfig.test.json` dla pakietu.
