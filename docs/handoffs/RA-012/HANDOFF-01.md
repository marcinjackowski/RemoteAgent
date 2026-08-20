# RA-012 — Handoff 01

## Metadata

- Task: `RA-012`
- Status proponowany: `IN_PROGRESS` (**nie** `AWAITING_AUDIT`) — patrz „Dlaczego to
  nie jest handoff do audytu"
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Implementer model/transport: `Claude Opus 5 / wysoki effort / IMPLEMENTER`,
  osobne subagenty w świeżych ephemerycznych sesjach, zamknięte context packi
  (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Work-units plan: `docs/work-units/RA-012/WORK_UNITS.md`, revision `6`
- Zaakceptowane units: `WU-01`, `WU-01B`, `WU-02`, `WU-03`, `WU-04`
- Data: `2026-08-20`
- Bazowy commit: `b2d6631`
- Końcowy stan: `b2d6631` + niecommitowany WIP (nowy pakiet
  `packages/implementation-tools/` + migracja `027`)

## Dlaczego to nie jest handoff do audytu

Właściciel polecił pauzę po zakończeniu bieżącej pracy. RA-012 ma siedem units;
pięć jest zaakceptowanych, `WU-05` był w toku w chwili pauzy, `WU-06` i `WU-07`
nie zostały uruchomione. Task **nie spełnia jeszcze kryteriów akceptacji** —
brakuje ochrony repo instructions/credential paths (`WU-07`), `mkdir` (`WU-06`)
i dowodu, że model nie zmieni scope argumentem toola (`WU-07`).

Dlatego ten dokument jest **punktem wznowienia**, nie handoffem do bramki
audytowej. Status pozostaje `IN_PROGRESS`; nie ustawiam `AWAITING_AUDIT`, bo
walidator wymagałby wtedy audytu, a audyt niekompletnego taska dałby fałszywy
sygnał gotowości.

## Wynik dotychczasowy

Powstał nowy pakiet `@remoteagent/implementation-tools` z warstwą model-facing nad
zaakceptowanym boundary RA-010/RA-011: strict kontrakty z pierwszorzędnym
`AMBIGUOUS`, trwały cross-process operation ledger w PostgreSQL (migracja `027`),
cztery bounded narzędzia read-only oraz journalowany zapis wielu plików, w którym
częściowy zapis jest nieomijalnie `AMBIGUOUS`.

## Stan units

| Unit | Status | Rezultat |
|---|---|---|
| `WU-01` | `ACCEPTED` | strict, wersjonowane kontrakty + scaffold pakietu |
| `WU-01B` | `ACCEPTED` | usunięcie kolizji nazw eksportów z `@remoteagent/contracts` |
| `WU-02` | `ACCEPTED` | durable operation intent ledger + migracja `027` |
| `WU-03` | `ACCEPTED` | bounded read/search/tree/config |
| `WU-04` | `ACCEPTED` | journaled multi-file patch ze staging/digest/recovery |
| `WU-05` | **PRZERWANY W TOKU** | command policy — patrz niżej |
| `WU-06` | `PENDING` | mkdir w scope + diagnostics (rozpisany, nieuruchomiony) |
| `WU-07` | `PENDING` | composition + fault/restart matrix (rozpisany, nieuruchomiony) |

## Stan `WU-05` w chwili pauzy — WYMAGA UWAGI PRZY WZNOWIENIU

Implementer zapisał `packages/implementation-tools/src/command.ts` (37 041 bajtów,
ostatnia modyfikacja `14:18`), ale **nie zapisał** wymaganego
`test/command.integration.test.ts`. Nie zaraportował wyniku i nie odpowiedział na
status check koordynatora.

Pozostawił też plik **poza swoją allowlistą**:
`packages/implementation-tools/test/zz-tmp-probe.test.ts` (11 linii) — sonda
sprawdzająca, czy `@remoteagent/observability` rozwiązuje się pod vitest. Pakiet
`implementation-tools` **nie ma** tej zależności w `dependencies`, a `WU-05` miał
zakaz modyfikacji `package.json`. To realny Decision Request, którego implementer
nie zgłosił — i najpewniej powód, dla którego utknął.

### Błąd proceduralny koordynatora — drugi tego rodzaju

Sesja `WU-05` **została zatrzymana przeze mnie, gdy jeszcze żyła.** Przesłanki:
brak wymaganego pliku testowego, brak odpowiedzi na status check i brak zmian w
plikach od 43 minut. Ostatni komunikat agenta w chwili zatrzymania brzmiał
„Typecheck passes. Now the test suite." — czyli implementer właśnie przechodził do
uruchomienia testów.

To **powtórzenie błędu z `WU-02`** (opisanego w `docs/work-units/RA-012/WORK_UNITS.md`),
mimo że po tamtym incydencie zapisałem regułę w
`docs/workflow/LUNA_IMPLEMENTER.md`: brak plików i cisza nie są dowodem śmierci
agenta. Tam uruchomiłem duplikat; tu zabiłem żywą sesję. Reguła mówiła „pytać i
czekać" — zapytałem, ale nie odczekałem wystarczająco długo, a długi czas bez
zapisu na dysk potraktowałem jako potwierdzenie, choć wprost odrzuciłem tę
przesłankę w regule.

Szkody w kodzie nie ma: zaakceptowane pliki mają niezmienione hashe
(`patch.ts` `42b2b83d…`, `read-tools.ts` `31552dda…`, `contracts.ts` `7efbb870…`),
a `git status` pokazuje pakiet jako spójny untracked. Strata to praca `WU-05`,
którą trzeba powtórzyć.

**Wniosek do reguły:** status check bez odpowiedzi nie upoważnia do zatrzymania.
Trzeba albo czekać na jawny raport/status z harnessu, albo — jeśli pauza jest
konieczna — zatrzymać sesję świadomie i **zapisać to jako decyzję koordynatora, a
nie jako wniosek o awarii agenta**. Ten wpis jest właśnie takim zapisem.

### Konsekwencja dla `command.ts`

**`WU-05` NIE jest zaakceptowany.** `command.ts` nie został zweryfikowany: brak
testu, brak raportu, brak uruchomionej komendy weryfikacyjnej. Plik przeszedł
jedynie `typecheck` po stronie implementera — to nie jest dowód spełnienia
kryteriów.

Przy wznowieniu: uruchomić `WU-05` od nowa w świeżej sesji, z context packiem
rozstrzygającym dostęp do `@remoteagent/observability`. Istniejący `command.ts`
można przekazać nowej sesji jako materiał wyjściowy, ale **nie wolno przyjąć go
jako gotowego** — decyzję o jego losie podejmuje implementer w ramach nowego unitu,
pod nadzorem bramki.

## Zmiany

| Ścieżka | Co zmieniono | Stan |
|---|---|---|
| `packages/implementation-tools/src/contracts.ts` | strict `implementationToolIntent`/`implementationToolResult`, `AMBIGUOUS` jako pierwszorzędny wariant | ACCEPTED, 243 linie, sha256 `7efbb870…` |
| `packages/implementation-tools/src/ledger.ts` | durable ledger: `claim`/`settle`/`markAbandonedAmbiguous`, exactly-once przez `ON CONFLICT DO NOTHING` | ACCEPTED, 536 linii, sha256 `2987a1d7…` |
| `packages/implementation-tools/src/read-tools.ts` | cztery bounded narzędzia read-only nad `discovery-policy` | ACCEPTED, 407 linii, sha256 `31552dda…` |
| `packages/implementation-tools/src/patch.ts` | journalowany zapis, jedna konstrukcja `SUCCEEDED`, `AMBIGUOUS` nieomijalny | ACCEPTED, 690 linii, sha256 `42b2b83d…` |
| `packages/database/migrations/027_implementation_tool_operations.{up,down}.sql` | tabela ledgera z 4 CHECK-ami czyniącymi niebezpieczne kształty niereprezentowalnymi | ACCEPTED, sha256 up `5b3991d5…` |
| `packages/implementation-tools/src/command.ts` | command policy | **WIP, NIEZWERYFIKOWANY** |
| `packages/implementation-tools/test/zz-tmp-probe.test.ts` | sonda implementera poza allowlistą | **DO USUNIĘCIA** |
| `packages/implementation-tools/test/zz-coord-probe.test.ts` | sondy adwersarialne koordynatora | do usunięcia albo świadomego zachowania |
| `pnpm-lock.yaml` | importer nowego pakietu (`pnpm install`) | oczekiwany efekt uboczny |

## Decyzje i uzasadnienie

- **Osobny pakiet, nie rozszerzenie `workspace-runner`.** Ten drugi jest
  zaakceptowany w RA-010 i konsumowany przez `repository-planner`; wstrzyknięcie
  warstwy model-facing rozszerzyłoby zaakceptowany kontrakt.
- **Ledger w PostgreSQL, nie istniejący `OperationLedger`.** Ten z
  `workspace-runner` pisze JSONL i serializuje przez in-process `Map`, więc nie
  jest cross-process authority. Sprawdzone w kodzie, nie założone.
- **Exactly-once bez advisory locka.** Implementer wybrał `PRIMARY KEY` +
  `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`: jedno połączenie na operację.
  Wariant z `withAdvisoryLock` owijającym `withTransaction` zużywałby dwa i
  zakleszczał domyślną pulę 10 przy N > 5. Zweryfikowałem to własną sondą (N=8 bez
  deadlocka, lock na tym samym kluczu serializuje z peakiem `1`).
- **Kolizja nazw rozwiązana po naszej stronie**, `packages/contracts` nietknięty.

## Kryteria akceptacji RA-012

| Kryterium | Status | Dowód |
|---|---|---|
| 1. Path traversal, symlink escape, cwd escape zablokowane | CZĘŚCIOWO | `WU-03` (read) i `WU-04` (write) PASS; cwd wymaga `WU-05`, mkdir `WU-06` |
| 2. Command nie wstrzyknie sekretów ani nie poszerzy network policy | **NIE** | wymaga `WU-05` |
| 3. Każda zmiana ma intent, wynik, pre/post digest i listę plików | PASS | `WU-02` + `WU-04` |
| 4. Truncated output zachowuje pełny artefakt i wskazuje obcięcie | CZĘŚCIOWO | `WU-03` PASS dla odczytu; output komendy wymaga `WU-05` |
| 5. Częściowy patch zostawia wykrywalny stan, nie fałszywy sukces | PASS | `WU-04`, potwierdzone dwiema mutacjami |
| 6. Implementer nie zmieni scope argumentem toola | **NIE** | wymaga `WU-07` |

## Testy i kontrole

Wszystkie uruchomione niezależnie przez koordynatora.

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm vitest run packages/implementation-tools/test` (po WU-04) | 0 | 93/93, 5 plików |
| `pnpm vitest run` całe repo, real PG (po WU-04) | 0 | **1189/1189, 117 plików** |
| `pnpm vitest run` ledger + patch (kontrola przy pauzie) | 0 | 52/52 |
| `pnpm --filter @remoteagent/implementation-tools typecheck` | 0 | PASS |
| `pnpm --filter @remoteagent/implementation-tools build` | 0 | PASS |
| `pnpm run typecheck` (turbo, całe repo) | 0 | 30/30 |
| `pnpm run build` (turbo, całe repo) | 0 | 23/23 |
| `pnpm exec eslint packages/implementation-tools/{src,test}` | 0 | PASS; tylko preexistujące warnings `boundaries` |
| `pnpm exec prettier --check` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| `git diff --check` | 0 | PASS |

### Mutation testing koordynatora

Zielone testy nie są dowodem — w `HANDOFF-01` RA-016 cała luka współbieżności była
zielona. Dlatego każdy istotny mechanizm został celowo zepsuty:

| Mutacja | Wynik |
|---|---|
| `ON CONFLICT DO NOTHING` → `DO UPDATE` (WU-02) | 7 testów FAIL |
| usunięcie fence'u `status = 'INTENT_RECORDED'` w `settle` (WU-02) | 1 test FAIL |
| kolidujący eksport **type-only** `ResolvedToolScope` (WU-01B) | test przecięcia FAIL |
| `catch { refuse() }` → cichy `succeed` (WU-03) | 8 testów FAIL |
| zwinięcie `PARTIAL_WRITE` w `FAILED` (WU-04) | 6 testów FAIL |
| nierozstrzygnięty `INTENT_RECORDED` → `SUCCEEDED` (WU-04) | 1 test FAIL |

Po każdej mutacji plik przywracano z kopii i potwierdzano hashem oraz ponownym
przebiegiem suite.

**Istotna obserwacja z mutacji WU-01B:** dodanie kolidującego eksportu type-only
nie powoduje żadnego błędu kompilacji — `typecheck` i `build` pozostają zielone, a
skan runtime go nie widzi. Wyłapuje go tylko test oparty na `ts.Program` +
`checker.getExportsOfModule()`. Zapisane w `CTF-002`.

## Bezpieczeństwo i dane

- Kod pakietu nie ma dostępu do `child_process` ani sieci; cały dostęp do dysku w
  `read-tools.ts` jest delegowany (zero bezpośrednich wywołań `fs` — sprawdzone
  `grep`em).
- Output narzędzi jest przypięty do `UNTRUSTED_DATA` na poziomie schematu.
- Komunikaty typed błędów nie trafiają do modelu — przenoszony jest tylko `code`,
  bo `message` zawiera absolutne host paths.
- Nie wykonano push, MR, commitu ani żadnego external write.

## Znane ograniczenia i ryzyka

- **`CTF-006` (HIGH, otwarty):** `SecretRedactor` przepuszcza host paths,
  `glpat-`, `AKIA`, klucze prywatne i JWT, a jest używany m.in. w
  `agent-orchestrator/src/context/compaction.ts` do budowy kontekstu modelu.
  `WU-05` został ostrzeżony, by nie polegać na nim wyłącznie. Domknięcie należy do
  RA-024 i dotyka pakietów `DONE`.
- **`CTF-004`:** `packages/implementation-tools` nie ma `tsconfig.test.json`, więc
  jego testy nie są objęte `typecheck` (wzór dzielony z 5 innymi pakietami bez
  pokrycia). Znany, zaobserwowany objaw: `ledger.integration.test.ts` kompilowany
  osobno daje 3 błędy `src`-vs-`dist` dla `Database`.
- `config` dzieli `ToolKind.READ_FILE` z `read`; rozróżnienie po polu `tool` w
  payloadzie. Sprawdziłem, że ledger nie kluczuje po `kind` (brak w `WHERE`/`ON
  CONFLICT`), więc ryzyko nie materializuje się.
- `patch.ts` celowo nie tworzy katalogów — brakujący rodzic daje czysty
  pre-flight `FAILED`. Zdolność `mkdir` dostarcza `WU-06`.

## Otwarte pytania

1. **Los `command.ts` z przerwanego `WU-05`** — dokończyć unit czy odrzucić plik i
   uruchomić od nowa? Rekomendacja koordynatora: **uruchomić od nowa** z context
   packiem rozstrzygającym dostęp do `@remoteagent/observability` (albo dodać go do
   `dependencies` w allowliście, albo jawnie zabronić i wskazać alternatywę).
   Plik bez testu i bez raportu nie ma wartości dowodowej.
2. **Priorytet `CTF-006`** — domykać w RA-024 zgodnie z planem, czy jako fix teraz?
   Pytanie zadane właścicielowi, bez odpowiedzi w chwili pauzy.

## Stan dla wznowienia

- Co jest gotowe: `WU-01`, `WU-01B`, `WU-02`, `WU-03`, `WU-04` — zaakceptowane,
  zweryfikowane niezależnie i potwierdzone mutation testingiem.
- Co zrobić najpierw po wznowieniu:
  1. usunąć `test/zz-tmp-probe.test.ts` (sonda implementera poza allowlistą) oraz
     zdecydować o `test/zz-coord-probe.test.ts` i
     `packages/database/test/zz-coord-probe.test.ts` (sondy koordynatora);
  2. rozstrzygnąć los `src/command.ts` (punkt 1 w Otwartych pytaniach);
  3. dokończyć `WU-05`, potem `WU-06` i `WU-07`;
  4. dopiero wtedy handoff `HANDOFF-02` do bramki audytowej i `AWAITING_AUDIT`.
- Czego nie robić: nie commitować WIP, nie ustawiać `AWAITING_AUDIT` przed
  domknięciem `WU-07`, nie przyjmować `command.ts` bez testu i raportu.
