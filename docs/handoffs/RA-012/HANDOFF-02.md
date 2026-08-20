# RA-012 — Handoff 02

## Metadata

- Task: `RA-012`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md) —
  jedna rola wykonawcza, bramką jest uruchomiona komenda
- Work-units plan: `docs/work-units/RA-012/WORK_UNITS.md`
- Zaakceptowane units: `WU-01`, `WU-01B`, `WU-02`, `WU-03`, `WU-04`, `WU-05`,
  `WU-06`, `WU-07` — wszystkie
- Data: `2026-08-20`
- Bazowy commit: `b2d6631` (stan z `HANDOFF-01`)
- Końcowy commit: `4af139d`

## Wynik

`@remoteagent/implementation-tools` jest kompletnym, ograniczonym toolsetem
model-facing nad zaakceptowanym boundary RA-010/RA-011: strict kontrakty z
pierwszorzędnym `AMBIGUOUS`, trwały cross-process operation ledger (migracja
`027`), cztery bounded narzędzia read-only, journalowany zapis wielu plików,
server-owned wykonywanie komend z redakcją outputu, scoped `mkdir` oraz warstwa
kompozycji, w której scope jest domknięciem, a nie parametrem.

Task przechodzi do bramki audytowej. W przeciwieństwie do `HANDOFF-01` nie ma
units w toku ani niezweryfikowanego materiału.

## Zrealizowany zakres od `HANDOFF-01`

- **`WU-05` domknięty** — nie przez powtórzenie od zera, jak zakładał plan
  (rewizja 8), lecz przez uruchomienie istniejącej komendy weryfikacyjnej i
  naprawę jednej linii. Szczegóły w „Defekt krytyczny" niżej.
- **`WU-06`** — scoped `mkdir` z idempotencją i diagnostyką bez host paths.
- **`WU-07`** — kompozycja toolsetu, ochrona repo instructions/credential paths,
  macierz fault/restart.
- **Reforma procesu** (ADR-0007) i naprawa środowiska, bez których żadna bramka
  nie dawała się uruchomić.

## Defekt krytyczny znaleziony w `WU-05` — odwrócone kryterium akceptacji 1

To najważniejsza pozycja tego handoffu.

`packages/implementation-tools/src/command.ts` odtwarzał request modelu ręcznie
jako `{ operation_id, command }`, przez co `env`, `cwd`, `network`, `timeoutMs`
i `outputBytes` **znikały przed** strict parse. Request poszerzający server-owned
policy zwracał `SUCCEEDED` zamiast `FAILED` / `POLICY_NOT_EXTENSIBLE`.

Komentarz nad tą linią opisywał zachowanie odwrotne i poprawne — stwierdzał
wprost, że spread jest tym, „co czyni kryterium 1 realnym". Defekt czytał się
więc jako prawidłowy przy każdym przeglądzie kodu.

Cztery testy w `test/command.integration.test.ts` (475 linii, istniejący na
dysku) wykrywały to natychmiast. Nie zostały uruchomione. Plan orzekł, że plik
„nie ma wartości dowodowej" i unit trzeba powtórzyć — podczas gdy brakowało
wyłącznie uruchomienia bramki.

Naprawa: `const { signal, ...requested } = input;` (commit `8680050`).

Wniosek zapisany w `AGENTS.md`: komentarz nie jest dowodem zachowania; gdy
komentarz i kod się nie zgadzają, rozstrzyga uruchomiony test.

## Wykonanie work units

| Unit | Rezultat | Gate | Wynik |
|---|---|---|---|
| `WU-01` | strict kontrakty + scaffold | diff + suite + mutacja | ACCEPTED |
| `WU-01B` | usunięcie kolizji nazw eksportów | sonda przecięcia | ACCEPTED |
| `WU-02` | durable intent ledger + migracja `027` | concurrency na realnym PG | ACCEPTED |
| `WU-03` | bounded read/search/tree/config | brak duplikacji `discovery-policy` | ACCEPTED |
| `WU-04` | journalowany patch ze staging/recovery | fault injection + 2 mutacje | ACCEPTED |
| `WU-05` | server-owned command policy + artifact sink | **naprawa 1 linii + 4 testy + mutacja** | ACCEPTED |
| `WU-06` | scoped `mkdir` + diagnostics | 5 mutacji, w tym wykryta słabość testów | ACCEPTED |
| `WU-07` | kompozycja + fault/restart matrix | 5 mutacji, sweep adwersarialny | ACCEPTED |

## Zmiany od `HANDOFF-01`

| Ścieżka | Co zmieniono | Stan |
|---|---|---|
| `src/command.ts` | naprawa odwróconego kryterium 1 (spread requestu) | ACCEPTED |
| `test/command.integration.test.ts` | wymagana weryfikacja `WU-05`, 3 kryteria, 14 testów | ACCEPTED |
| `src/mkdir.ts` | scoped, idempotentny `mkdir` z ledgerem | ACCEPTED |
| `test/mkdir.integration.test.ts` | 19 testów; asercje na kod polityki, nie na `FAILED` | ACCEPTED |
| `src/toolset.ts` | kompozycja; scope jako domknięcie; `guardPath`/`isProtectedPath` | ACCEPTED |
| `test/toolset.integration.test.ts` | 15 testów; sweep adwersarialny + fault/restart | ACCEPTED |
| `src/index.ts` | re-eksport `mkdir` i `toolset` | ACCEPTED |

## Decyzje i uzasadnienie

- **`ToolKind` nie zyskuje `MKDIR`.** Zamknięty zbiór kinds jest zaakceptowanym
  kontraktem `WU-01`, konsumowanym przez enum ledgera i CHECK migracji `027`.
  Rozszerzanie go dla kosmetyki poszerzyłoby zaakceptowaną granicę. Tworzenie
  katalogu jest mutacją workspace, więc jego klasa efektu to `WRITE_FILE`; nazwa
  narzędzia w payloadzie zachowuje rozróżnialność.
- **`mkdir` wspiera `recursive`.** Alternatywa jest gorsza: bez tego model musi
  wykonać jedno wywołanie na przodka, a każde pośrednie jest osobno klaimowanym
  side effectem, którego częściowe wykonanie jest niewidoczne. Jedna operacja z
  jednym zapisanym intentem jest uczciwą jednostką; każdy utworzony przodek trafia
  do `changed_files`, więc write surface nie jest zaniżony.
- **Scope jako domknięcie, nie parametr.** Dwie pierwsze mutacje `WU-07` nie dały
  się zmaterializować, bo narzędzia są budowane raz przy konstrukcji. To mocniejsza
  własność niż walidowanie przekazanego scope: wartość, której się nigdy nie
  przyjmuje, nie może być źle zwalidowana.
- **Ochrona ścieżek w warstwie kompozycji, nie w każdym narzędziu.** Repo
  instructions są dla `discovery-policy` i path policy zwykłymi plikami — żadna
  warstwa niżej ich nie chroni, a model, który nadpisze `AGENTS.md`, edytuje
  instrukcje dla własnego kolejnego przebiegu. Jedna bramka oznacza też, że nowe
  narzędzie musi przez nią przejść, żeby w ogóle dostać ścieżkę.
- **Batch `patch` z jedną chronioną ścieżką jest odrzucany całościowo**, inaczej
  model przemyca chroniony zapis za legalnym.

## Kryteria akceptacji RA-012

Każde weryfikowane osobno, zgodnie z final task gate.

| Kryterium | Status | Dowód |
|---|---|---|
| 1. Path traversal, symlink escape, cwd escape zablokowane | PASS | `read-tools` (traversal, symlink), `patch` (symlink swap mid-batch), `command` (cwd), `mkdir` (4 testy negatywne), `toolset` (protected paths) |
| 2. Command nie wstrzyknie sekretów ani nie poszerzy network policy | PASS | `command` — 4 testy negatywne (`env`, `cwd`, `network`, limit) + canary na 7 literałach w stdout, stderr, logu i artefakcie |
| 3. Każda zmiana ma intent, wynik, pre/post digest i listę plików | PASS | `ledger` (intent przed efektem, exactly-once na realnym PG), `patch`/`mkdir` (digest + `changed_files`) |
| 4. Truncated output zachowuje pełny artefakt i wskazuje obcięcie | PASS | `read-tools` (clipping z `original_byte_length`), `command` (artefakt poza promptem z digestem) |
| 5. Częściowy patch zostawia wykrywalny stan, nie fałszywy sukces | PASS | `patch` — fault injection, asercje na bajtach na dysku, 2 mutacje |
| 6. Implementer nie zmieni scope argumentem toola | PASS | `toolset` — sweep adwersarialny po 8 narzędziach; obcy scope ma 0 wierszy w ledgerze |

## Testy i kontrole

Wszystkie **uruchomione**, nie zapowiedziane.

| Komenda/kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo, realny PG) | 0 | **1230/1230, 118 plików** |
| `pnpm vitest run packages/implementation-tools/test` | 0 | 136/136, 7 plików |
| `pnpm vitest run .../command.integration.test.ts` | 0 | 14/14 |
| `pnpm vitest run .../mkdir.integration.test.ts` | 0 | 19/19 |
| `pnpm vitest run .../toolset.integration.test.ts` | 0 | 15/15 |
| `pnpm run typecheck --force` (uncached) | 0 | 31/31 |
| `pnpm run build --force` (uncached) | 0 | 23/23 |
| `pnpm exec eslint packages/implementation-tools/{src,test}` | 0 | PASS (tylko preexistujące warnings `boundaries`) |
| `pnpm exec prettier --check` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| sonda przecięcia eksportów (11 pakietów) | 0 | brak realnych kolizji |

`--force` jest istotne: `turbo` raportuje `FULL TURBO` / `31 cached` bez
uruchomienia czegokolwiek, więc przebieg cache'owany nie jest dowodem.

## Mutation testing

Zielone testy nie są dowodem. Każdy istotny mechanizm zepsuty celowo, plik
przywracany z kopii i potwierdzany ponownym przebiegiem.

| Mutacja | Unit | Wynik |
|---|---|---|
| ręcznie budowany request (przywrócenie defektu) | WU-05 | 4 testy FAIL |
| usunięcie `validateCreateTarget` (surowy `join`) | WU-06 | 3 testy FAIL (po wzmocnieniu asercji) |
| `if (missing.length === 0)` → `if (false)` | WU-06 | 2 testy FAIL |
| `error.code` → `error.message` (wyciek host path) | WU-06 | 3 testy FAIL |
| nierozstrzygnięty `INTENT_RECORDED` → `SUCCEEDED` | WU-06 | 1 test FAIL |
| pominięcie kontroli non-directory na przodku | WU-06 | 1 test FAIL |
| budowa write toola per call z `input.identity` | WU-07 | 1 test FAIL |
| `guardPath` sprawdza tylko pierwszą ścieżkę | WU-07 | 1 test FAIL |
| `PROTECTED_FILE_NAMES` wyłączone | WU-07 | 4 testy FAIL |
| `...input` / mutowalny `identity` (scope override) | WU-07 | **nieosiągalne** — scope jest domknięciem |

### Słabość testów wykryta mutacją w `WU-06`

Warta odnotowania, bo to wzorzec defektu `WU-05` w wersji testowej. Usunięcie
całej polityki ścieżek początkowo przeszło **18/18 zielono**: testy symlinkowe
asertowały tylko `outcome === FAILED`, a odmowę przejmował mój własny
`isDirectory()`. Luka jest materialna — `isDirectory()` **akceptuje** symlink
wskazujący na prawdziwy katalog, więc wersja bez polityki adoptowałaby katalog
poza workspace jako idempotentny sukces.

Naprawa: asercje na kod polityki (`SYMLINK_NOT_ALLOWED`) plus nowy przypadek
„symlinked leaf pointing at a DIRECTORY". Po tej zmianie ta sama mutacja wywala
3 testy.

## Bezpieczeństwo i dane

- `toolset.ts` nie importuje `fs`, `child_process`, `pg` ani path policy
  bezpośrednio — tylko cztery fabryki narzędzi i kontrakty (sprawdzone `grep`em,
  wynik `0`). Nie ma ścieżki obchodzącej limit, katalog komend albo politykę
  ścieżek warstwy niżej.
- `mkdir.ts` i `command.ts`: zero `any` / `as unknown as`; `command.ts` nie
  importuje `child_process` (jedyne trafienie to komentarz), 17 delegacji do
  `runProcess`.
- Output narzędzi przypięty do `UNTRUSTED_DATA` na poziomie schematu.
- Diagnostyka przenosi wyłącznie kody i liczniki; canary sweep po całej
  zserializowanej kopercie nie znajduje host paths ani model-supplied path.
- `@remoteagent/observability` **nie** jest zależnością pakietu — rozstrzygnięcie
  o lokalnej warstwie redakcji zachowane (`CTF-006`).
- Nie wykonano push, MR ani żadnego external write.

## Znane ograniczenia i ryzyka

- **`CTF-006` (HIGH, otwarty)** — `SecretRedactor` przepuszcza host paths,
  `glpat-`, `AKIA`, klucze prywatne i JWT. `command.ts` ma własną, oznaczoną
  `Transitional` tabelę wzorców; jest to **trzecie** miejsce z własnym zestawem,
  a zakres RA-024 obejmuje zwinięcie wszystkich trzech.
- **`CTF-004`** — `implementation-tools` nadal nie ma `tsconfig.test.json`, więc
  jego testy nie są objęte `typecheck`.
- **`CTF-008` (nowy, LOW)** — `pnpm run lint` jest czerwony na `main` (3 błędy w
  `bedrock-runtime`), więc `pnpm run check` nie może przejść. Preexistujące,
  potwierdzone przez odłożenie zmian.
- **`CTF-003`/`CTF-007`** — flake cross-worker; raz zaobserwowany w tej sesji
  (`workspace-runner/recovery`), zielony solo i w powtórzonym pełnym przebiegu.
- `search` nie ma bramki ścieżkowej w `toolset.ts`, bo przyjmuje zapytanie, nie
  ścieżkę; chronione pliki są wykluczane przez `isForbiddenPath` w skanie
  `discovery-policy`. Audyt powinien to potwierdzić jako świadomą decyzję.
- `command` nie ma bramki ścieżkowej, bo model podaje klucz katalogu, a cwd jest
  server-owned. To ta sama świadoma asymetria.

## Stan dla audytu

- Wszystkie osiem units `ACCEPTED`; brak pracy w toku i brak niezweryfikowanego
  materiału na dysku.
- Working tree czysty; `4af139d` zawiera całość.
- Audyt powinien niezależnie: odtworzyć pełny przebieg na realnym PostgreSQL,
  przeczytać diff od `b2d6631`, sprawdzić sześć kryteriów osobno i potwierdzić
  dwie świadome asymetrie (`search`, `command` bez bramki ścieżkowej) oraz
  klasyfikację `mkdir` jako `WRITE_FILE`.
