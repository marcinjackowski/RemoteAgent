# RA-042 — WORK_UNITS

- Task: `RA-042` Deterministyczny gate runner i evidence binding
- Bazowy commit: `40c81dbdae91fcbb3a4a97a2a89e3ab7e415794d`
- Status: `DONE`
- ADR: `ADR-0011`, ciągły przebieg z `AGENTS.md`

## Inwariant projektu

RA-042 nie tworzy drugiego process runnera ani drugiego effect journalu.
`workspace-runner.runProcess` pozostaje jedyną granicą procesu i sandboxu,
`job_intents`/`job_completions` oraz bindingi RA-038 pozostają jedynym trwałym
źródłem intent/receipt. Nowa warstwa jest adapterem domenowym: zamknięty,
server-owned katalog gate'ów, jednorazowe kopie drzewa, ścisłe command receipts
ponownie odczytane z ledgera oraz konserwatywny `EvidenceBundle`.

Gate nigdy nie działa w authoritative worktree. Baseline i current są osobnymi
wejściami, osobnymi disposable workspace i osobnymi operacjami. Wynik `PASSED`
oznacza wyłącznie kompletne, spójne receipts dla dokładnego drzewa i configu;
pusty zestaw, brak required gate, brak logu/receiptu, obcy scope albo zielony
baseline dla gate'a test-first nigdy nie daje PASS.

## RA-042-WU-00 — Zamknięty katalog, receipts i konserwatywny agregat

**Status:** DONE

**Rezultat:** `test-evidence` ma strict/versioned kontrakty gate definition,
command receipt i aggregate oraz code-owned catalog factory. Executable musi być
kanoniczną pozycją allowlisty, argv pozostaje tablicą, konfiguracja ma canonical
digest, a pure aggregate fail-closuje na pustym/missing/duplicate/foreign/stale
lub wewnętrznie niespójnym evidence. Nie istnieje caller-supplied verdict.

**Allowed paths:**

- `packages/test-evidence/src/engineering-gates.ts`
- `packages/test-evidence/src/index.ts`
- `packages/test-evidence/test/engineering-gates.test.ts`
- `docs/work-units/RA-042/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm exec vitest run packages/test-evidence/test/engineering-gates.test.ts && pnpm --filter @remoteagent/test-evidence typecheck
```

**Evidence (2026-08-26):**

- finalna komenda WU uruchomiona 8 razy; ostatni przebieg exit code `0`, Vitest
  `13/13`, oba przebiegi `tsc --noEmit` exit code `0`;
- mutation executable allowlist: usunięcie `allowed.has(canonical)` dało RED,
  exit code `1`, `1 failed | 12 passed`; po przywróceniu pełnego warunku finalna
  komenda WU ponownie GREEN, exit code `0`;
- pre-audit: katalog wykonuje deep snapshot/freeze tablic oraz precomputuje
  command digests; operation bindings są unikalne i dokładne per
  `gate_id:BASELINE|CURRENT`, z osobnymi operacjami dla dwóch gate'ów.

## RA-042-WU-01 — Disposable workspace i przerwanie procesu

**Status:** DONE

**Zależy od:** RA-042-WU-00

**Rezultat:** launcher tworzy jednorazową kopię authoritative tree poza nim,
weryfikuje identyczny pre-digest, wyklucza `.git` jako krawędź do authority i po
gate dowodzi: authoritative digest bez zmian oraz brak zmian kopii poza
kanonicznie zweryfikowanymi `mutable_outputs`. `runProcess` obsługuje aktywne
anulowanie przez `AbortSignal`, zabija całą grupę i raportuje `cancelled`
oddzielnie od timeoutu i zwykłego exit failure. Brak egzekwowalnego profilu
sandboxu/network daje `INFRASTRUCTURE`, nigdy fallback unsandboxed.

**Allowed paths:**

- `packages/workspace-runner/src/process-runner.ts`
- `packages/workspace-runner/test/process-runner.test.ts`
- `packages/test-evidence/src/disposable-workspace.ts`
- `packages/test-evidence/src/index.ts`
- `packages/test-evidence/test/disposable-workspace.integration.test.ts`
- `docs/work-units/RA-042/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm exec vitest run packages/workspace-runner/test/process-runner.test.ts packages/test-evidence/test/disposable-workspace.integration.test.ts && pnpm --filter @remoteagent/workspace-runner typecheck && pnpm --filter @remoteagent/test-evidence typecheck
```

**Evidence (2026-08-26):**

- finalna komenda WU uruchomiona 5 razy; ostatni przebieg exit code `0`, Vitest
  `19/19`, oba przebiegi `tsc --noEmit` exit code `0`;
- disposable copy jest tworzona w losowym katalogu tymczasowym poza authority,
  nie przenosi żadnej krawędzi `.git`, odrzuca absolutne/uciekające/broken
  symlinki i wymaga identycznego digestu authority/copy przed callbackiem;
- protected inventory dopuszcza wyłącznie kanoniczne `mutable_outputs` i ich
  katalogi-przodków; siblingi oraz nowo utworzone `.git` pozostają chronione,
  a authority ma identyczny digest przed/po; cleanup jest bounded, działa również
  po błędzie callbacka i został sprawdzony rzeczywistym `ENOENT`;
- `runProcess` przyjmuje `AbortSignal`, nie startuje po pre-abort, aktywnie zabija
  detached process group, rozróżnia `cancelled` od `timedOut` i usuwa listener;
  realny test wnuka używa ograniczonego pollingu na powstanie i zniknięcie PID;
- mutation outside-mutable guard: wyłączenie porównania protected digest dało RED,
  exit code `1`, `1 failed | 7 skipped`; po przywróceniu pełna komenda WU ponownie
  GREEN, exit code `0`;
- niezależny pre-audit Sol domknął HIGH w granicy mutable output: po callbacku
  ponownie kanonikalizowane są root/ancestors i symlink-swap nie może wyprowadzić
  zapisu poza disposable root; realne integracje po korekcie `19/19`, exit code `0`;
- scoped ESLint ujawnił `prefer-const` dla timera i został poprawiony przed
  finalnym przebiegiem; końcowe scoped ESLint, Prettier, `workflow:validate`
  (`OK — 45 tasks`) i `git diff --check` zakończyły się exit code `0` (ESLint
  zgłosił wyłącznie preexistujące ostrzeżenia migracyjne `boundaries`).

## RA-042-WU-02 — Per-command intent, durable receipt i recovery

**Status:** DONE

**Zależy od:** RA-042-WU-01

**Rezultat:** executor dla jednego gate'a zapisuje RA-038 intent i singleton
`STARTED` przed dispatch, wykonuje wyłącznie definicję z katalogu, zapisuje exact
completion receipt i buduje wynik dopiero po ponownym odczycie receipt z trwałego
ledgera. Receipt wiąże case/run/operation/gate/target, tree/config/command digest,
process facts i log digest. Crash po `STARTED` bez receipt pozostaje
`AMBIGUOUS`; stale lease, obcy scope/tree/config/command albo receipt bez
obserwowanego completion fail-closuje.

**Allowed paths:**

- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `packages/test-evidence/src/engineering-gates.ts`
- `packages/test-evidence/src/runner.ts`
- `packages/test-evidence/test/engineering-gates.integration.test.ts`
- `packages/test-evidence/test/engineering-gates.test.ts` — dodany do WU-02 za
  zgodą Sol, ponieważ strict `workspace_id` i `log_artifact` zmieniają load-bearing
  fixture kontraktu WU-00, a package test typecheck nie może pozostać słabszy
- `packages/test-evidence/test/evidence.integration.test.ts`
- `packages/test-evidence/src/index.ts`
- `docs/work-units/RA-042/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm --filter @remoteagent/workspace-runner build && pnpm --filter @remoteagent/database build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/engineering-control-plane.integration.test.ts packages/test-evidence/test/evidence.integration.test.ts packages/test-evidence/test/engineering-gates.integration.test.ts && pnpm --filter @remoteagent/database typecheck && pnpm --filter @remoteagent/test-evidence typecheck
```

**Evidence (2026-08-26):**

- finalna komenda WU z jawnym buildem cross-package source→dist została uruchomiona
  3 razy; pierwszy przebieg exit code `1` rozstrzygnął błąd przywrócenia mutacji
  (rekurencyjny helper recovery, nie flake PG), po dokładnej korekcie przebieg solo
  `7/7`, a dwa końcowe przebiegi komendy WU exit code `0`, ostatni Vitest `86/86`,
  oba package typechecki exit code `0`; strict kontrakt WU-00 uruchomiony osobno
  po ostatnim guardzie `14/14`, exit code `0`;
- realny Postgres, filesystem i proces dowodzą: exact operation/intent/job
  completion read, singleton `STARTED`, completion outcome `SUCCEEDED` dla
  potwierdzonej obserwacji komendy, exact `COMPLETION_OBSERVED`, strict durable
  re-read oraz recovery brakującego observation event bez ponownego dispatchu;
- receipt wiąże case/workspace/run/operation/gate/target, stage attempt,
  authoritative tree, config/command, zamknięty signal/exit, duration i bezpieczną
  store-relative referencję logu; stary receipt swap, obcy/inactive workspace,
  obcy adapter tree/scope oraz zły legacy receipt digest fail-closują;
- operation ID hashuje exact descriptor (w tym attempt/tree/config/command):
  identyczny attempt/tree reużywa receipt, zmienione drzewo daje inną operację;
  immutable creation digest workspace może różnić się od bieżącego drzewa, które
  jest mierzone i wiązane osobno;
- generic adapter obsługuje tylko `HERMETIC`+`DENY`; pozostałe profile bez
  jawnego adaptera dają trwałe `INFRASTRUCTURE`, a wstrzyknięty adapter przechodzi
  ten sam strict TestRun scope/tree/manifest i recomputed receipt-digest guard;
  brak log artifact oraz post-run disposable boundary failure nie mogą dać PASS;
- mutation durable re-read bypass: RED exit code `1`, `1 failed | 6 passed`
  (oczekiwane 2 odczyty, otrzymano 1); po przywróceniu GREEN `7/7`;
- mutation `STARTED` replay: RED exit code `1`, `1 failed | 6 skipped`
  (`STARTED already exists ... recover before dispatch` zamiast AMBIGUOUS); po
  przywróceniu GREEN;
- mutation ACTIVE workspace scope guard: RED exit code `1`, `1 failed | 6 skipped`
  (archived workspace uzyskał fałszywy `PASSED`); po przywróceniu GREEN;
- scoped ESLint exit code `0` (wyłącznie preexistujące ostrzeżenia migracyjne
  `boundaries`), Prettier i `git diff --check` exit code `0`.

## RA-042-WU-03 — Baseline/current, test-first i `EvidenceBundle`

**Status:** DONE

**Zależy od:** RA-042-WU-02

**Rezultat:** batch executor uruchamia required gates kolejno i składa
`EngineeringEvidenceBundle` wyłącznie z ponownie zweryfikowanych durable receipts.
Gate test-first ma osobne receipts baseline/current i przechodzi tylko przy
`baseline FAILED` oraz `current PASSED`; baseline `PASSED` jest vacuous, a
baseline `INCONCLUSIVE` pozostaje brakiem dowodu — oba blokują. Zwykły required
gate wymaga current `PASSED`. Bundle wiąże
current tree, wszystkie config/receipt/log digests, diff/context digest i nie
akceptuje modelowego rozszerzenia katalogu. Adwersarialna integracja dowodzi
command injection, write poza mutable output, missing receipt, stale tree/config,
timeout/cancel i baseline-green.

**Allowed paths:**

- `packages/test-evidence/src/engineering-gates.ts`
- `packages/test-evidence/test/engineering-gates.integration.test.ts`
- `packages/test-evidence/test/engineering-gates.test.ts`
- `packages/test-evidence/src/index.ts`
- `docs/work-units/RA-042/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm --filter @remoteagent/workspace-runner build && pnpm --filter @remoteagent/database build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/test-evidence/test/engineering-gates.test.ts packages/test-evidence/test/disposable-workspace.integration.test.ts packages/test-evidence/test/engineering-gates.integration.test.ts && pnpm --filter @remoteagent/test-evidence typecheck
```

**Evidence (2026-08-26):**

- finalna komenda WU z jawnymi buildami cross-package została uruchomiona po
  przywróceniu mutacji 2 razy; końcowy przebieg exit code `0`, Vitest `39/39`,
  package typecheck exit code `0`; nie wystąpił flake;
- required gates biegną deterministycznie w kolejności katalogu, dla gate'a
  baseline zawsze `BASELINE` przed `CURRENT`; optional gate z host-canary nie
  został uruchomiony, a strict metadata odrzuca modelowe `authority`, katalog i
  receipts; katalog ma code-owned limit `128` definicji (boundary 128 przyjęta,
  129 odrzucona);
- bundle powstaje wyłącznie dla kompletnego agregatu `PASSED`; zawiera dokładne
  `job_completion.completion_id` odczytane z Postgresa (nie payload
  `receipt_id`), server-owned tree/config/diff/context/review/decision metadata
  oraz wyłącznie bounded `UNTRUSTED_DATA` summaries bez host paths i treści logu;
- baseline-green daje `FAILED` bez bundle, timeout i protected-write dają
  `INCONCLUSIVE` bez bundle, a aktywne anulowanie po durable `STARTED` zapisuje
  osobny `CANCELLED`, zatrzymuje batch przed następnym gate'em i nie tworzy
  agregatu ani bundle; `STARTED` bez completion pozostaje `AMBIGUOUS` bez replay;
- log artifact ID jest deterministycznie scope'owany exact operation ID, więc
  baseline/current tego samego gate'a przy stałym zegarze mają różne artefakty;
- mutation baseline-vacuity: wyłączenie wymogu `baseline FAILED` dało RED, exit
  code `1`, `1 failed | 13 skipped`; po przywróceniu GREEN;
- mutation durable completion binding: zastąpienie DB `completion_id` przez
  payload `receipt_id` dało RED, exit code `1`, `1 failed | 13 skipped`; po
  przywróceniu GREEN;
- mutation required-only selection: wykonanie całego katalogu wraz z optional
  gate'em dało RED, exit code `1`, `1 failed | 13 skipped`; po przywróceniu
  GREEN;
- scoped ESLint, Prettier, `workflow:validate` i `git diff --check` uruchomiono
  po finalnym restore; ESLint raportuje wyłącznie preexistujące ostrzeżenia
  migracyjne `boundaries`.

## RA-042-WU-04 — Mutation evidence i pełna bramka taska

**Status:** DONE

**Zależy od:** RA-042-WU-03

**Rezultat:** load-bearing mutacje executable allowlist, process-group cancel,
outside-mutable guard, missing required receipt, durable re-read i baseline-vacuity
dają RED; każda zostaje przywrócona i potwierdzona GREEN. Regresje istniejących
`test-evidence`, `workspace-runner`, RA-038 i workflow są zielone, a task jest
gotowy do niezależnego audytu Sol.

**Allowed paths:**

- ścieżki WU-00..03 wyłącznie do kontrolowanych mutacji i przywrócenia
- `docs/work-units/RA-042/WORK_UNITS.md`
- `docs/tasks/RA-042.md`
- `docs/tasks/TASK_INDEX.md`
- `docs/audits/CROSS_TASK_FINDINGS.md`

**Korekty pre-audytu Sol (2026-08-26):**

- `readOperationCompletion()` projektuje jawnie dokładny
  `EngineeringControlOperationRow`; joined `descriptor`, completion receipt,
  completion ID/outcome i pola observation nie wyciekają przez publiczne
  `operation`. Realny test PostgreSQL sprawdza dokładny zestaw 18 kluczy;
  mutation zwracająca szeroki joined row dała RED, exit code `1`,
  `1 failed | 34 skipped`, ujawniając 7 nadmiarowych pól; po restore pełny plik
  integracyjny `35/35` GREEN;
- gate receipt zachowuje obserwowany `exit_code` również po downgrade do
  `INFRASTRUCTURE` (brak durable logu albo naruszenie disposable boundary);
  `TIMED_OUT`, `CANCELLED` i `AMBIGUOUS` nadal wymagają `null`. Mutation kasująca
  exit fact dała RED, exit code `1`, `2 failed | 12 skipped`; po restore oba
  regresy i strict unit schema są GREEN;
- łączna bramka korekt na realnym PostgreSQL/FS/process: exit code `0`, Vitest
  `74/74` (35 DB + 39 gate/disposable), oba package typechecki exit code `0`;
  scoped ESLint exit code `0` z wyłącznie preexistującymi ostrzeżeniami
  `boundaries`, Prettier, `workflow:validate` (`OK — 45 tasks`) i
  `git diff --check` exit code `0`; brak flake.

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check
```

**Evidence (2026-08-26):**

- pierwsza próba pełnej bramki zakończyła się exit code `254` po poprawnym lint,
  ponieważ plan wskazywał nieistniejący skrypt `format:check`; plan skorygowano
  do rzeczywistego `pnpm format`, bez zmiany implementacji ani pominięcia kroku;
- skorygowana pełna komenda została uruchomiona od początku i zakończyła się
  exit code `0`: lint exit `0` (wyłącznie istniejące warnings `boundaries`),
  format exit `0`, build `26/26` z `0 cached`, testy z wymaganym PostgreSQL
  `2652/2652` w `206` plikach bez skipów/faila, typecheck `38/38` z `0 cached`,
  `workflow:validate OK — 45 tasks` oraz `git diff --check` exit `0`;
- po pełnej bramce audyt ponowił pełny Vitest z reporterem JSON:
  `2652/2652`, `206` plików, `639/639` suites, exit code `0`, oraz osobno
  wymuszony build `26/26`, `0 cached`, exit code `0`;
- wszystkie mutacje WU-00..03 i dwie korekty pre-audytu dały RED, zostały
  przywrócone i mają końcowy GREEN. Nie pozostał finding BLOCKER/HIGH/MEDIUM;
- wejście dla RA-043: produkcyjny stage `GATE_EXECUTION` ma wywoływać
  `executeVerificationGateBatch`, zachować pojedynczy ledger RA-038 i utrzymywać
  heartbeat lease podczas długich gate'ów. Brak świeżego fence pozostaje
  bezpiecznie `AMBIGUOUS`; RA-043 nie tworzy drugiego runnera ani journala.
