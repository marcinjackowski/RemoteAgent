# RA-016 — Audit 02

> Rewizja `02`, a nie `01`: `workflow:validate` wymaga, aby najnowszy audyt nie był
> starszy od handoffu, który ocenia (`HANDOFF-02`). Audyt `01` nie istnieje —
> `CHANGES_REQUIRED` dla `HANDOFF-01` powstał w sesji poprzedniego koordynatora i
> nie został zapisany jako dokument przed wyczerpaniem jego limitu.

## Metadata

- Task: `RA-016`
- Audytowany handoff: `docs/handoffs/RA-016/HANDOFF-02.md`
- Audytor: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Implementer model/transport: `Claude Opus 5 / wysoki effort / IMPLEMENTER`,
  osobne subagenty, świeże ephemeryczne sesje, zamknięte context packi
  (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Work-units plan: `docs/work-units/RA-016/WORK_UNITS.md`, revision `25`
- Data: `2026-08-20`
- Werdykt: `PASS`

## Podsumowanie

Wszystkie sześć kryteriów akceptacji RA-016 jest spełnionych i udowodnionych
niezależnie uruchomionymi testami na prawdziwym PostgreSQL. Finding z
`HANDOFF-01` — concurrent exact duplicate wykonujący wielokrotny `getIssue` — jest
domknięty: replay probe, REST GET i zapis dzielą jedną sekcję krytyczną per
`event_id`. Brakujący dowód end-to-end, wymagany przez `Required verification`
taska, powstał i został zweryfikowany jako niepusty.

Nie pozostały findingi klasy BLOCKER, HIGH ani MEDIUM. Trzy findingi klasy LOW
dotyczą hardeningu i higieny narzędziowej, nie kryteriów taska. Osobno odnotowany
jest jeden obowiązkowy krok porządkowy przed commitem: plik sondy audytora, którego
nie udało mi się usunąć z powodu odmowy uprawnień.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `docs/MASTER_PLAN.md`,
  `docs/workflow/EXECUTION_AND_AUDIT.md`, `docs/workflow/AUDIT_CHECKLIST.md`,
  `docs/tasks/TASK_INDEX.md`, `docs/tasks/RA-016.md`,
  `docs/work-units/RA-016/WORK_UNITS.md`, `docs/handoffs/RA-016/HANDOFF-01.md`,
  `docs/handoffs/RA-016/HANDOFF-02.md`.
- Sprawdzony diff: pełny WIP względem `b2d6631`. Przeczytane w całości
  `src/runtime.ts` (292 linie) oraz nowy `test/jira-e2e.integration.test.ts`
  w istotnych partiach (scope isolation, restart, duplicate, sparse). Przeczytane
  dla kontekstu, niezmienione: `src/correlation.ts`, `src/enrichment.ts`,
  `packages/database/src/client.ts`, `packages/database/src/migrate.ts`.
- **Weryfikacja allowlisty wykraczająca poza `git status`.** Raport `WU-08F`
  twierdził, że nie tknął istniejących plików. Hashe `runtime.ts` i
  `runtime.integration.test.ts` różniły się jednak od tych zanotowanych przed
  `WU-08G`, a nie miałem baseline'u pośredniego. Rozstrzygnąłem to mtimes:
  `runtime.ts` 10:42:22 i `runtime.integration.test.ts` 10:41:07 wobec plików
  `WU-08F` 11:00:43–11:02:14. Zmiany pochodzą więc z `WU-08G`, a `WU-08F` istotnie
  ich nie ruszył. Allowlisty obu unitów dotrzymane.
- Uruchomione kontrole: pełna suite pakietu na real PG, całe repo (czterokrotnie),
  typecheck, build, scoped ESLint, scoped Prettier, `workflow:validate`,
  `git diff --check`, skan sekretów, dwa mutation testy i własna sonda puli
  połączeń.
- Potwierdzenie, że audytor nie implementował ocenianego kodu: `src/runtime.ts`,
  `test/runtime.integration.test.ts` i cztery pliki e2e napisały subagenty
  `IMPLEMENTER` w osobnych sesjach z zamkniętymi context packami. Audytor nie
  edytował tych plików. Ponieważ od ADR-0005 obie role dzieli tożsamość modelu,
  werdykt opiera się wyłącznie na odczycie rzeczywistego diffu i własnym
  uruchomieniu bramek. Tymczasowe mutacje przywrócono; `runtime.ts` ma sha256
  `b2688d0cedb2334c4ed35f86e5ec00cfdcbe531abc468b204b5c6b13aaee3b71`,
  `correlation.ts` jest tracked-clean.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Duplicate/retried webhook → jeden normalized event i jedna projekcja | PASS | e2e duplicate: jeden `raw_events`, `APPLIED`+`REPLAYED`, po jednym event/case/entity/snapshot/receipt/outbox, `next_seq` bez zmian, `getIssueCalls === [issueKey]`; concurrency test: `getIssue` ×1 przy 4 równoległych; restart test: `getIssueCalls === []` i identyczny 8-kolumnowy snapshot liczników |
| 2. Event spoza project/owner scope odrzucony przed enrichment/model call | PASS | `scope.test.ts`; `response_scope` rzucany przed jakimkolwiek zapisem, wewnątrz transakcji → rollback; e2e potwierdza zero `raw_events` dla podrobionego bearera |
| 3. Sparse webhook wzbogacony z provenance, bez nadpisania nowszego stanu | PASS | e2e sparse: brakujące summary/status/actor uzupełnione z REST; następnie preseedowany nowszy durable snapshot daje `STALE`, `issue_version_ms` zostaje na nowszej wartości, zero case/receipt/outbox |
| 4. Wygasający webhook → renewal job i alert po nieudanym odnowieniu | PASS | `webhook-renewal.integration.test.ts`, 8 testów |
| 5. Reconciliation odnajduje symulowany utracony webhook | PASS | `reconciliation.integration.test.ts`, 11 testów; e2e lost-event: brak `raw_events`, `reconcileJiraIssues` odtwarza tę samą ścieżkę `#jira`, druga zamiatka `replay=true`, `applied=0`, write-free |
| 6. Jira content oznaczone jako untrusted w context | PASS | `UNTRUSTED_DATA` potwierdzone odczytem z DB w e2e; mass-mention zneutralizowany przed outboxem; REST text wygrywa z webhook text bez utraty oznaczenia trustu |
| Exact concurrent replay przed ponownym REST (FAIL w `HANDOFF-01`) | PASS | `pg_advisory_xact_lock` jako pierwsza instrukcja transakcji, przed replay probe i REST; `getIssue` ×1; mutation test potwierdza load-bearing |

## Findingi

### LOW — brak bounded timeoutu dla REST wewnątrz otwartej transakcji

- Lokalizacja: `packages/connector-jira/src/runtime.ts:199`
  (`issue = await options.restClient.getIssue(...)` wewnątrz
  `options.db.withTransaction`, po `pg_advisory_xact_lock`).
- Dowód: odczyt kodu. Sekcja krytyczna obejmuje wywołanie sieciowe, a na tej
  warstwie nie ma `AbortSignal` ani timeoutu. Transakcja i advisory lock są
  trzymane przez cały czas I/O.
- Wpływ: zawieszony lub bardzo wolny Jira przypina jedno połączenie z puli
  (domyślnie 10) oraz lock dla danego `event_id`, dopóki nie zadziała timeout
  niższej warstwy HTTP. Lock jest per-event, więc inne zdarzenia nie są blokowane —
  degradacja jest ograniczona, nie globalna. Nie narusza żadnego kryterium
  akceptacji: to nieusuwalny koszt objęcia lockiem wywołania REST, czego kryterium
  wprost wymaga.
- Wymagana zmiana: follow-up unit z bounded timeoutem na warstwie
  `JiraRestClient` (`AbortSignal` + jawny budżet), tak aby najgorszy czas trzymania
  locka był deterministyczny. Poza allowed paths obu ocenianych unitów.

### LOW — `test/**` pakietu nie jest objęty `typecheck`

- Lokalizacja: brak `packages/connector-jira/tsconfig.test.json`; `tsconfig.json`
  pakietu ma `include: ["src"]`.
- Dowód: `pnpm --filter @remoteagent/connector-jira typecheck` przechodzi, ale nie
  obejmuje plików testowych. Dotyczy zarówno nowych plików e2e, jak i wcześniej
  zaakceptowanych testów.
- Wpływ: błąd typów w teście integracyjnym ujawnia się dopiero przy uruchomieniu
  vitest, nie w bramce typecheck. Preexistujące, nie regresja tych unitów.
- Wymagana zmiana: osobny unit dodający `tsconfig.test.json` i rozszerzający
  skrypt `typecheck` — dla całego repozytorium, nie tylko tego pakietu.

### LOW — `as unknown as JiraRestClient` w punkcie wstrzyknięcia fake'a

- Lokalizacja: `packages/connector-jira/test/jira-e2e.integration.test.ts`
  (wstrzyknięcie `FakeJira`).
- Dowód: `JiraRestClient` ma prywatne pole, więc jest typem nominalnym i
  strukturalny fake go nie spełnia.
- Wpływ: znikomy. `FakeJira implements Pick<JiraRestClient, "getIssue" |
  "searchJql">`, więc sygnatury metod pozostają sprawdzane; rzutowany jest wyłącznie
  punkt wstrzyknięcia. Ten sam wzór stosują już zaakceptowane
  `runtime.integration.test.ts` (`as JiraRestClient`) i
  `reconciliation.integration.test.ts` (`as never`, czyli tępszy). Nie jest to
  regresja dyscypliny — jest to jej lokalna poprawa.
- Wymagana zmiana: brak wymaganej. Docelowo `JiraRuntimeOptions.restClient`
  mógłby przyjmować port strukturalny zamiast klasy; to zmiana kontraktu i wymaga
  osobnej decyzji.

Findingów klasy BLOCKER, HIGH i MEDIUM nie ma.

## Obowiązkowy krok porządkowy przed commitem

Nie jest to finding wobec implementacji, lecz zaległość audytora, która musi być
domknięta, aby drzewo było czyste:

- Plik `packages/database/test/zz-coord-probe.test.ts` utworzyłem sam jako sondę
  do pomiaru zużycia puli połączeń (patrz „Testy audytora"). Nie należy do żadnego
  work unitu i nie może trafić do commitu. Dwie próby jego usunięcia zostały
  odrzucone na poziomie uprawnień narzędzia, dlatego usunięcie pozostaje po stronie
  właściciela: `rm packages/database/test/zz-coord-probe.test.ts`.
- Do czasu usunięcia `pnpm vitest run` całego repo zawiera dwa dodatkowe,
  przechodzące testy, które nie są częścią RA-016. Nie wpływa to na werdykt, bo
  suite pakietu (`103/103`) go nie obejmuje.

## Testy audytora

Wszystkie poniższe uruchomił audytor samodzielnie. Raporty implementerów i unit
gates nie zastępują tych kontroli.

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/connector-jira/test` | 0 | 103/103, 13 plików (baseline `HANDOFF-01`: 97/97, 12) |
| `pnpm vitest run` całe repo, real PG — przebieg A | 0 | 1114/1114, 112 plików |
| `pnpm vitest run` całe repo — przebieg B | 1 | 1113/1114; jedyny fail: `workspace-runner/process-runner` (patrz niżej) |
| `pnpm vitest run` całe repo — przebiegi C, D | 0 | 1114/1114 |
| `pnpm --filter @remoteagent/connector-jira typecheck` | 0 | PASS |
| `pnpm --filter @remoteagent/connector-jira build` | 0 | PASS |
| `pnpm exec eslint packages/connector-jira/src packages/connector-jira/test` | 0 | PASS; tylko preexistujące warnings `boundaries` |
| `pnpm exec prettier --check packages/connector-jira/src packages/connector-jira/test` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| `git diff --check` | 0 | PASS |
| skan sekretów w 4 nowych plikach (`glpat-`, `gh*_`, `AKIA`, JWT, klucze prywatne, host paths) | n/a | czysto |
| mutation: usunięty `pg_advisory_xact_lock` | 1 | `expected "vi.fn()" to be called 1 times, but got 4 times` — lock load-bearing |
| mutation: routing Discord `"jira"` → `"system"` w `correlation.ts` | 1 | **6/6 testów e2e FAIL** — asercje e2e nie są puste |
| sonda puli: 8 równoległych transakcji z per-event xact lock | 0 | brak deadlocka przy N=8 (próg, na którym wariant z `withAdvisoryLock` by padł) |
| sonda puli: 8 transakcji na tym samym kluczu | 0 | pełna serializacja, zmierzony peak współbieżności `1` |

### Preexistujący flake poza zakresem RA-016

`packages/workspace-runner/test/process-runner.test.ts` → „kills the process tree on
timeout" failuje niedeterministycznie w pełnym przebiegu repo z
`ENOENT … child.pid`. Zbadane niezależnie:

- plik jest tracked i niezmieniony (`git status` dla `packages/workspace-runner/`
  jest pusty), należy do RA-010;
- solo, sześć przebiegów pod rząd: `6/6 PASS`;
- pełne repo: 1 fail na 4 przebiegi;
- nie reprodukuje się pod sztucznym obciążeniem CPU (24 procesy pętli busy-loop,
  trzy przebiegi zielone);
- przyczyna wynika z odczytu testu: `timeoutMs: 100`, a asercja wymaga, by proces
  wnuk zdążył zapisać `child.pid` przed zabiciem drzewa procesów — pod
  współbieżnym I/O pełnej suity ten wyścig czasem przegrywa.

Nie blokuje RA-016: suite pakietu przechodzi deterministycznie, a defekt leży w
innym, wcześniej zaakceptowanym pakiecie. Wymaga własnego unitu w RA-010.

## Ryzyka przekrojowe

- Security/privacy: REST i payload errors nie zawierają plaintextu, payload
  ref/digest, tokenu ani sekretu; `JiraRuntimeError` nie ma `cause` i ma stały
  komunikat. Treść Jira pozostaje `UNTRUSTED_DATA`; mass-mention neutralizowany
  przed outboxem. Fixtures zawierają celowe kanarki injection (`@everyone`,
  `<@…>`, zero-width space jako escape), co jest właściwym wzorcem.
- Idempotencja/recovery: jeden `getIssue` per `event_id` również przy
  równoległości; restart nie duplikuje eventu ani projekcji; fault w każdym
  logicznym boundary rollbackuje całość (macierz 9 etapów); `STALE` nie tworzy
  projekcji.
- Współbieżność: lock jest per-event i deterministyczny
  (`sha256("jira-runtime-event:" + eventId)` → `readBigInt64BE(0)`); kolizja
  64-bitowa powodowałaby wyłącznie zbędną serializację dwóch niezwiązanych
  zdarzeń, nie utratę poprawności. Zużycie połączeń spadło względem stanu
  poprzedniego (usunięta osobna transakcja pre-REST probe) — potwierdzone sondą.
- Observability: statusy `APPLIED`/`REPLAYED`/`STALE` są rozłączne i czytelne;
  receipty zamykają event → case → outbox.
- Kompatybilność: `correlation.ts`, `enrichment.ts`, migracje i `packages/database`
  niezmienione. `src/index.ts` zyskał tylko export `./runtime.js`. Numer najwyższej
  migracji pozostaje `026`, więc RA-012 może bezkolizyjnie zająć `027`.

## Kolejny makro-task po `PASS`

`RA-016` przechodzi na `DONE`. To **nie** odblokowuje samodzielnie żadnego taska:

- `RA-017` czeka jeszcze na RA-013, RA-014, RA-015;
- `RA-018` na cały coding-engine stream oraz RA-017;
- `RA-021` na RA-013, RA-017, RA-019, RA-020;
- `RA-023` na RA-021 i RA-022.

Aktywnym strumieniem pozostaje `RA-012` (`IN_PROGRESS`, plan revision `1`).
Rekomendowane, niezależne od werdyktu units do zakolejkowania:

1. bounded REST timeout dla `JiraRestClient` (finding LOW nr 1);
2. `tsconfig.test.json` i typecheck dla `test/**` w całym repo (finding LOW nr 2);
3. stabilizacja `process-runner` timeout race w RA-010 (flake poza RA-016).

## Uzasadnienie werdyktu

`PASS` jest dozwolony, ponieważ wszystkie sześć kryteriów akceptacji jest
spełnionych i udowodnionych niezależnie uruchomionymi testami na prawdziwym
PostgreSQL, a wcześniej failujące kryterium „exact concurrent replay przed
ponownym REST" jest teraz spełnione. Nie pozostał żaden finding klasy BLOCKER,
HIGH ani MEDIUM; trzy findingi LOW dotyczą hardeningu i higieny narzędziowej, a
żaden z nich nie narusza kryterium taska.

Werdykt nie opiera się na raportach implementerów. Oba istotne elementy zostały
zweryfikowane przez celowe wprowadzenie regresji: usunięcie advisory locka wywala
test call-count, a zepsucie routingu Discord wywala wszystkie sześć testów e2e —
co dowodzi, że nowa suite e2e nie jest zbiorem pustych asercji. Ta kontrola była
konieczna, ponieważ w `HANDOFF-01` cała luka współbieżności była zielona pod
istniejącymi testami. Dodatkowo samodzielnie sprawdziłem założenie o puli
połączeń, na którym opiera się wybrany kształt sekcji krytycznej, oraz ustaliłem,
że jedyny niedeterministyczny fail w pełnym przebiegu repo pochodzi z innego,
wcześniej zaakceptowanego pakietu.
