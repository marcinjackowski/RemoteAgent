# Engineering — techniczny plan doprowadzenia do używalności

Snapshot: `2026-09-05`, HEAD `ce9b2ff62e3c947c72c0fafca47d192af983ce98`.
Źródło diagnozy: [audyt techniczny](../../audits/ENGINEERING_LOOP_TECHNICAL_AUDIT_2026-09-05.md).
Statusy makro-tasków: wyłącznie [TASK_INDEX](../../tasks/TASK_INDEX.md).

## 0. Kontrakt dla następnego modelu — przeczytaj najpierw

Stan początkowy tego dokumentu pochodzi z audytu 2026-09-05. Później właściciel
zlecił implementację, wykonano naprawy i cztery próby bieżącego bundle live.
Aktualna nawigacja: [plan domknięcia 2026-09-07](ENGINEERING_FINISH_PLAN.md).
Wyniki wykonania i następny krok odtwarzaj z tego planu oraz WORK_UNITS, nie
z historycznej kolejności startowej poniżej. RA-055 nadal jest `IN_PROGRESS`.
Ten dokument pozostaje specyfikacją R0–R9, nie PASS ani źródłem statusów.

Po poleceniu wdrożenia:

1. Przeczytaj komplet obowiązkowych dokumentów z AGENTS oraz ten plan i audyt.
2. Sprawdź `git status`, HEAD, bieżące zmiany i różnicę względem snapshotu.
3. Odtwórz findingi, nie rozpoczynaj od nowego pełnego MOBL-2023 live runu.
4. Sol/primary planuje i odbiera; jeden `luna_implementer` wykonuje bounded
   zmiany. Nie edytuj tych samych plików równolegle. Raport Luny nie zastępuje
   własnego odczytu diffu i komendy primary.
5. Kroki R0–R9 poniżej są planem wykonania w obrębie istniejącego RA-055,
   nie nową kolejką RA-NNN. Przenieś aktualnie wykonywany krok do WORK_UNITS
   just-in-time z baseline, allowed paths i wynikiem jego jednej bramki.
6. Kroki Q1–Q3 rozszerzają kwalifikację poza jedno MOBL-2023. Wymagają decyzji
   właściciela i dopisania do oficjalnej kolejki/ADR, zanim rozpoczniesz ich
   implementację lub live. Nie ogłaszaj całego produktu gotowym po samym R9.
7. Nie używaj Bedrock, OpenCode ani API keys. Nie wybieraj nowych modeli za
   właściciela. RA-055 ma explicit `codex-sol-live / gpt-5.6-sol` dla czterech
   ról; brak profilu lub auth kończy się jawnie bez fallbacku.
8. Nie kontaktuj Jira/Discord ani innych integracji. Nie pushuj iOS/RemoteAgent,
   nie twórz MR, nie merge'uj. Zgoda na wcześniejszy checkpoint push została
   wykorzystana. Lokalne commity dopiero zgodnie z aktualnymi zgodami i bramkami.
9. Zachowaj wszystkie stare worktree, branche, logi i assety. Nie naprawiaj
   ręcznie Run 89 po to, żeby zaliczyć autonomiczną kwalifikację.

### Czego nie robić

- Nie dokładaj kolejnego regexu dla każdej nazwy zmiennej w Swift.
- Nie zwiększaj limitu tokenów/rund/timeoutu bez porównywalnego pomiaru.
- Nie zmieniaj asercji na aktualne zachowanie tylko dlatego, że pełna suite jest czerwona.
- Nie uznawaj `changed_files`, samego dotknięcia pliku ani modelowego PASS za evidence.
- Nie usuwaj failing testów, generator fences, lease guards ani final verification.
- Nie sumuj kumulatywnych usage snapshots i nie nazywaj brakującego usage zerowym kosztem.
- Nie kasuj diagnostycznej bazy/worktree, zanim nie ma zatwierdzonej retencji i exportu.
- Nie wykonuj live, gdy działa mutant lub równolegle zmienia się kod/config.

## 1. Co dokładnie uznajemy za zakończone

Rozdziel trzy poziomy odbioru; ich pomieszanie prowadziło do pozornego postępu.

| Poziom | Minimalny dowód | Czego NIE dowodzi |
|---|---|---|
| Bezpieczny core | receipts, isolation, recovery, mutation checks i pełna bramka | skutecznego wykonania realnego zadania |
| RA-055 ukończony | dokładny MOBL-2023, świeży isolated run, wymagane gates, fresh review, verifier, jeden commit | uniwersalnej skuteczności ani live Claude |
| Engineering Local v1 używalny | RA-055 + mały niezależny benchmark + powtórzenia + stop/resume + runbook | pełnego produktu Jira/Discord/GitLab/AWS |

Docelowy wynik użytkowy Local v1: właściciel podaje description, wybiera
zatwierdzone profile ról i repo/seed, dostaje identyfikator runu, aktualny status,
zużycie, zachowany diff/commit albo konkretny blocker. Nie musi odgadywać ścieżek,
edytować bazy czy analizować wielotysięcznej historii chatu.

Nie obiecujemy dowolnego zadania bez interwencji. Niewystarczający scope,
sprzeczne wymagania i zewnętrzna awaria mają mieć krótki, actionable terminal.

## 2. Mapa istniejącej architektury

```text
job + lease + explicit role configuration
  -> createWorkerHandlers / createImplementerHandler
  -> SupervisorRuntime
  -> PostgresEngineeringRuntimePort
  -> design + server-materialized SliceContract
  -> executeVerticalSlice
       -> bounded tools -> intent/receipt -> Git actual observation
  -> executeVerticalSliceGates -> EvidenceBundle albo GateFailure
  -> fresh read-only review -> PASS albo bounded correction
  -> final VerificationDecision
  -> evidence-bound LOCAL_COMMIT
```

Zostaje jeden control plane. CLI providera nie dostaje bezpośredniego shell,
write, network ani cudzych MCP tools. Subscription transport generuje bounded
structured output, a RemoteAgent wykonuje narzędzia po walidacji.

| Odpowiedzialność | Główne pliki |
|---|---|
| Runtime/config/context/receipt projection | `apps/agent-worker/src/engineering-execution.ts` |
| Durable artifacts, stages, recovery, completion | `apps/agent-worker/src/engineering-workflow.ts` |
| Przepływ i stop/no-progress | `packages/agent-orchestrator/src/engineering/workflow.ts`, `src/supervisor/runtime.ts` |
| Tool loop i compaction | `packages/model-runtime/src/tool-loop.ts`, `structured-completion.ts`, `config.ts`, `types.ts` |
| Write preflight, patch, content policy | `packages/implementation-tools/src/toolset.ts`, `patch.ts` |
| Git delta, generator, test-first chronology | `apps/agent-worker/src/vertical-slice-executor.ts` |
| Fresh review i findings | `packages/review-loop/src/pre-commit.ts`, `contracts.ts` |
| Gate catalog / receipts | `packages/test-evidence/src/engineering-gates.ts` |
| Xcode process/log parser | `apps/agent-worker/src/xcode-gate-adapter.ts` |
| Journal i token accounting | `apps/agent-worker/src/engineering-debug-journal.ts` |
| Subscription routing/config | `apps/agent-worker/src/engineering-model-routing.ts`, `packages/model-runtime/src/subscription.ts` |
| Provider adapters | `packages/model-provider-codex-cli/`, `packages/model-provider-claude-code/` |
| Aktualny live harness | `apps/agent-worker/test/engineering-live-ios.integration.test.ts` |

Nazwy nowych plików w dalszych krokach są **proponowane**. Przed pierwszą edycją
sprawdź aktualny `rg --files`; nie zakładaj, że wszystkie już istnieją.

## 3. Decyzje, które należy utrwalić przed odpowiednimi zmianami

Nie wszystkie wymagają zatrzymania prac: R1–R3 można przygotować bez zmiany
architektury. Poniższe decyzje mają być jawne, nie ukryte w promptach.

- D1: granica ukończenia tej fazy = Local v1, bez integracji. Wymaga potwierdzenia
  przed rozszerzeniem kolejki o Q1–Q3; RA-055 nie ma automatycznie nowego AC.
- D2: task gates/eval fixtures trafiają do Git, prywatne ścieżki i firmowy
  objective pozostają w local overlay. Nie publikować kodu Sondermind ani
  firmowej treści do RemoteAgent bez potwierdzenia prawa/scope.
- D3: diagnostyka i runner zachowują canonical receipts/artifacts lub dedykowaną
  lokalną bazę. Retencja i usuwanie wymagają osobnej zgody; domyślnie zachowaj.
- D4: read-only context request nie rozszerza write scope i nie tworzy drugiego
  orchestratora. Wymaga wersji policy i regresji auth/tool boundary.
- D5: all-of mutation paths pozostaje do czasu dowodu dla lepszego kontraktu
  „napraw kryterium”. Nie usuwaj go tylko dlatego, że komplikuje correction.
- D6: poniższe cele kosztu są propozycją kryteriów wydajności, nie pomiarem ani
  obietnicą. Zatwierdź campaign cap przed nową serią live. Nie używaj API cennika.

Zmiany zaakceptowanego kontraktu (np. ReviewFinding identity, journal schema,
nowy context request) opisz w nowym ADR przed wdrożeniem. Nie modyfikuj po cichu
ADR-0016 ani historycznych wersji zapisanych w DB.

## 4. Kolejność wykonania

```text
R0: baseline + reprodukcje
 -> R1: receipt/failure state
 -> R2: kompletna checklista review
 -> R3: prawdziwy status i trwałe evidence
 -> R4: wersjonowany benchmark + gate ownership
 -> R5: dowód zachowania / Xcode test discovery
 -> R6: bounded context i repair
 -> R7: budżet, metryki, stop/recovery
 -> R8: deterministyczna macierz całego handlera
 -> R9: autoryzowany live + zamknięcie RA-055
 -> Q1–Q3: osobno zatwierdzona kwalifikacja Local v1
```

R1/R2 można czytać równolegle, ale zmiany w workerze wykonuje jeden writer.
Nie równoleglij Xcode, mutation checks i live na tych samych bajtach/configu.

### R0 — odtwarzalny baseline i czerwone reprodukcje

Rezultat: każda poprawka ma failing regression przed implementacją; nie jest
to nowy przebieg modelu. Przeczytaj audyt EL-01…EL-06 i aktualny CTF register.

Allowed paths: wyłącznie testy wymienione w R1–R3, nowy
`test/engineering-evals/`, `docs/work-units/RA-055/WORK_UNITS.md`.

Przygotuj reprodukcje:

1. `receiptBackedImplementationReport`: success A, unresolved failed A,
   ToolLimitError lub token fence → odmowa, nie report.
2. `executeFreshPreCommitReview`: dwa HIGH, ta sama linia, różne wymagane
   poprawki → dwa findingi i dwa IDs.
3. Production journal runner: resolved callback + trwały BLOCKED/TerminalReason
   + brak commita → zadanie BLOCKED, nie SUCCEEDED.
4. Flow preflight: komentarze zawierają wszystkie markery, zachowanie nie istnieje.
   Ten fixture ma być odrzucony przez behavioral acceptance, nie tylko regex.

Weryfikacja: właściwa komenda R1/R2/R3 uruchomiona z filtrem nowego testu
wykazuje exit `1` na dokładnej oczekiwanej asercji. Zapisz nazwy testów i
wyjścia, nie samą liczbę fails. Po dodaniu testów nie deklaruj WU DONE, dopóki
ich odpowiadające naprawy i zielona bramka nie są wykonane.

### R1 — jednoznaczny wynik mutacji i fallbacku (EL-02 / CTF-025)

Rezultat: zewnętrzny catch nie obchodzi path-level refusal guarda tool-loop.

Allowed paths:

- `apps/agent-worker/src/engineering-execution.ts`
- `apps/agent-worker/test/engineering-execution.integration.test.ts`
- `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
- `packages/model-runtime/src/{tool-loop.ts,errors.ts,types.ts}` tylko jeśli
  potrzebny jest typed outcome współdzielony z workerem
- `packages/bedrock-runtime/test/tool-loop.test.ts`

Implementacja:

1. Zastąp lokalny globalny boolean canonical per-target mutation state.
   Successful receipt A nie czyści failed B. Ambiguity jest sticky do końca
   attemptu; bez proven reconciliation nie może jej skasować kolejny sukces.
2. `receiptBackedImplementationReport` odrzuca unresolved failed targets.
   Zawęź fallback do jawnej allowlisty terminal reasons. Nie każdy
   `ToolLimitError` oznacza „zabrakło redundantnego final reportu”.
3. Zachowaj normalizację reported paths do successful receipts oraz fresh Git
   comparison. Request target bez rzeczywistego changed path nie zalicza all-of.
4. Rewiduj special catch `FINAL_WITHOUT_REQUIRED_CORRECTION_RECEIPT`:
   honest empty i overclaimed empty nie mogą udawać naprawy. Pusty attempt
   terminalizuj deterministycznie z powodem i receipt/provenance; nie uruchamiaj
   ponownie drogich gates wyłącznie po to, żeby wykryć niezmieniony patch.
5. Nie pomijaj clean-failure recovery: po failed A → rzeczywisty success A
   poprawny report nadal działa. Nie dodawaj ręcznego commita w tej ścieżce.

Macierz testów: success A→failed A; failed A→success B; failed A→success A;
ambiguous A→dowolny sukces; no targets; mixed batch; token fence; repeated
refusal; empty correction po GateFailure i po ReviewDecision; unknown ToolLimitError.

Jedna bramka:

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/bedrock-runtime/test/tool-loop.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts apps/agent-worker/test/vertical-slice-e2e.integration.test.ts
```

Mutation RED→GREEN: usuń unresolved guard; czyść wszystkie failures po sukcesie
obcego targetu; dopuść ambiguity fallback; zastąp all-of przez any-of.
Każda mutacja ma obalić asercję efektu/receiptu, nie tylko tekst promptu.

### R2 — review nie gubi kryteriów i nie steruje scope (EL-03)

Rezultat: wszystkie niezależne fixes pozostają w durable checklist do nowego
fresh review; starszy finding nie poszerza writer authority.

Allowed paths: `packages/review-loop/src/{pre-commit.ts,contracts.ts}`,
`packages/review-loop/test/pre-commit.integration.test.ts`,
`apps/agent-worker/src/{engineering-execution.ts,engineering-workflow.ts}`,
odpowiadające testy i kontrakty Engineering wyłącznie po wersjonowanej decyzji.

Implementacja:

1. Zastąp dedup po `path:line` dedupem identycznego findingu. Dwa defekty na
   jednej linii mają różne stabilne IDs. Określ stabilność w obrębie reportu;
   nie obiecuj semantic identity niezależnej od dowolnej parafrazy modelu.
2. Zachowaj oryginalną i effective anchor provenance. Nie zgub required_fix,
   jeśli nearest substantive line jest wspólna dla dwóch findingów.
3. Invalid blocking anchor ma jawny wynik: bounded tools-disabled reanchor
   repair albo REVIEW_INCONCLUSIVE. Nie przekształcaj go po cichu w dowód
   poprawności. LOW/NIT pozostaje untrusted informational, bez write authority.
4. Dla findingu w generator output/innym slice odróżnij brak authority do
   bieżącej korekty od nieistnienia defektu. Zapisz eskalację/replan request;
   nie pozwalaj implementerowi samodzielnie rozszerzyć allowed_paths.
5. Fresh review po GateFailure zachowuje regression checklistę, ale nie wymusza
   sztucznej ponownej mutacji każdego starego anchoru przy naprawie kompilacji.

Bramka:

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/review-loop/test/pre-commit.integration.test.ts apps/agent-worker/test/vertical-slice-e2e.integration.test.ts apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts
```

Mutacje: location-only dedup; drop drugiego findingu; foreign scope jako blocking
write target; zgubiona checklista po GateFailure; reuse starej sesji review.
Exit 0 oznacza kompletność i izolację, nie że sam model znalazł wszystkie defekty.

### R3 — prawdziwy status i evidence po awarii (EL-04/05 / CTF-026)

Rezultat: użytkownik widzi outcome zadania, a kolejny agent odtwarza dowody bez
historii chatu i bez błędnego `SUCCEEDED`.

Allowed paths: `apps/agent-worker/src/engineering-debug-journal.ts`,
`handlers.ts`, ich testy; `engineering-live-ios.integration.test.ts`;
nowy `apps/agent-worker/src/engineering-run-report.ts` jeśli rozdzielenie
projekcji uprości kod. DB repositories/migracja tylko jeśli zatwierdzona decyzja
wymaga nowej persystencji, nie nowej authority.

Implementacja:

1. Versioned report rozdziela `handler_outcome`, `engineering_outcome`,
   `diagnostic_completeness`. Źródło outcome zadania to durable AgentCompletion
   i końcowe artifacts, nie brak wyjątku.
2. Engineering COMPLETED wymaga odpowiednich artifacts, a dla commit-enabled
   taska exact LocalCommitReceipt. BLOCKED/CANCELLED/WAITING/INCOMPLETE mają
   własny stan; błąd odczytu DB daje unknown diagnostic outcome.
3. Nie rzucaj ponownie zakończonej operacji tylko dlatego, że zapis summary
   zawiódł. Oddziel correctness od best-effort diagnostyki, ale pokaż jej brak.
4. Dodaj odtwarzanie summary z istniejącego JSONL. Przerwany ostatni wiersz
   oznacz jako incomplete, nie interpretuj jako pełnego eventu. Nie nadpisuj
   historycznej raw wersji. Event sequence i schema version są weryfikowane.
5. Eksportuj canonical artifacts/receipts z digestami przed teardownem live DB,
   albo użyj persistent isolated DB w runnerze. Journal content-free nie jest
   zamiennikiem pełnego EvidenceBundle. Private evidence oddziel od Git/logów.
6. Sprawdź błąd append/close: jeden rejected append nie może ukrywać bez końca
   kolejnych eventów ani pozostawiać deskryptora bez best-effort close.

Bramka:

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run apps/agent-worker/test/engineering-debug-journal.test.ts apps/agent-worker/test/handlers.integration.test.ts apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts
```

Przed użyciem sprawdź nazwę istniejącego handler testu przez `rg --files`.
Nowe testy export/reconstruction umieść w tych plikach lub dodaj jawnie do
komendy; glob/nazwa nie może dać zero selected tests.

Mutacje: resolved callback→SUCCEEDED; brak sprawdzenia receipt; usunięcie
completeness; dropped terminal line; brak digest match przy odtwarzaniu;
awaria DB/logu nie może powtórzyć commita.

### R4 — zamrożony benchmark i poprawne ownership bramek (EL-01/05)

Rezultat: inny model na tej lub innej maszynie odtwarza test z wersji Git i
prywatnego overlay, bez zgadywania historycznych zmian `engineering.json`.

Allowed paths: nowe `test/engineering-evals/fixtures/` i
`test/engineering-evals/catalog.test.ts`,
`apps/agent-worker/src/{engineering-live-qualification.ts,engineering-execution.ts}`,
`packages/test-evidence/src/engineering-gates.ts`, ich testy; docs runbook.
Eksport prywatnego configu do Git tylko po sanitizacji i decyzji D2.
Zmiana schema failure wymaga dodatkowo `packages/contracts/src/engineering-workflow.ts`
i jego testów, nowej wersji kontraktu oraz ADR przed implementacją.

Manifest benchmarku zawiera:

- benchmark ID/version, repo identity, seed SHA, objective digest;
- authority envelope: dozwolone produkcyjne/test/generator paths;
- criterion IDs, owning slice/capability, wymagane gates i executable selectors;
- gate program/config/schema digests oraz wersję metody oceny;
- CLI/model/profile identity, narzędzia i deadline/budget policy;
- logical Xcode scheme/destination requirements, bez hardcoded host UUID;
- expected baseline outcomes, negative controls i zakres public/private artifacts.

Local overlay zawiera jedynie fizyczne ścieżki/binarne SDK, simulator mapping,
prywatny objective/asset refs i approved subscription profiles — bez API keys
lub kopiowania OAuth credentials. Strict loader waliduje resolved profile i
digest przed pierwszym modelem. Digest bez zachowanych bytes nie wystarcza.

Gate ownership musi być wykonalne: gate zaplanowany na slice nie wymaga
produkcji/testu poza jego authority. Potrzebny read context jest osobnym polem
od mutation target; brakujący nowy plik nie może wymagać prefetch READ.
Final union obejmuje wszystkie task criteria niezależnie od wczesnych neutral gates.

Docelowy gate failure przenosi typowane `criterion_id`, `failure_class`,
`evidence_ref` i `related_target_ids`. Target IDs są rozwiązywane wyłącznie
przez zamrożony code-owned katalog i przecinane z active slice authority.
Human-readable message jest do diagnozy, nie do wybierania ścieżki regexem.
Nie parsuj `SafetyAlert`/`SafetyAlertTests` z prose jako głównego control flow.
Legacy receipts bez pól mają jawną kompatybilność i bounded fallback albo
terminal `UNCLASSIFIED_GATE_FAILURE`, nigdy poszerzenie scope.
Testuj zmianę samego wording/case/localization logu bez zmiany targetu i
progress identity; foreign target ID ma odmowę przed write. Oddziel
`ASSERTION_FAILED`, `COMPILE_FAILED`, `TEST_DISCOVERY_FAILED`,
`INFRASTRUCTURE` i `UNKNOWN`, żeby awaria środowiska nie inicjowała edycji kodu.

Bramka (nowy plik powstaje w tym kroku):

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals/catalog.test.ts apps/agent-worker/test/engineering-live-qualification.test.ts packages/test-evidence/test/engineering-gates.integration.test.ts
```

Mutacje: bramka na złym slice; missing required gate/selector; context READ
absent file; foreign required path; config drift; profile fallback; empty
selector list. Preflight odmowa musi mieć zero model calls i zero source writes.

### R5 — rzeczywiste testy zachowania i non-vacuous Xcode (EL-01)

Rezultat: komentarze, martwy helper i zmiana nazwy zmiennej nie sterują oceną.

Allowed paths: `test/engineering-evals/`,
`apps/agent-worker/src/xcode-gate-adapter.ts`, jego test;
gate catalog i live harness. Testy iOS wyłącznie w **nowym, zatwierdzonym,
izolowanym fixture worktree**, nie w źródłowym checkout/seed/Run 89.
Do iOS build/test użyj obowiązkowego skillu xcodebuildmcp.

Macierz MOBL-2023, oceniana niezależnie od nazw nowych helperów:

| Criterion | Wymagany obserwowalny test |
|---|---|
| C1 safety event | realny single-agent flow otrzymuje event i otwiera alert |
| C2 multi-agent | realna sesja/multi flow emituje presentation; stale/inactive event nie otwiera alertu |
| C3 interruption | brak legacy inline karty; stan input/session zgodny z wymaganym przerwaniem |
| C4 non-sharing | właściwy heading/body i brak nieprawdziwej deklaracji udostępnienia |
| C5 sharing | wariant zależny od rzeczywistej preference, poprawny disclosure/copy |
| C6 Text 988 | wykonanie akcji przez production path z oczekiwanym URL i istniejącym analytics contract |
| C7 resources | wykonanie production resources action i oczekiwane presentation/URL |
| C8 Close | kontrolowane zamknięcie, bez wysyłania SMS/otwierania resources |
| C9 lifecycle | dismiss/reopen, ponowne zdarzenie, session boundaries; brak podwójnego side effectu |
| C10 asset/layout | istniejący help.pdf, rozmiar/gradient, accessibility/dynamic type i warianty UI |

C3/C10 wymagają doprecyzowania z załączonym designem, jeśli exact oczekiwanie
nie jest w local objective. Nie wymyślaj czasu wznowienia sesji ani liczby akcji.
Nie testuj usług kryzysowych przez rzeczywiste wysłanie wiadomości/połączenie;
testuj kontrolowane platform dependency spies.

Oddziel model-authored tests od evaluator tests niedostępnych do edycji modelu.
Test-first receipt dowodzi chronologii zapisu testu; prawdziwy test-first
behawioralny wymaga uruchomienia RED przed poprawką i GREEN po niej.

Xcode evidence musi podać rzeczywiście wykonane test IDs/count i failures,
związane z tree/config/command. Zero tests, missing suite, compile fail,
truncated/unrecognized output nie dają PASS. Rozważ version-pinned xcresult
adapter z potwierdzeniem aktualnej wersji narzędzia; nie zastępuj jednym
niezweryfikowanym parserem drugiego. Fixture corpus ma pochodzić z realnego
targetu, po redakcji i zgodzie na publikację.

Bramka offline (nowy plik powstaje w tym kroku):

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals/behavioral-oracle.test.ts apps/agent-worker/test/xcode-gate-adapter.integration.test.ts
```

Po niej osobna zatwierdzona exact Xcode command, zapisująca test IDs/count,
exit, tree i logs. Obie muszą być rzeczywiście uruchomione przed odbiorem R5.

Mutacje jakości: usuń production route; podłącz wszystkie buttons do Close;
odwróć sharing flag; usuń stale-session guard; zastąp test tautologią; zostaw
wyłącznie komentowane markery; zmień wyłącznie legalną nazwę `openURLCalls`.
Pierwsze sześć ma RED; legalny rename ma GREEN. Nie usuwać ochrony legacy
fixture, zanim nowy oracle nie dowiedzie tych samych braków.

### R6 — mały, kompletny context zamiast zgadywania deklaracji (EL-06)

Rezultat: compiler/test repair dostaje użyteczne definicje i utrzymuje cel
review bez wielokrotnego wysyłania całego prefetched packetu.

Allowed paths: `engineering-execution.ts` i jego test;
`packages/model-runtime/src/{tool-loop.ts,types.ts,config.ts}`,
`packages/bedrock-runtime/test/tool-loop.test.ts`; nowy
`apps/agent-worker/src/engineering-repair-context.ts` jeśli wydzielony;
`test/engineering-evals/repair-context.test.ts`.

Implementacja:

1. Zbuduj corpus co najmniej: missing symbol, protocol conformance, brak
   initializera, wrong member, test-target import, compile→review regression.
   Włącz `SafetyAlertTestAnalyticsService` jako prywatny digest-bound przykład,
   a publiczny odpowiednik zsyntetyzuj bez firmowego źródła.
2. Context ranking: exact diagnostic location → canonical declaration →
   potrzebny existing usage/test → poprzednie do-not-regress criteria.
   Usuń bezwarunkowe dodawanie wszystkich configured READs.
3. Wprowadź limit bajtów/token estimate poza samą liczbą wpisów 24. Każdy
   pominięty fragment ma reason; missing required declaration daje context
   escalation, nie instrukcję „napisz patch na ślepo”.
   `ADR-0024` ustala po porównywalnym pomiarze produkcyjny limit 48000 bytes /
   12000 estimated tokens na kontekst korekty, z wersjonowaną polityką w stage
   config digest. Nie zmienia to 48 calls ani budżetu całego invocation.
4. Dodaj bounded read-only request dla brakującego symbolu, wykonywany przez
   ten sam broker i server scope. Liczy się do osobnego bounded context budget,
   nigdy nie otwiera command/network/write. Nie zmieniaj samego CLI sandboxu.
5. Current bytes + digest służą exact patchowi. Epoch projection zachowuje
   required targets, unresolved refusals i repair coordinates aż do rozwiązania;
   nie kopiuje całego starego packetu i nie udaje pełnej zawartości po truncation.
6. Wielka definicja dostaje exact bounded excerpt z provenance. No-match to
   obserwacja, nie 61 niezróżnicowanych „błędów”. Nie zwiększaj limitu w ciemno.

Bramka:

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals/repair-context.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts packages/bedrock-runtime/test/tool-loop.test.ts
```

Mierz context bytes per category, hit/miss, liczbę reads i skuteczność repair
na zamrożonym corpus. Proponowany cel: co najmniej 50% mniej pierwszego inputu
korekty wobec tej samej baseline fixture, bez utraty required declarations.
Nie porównuj krótkiej failed próby z długim poprawnym rozwiązaniem.

Mutacje: zgubiona declaration; ignorowanie scope przy context request;
wyczyszczony unresolved target po epoch; raw context wraca w każdym call;
silent truncation required evidence. Każda ma konkretną asercję.

### R7 — mierzalny budżet, czytelny stop i recovery

Rezultat: operator wie co trwa, dlaczego przerwano i ile pracy zmierzono.

Allowed paths: `engineering-debug-journal.ts`, `engineering-live-qualification.ts`,
ich testy; orchestrator workflow/runtime i testy; nowy
`test/engineering-evals/budget-recovery.test.ts`; DB budget persistence tylko
po jawnej decyzji o granicy per-run/per-invocation.

Raport powinien zawierać:

- invocation/run/benchmark/config/model IDs, bieżący stage/slice/attempt;
- input/output/reported total, missing/partial usage count, estimated/reserved
  usage **osobno**, nigdy dopisane do provider-reported;
- stage i whole-run elapsed, model/process/gate durations;
- tool requested/succeeded/refused, path-target progress vs criterion progress;
- dokładny powód stopu, pozostały budget i bezpieczny następny krok;
- deadline, last event/heartbeat, status przerwania i potrzebę reconciliation;
- worktree/commit/evidence lokalne odnośniki w operator view; content-free
  journal nadal bez host paths, promptów, raw prose i chain-of-thought.

Nie opisuj „nad czym model się zastanawiał” jako dostępu do prywatnego toku
rozumowania. Loguj jawne działania, krótkie kody decyzji i ich evidence.

Budget policy: zachowaj istniejące 750k/1.2M/1.8M do czasu zatwierdzonej
kalibracji. Brak usage nie znaczy zero; widoczny lower bound i conservative
reservation mają chronić przed nieograniczonym retry. Pokaż również łączną
wartość campaign, żeby restart nie ukrywał kosztu.

Stop/recovery: deterministic terminal po no-progress; controlled cancellation
przerywa subprocess tree, zachowuje event/receipt i nie replays ambiguous write.
Recovery z compatible profile/config odtwarza stan i budget; zmiana profilu to
nowy run, nie cichy resume. Benchmark fresh-run zawsze zaczyna z seed, nie z
wybranej ręcznie najlepszej próby.

Bramka:

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals/budget-recovery.test.ts apps/agent-worker/test/engineering-debug-journal.test.ts apps/agent-worker/test/engineering-live-qualification.test.ts packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts
```

Mutacje: sumowanie globalnych snapshotów per rola; brak kosztu failed attempt
z usage; kasowanie campaign total przy resume; disabled cancellation/fence;
SUCCEEDED bez terminal evidence; retry ambiguous write.

### R8 — macierz całego handlera przed kolejnym live

Rezultat: run z production handler/PG/Git dowodzi pozytywnej ścieżki i
interakcji guardów; model boundary jest kontrolowanym transcript fixture.

Allowed paths: `apps/agent-worker/test/engineering-qualification*.ts`,
`vertical-slice-e2e.integration.test.ts`, `test/engineering-evals/`.
Finding w produkcji wraca do właściciela odpowiedniego R1–R7, nie jest
maskowany zmianą expected result.

Obowiązkowe scenariusze:

1. Happy path dwóch slices → rzeczywisty diff → gates → review → verifier →
   dokładnie jeden commit; bez bezpośredniego seedowania brakujących artifacts.
2. Gate failure → exact correction → review failure → compiler regression →
   repair zachowujący checklistę → final commit.
3. Dwa niezależne findingi na jednej linii; oba muszą dotrzeć do correction.
4. Clean refusal/mismatch i odzyskanie; failed A + success B nie omija odmowy.
5. Brak postępu i oscylacja → trwały terminal bez kolejnego kosztownego calla.
6. Crash przed/po intent, mutation, receipt, gate, review i commit; exact
   reconciliation bez drugiego side effectu.
7. Dwa cases równolegle, dwóch writerów jednego case'a odrzuconych przez fence.
8. Cancellation + restart + zmieniony config/profile → fail closed.
9. Unknown usage/process exit/output malformed → bounded terminal, bez fallbacku.
10. Model próbuje edytować evaluator/generator/instructions albo zgłasza obce
    changed_files; source/seed i niezwiązane pliki pozostają niezmienione.

Bramka:

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals apps/agent-worker/test/engineering-qualification-control.integration.test.ts apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts apps/agent-worker/test/vertical-slice-e2e.integration.test.ts
```

Primary powtarza bramkę po przywróceniu każdego mutanta, potem pełną bramkę
RA-055. Jeżeli registry acceptance nadal czerwone wyłącznie na otwartych
CTF-025/026, nie ignoruj testu: odnotuj fix + własną celowaną weryfikację w
rejestrze jako rzeczywiście adresowany, dopiero potem uruchom pełną bramkę.
Nie oznaczaj findingu jako adresowanego na podstawie samego planu.
Po zatwierdzeniu napraw przez właściciela uwzględnij także jawne decyzje w
`scripts/acceptance/criteria.ts:OPEN_FINDING_DECISIONS`, zgodnie z istniejącym
kontraktem AC3. Obecny test pomimo nazwy LOW sprawdza każdy otwarty wpis;
nie usuwaj wpisów CTF ani nie zawężaj testu tylko po to, żeby stał się zielony.

### R9 — kontrolowany live MOBL-2023 i końcowy audyt RA-055

Wejście: R1–R8 zweryfikowane; uzgodnione scope i budget kampanii; brak mutanta
i równoległego writera; źródła benchmarku/configu zamrożone i zachowane.

Preflight ma wykonać read-only checks i zapisać: checkout/seed SHA oraz status,
config/manifest/profile digests, canonical CLI i subscription login, exact
model dla wszystkich ról, Xcode version i simulator mapping, wolne miejsce,
PG SELECT 1, brak zewnętrznego write surface. Nie wypisuj env/credential files.

Aktualne uruchomienie referencyjne poniżej jest **opt-in live**, nie komendą
do uruchomienia podczas samego czytania planu. Jeżeli R3/R4 wprowadzi runner,
runbook musi zastąpić tę komendę zweryfikowanym entrypointem, nie zostawić dwóch
konkurencyjnych ścieżek kwalifikacji.

```sh
. scripts/dev/env.sh
set -o pipefail
export RA_REQUIRE_POSTGRES=1
export RA_RUN_LIVE_IOS_ENGINEERING=1
export RA_LIVE_ENGINEERING_INVOCATION_ID="mobl-2023-qualified-$(date -u +%Y%m%dT%H%M%SZ)"
export RA_LIVE_ENGINEERING_IMPLEMENTER_PROFILE=codex-sol-live
export RA_LIVE_ENGINEERING_REVIEWER_PROFILE=codex-sol-live
export RA_ENGINEERING_MODEL_CONFIG_PATH=/Users/marcinjackowski/.remoteagent/live-mobl-2023/models-codex.json
export RA_ENGINEERING_CONFIG_PATH=/Users/marcinjackowski/.remoteagent/live-mobl-2023/benchmark-20260907-changelog/engineering.json
export RA_ENGINEERING_BENCHMARK_MANIFEST_PATH=/Users/marcinjackowski/.remoteagent/live-mobl-2023/benchmark-20260907-changelog/benchmark-manifest.json
export RA_ENGINEERING_BENCHMARK_OVERLAY_PATH=/Users/marcinjackowski/.remoteagent/live-mobl-2023/benchmark-20260907-changelog/benchmark-overlay.json
export RA_LIVE_ENGINEERING_OBJECTIVE="$(< /Users/marcinjackowski/.remoteagent/live-mobl-2023/objective.txt)"
export RA_XCODEBUILD_PATH=/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
pnpm exec vitest run apps/agent-worker/test/engineering-live-ios.integration.test.ts --reporter=verbose
```

Nie zwiększaj success count za samo przejście smoketestu providera. Live failure
klasyfikuj jako harness/code/model/provider/environment; zbierz minimalny
reproducer, nie powtarzaj pełnego runu dla tej samej niewyjaśnionej przyczyny.
Proponowana kampania: maksymalnie 3 pełne próby danej zamrożonej wersji,
łącznie do 4.5M zgłoszonych tokenów; właściciel zatwierdza limit przed startem.
Zmiana gate/configu tworzy nową wersję kampanii, nie usuwa kosztów starej.

Odbiór R9 wymaga jednocześnie:

- commit receipt wskazuje jeden nowy lokalny commit, właściwego parenta i
  tree; faktyczny `git log/show/status` to potwierdza;
- każdy wymagany gate/test jest wykonany na właściwym tree/config, nie tylko
  wybrany; brak flake'a bez jawnego rozstrzygnięcia;
- końcowy fresh review jest PASS, verifier VERIFIED; brak pominiętych
  unresolved B/H/M, missing criterion i niezreviewowanych późniejszych zmian;
- brak ręcznych source corrections, zewnętrznych write'ów, edycji evaluatorów;
- zachowane evidence/export/journal/worktree; source i seed niezmienione;
- raport rzeczywistego usage porównuje initial180k–450k, historyczne800k–1.5M
  i aktualne progi; missing usage jest widoczny.

Po sukcesie uruchom pełną bramkę RA-055 z task file. Dopiero następnie primary
czyta **pełny** diff od baseline, każde AC i mutation evidence, pisze formalny
AUDIT/HANDOFF, aktualizuje statusy/CTF, wykonuje `workflow:validate`, logiczne
commity zgodnie z AGENTS. Ten diagnostyczny audyt nie zastępuje żadnego z tych
kroków. Push/MR wymagają osobnej zgody.

## 5. Kolejna faza: Local v1, nie kolejny niekończący się MOBL-2023

Poniższe pakiety mają dostać oficjalne task IDs dopiero po decyzji właściciela.
RA-055 może być DONE wcześniej, lecz komunikat „Engineering gotowy do użycia”
powinien poczekać na tę niezależną kwalifikację.

### Q1 — mały, niezależny benchmark i uczciwe powtórzenia

Trzy poziomy: drobna poprawka logiki/copy, średnia integracja event→state→action,
przekrojowy iOS MOBL-2023. Co najmniej jeden task ma być niewykorzystany podczas
strojenia R1–R9. Dla każdej zamrożonej konfiguracji wykonaj 3 fresh runs;
nie wybieraj do raportu wyłącznie najlepszego.

Proponowane kryterium Local v1: wszystkie małe runs poprawne, co najmniej 2/3
średnich i 2/3 przekrojowych poprawne; każda porażka ma bezpieczny, czytelny
terminal. To próg pilota, nie statystyczny dowód niezawodności produkcyjnej.
Właściciel zatwierdza liczbę i budżet, zanim ruszy seria.

Nowa macierz profili zachowuje seed/objective/gates i zmienia tylko jawne role.
Claude live wymaga osobnego opt-in/auth preflight; do tego czasu testuj routing
deterministycznie. Nie przypisuj na stałe implementera/reviewera do modelu.

### Q2 — operacyjny local entrypoint

Proponowana odpowiedzialność: nowy `scripts/engineering/` lub odpowiedni CLI
composition root, bez drugiego control plane. Komendy projektowane:
`preflight`, `run`, `status`, `report`, `cancel`, `resume`, `export-evidence`.
To nazwy docelowe — **nie istnieją dziś jako zweryfikowany interfejs**.

`run` przyjmuje objective file i profile config, waliduje wersje/scope, tworzy
trwały case/run i oddaje ID. `status/report` nie wywołuje modelu. `resume`
odtwarza receipt-backed state, a `cancel` nie kasuje źródeł ani logów.
Bez zgody na commit domyślnie kończy na reviewable diff; z zatwierdzonym commit
scope używa dotychczasowego evidence-bound LOCAL_COMMIT.

Odbiór: nowa sesja modelu potrafi uruchomić jeden zatwierdzony task i znaleźć
jego stan wyłącznie z runbooka. Zero ręcznych UPDATE w DB, kopiowania tokens,
edytowania hardcoded ścieżek w testach czy sklejania prywatnych skryptów.

### Q3 — maintainability dopiero po dowodzie zachowania

Po R9/Q1 wydziel `engineering-execution.ts` na context, mutation-result policy,
stage composition i config loader; journal na schema/writer/projection/budget.
Nie rób dużego refactoru równolegle z diagnozą liveness. Publiczne kontrakty i
receipts pozostają identyczne, a benchmark potwierdza brak regresji.

Przenieś provider-neutral tests z historycznego katalogu bedrock do
model-runtime z aktualizacją importów/komend; nie kasuj istniejącego pokrycia.
Stwórz jedną tabelę error taxonomy oraz jedną zweryfikowaną komendę bramki,
żeby nie powtarzać pomyłki `tsc -p --force` i wykonywania stale dist.

## 6. Szacunki i mierniki do raportowania właścicielowi

Wartości poniżej to **proponowane cele pilota**, nie zmierzone możliwości ani
gwarancja kosztu. Tokeny = input+output według providera, z missing usage osobno.

| Klasa taska | Cel zgłoszonych tokenów poprawnego runu | Cel czasu ściennego |
|---|---:|---:|
| mała, kilka lokalnych plików | 30k–100k | 5–15 min |
| średnia, routing/state + testy | 100k–300k | 10–30 min |
| przekrojowa iOS jak MOBL-2023 | 300k–750k | 20–60 min, zależnie od Xcode |

Obecne historyczne 800k–1.5M nie jest estymatą udowodnionego sukcesu: brak
udanego pełnego runu w kohorcie. Traktuj ją jako zakres zaobserwowanego kosztu
częściowych prób. Run 89: 1.227M i 67 min, bez delivery.

Raport po każdej kampanii: liczba wszystkich prób/sukcesów/przerwań, failure
class, median i max token/time (p95 dopiero przy sensownej liczbie próbek),
model calls, gate runs, corrections per slice, bytes context, missing usage,
liczba ręcznych interwencji, digest wersji. Pokaż koszt na **dostarczony task**,
czyli także koszt nieudanych prób, nie tylko ostatniego sukcesu.

R0–R3 powinny być rozstrzygnięte bez jakiegokolwiek live. R4–R8 korzystają
najpierw z deterministic fakes/synthetic fixtures, a dopiero exact Xcode
waliduje właściwy adapter. To jest istotna zmiana metody pracy: drogi model
nie służy do wykrywania kolejnego błędu w schema/path/schedule.

## 7. Zamknięcie sesji i odzyskiwanie pracy

Po każdym odebranym kroku zapisz w WORK_UNITS: baseline, zmienione paths,
komendę i exit, RED/restore/GREEN, otwarte findings, następny krok i intentional
dirty paths. Nie kopiuj kolejnych tysięcy wierszy live historii do aktywnego
planu; historyczny WORK_UNITS pozostaje evidence, ten dokument jest nawigacją.

Przy pause w środku kroku nie twórz PASS/DONE. Zapisz dokładny failing test,
czy mutant został przywrócony, czy działa proces, gdzie jest evidence i kto
ma write scope. Nie zaczynaj live automatycznie po compaction.

Pierwszy następny ruch po zatwierdzeniu wdrożenia: **R0/R1**, reprodukcja
unresolved-mutation fallback i naprawa jego kontraktu. Równolegle dozwolona
jest wyłącznie read-only analiza R2, nie kolejny writer w workerze.
