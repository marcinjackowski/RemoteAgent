# Rejestr findingów przekrojowych

Ten plik zbiera findingi, które **nie należą do jednego taska** i dlatego nie mają
naturalnego miejsca w `docs/audits/<TASK_ID>/AUDIT-NN.md`. Powstają zwykle, gdy
audyt jednego taska ujawnia defekt w innym, wcześniej zaakceptowanym pakiecie.

Zasady:

- wpis nie zmienia statusu żadnego taska ani nie zastępuje audytu;
- każdy wpis ma severity, dowód, wpływ i wymaganą zmianę;
- wpis zostaje zamknięty dopiero, gdy odpowiedni task go domknie — wtedy
  odnotowujemy, który audyt to potwierdził;
- findingi należące do jednego taska trafiają do jego audytu, nie tutaj.

Format ID: `CTF-<NNN>`.

## Dlaczego ten rejestr jest bramką, nie notatnikiem

`RA-026` AC2 wymaga **braku otwartych findingów BLOCKER/HIGH/MEDIUM**, a AC3 — by
każdy znany LOW miał ownera i decyzję `accept/fix/defer`. Wpisy poniżej nie są więc
listą życzeń: każdy otwarty MEDIUM blokuje końcowe `PASS` całego projektu, a każdy
LOW musi mieć jawną decyzję przed odbiorem. Ustalone przy planowaniu RA-026
(`2026-08-20`).

### Stan zbiorczy

| ID | Severity | Status | Domknięcie zaplanowane w |
|---|---|---|---|
| `CTF-001` | MEDIUM | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-023 | `RA-023-WU-00`; jedna definicja w `contracts` |
| `CTF-002` | MEDIUM | **CZĘŚCIOWO** — `packageName` 5/6 otwarte; RA-022 dodał dowód, że sonda wartościowa NIE wystarcza | `RA-012-WU-01B` wykonany; guardrail `CTF-002-U1` otwarty i **pilniejszy** |
| `CTF-005` | MEDIUM | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-022 | migracje `029`+`030`, fencing w `WU-02` |
| `CTF-006` | HIGH | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-024 | `RA-024-WU-01`; jedna tabela w `observability`, trzy konsumenty |
| `CTF-003` | LOW | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-018 | naprawiony w `cfc3a15` |
| `CTF-004` | LOW | **CZĘŚCIOWO** — połowa src-vs-dist rozstrzygnięta w RA-024 | `tsconfig.test.json` dla 6 pakietów nadal otwarte |
| `CTF-007` | LOW | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-018 | naprawiony w `cfc3a15`; miał za sobą realny defekt produkcyjny |
| `CTF-011` | LOW | **ZAMKNIĘTY dla RA-018** — wzorzec otwarty | bramka mogła przejść na starym buildzie |
| `CTF-008` | LOW | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-024 | `RA-024-WU-00`; `argsIgnorePattern` + dwie poprawki |
| `CTF-012` | LOW | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-024 | zdiagnozowany: `ON CONFLICT` pokrywał jeden z dwóch unique constraintów |
| `CTF-010` | LOW | **ADRESOWANY procesowo** (ADR-0007) | wzorzec: komentarz != zachowanie; 5 defektów HIGH |
| `CTF-009` | LOW | OTWARTY — mechanizm domknięty w RA-012 | `isForbiddenPath` nie zna plików instrukcji; RA-015/RA-021 |
| `CTF-013` | MEDIUM | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-024 | `RA-024-WU-00`; przyczyna: instantiation expression w `Parameters<>` |
| `CTF-014` | LOW | OTWARTY — decyzja `defer`, wymaga ADR | push brancha case'a nie przechodzi przez `ACTION_REGISTRY`; wykryty `RA-024-WU-04` |
| `CTF-015` | LOW | OTWARTY — decyzja `accept` | sześć nowych kolizji type-level poza `packageName`; nieosiągalne, wzmacniają `CTF-002-U1` |

---

## `CTF-001` — dwie różne klasy `CredentialRefreshConflictError` / `CredentialRefreshIdentityError`

- Severity: **MEDIUM**
- Wykryty: `2026-08-20`, podczas planowania RA-013/RA-017 (audyt przekrojowy
  eksportów, nie zgłoszony przez żadnego implementera)
- Dotyczy: `packages/database`, `packages/policy` (RA-003, RA-005)
- Status: **ZAMKNIĘTY** `2026-08-21` — potwierdzony `AUDIT-01` RA-023

### Dowód

Dwie niezależne definicje o tej samej nazwie i różnych klasach bazowych:

- `packages/database/src/errors.ts:147` — `class CredentialRefreshConflictError
  extends PersistenceError`
- `packages/policy/src/credential-refresh.ts:13` — `class
  CredentialRefreshConflictError extends Error`

Sonda na zbudowanym `dist/` obu pakietów:

```text
ta sama klasa?                              false
policy err instanceof database.Error?       false
policy err instanceof policy.Error?         true
database baza: PersistenceError
policy   baza: Error
```

To samo dotyczy `CredentialRefreshIdentityError`.

### Wpływ

Kod, który łapie błąd przez `instanceof` importowany z „drugiego" pakietu, **nie
złapie** błędu rzuconego przez pierwszy — `catch` po cichu nie zadziała i błąd
poleci wyżej jako nieobsłużony. Obecnie nieosiągalne w produkcji:
`packages/policy/src/credential-refresh.ts` nie importuje
`@remoteagent/database`, więc oba światy się nie spotykają. Ryzyko materializuje
się, gdy warstwa wyżej (kandydaci: RA-021 MCP broker, RA-022 policy/approvals,
RA-023 AgentCore) zacznie konsumować oba pakiety i łapać te błędy.

Osobno: przy re-eksporcie oba w jednym barrelu (`export *` z obu) ESM **cicho
usuwa** niejednoznaczną nazwę — patrz `CTF-002`.

### Wymagana zmiana

Jedna definicja jako źródło prawdy. Rekomendacja: `packages/policy` przestaje
definiować własne klasy i albo importuje je z `@remoteagent/database`, albo nadaje
im odrębne, jednoznaczne nazwy (`CredentialPublishConflictError`), jeśli semantyka
jest faktycznie inna. Wymaga własnego unitu w tasku, który jako pierwszy dotknie
tej granicy — nie należy tego robić „po drodze" w niepowiązanym tasku.

**Ustalone przy planowaniu RA-023 (`2026-08-20`): tym taskiem jest RA-023.** Spina
on warstwę credentiali (`packages/policy`) z resztą systemu, więc oba światy się
tam spotkają. Ujęte jako `RA-023-WU-00` — pierwszy unit tego taska, przed
jakąkolwiek pracą nad Gateway.

### Domknięcie (`2026-08-21`) — potwierdzone `AUDIT-01` RA-023 `PASS`

**Żadna z dwóch rekomendacji tego wpisu nie była wykonalna w zapisanej formie**, i to
jest najużyteczniejsza część domknięcia:

1. „`packages/policy` importuje z `@remoteagent/database`" — **niemożliwe**.
   `packages/database` devDependuje na `@remoteagent/policy` dla własnych testów, więc
   krawędź w tę stronę czyni graf turbo cyklicznym i `build` odmawia startu. Zmierzone w
   RA-022-WU-01, nie założone.
2. „odrębne, jednoznaczne nazwy (`CredentialPublishConflictError`), **jeśli semantyka
   jest faktycznie inna**" — semantyka jest **identyczna**. Oba conflict errors znaczą
   „przegrany wyścig optimistic-concurrency", oba identity errors „to samo
   `operationId` przy innej niezmiennej tożsamości". Dwie nazwy na jedno znaczenie
   utrwaliłyby duplikat i utrudniły jego zobaczenie.

Wykonane: **jedna definicja w `packages/contracts/src/credential-refresh-errors.ts`**,
pakiecie, od którego oba już zależą — więc nie powstaje żadna nowa krawędź w grafie.
`contracts` niesie już sześć przekrojowych klas błędów, więc jest naturalnym hostem.

`PersistenceError` **nie** został odtworzony jako baza: refresh conflict jest wynikiem
domenowym, nie awarią persystencji, a nic w repozytorium nie łapie tych klas przez
`PersistenceError` (sprawdzone `grep`em, nie założone).

Dowód domknięcia — sonda z tego wpisu, uruchomiona ponownie:

```text
same class across contracts/database/policy?   true
policy-thrown instanceof database's import?    true
sonda wartościowa:   CredentialRefresh* NIEOBECNE
sonda type-level:    CredentialRefresh* NIEOBECNE
```

**Domknięte razem z tym: `RefreshIntentStatus`** (database ↔ policy), kolizja type-only
wykryta w bramce RA-022 i odnotowana wtedy jako nowa. Był to ten sam defekt na tej samej
granicy, więc został naprawiony w tym samym miejscu.

Finding sondy adwersarialnej przy domykaniu: `this.name` przypisany z **literału**
powodował, że subklasa raportowała nazwę rodzica — czyli przyszły węższy błąd byłby
nieodróżnialny od bazowego w każdej linii logu i każdym branchu po `name`. Naprawione na
`new.target.name`, co zachowuje też poprzednie zachowanie klas `policy`.

---

## `CTF-002` — ESM cicho usuwa niejednoznaczne nazwy z `export *`

- Severity: **MEDIUM** (mechanizm), **LOW** obecnie (nieosiągalne)
- Wykryty: `2026-08-20`, podczas planowania dalszych units RA-012
- Dotyczy: wszystkich pakietów z barrelem `export *`
- Status: **CZĘŚCIOWO ADRESOWANY** — dla RA-012 przez `RA-012-WU-01B`

### Dowód

Sonda ESM (dwa moduły eksportujące tę samą nazwę, jeden barrel z dwoma
`export *`):

```text
eksporty barrela: [ 'onlyA', 'onlyB' ]
toolIntent obecny? false
```

Nazwa znika **bez błędu kompilacji**. Skan realnych kolizji (różne wartości pod tą
samą nazwą) w zbudowanych pakietach:

```text
toolIntent                      <- contracts, implementation-tools
toolResult                      <- contracts, implementation-tools
CredentialRefreshConflictError  <- database, policy        (CTF-001)
CredentialRefreshIdentityError  <- database, policy        (CTF-001)
packageName                     <- database, discord, agent-orchestrator,
                                   observability, policy, connector-jira
```

Pozostałe współdzielone nazwy (`AgentRole`, `repositoryProfile`, `planner*`,
`TrustLevel`, `schemaVersion`, `eventEnvelope`, …) są **legalnymi re-eksportami
tej samej wartości** — ESM ich nie usuwa i nie stanowią defektu. To rozróżnienie
jest istotne: sam skan po nazwach daje fałszywe alarmy.

### Domknięcie części RA-012 (`2026-08-20`)

`RA-012-WU-01B` wykonany i zweryfikowany niezależnie przez koordynatora.
`implementation-tools` eksportuje teraz `implementationToolIntent` /
`implementationToolResult` (wraz z wariantami unii), a `@remoteagent/contracts`
pozostał nietknięty. Ponowny przebieg sondy koordynatora po zmianie:

```text
CredentialRefreshConflictError  <- database, policy      (CTF-001, nadal otwarte)
CredentialRefreshIdentityError  <- database, policy      (CTF-001, nadal otwarte)
packageName                     <- database, discord, agent-orchestrator,
                                   observability, policy, connector-jira
```

`toolIntent`/`toolResult` zniknęły z listy realnych kolizji.

**Ważna obserwacja z mutation testingu koordynatora:** dodanie kolidującego
eksportu **type-only** (`export type ResolvedToolScope = …`) nie powoduje żadnego
błędu kompilacji — `typecheck` i `build` pozostają zielone. Skan runtime
(`Object.keys`) też go nie widzi, bo typ nie ma wartości. Wyłapał go dopiero test
oparty na `ts.Program` + `checker.getExportsOfModule()`, dodany w tym unicie.
To uzasadnia, dlaczego guardrail (`CTF-002-U1`) musi używać type-checkera, a nie
skanu wartości: najcichsza wersja tego błędu jest niewidoczna dla obu prostszych
metod.

### Wpływ

- `toolIntent`/`toolResult`: **domknięte** przez `RA-012-WU-01B` (patrz wyżej),
  przed tym jak cokolwiek zaczęło konsumować `implementation-tools` (`grep` na
  konsumentów był pusty).
  **Ustalone przy planowaniu RA-021 (`2026-08-20`): RA-021 jest taskiem, w którym
  ta kolizja przestaje być teoretyczna.** RA-021 konsumuje
  `contracts.toolIntent`/`resolvedToolIntent` (broker), a RA-012 wystawia własne
  `toolIntent` o innym kształcie. Dlatego `RA-012-WU-01B` jest **warunkiem wejścia
  do RA-021**, nie kosmetyką — wpisany jako zależność `RA-021-WU-01`. Jeśli RA-021
  wystartuje przed nim, jest to blokada, nie detal do naprawy po drodze.
- `packageName`: sześć pakietów eksportuje własny literał `packageName` (relikt
  szkieletów z RA-001). Nieszkodliwe dopóki nikt nie robi wspólnego barrela nad
  wieloma pakietami, ale to śmieć w publicznym API — kandydat do usunięcia przy
  okazji taska dotykającego danego pakietu.

### Wymagana zmiana

1. `RA-012-WU-01B` — jednoznaczne nazwy w `implementation-tools` (zaplanowane).
2. **Guardrail zamiast ręcznej sondy.** Repo ma już mechanizm guardrails
   (`test/guardrails/guardrails.test.ts`) dowodzący, że bramki compile-time są
   faktycznie egzekwowane — uruchamia prawdziwe narzędzia na celowo zepsutych
   fixture'ach. Kolizja eksportów należy do tej samej klasy problemu i powinna być
   wyłapywana automatycznie, a nie ręczną sondą koordynatora przy każdym tasku.
   Proponowany guardrail: zaimportować barrele wszystkich zbudowanych pakietów,
   zebrać nazwy eksportów i asertować, że żadna nazwa nie występuje w dwóch
   pakietach z **różnymi wartościami** (re-eksport tej samej wartości jest legalny
   i nie może dawać fałszywego alarmu — to rozróżnienie jest istotą tego
   guardraila). Wymaga zbudowanego `dist/`, więc musi zależeć od `build` albo
   budować w locie. Ujęte jako `CTF-002-U1` do zakolejkowania w najbliższym tasku
   dotykającym infrastruktury testowej; do jego wykonania obowiązuje sonda ręczna
   w final task gate (wpisana do planów DRAFT RA-013, RA-014, RA-015, RA-017).
3. `packageName` i `CTF-001` — osobne, drobne unity w odpowiednich taskach.

---

## `CTF-003` — niedeterministyczny flake `process-runner` timeout race

- Severity: **LOW**
- Wykryty: `2026-08-20`, podczas audytu RA-016 (pełne przebiegi repo)
- Dotyczy: `packages/workspace-runner` (RA-010)
- Status: **OTWARTY**
- Pełny opis: `docs/audits/RA-016/AUDIT-02.md`, sekcja „Preexistujący flake poza
  zakresem RA-016"

### Dowód

`packages/workspace-runner/test/process-runner.test.ts` → „kills the process tree
on timeout and reports the timeout" failuje niedeterministycznie w pełnym
przebiegu repo: `ENOENT … child.pid`. Zmierzone: 1 fail na 4 pełne przebiegi;
6/6 PASS solo; nie reprodukuje się pod sztucznym obciążeniem CPU (24 procesy
busy-loop, 3 przebiegi zielone). Plik jest tracked i niezmieniony.

### Wpływ

Bramka „całe repo zielone" jest niestabilna, co obniża wartość dowodową każdego
przyszłego handoffu — zielony przebieg przestaje być rozstrzygający, a czerwony
wymaga każdorazowego dochodzenia. Nie wpływa na poprawność produkcyjną.

### Wymagana zmiana

Test ma `timeoutMs: 100` i wymaga, by proces wnuk zdążył zapisać `child.pid`
przed zabiciem drzewa procesów. Poprawka: poczekać na powstanie pliku przed
asercją (polling z własnym, dłuższym budżetem) albo rozdzielić „proces zabity"
od „wnuk zdążył wystartować" na dwie asercje.

**Zaplanowane `2026-08-20` jako `RA-010-WU-11`** (`READY`, plan revision `22`).
Uwaga proceduralna zapisana w tym unicie: RA-010 jest `DONE` z `AUDIT-02` `PASS`,
więc zmiana jego kodu wymaga przejścia pełnego cyklu
`IN_PROGRESS` → `HANDOFF-03` → `AWAITING_AUDIT` → `AUDIT-03` → `DONE`. Nie wolno
wprowadzić poprawki do zamkniętego taska bez ponownego audytu — a
`workflow:validate` i tak by to wykrył, bo dla `DONE` wymaga
`rewizja_audytu ≥ rewizja_handoffu`.

Kolejność: `RA-010-WU-11` powinien iść **przed** finalnymi bramkami RA-018 i
RA-026, bo oba opierają dowodowość na „całe repo zielone". Nie musi wyprzedzać
RA-012, który ma własne, deterministyczne bramki pakietowe.

---

## `CTF-006` — dwa rozjechane zestawy wzorców sekretów; mocniejszy jest prywatny

- Severity: **HIGH** (podniesione z MEDIUM po ustaleniu, że ścieżka jest osiągalna
  w już zaakceptowanym kodzie — patrz „Osiągalność" niżej)
- Wykryty: `2026-08-20`, podczas planowania `RA-012-WU-05`
- Dotyczy: `packages/observability/src/redaction.ts` (RA-024 scope),
  `packages/repository-planner/src/profile.ts` (RA-011, `DONE`),
  `packages/agent-orchestrator/src/context/compaction.ts` (RA-008/RA-009, `DONE`)
- Status: **OTWARTY**

### Dowód

`SecretRedactor` (`packages/observability`) jest mechanizmem redakcji dla logów,
błędów i telemetrii — i to jego wskazują plany RA-012-WU-05, RA-017, RA-019 i
RA-024. Sonda koordynatora na zbudowanym `dist/`:

```text
NIE ZREDAGOWANO: "error at /Users/marcinjackowski/Private/RemoteAgent/pac…"
NIE ZREDAGOWANO: "cwd=/home/runner/work/secret-project"
zredagowano:      "Bearer abcdefghijklmnop"
NIE ZREDAGOWANO: "glpat-ABCDEFGHIJKLMNOPQRST"
NIE ZREDAGOWANO: "AKIAIOSFODNN7EXAMPLE"
NIE ZREDAGOWANO: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow=="
NIE ZREDAGOWANO: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
```

Równolegle `packages/repository-planner/src/profile.ts` (funkcja `unsafeString`,
zaakceptowana w RA-011) **ma** wszystkie brakujące wzorce: host paths
(`/Users/`, `/home/`, `/tmp/`, `/private/`, `C:\`, `file://`),
`-----BEGIN … PRIVATE KEY-----`, JWT (`eyJ…`), `glpat-`, `gh[pousr]_`, `AKIA`.
Jest jednak **prywatna** — nie ma jej w `packages/repository-planner/src/index.ts`.

### Wpływ

Warstwy planowane w RA-012/RA-017/RA-019/RA-024 mają redagować output narzędzi,
błędy REST i telemetrię przez `SecretRedactor`. W obecnym kształcie przepuści on:

- **absolutne host paths** — output komendy (`RA-012-WU-05`) i komunikaty błędów
  są ich pełne, a to wyciek topologii hosta do kontekstu modelu;
- **tokeny GitLab (`glpat-`) i AWS (`AKIA`)** — istotne dokładnie w RA-017;
- **klucze prywatne i JWT**.

`Bearer`/`Basic`, wrażliwe klucze obiektów i URL-e z hasłem są pokryte, więc
mechanizm nie jest bezwartościowy — jest niekompletny w sposób, który łatwo
przeoczyć, bo „redakcja jest włączona".

### Osiągalność — ścieżka istnieje w zaakceptowanym kodzie

Pierwotnie oceniłem to na MEDIUM, zakładając, że warstwy konsumujące jeszcze nie
istnieją. **To było błędne.** Skan konsumentów pokazał pięć realnych miejsc:

```text
packages/discord/src/status.ts
packages/discord/src/dispatcher.ts
packages/agent-orchestrator/src/recovery.ts
packages/agent-orchestrator/src/context/compaction.ts     <-- kontekst modelu
packages/agent-orchestrator/src/checkpoint/render.ts
```

`packages/agent-orchestrator/src/context/compaction.ts:149` buduje **kontekst
przekazywany modelowi** i redaguje treść źródeł przez:

```ts
const redactor = new SecretRedactor();          // brak knownSecrets
const safe = redactor.redactString(source.content);
```

Konstruktor bez `knownSecrets` opiera się wyłącznie na `INLINE_PATTERNS`, które —
jak wykazała sonda — nie zawierają host paths, `glpat-`, `AKIA`, kluczy prywatnych
ani JWT. Skoro źródła kontekstu obejmują treść repozytorium i wyniki narzędzi,
absolutna ścieżka hosta albo token GitLaba w pliku przechodzi do kontekstu modelu
mimo włączonej redakcji.

To czyni finding **osiągalnym w kodzie już zaakceptowanym** (RA-008/RA-009 są
`DONE`), a nie tylko ryzykiem dla przyszłych tasków — stąd HIGH. Konsekwencja
proceduralna: RA-024 AC2 („canary secrets/PII nie pojawiają się w logs, traces ani
model context") nie może zostać zaliczone na obecnym mechanizmie, a domknięcie
dotyka pakietów `DONE`, więc wymaga pełnego cyklu audytowego.

Nie oceniam tego jako BLOCKER, bo redakcja nie jest jedyną warstwą obrony:
`repository-planner` niezależnie **odrzuca** profile zawierające host paths i
tokeny (`unsafeString`, fail-closed), a treść repozytorium jest oznaczona
`UNTRUSTED_DATA`. Ryzykiem jest wyciek do kontekstu/logów, nie eskalacja
uprawnień.

### Wymagana zmiana

Jedno źródło prawdy dla wzorców sekretów. Rekomendacja: przenieść zestaw z
`unsafeString` do `packages/observability` (naturalny właściciel redakcji) i
rozszerzyć `INLINE_PATTERNS` o host paths, `glpat-`/`gh*_`/`AKIA`, klucze prywatne
i JWT; `repository-planner` konsumuje wspólny zestaw zamiast trzymać własny.
Uwaga na dwa różne cele: `unsafeString` **odrzuca** wartość (fail-closed w
profilu), a `SecretRedactor` **maskuje** ją — wspólny powinien być zestaw wzorców,
nie polityka reakcji.

Zakres: `packages/observability` + `packages/repository-planner` (który jest
`DONE`, więc zmiana jego kodu wymaga pełnego cyklu audytowego, jak w `CTF-003`).
Najwłaściwszy właściciel: **RA-024** (hardening telemetrii). Do tego czasu każdy
unit polegający na redakcji musi w teście canary jawnie sprawdzać host paths i
tokeny providerów, nie zakładając, że `SecretRedactor` je pokrywa.

### Decyzja właściciela (`2026-08-20`)

Domknięcie **zostaje w RA-024**, zgodnie z planem; nie robimy fixu teraz. Podstawa:
finding nie jest BLOCKER-em (`repository-planner` odrzuca host paths fail-closed,
treść repo jest `UNTRUSTED_DATA`, ryzykiem jest wyciek do kontekstu/logów, nie
eskalacja uprawnień), a fix dotyka pakietów `DONE`, więc przerwałby M2 pełnym
cyklem audytowym.

Konsekwencje, które muszą obowiązywać do RA-024:

1. Żaden unit nie zalicza kryterium redakcji wyłącznie na `SecretRedactor`.
2. `RA-012-WU-05` dostaje **lokalną** tabelę wzorców (host paths, `glpat-`, `AKIA`,
   klucze prywatne, JWT) i jawny komentarz, że jest to stan przejściowy.
   **Wykonane `2026-08-20`** (commit `8680050`): `redactCommandOutput` w
   `packages/implementation-tools/src/command.ts`, oznaczone `Transitional` ze
   wskazaniem na ten finding. Test canary sprawdza host paths i tokeny providerów
   jawnie, nie polegając na `SecretRedactor`. To **trzecie** miejsce z własnym
   zestawem wzorców — zakres RA-024 obejmuje je razem z pozostałymi dwoma.
3. Zakres domknięcia w RA-024 obejmuje **również** zwinięcie tej lokalnej tabeli z
   `implementation-tools` do wspólnego zestawu — inaczej RA-024 ujednolici dwa
   miejsca, zostawiając trzecie.
4. RA-024 AC2 („canary secrets/PII nie pojawiają się w logs, traces ani model
   context") nie może zostać zaliczone na obecnym mechanizmie.

### Domknięcie (`2026-08-21`) — potwierdzone `AUDIT-01` RA-024 `PASS`

Wykonane w `RA-024-WU-01`. Jedna tabela w
`packages/observability/src/secret-patterns.ts`; **wszystkie trzy** konsumenty
delegują do niej:

| Miejsce | Przed | Po |
|---|---|---|
| `SecretRedactor` | `INLINE_PATTERNS` (5 wzorców) | `maskSecretShapes` |
| `unsafeString` (`repository-planner`) | prywatne 6 regexów | `containsSecretShape` |
| `redactCommandOutput` (`implementation-tools`) | lokalna tabela `Transitional` | `maskSecretShapes` |

**Rekomendacja tego wpisu została wykonana dokładnie**, w tym rozróżnienie polityki:
wspólny jest **zestaw wzorców**, nie reakcja. `SecretRedactor` **maskuje**,
`unsafeString` **odrzuca**. `containsSecretShape` jest zaimplementowane jako „czy
maskowanie zmienia wartość?", więc obie połowy **nie mogą** się rozjechać co do
definicji sekretu — a to właśnie sposób, w jaki trzy tabele się rozjechały.

Oba obstacles z RA-012-WU-05 zniknęły: `@remoteagent/observability` jest teraz
zadeklarowaną zależnością obu konsumentów, a wspólna tabela pokrywa **nadzbiór**
tego, co miały kopie lokalne. Dodane kształty, których nie znała **żadna** z trzech:
Google OAuth (`1//`, `ya29.`) — trzymane przez dwa Gmaile i dwa Calendary,
fine-grained GitHub PAT, tokeny Slacka, **nieterminowany** nagłówek PEM (streamowany
albo obcięty log to normalna droga, którą to przychodzi) i więcej rootów ścieżek.

Sonda z tego wpisu, uruchomiona ponownie jako **test**
(`packages/observability/test/secret-patterns.test.ts`) — każdy string, przy którym
ten wpis notował `NIE ZREDAGOWANO`:

```text
absolute macOS host path        zredagowano
absolute linux host path        zredagowano
glpat-                          zredagowano
AKIA                            zredagowano
PEM private key                 zredagowano
JWT                             zredagowano
Bearer (regresja)               zredagowano
```

Mutation check, 7 mutacji, każda czerwona i przywrócona do zielonego: usunięcie
wzorca host-path, provider-token, PEM i JWT; zdjęcie flagi `g` (maskowanie tylko
pierwszego wystąpienia); `containsSecretShape` → `false`; `maskSecretShapes` →
identyczność.

AC2 sprawdzone **osobno dla trzech sinków** (`test/security/canary.test.ts`, 111
testów): logi, traces i kontekst modelu, plus output komendy jako czwarta
powierzchnia. Jeden przypadek używa `ya29.` — kształtu, którego **nie miała żadna** z
trzech pierwotnych tabel: sink trzymający własną kopię wyglądałby na zredagowany dla
starych kształtów i przepuściłby ten.

Osiągalność z tego wpisu domknięta wprost: `compaction.ts` konstruuje
`SecretRedactor` **bez** `knownSecrets`, więc test asertuje, że konstrukcja
bezargumentowa maskuje wszystkie kanarki — bezpieczna, nie „mniej niebezpieczna".

### Dowód z RA-022 (`2026-08-21`) — sonda wartościowa przepuściła cztery kolizje

Najmocniejszy dotychczasowy argument za guardrailem `CTF-002-U1`, bo tym razem
kolizje **powstały w trakcie taska** i przeszły przez wszystkie zwykłe bramki.

`packages/policy/src/ingestion-ports.ts` restated cztery typy, które
`packages/database` też eksportuje: `ApprovalRow`, `ApprovalGrantOutcome`,
`ApprovalConsumption`, `ExternalActionRow` (plus `Transaction`). Wynik sond w final
task gate:

```text
sonda WARTOŚCIOWA (Object.keys na dist/):   tylko preexistujące CTF-001/CTF-002
turbo run typecheck --force:                36 successful, 0 errors
pnpm run build --force:                     26 successful
sonda TYPE-LEVEL (ts.Program):              ApprovalRow, ApprovalGrantOutcome,
                                            ApprovalConsumption, ExternalActionRow,
                                            Transaction  <- database, policy
```

Czyli: trzy bramki zielone, jedna sonda czerwona. Typ nie ma wartości, więc
`Object.keys` go nie widzi, a ESM usuwa niejednoznaczną nazwę z połączonego barrela
**bez błędu kompilacji**. Naprawione prefiksem `Policy*`
(`PolicyApprovalRow`, `PolicyTransaction`, …), zgodnie z rekomendacją tego wpisu.

Przy okazji ujawniona **nowa preexistująca** kolizja, wcześniej nieodnotowana:
`RefreshIntentStatus` (`database` ↔ `policy`). Należy do `CTF-001`, bo dotyczy tej
samej granicy credentiali — domknięcie w `RA-023-WU-00`.

Wniosek operacyjny: dopóki `CTF-002-U1` nie istnieje, **final task gate musi
uruchamiać sondę type-level, nie tylko wartościową.** Sonda wartościowa daje
fałszywe poczucie bezpieczeństwa dla typów, a to najczęstszy kształt tej kolizji.

---

## `CTF-005` — `approvals` nie wiąże zgody z rewizją checkpointu

- Severity: **MEDIUM**
- Wykryty: `2026-08-20`, podczas planowania RA-022
- Dotyczy: `packages/database/migrations/008_actions_approvals_receipts.up.sql`,
  `packages/contracts/src/external-action.ts` (RA-003, RA-008)
- Status: **OTWARTY** — kształt rozstrzygnięty przez właściciela `2026-08-20`,
  wykonanie należy do RA-022

### Decyzja właściciela (`2026-08-20`)

Rozszerzyć tabelę `approvals` nową migracją o `checkpoint_revision`, **bez**
osobnego grant/use ledgera. Warunek przyjęty razem z decyzją: **backfill jest
fail-closed** — istniejące, niezużyte zgody bez rewizji zostają unieważnione, a nie
uznane za ważne. Uzasadnienie wyboru: jedno źródło prawdy o zgodzie i mniejszy blast
radius w RA-022 niż utrzymywanie spójności między dwiema tabelami.

Konsekwencje dla planów: `RA-022-WU-*` traci Decision Request na starcie i zaczyna
od migracji rozszerzającej `approvals` plus aktualizacji kontraktu `approval` w
`packages/contracts/src/external-action.ts`. Zmiana dotyka schematu zaakceptowanego
w RA-003/RA-008, więc wymaga pełnego cyklu audytowego w ramach RA-022 — nie jest
doczepką do innego taska. Plan RA-022 (`DRAFT`) zostanie zrewidowany przy starcie
taska; ten wpis jest źródłem prawdy do tego czasu.

### Dowód

Tabela `approvals` (migracja `008`) ma kolumny: `approval_id`, `case_id`,
`granted_by`, `action_digest`, `granted_at`, `expires_at`, `consumed`,
`consumed_at`, `updated_at`, oraz CHECK-i `approvals_expiry_after_grant` i
`approvals_consumed_consistent`. **Nie ma żadnej kolumny wiążącej zgodę z rewizją
checkpointu.** Kontrakt `approval` w `external-action.ts` również jej nie zawiera.

Tymczasem RA-022 AC2 wymaga wprost, by approval „odrzucał stale checkpoint
revision", a audit focus tego taska wskazuje TOCTOU między approval i execute jako
główne ryzyko.

### Wpływ

Approval udzielony, gdy stan case był w rewizji `N`, pozostaje formalnie ważny po
zmianie stanu do `N+1`. Wiązanie przez `action_digest` chroni przed **zmianą
payloadu akcji**, ale nie przed zmianą **kontekstu**, w którym właściciel wyrażał
zgodę. Obecnie nieosiągalne, bo executor z RA-022 nie istnieje — ale to luka w
zaakceptowanym schemacie, nie w kodzie, który jeszcze nie powstał, więc nie
zniknie sama.

### Wymagana zmiana

Rozstrzygnąć jako Decision Request na starcie RA-022 (opis opcji w
`docs/work-units/RA-022/WORK_UNITS.md`): rozszerzyć `approvals` nową migracją o
`checkpoint_revision` (rekomendacja koordynatora, o ile backfill jest
fail-closed — istniejące niezużyte zgody unieważnić, nie uznać za ważne), albo
utworzyć osobny grant/use ledger z jasno wskazaną authority. Decyzja należy do
właściciela, bo zmienia schemat zaakceptowany w RA-003/RA-008.
**Rozstrzygnięte `2026-08-20`** — patrz „Decyzja właściciela" wyżej: wybrano
rozszerzenie `approvals` z fail-closed backfillem.

### Domknięcie (`2026-08-21`) — potwierdzone `AUDIT-01` RA-022 `PASS`

Zaimplementowane: migracja `029` (`checkpoint_revision`, `owner_id`, fail-closed
backfill) w `WU-01`, fencing consumption na rewizji w `WU-02`, oraz migracja `030`,
która zamraża `checkpoint_revision` granta — bez niej jeden `UPDATE` przestawiał
rewizję i obchodził cały mechanizm.

Przy implementacji ujawniło się, że sam `checkpoint_revision` nie wystarcza:
`cases.checkpoint_revision` jest licznikiem MUTOWALNYM, więc cofnięcie go
(recovery, restore, naprawa operatorska) wskrzeszało grant już odrzucony jako
`STALE_REVISION`. Domknięte w `WU-02` przez porównanie z append-only
`case_checkpoints` (najwyższa kiedykolwiek zapisana rewizja), nie z licznikiem.
Ten wariant nie był częścią pierwotnego opisu findingu i jest najważniejszą
nauką tego wpisu: **wiązanie z mutowalnym licznikiem nie jest wiązaniem.**
Monotoniczny fakt musi pochodzić z append-only źródła.

---

## `CTF-004` — `typecheck` pokrywa `test/**` tylko w 5 z 11 pakietów

- Severity: **LOW**
- Wykryty: `2026-08-20`, podczas audytu RA-016
- Dotyczy: 6 pakietów (lista niżej)
- Status: **OTWARTY**

> Korekta z `2026-08-20`: pierwotny zapis tego findingu brzmiał „w żadnym
> pakiecie" i był zbyt szeroki. Wzorzec **istnieje i jest podłączony** w pięciu
> pakietach; finding dotyczy jego niekompletnego rozszerzenia, co czyni go
> znacznie tańszym do domknięcia niż zakładałem.

### Dowód

Audyt wszystkich pakietów pod kątem `tsconfig.test.json`:

```text
MA:   contracts, database, discord, observability, policy
brak: workspace-runner, repository-planner, agent-orchestrator,
      connector-jira, implementation-tools, bedrock-runtime
```

Wzorzec jest ustalony i realnie podłączony do bramki — `packages/contracts`:

```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "rootDir": ".", "types": ["node"] },
  "include": ["src", "test"] }
```

```text
contracts:      "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit"
connector-jira: "typecheck": "tsc -p tsconfig.json --noEmit"
```

### Wpływ

W sześciu pakietach błąd typów w teście ujawnia się dopiero przy uruchomieniu
vitest, nie w bramce `typecheck`. Osłabia bramkę, nie kod produkcyjny.

Konkretny, już zaobserwowany przypadek: `packages/implementation-tools/test/ledger.integration.test.ts`
kompilowany osobno daje 3 błędy `TS2322`/`TS2345`, bo `Database` z
`packages/database/src` i z `dist` są strukturalnie różne (prywatne pole `pool`) —
test importuje harness ze `src`, a `@remoteagent/database` rozwiązuje się do
`dist`. Ten sam wzór ma zaakceptowany `connector-jira`. Nie jest to defekt tych
testów, ale pokazuje, że luka jest realna, a nie teoretyczna, i że domknięcie
findingu wymaga rozstrzygnięcia src-vs-dist, nie tylko dopisania plików.

### Wymagana zmiana

Dodać `tsconfig.test.json` do sześciu brakujących pakietów według istniejącego
wzorca i rozszerzyć ich skrypt `typecheck` o drugie wywołanie `tsc`. Osobno
rozstrzygnąć konflikt src-vs-dist dla testów importujących harness bazy — inaczej
nowo objęte pakiety od razu zaświecą się na czerwono. Zakres repozytorialny;
wymaga własnego unitu, nie doczepki do niepowiązanego taska.

---

## `CTF-007` — niedeterministyczny unhandled `57P01` przy teardownie pełnej suite

- Severity: **LOW**
- Wykryty: `2026-08-20`, podczas bramki przed commitem WIP (koordynator, nie
  implementer)
- Dotyczy: `packages/workspace-runner/test/fencing.integration.test.ts` oraz
  harnessu testowego bazy (`packages/database/test/harness.ts`)
- Status: **OTWARTY**

### Dowód

Pierwszy przebieg pełnej suite po usunięciu sond diagnostycznych:

```text
Test Files  115 passed (115)
     Tests  1182 passed (1182)
    Errors  1 error

Uncaught Exception: error: terminating connection due to administrator command
  code: '57P01', database: 'ra_test_841bf55c6a934f699d5da66fbb53e44f'
This error originated in "packages/workspace-runner/test/fencing.integration.test.ts"
```

Ten sam plik uruchomiony osobno: **2/2 zielone, exit `0`, dwa przebiegi z rzędu**.
Powtórzony pełny przebieg całego repozytorium: **exit `0`, 115 plików, 1182 testy,
zero błędów**. Wniosek: race przy teardownie między workerami vitest, nie defekt
kodu produkcyjnego. `57P01` oznacza `DROP DATABASE`/`pg_terminate_backend` na bazie,
do której inny worker miał jeszcze otwarte połączenie.

### Wpływ

Nie dotyczy kodu produkcyjnego, ale osłabia bramkę dowodową. `Errors 1` przy
zielonych testach może zamienić przebieg w niezerowy exit code, a `RA-018` i
`RA-026` opierają dowodowość na „całe repo zielone". Flake tej klasy powoduje albo
fałszywy alarm, albo — gorzej — przyzwyczajenie do ignorowania błędów w podsumowaniu.

### Wymagana zmiana

Teardown testowej bazy musi być odporny na otwarte połączenia innego workera:
zamykać własną pulę przed `DROP DATABASE`, a samo `DROP` wykonywać z
`pg_terminate_backend` dla tej konkretnej bazy i tolerować `57P01` jako oczekiwany
skutek zamknięcia, nie jako unhandled exception. Domykać razem z `CTF-003` (ten sam
charakter: flake harnessu testowego) i przed finalnymi bramkami `RA-018`/`RA-026`.
Zakres: `packages/workspace-runner` i/lub `packages/database/test` — oba należą do
tasków `DONE`, więc wymaga pełnego cyklu audytowego.

---

## `CTF-008` — `pnpm run lint` jest czerwony na `main`

- Severity: **LOW**
- Wykryty: `2026-08-20`, podczas reformy procesu (ADR-0007), przy pierwszym
  uruchomieniu **repozytorialnej** bramki lint
- Dotyczy: `packages/bedrock-runtime` (RA-007, `DONE`)
- Status: **OTWARTY**

### Dowód

```text
packages/bedrock-runtime/src/fake-transport.ts
  36:43  error  '_config' is defined but never used   @typescript-eslint/no-unused-vars
packages/bedrock-runtime/src/retry.ts
  42:13  error  'handle' is never reassigned. Use 'const' instead   prefer-const
packages/bedrock-runtime/test/runtime.integration.test.ts
  11:8   error  'RuntimeTransport' is defined but never used   @typescript-eslint/no-unused-vars
✖ 3 problems (3 errors, 0 warnings)   exit 1
```

Potwierdzone jako **preexistujące**: te same trzy błędy występują po odłożeniu
wszystkich zmian reformy (`git stash -u`), więc nie pochodzą z ADR-0007 ani z
commita `8680050`.

### Wpływ

Sam kod jest poprawny — to nieużywane symbole i jeden `let`, który powinien być
`const`. Istotne jest co innego: **`pnpm run check` nie może przejść na `main`**,
bo `lint` jest jego pierwszym krokiem. Każdy handoff deklarujący „scoped ESLint
PASS" był prawdziwy tylko dla wybranego pakietu; bramka repozytorialna nigdy nie
była zielona. To dokładnie ta klasa różnicy między „bramka zadeklarowana" a
„bramka uruchomiona", którą adresuje ADR-0007 — i została znaleziona pierwszym
uruchomieniem pełnego linta, nie przeglądem dokumentów.

Osobno: `_config` z podkreśleniem sugeruje intencję „świadomie nieużywany", ale
konfiguracja ESLint nie ma dla tego wzorca wyjątku (`argsIgnorePattern`), więc
konwencja i bramka się rozjeżdżają.

### Wymagana zmiana

Usunąć trzy nieużywane symbole i zamienić `let handle` na `const`, albo — dla
`_config` — dodać `argsIgnorePattern: "^_"` do konfiguracji ESLint, jeżeli
podkreślenie ma być obowiązującą konwencją. Rozstrzygnąć jedno i drugie razem, żeby
nie zostawić trzeciej wersji tej samej reguły.

Zakres dotyka `packages/bedrock-runtime`, który jest `DONE`, więc zmiana wymaga
pełnego cyklu audytowego (jak `CTF-003` i `CTF-007`). Domykać razem z nimi, przed
finalnymi bramkami `RA-018`/`RA-026`, które opierają dowodowość na zielonym
`check`.

### Domknięcie (`2026-08-21`) — potwierdzone `AUDIT-01` RA-024 `PASS`

`RA-024-WU-00`. Wpis stawiał alternatywę „usunąć symbole ALBO dodać
`argsIgnorePattern`" — **wykonane oba**, bo dotyczą różnych rzeczy, a wybranie
jednego zostawiłoby trzecią wersję tej samej reguły, przed czym ten wpis ostrzegał.

Kluczowe ustalenie, którego wpis nie znał: **konwencja i bramka rozjechały się
asymetrycznie.** Domyślne `after-used` w ESLint raportuje tylko **końcowy**
nieużywany argument, więc `(_type, listener)` przechodziło, a `(request, _config)`
nie. Repozytorium pisze `_config`/`_type`/`_unused` w ~20 miejscach, więc reguła była
egzekwowana w połowie przypadków, na których wyglądała na działającą.

Wykonane: `argsIgnorePattern: "^_"` **i** `caughtErrorsIgnorePattern: "^_"` w
`eslint.config.mjs`, celowo **wąsko** — nieużywana zmienna albo import pozostaje
błędem niezależnie od nazwy, bo to martwy kod, nie kształt interfejsu. Sonda
potwierdziła, że bramka nie osłabła:

```text
probeA(used, notUsed)      error  'notUsed' ... Allowed unused args must match /^_/u
probeB(used, _ok)          (brak)
probeC() const deadVar     error  'deadVar' is assigned a value but never used
probeD() catch(realError)  error  'realError' ... must match /^_/u
```

`prefer-const` w `retry.ts` był realną wzajemną referencją między callbackiem timera i
`onAbort` — trzymana w boxie, żeby oba wiązania były `const` **bez** zmiany
kolejności: wstrzyknięty **synchroniczny** `setTimeout` (używa go kilka testów)
odpala callback zanim przypisanie by się wykonało. Nieużywany import
`RuntimeTransport` był martwym kodem i został usunięty.

```text
pnpm run lint    -> exit 0   (było: 3 errors, exit 1)
```


---

## `CTF-009` — `isForbiddenPath` nie zna plików instrukcji repozytorium

- Severity: **LOW** (dla RA-012 domknięte lokalnie; mechanizm nadal rozjechany)
- Wykryty: `2026-08-20`, podczas audytu RA-012 sondą adwersarialną audytora
- Dotyczy: `packages/repository-planner/src/discovery-policy.ts` (RA-011, `DONE`)
- Status: **OTWARTY** — RA-012 ma własny filtr, reszta konsumentów nie

### Dowód

`isForbiddenPath` (`discovery-policy.ts:65`) odrzuca `.git`, `.env`/`.env.*`,
`*.key|pem|p12|pfx`, `id_rsa`, `id_ed25519` oraz nazwy `credentials`/`secrets`/
`token`. **Nie zna** `AGENTS.md`, `CLAUDE.md`, `.cursorrules` ani
`copilot-instructions.md`.

Sonda audytora na realnym workspace, przed naprawą RA-012:

```text
search "INSTRUCTION_MARKER" -> zwrócona treść AGENTS.md
tree (root)                 -> AGENTS.md wylistowany
.env, .git                  -> poprawnie odfiltrowane
```

### Wpływ

Każdy konsument `createPlannerReadPort`, który zakłada, że `isForbiddenPath`
pokrywa „wszystko, czego model nie powinien czytać", wystawi pliki instrukcji.
`repository-planner` (RA-011) czyta je celowo — to jego zadanie — więc **dla niego
nie jest to defekt**. Ryzyko dotyczy warstw model-facing, które dziedziczą ten
predykat jako politykę bezpieczeństwa: model czytający własne instrukcje może
planować wokół nich.

Nie jest to eskalacja uprawnień: zapis do plików instrukcji był i pozostaje
blokowany osobno.

### Domknięcie dla RA-012 (`2026-08-20`)

`packages/implementation-tools/src/toolset.ts` filtruje payloady listingowe na
wyjściu własnym `isProtectedPath`, który pokrywa pliki instrukcji. Rozliczone przez
`dropped`/`complete: false`/`truncated`, nie ciche. Commit `5c3df61`,
potwierdzone mutacją i trzema testami regresyjnymi.

### Wymagana zmiana

Rozstrzygnąć, gdzie należy polityka „czego model nie czyta". Rekomendacja: nie
rozszerzać `isForbiddenPath` (RA-011 **musi** czytać instrukcje, żeby zbudować
profil), lecz utrzymać rozróżnienie jawnie — `discovery-policy` chroni
credentiale i VCS, a warstwa model-facing dokłada pliki instrukcji. Wymaga wtedy,
by każda nowa warstwa model-facing przechodziła przez własną bramkę, a nie
dziedziczyła cudzą.

Najbliżsi kandydaci na konsumentów: **RA-015** (independent reviewer czyta repo) i
**RA-021** (MCP broker wystawia narzędzia read). Oba muszą albo użyć
`isProtectedPath` z `implementation-tools`, albo mieć własną, jawną bramkę —
nie zakładać, że `isForbiddenPath` wystarcza. Wpisane jako warunek wejścia do
planów obu tasków.

---

## `CTF-010` — wzorzec: komentarz opisuje gwarancję, której kod nie daje

- Severity: **LOW** (jako wpis rejestru), ale opisuje przyczynę **pięciu** defektów
  klasy HIGH
- Wykryty: `2026-08-20`, jako wzorzec przekrojowy w RA-012, RA-013, RA-014, RA-015,
  RA-017
- Status: **ADRESOWANY procesowo** przez ADR-0007; wpis istnieje jako dowód, że
  bramka działa

### Dowód

Pięć niezależnych defektów o tej samej strukturze — kod czytał się jako poprawny,
bo komentarz obok opisywał zachowanie, którego kod nie realizował:

| Task | Komentarz twierdził | Kod robił |
|---|---|---|
| RA-012 | „spread czyni kryterium 1 realnym" | ręcznie odtwarzał request, gubiąc pola |
| RA-012 | (test) „symlink odrzucony" | asercja tylko na `FAILED`, nie na kodzie polityki |
| RA-014 | „guard odrzuca destrukcyjne komendy" | denylista defeatowalna sześcioma sposobami |
| RA-015 | „resolution wskazuje evidence poprawki" | dowolny commit i digest czyściły blocker |
| RA-017 | „URL nie niesie credentiala" | query string przechodził obie bramki |

### Wpływ

Wzorzec jest istotny, bo **przegląd kodu go nie wyłapuje** — komentarz i kod czyta
się razem, a komentarz nadaje kodowi intencję, której ten nie ma. Wszystkie pięć
wykryły dopiero: uruchomiona komenda weryfikacyjna (RA-012), mutation testing
(RA-012 test, RA-015 częściowo) albo sonda adwersarialna audytora (RA-014, RA-015,
RA-017).

### Wymagana zmiana

Żadna zmiana kodu — to wniosek procesowy, już zapisany w `AGENTS.md` jako zasada 9:
„Komentarz nie jest dowodem zachowania. Jeżeli komentarz i kod się nie zgadzają,
uruchomiony test rozstrzyga."

Praktyczne konsekwencje, obowiązujące od teraz:

1. **Asercja na kodzie, nie na klasie wyniku.** Test sprawdzający `FAILED` zamiast
   konkretnego kodu odmowy przechodzi także wtedy, gdy odmowę wydała inna, słabsza
   warstwa (RA-014, dowiedzione mutacją).
2. **Allowlista zamiast denylisty** dla każdej granicy bezpieczeństwa. Denylista musi
   przewidzieć wszystkie przyszłe wektory; allowlista tylko te używane (RA-014).
3. **Sonda adwersarialna w każdym audycie.** Pięć na pięć tasków, w których jej
   użyłem, dało finding, którego nie dały testy unitu. To najtańsza znana tu bramka.
4. **Fail closed przy pustej konfiguracji.** Dwa defekty (`declaredPaths` w RA-014,
   `declared.size > 0`) wynikały z traktowania braku deklaracji jako zgody.

---

## `CTF-011` — test integracyjny może przejść na starym buildzie

- Severity: **LOW** jako wpis rejestru; był **HIGH** jako defekt bramki RA-018
- Wykryty: `2026-08-21`, podczas audytu RA-018, mutation testingiem samego testu
- Dotyczy: każdego testu w `test/**`, który importuje pakiet przez `node_modules`
- Status: **ZAMKNIĘTY dla RA-018**; wzorzec pozostaje otwarty dla przyszłych suite

### Dowód

Testy w pakiecie importują `../src/index.js`. Testy w `test/**` rozwiązują się przez
`node_modules` do `dist/` — co jest **właściwe**, bo ćwiczą artefakty, które
załadowałby deployment.

Konsekwencja zmierzona wprost:

```text
zepsucie packages/implementation-tools/src/patch.ts   -> 8/8 zielonych
ta sama mutacja po `pnpm run build --force`            -> test wywalony
```

### Wpływ

Dwa fałszywe wnioski, oba groźne:

1. **fałszywe `PASS` bramki** — zmiana w `src` bez builda przechodzi golden path, bo
   suite testuje poprzedni artefakt;
2. **fałszywy wniosek z mutation testingu** — „mutacja nie wywala testów, więc testy
   nie są load-bearing", gdy w rzeczywistości mutacja nigdy nie dotarła do
   uruchamianego kodu. To odwraca sens narzędzia, którym ten projekt weryfikuje
   wszystkie pozostałe bramki.

### Wymagana zmiana

Zrobione dla RA-018: `assertPackagesAreCurrent` w
`test/golden-path/golden-path.integration.test.ts` porównuje najnowszy mtime `src/` z
najstarszym `dist/` dla każdego ćwiczonego pakietu i odmawia uruchomienia, podając
pakiet oraz komendę naprawczą. Fail-closed: pakiet nieczytelny albo niezbudowany też
blokuje.

Dla przyszłych suite w `test/**` obowiązuje ta sama zasada. Naturalnym wzmocnieniem
byłoby przeniesienie tego guardraila do `test/guardrails/`, tak by obejmował każdą
nową suite automatycznie zamiast wymagać skopiowania funkcji — kandydat do
zakolejkowania razem z `CTF-002-U1`, który ma ten sam charakter (guardrail zamiast
ręcznej dyscypliny).

### Uwaga metodologiczna

Ten finding jest wariantem `CTF-010` przeniesionym na poziom bramki: nie komentarz,
lecz **nazwa i lokalizacja testu** obiecywały weryfikację obecnego kodu, a mechanizm
jej nie dawał. Wniosek praktyczny, obowiązujący od teraz: **każda mutacja w pakiecie
konsumowanym przez `test/**` musi być poprzedzona przebudowaniem tego pakietu**,
inaczej wynik mutation testingu jest bez wartości.

---

## `CTF-013` — `pnpm run typecheck` crashuje `RangeError` na kroku root

- Severity: **MEDIUM** (bramka repozytorialna nie może przejść; sam kod jest poprawny)
- Wykryty: `2026-08-21`, podczas final task gate RA-021, pierwszym uruchomieniem
  `pnpm run typecheck --force` na tej maszynie
- Dotyczy: `tsconfig.json` w rootcie + `test/golden-path/golden-path.integration.test.ts`
  (RA-018, `DONE`)
- Status: **OTWARTY** — zdiagnozowany, niezależny od RA-021

### Dowód

`package.json` ma `"typecheck": "tsc -p tsconfig.json --noEmit && turbo run typecheck"`.
**Pierwszy** krok — root, obejmujący `scripts/**` i `test/**` — crashuje:

```text
RangeError: Maximum call stack size exceeded
    at hasSyntacticModifier (typescript/lib/_tsc.js:16870:30)
    at getIsDeferredContext (…:19800:35)
    at resolveNameHelper (…:19523:58)
    at trackExistingEntityName (…:53506:31)
    at tryVisitTypeQuery (…:132702:60)
```

Zmierzone na **czystym drzewie bazowym** (`git stash -u`, `git status` pusty), więc
**nie pochodzi z RA-021**:

```text
base, domyślny stack:      RangeError
base, --stack-size=4000:   RangeError
base, --stack-size=6000:   RangeError
base, --stack-size=8000:   RangeError
base, --stack-size=10000:  czysto, zero błędów
```

Izolacja do katalogu przez osobne wywołania `tsc` na plikach root-included:

```text
test/golden-path:  RangeError=1
test/guardrails:   RangeError=0
test/workflow:     RangeError=0
scripts/workflow:  RangeError=0
```

`test/golden-path/golden-path.integration.test.ts` (RA-018, commit `8edd109`)
importuje jednocześnie siedem pakietów `@remoteagent/*`, a ślad stosu
(`trackExistingEntityName`, `tryVisitTypeQuery`) wskazuje na inferencję typów
przy głęboko zagnieżdżonych, rekurencyjnych typach Zod z wielu pakietów naraz.

### Wpływ

**`pnpm run typecheck` nie może przejść na `main`** — dokładnie ta klasa różnicy
między „bramka zadeklarowana" a „bramka uruchomiona", którą opisuje `CTF-008` dla
`lint`. Konsekwencja jest ta sama i poważniejsza, niż wygląda: `RA-026` AC opiera
dowodowość na zielonych bramkach repozytorialnych, a obecnie dwie z nich
(`lint` — `CTF-008`, `typecheck` — ten wpis) są czerwone na `main`.

Sam kod jest poprawny: **`turbo run typecheck --force` przechodzi dla wszystkich
36 zadań** (`0 cached`), więc każdy pakiet osobno typechecuje się czysto — łącznie
z `packages/mcp-tool-broker` i jego `tsconfig.test.json`. Awaria dotyczy wyłącznie
zagregowanego programu root.

### Wymagana zmiana

Diagnoza wskazuje na limit stosu, nie na błąd typów, więc są dwie sensowne opcje i
obie należą do własnego unitu, nie do doczepki:

1. podnieść stos dla kroku root (`node --stack-size=10000 node_modules/typescript/lib/tsc.js`)
   — najmniejsza zmiana, ale ukrywa przyczynę i jest wrażliwa na wersję Node;
2. rozbić root `tsconfig.json` albo wyłączyć `test/golden-path` z programu root
   (suite i tak jest typechecowana przez vitest i uruchamiana w bramce), ewentualnie
   uprościć import surface tego pliku.

Zakres dotyka RA-018 (`DONE`), więc zmiana wymaga pełnego cyklu audytowego, jak
`CTF-003`, `CTF-007` i `CTF-008`. Domykać razem z `CTF-008` przed `RA-026`, bo oba
są tą samą klasą problemu: bramka repozytorialna czerwona na `main`.

### Domknięcie (`2026-08-21`) — potwierdzone `AUDIT-01` RA-024 `PASS`

`RA-024-WU-00`. **Żadna z dwóch opcji tego wpisu nie była właściwa**, i to jest
najużyteczniejsza część domknięcia: diagnoza „limit stosu, nie błąd typów" była
błędna.

Prawdziwą przyczyną jest **jedno wyrażenie typu**. Bisekcja pliku
`test/golden-path/golden-path.integration.test.ts`:

```text
head -750 … head -960     RangeError = 0
head -969 (cały plik)     RangeError = 1
```

Crash wymaga **składniowo kompletnego** pliku, więc nie jest to „jedna linia" ani
kumulacja rozmiaru. Izolacja przez podmianę pojedynczych typów:

```text
baseline (bez zmian)                              RangeError
wariant A: `db` typowane jawnym importem          RangeError
wariant B: `inTx` bez instantiation expression    CZYSTO
wariant C: A + B                                  CZYSTO
```

Winowajcą jest `Parameters<typeof db.withTransaction<T>>[0]` — **instantiation
expression zagnieżdżone w `Parameters<>`**. Przepisanie **tylko tego typu** usunęło
crash i nie zmieniło niczego innego w pliku. Podnoszenie `--stack-size` (opcja 1)
maskowałoby to, a rozbijanie root `tsconfig.json` (opcja 2) usunęłoby suite z bramki —
oba obok przyczyny.

**Usunięcie crashu ujawniło błędy, które on maskował** — i to jest samodzielne
ustalenie: `RangeError` przerywał program, więc `tsc` nigdy nie doszedł do raportowania
`TS2322`. To otwarta połowa `CTF-004`: harness importuje `../src/client.js`, więc
zwraca **src** `Database`, a każdy ćwiczony pakiet deklaruje `runTransaction` wobec
**dist** `Transaction`. Oba są brandowane `unique symbol`, więc są wzajemnie
nieprzypisywalne — `TS2741` w obu kierunkach, zmierzone sondą, nie założone.

Zmostkowane **jednym** castem na jedynej wartości przechodzącej granicę, z zapisanym
powodem: brand istnieje wyłącznie w `client.d.ts` i **żadne pole runtime go nie
realizuje** (sprawdzone — `withTransaction` wydaje sam pooled client), więc cast nie
twierdzi nieprawdy. `assertPackagesAreCurrent` nadal pilnuje świeżości builda.

```text
node …/tsc.js -p tsconfig.json --noEmit   -> exit 0   (było: RangeError, exit 1)
pnpm run typecheck --force                -> 36 successful, 0 cached
```

Ta sama granica wystąpiła ponownie w `test/security/kill-switch-drill.test.ts` i jest
tam zmostkowana identycznie, ze wskazaniem na ten wpis.


---

## `CTF-012` — niedeterministyczny fail `recovery.integration` w pełnym przebiegu

- Severity: **LOW**
- Wykryty: `2026-08-21`, podczas bramki RA-019
- Dotyczy: `packages/workspace-runner/test/recovery.integration.test.ts`, test
  „keeps DB connection available for restart/kill-point matrix"
- Status: **OTWARTY** — nie zdiagnozowany, nie naprawiony

### Dowód

Zmierzone w pełnych przebiegach repozytorium, po domknięciu `CTF-003` i `CTF-007`:

```text
przebieg A: 1418/1419  (1 failed)
przebieg B: 1419/1419
przebieg C: 1418/1419  (1 failed)
przebiegi D–M: 1419/1419  (dziesięć z rzędu)
solo:       5/5
```

Czyli: **2 faile na 13 pełnych przebiegów**, zero faili solo, zero faili w dziesięciu
kolejnych przebiegach po tych dwóch. Nie udało mi się przechwycić komunikatu błędu —
sześć celowych prób reprodukcji z pełnym reporterem wyszło zielono.

### Dlaczego to zapisuję jako otwarte, a nie jako „naprawione"

To jest **inny** test niż flake z `CTF-003` (tam `process-runner`, timeout race) i
inny objaw niż `CTF-007` (tam unhandled `57P01` przy `Errors`, tu prawdziwy fail
asercji bez `Errors`). Oba tamte są domknięte i potwierdzone; ten jest nowy.

Nie mam diagnozy, więc nie mam prawa twierdzić, że jest nieszkodliwy. Nazwa testu
dotyczy dostępności połączenia DB przy macierzy restart/kill — czyli obszaru, w
którym `CTF-007` ujawnił realny defekt produkcyjny (brak `pool.on("error")`).
Możliwe, choć niepotwierdzone, że to pozostałość tej samej klasy: rywalizacja o
połączenia między workerami vitest przy równoległych suite'ach integracyjnych.

### Wpływ

Bramka „całe repo zielone" jest ponownie niestabilna, na poziomie ~15% przebiegów.
`RA-018` i `RA-026` opierają na niej dowodowość, więc to obniża wartość każdego
pojedynczego zielonego przebiegu — dokładnie ten mechanizm opisuje `CTF-003`.

**Nie blokuje RA-019 ani RA-020:** dotyczy pakietu `workspace-runner`, którego te
taski nie zmieniają, a ich własne suite są zielone solo i w pełnym przebiegu.

### Obserwacja z bramki RA-021 (`2026-08-21`)

Pełne przebiegi repozytorium w final task gate RA-021 (po dodaniu migracji `028` i
pakietu `mcp-tool-broker`):

```text
przebiegi 1-4 (przed fixem sondy):   1601/1601, cztery z rzędu, zero błędów
przebieg 1 (po fixie sondy):         1603/1604  (1 failed)
przebiegi 2-12 (po fixie sondy):     1604/1604, JEDENAŚCIE z rzędu
```

**Nie udało mi się przechwycić tożsamości tego jednego faila** — pojawił się w
przebiegu, w którym nie zachowywałem pełnego logu, a jedenaście kolejnych przebiegów
(w tym trzy z zachowanym logiem) wyszło zielono. Zapisuję to jako obserwację, a **nie**
jako potwierdzenie, że był to `CTF-012`: nie mam na to dowodu, a zgadywanie tożsamości
flake'a to dokładnie ten wzorzec, który ten rejestr trzykrotnie ukarał (`CTF-010`).

Co z tego wynika dla `CTF-012`: częstotliwość „~15% przebiegów" z pierwotnego pomiaru
**nie potwierdziła się** w tej bramce (1 na 16 przebiegów łącznie, tożsamość nieznana),
ale wniosek pozostaje ten sam — pojedynczy zielony przebieg całego repo nie jest
rozstrzygający, więc każdy raport powinien podawać liczbę przebiegów. Ten podał
sześnaście.

### Wymagana zmiana

Najpierw **diagnoza**, nie poprawka. Konkretnie: uruchomić pełny przebieg z
`--reporter=verbose` i zachowanym outputem w pętli do przechwycenia komunikatu, oraz
sprawdzić, czy test dzieli pulę połączeń z innym suite'em integracyjnym startującym w
tym samym momencie. Poprawka „na wyczucie" w teście, którego trybu awarii nie znam,
byłaby dokładnie tym wzorcem, który ten projekt trzykrotnie ukarał (`CTF-010`).

Właściciel: task dotykający `workspace-runner` albo osobny unit przed `RA-026`, bo
`RA-026` AC wymaga stabilnej bramki. Do tego czasu każdy raport pełnego przebiegu
powinien podawać liczbę przebiegów, nie tylko wynik jednego.

### Domknięcie (`2026-08-21`) — potwierdzone `AUDIT-01` RA-024 `PASS`

**Diagnoza najpierw, jak ten wpis wymagał.** Komunikat, którego nie udało się
przechwycić w ~15 przebiegach, wypadł w bramce RA-024:

```text
duplicate key value violates unique constraint "workspaces_case_id_key"
  at WorkspaceRepository.recordIntent (packages/database/src/repositories/workspace.ts:39)
  at Object.recordIntent (packages/workspace-runner/src/recovery.ts:54)
```

Przyczyna jest deterministyczna i **nie** jest wyścigiem o pulę połączeń, jak
spekulował ten wpis. `workspaces` ma **dwa** unique constrainty — `workspace_id`
(primary key) i `UNIQUE (case_id)`, czyli inwariant single-writer — a `recordIntent`
absorbował konflikty przez `ON CONFLICT (workspace_id) DO NOTHING`, pokrywając tylko
pierwszy. Współbieżny insert, który przegrał wyścig na `workspaces_case_id_key`,
uciekał jako surowy `23505` zamiast `WorkspaceMappingConflictError`.

Dlatego reprodukował się **wyłącznie** w pełnym przebiegu: potrzebuje dwóch insertów
faktycznie w locie. Solo 5/5 zielone — zmierzone, nie założone.

Naprawione **nietargetowanym** `ON CONFLICT DO NOTHING`. To właściwy absorber, nie
szerszy: istniejąca weryfikacja odczytuje wiersz ponownie i odrzuca wszystko, co nie
zgadza się z tym konkretnym intentem, więc insert **może** być no-opem, ale nigdy nie
jest niezbadanym sukcesem.

Test regresyjny **wymusza** wyścig ośmioma współbieżnymi insertami zamiast liczyć na
zaobserwowanie go — flake odtworzony przypadkiem nie jest testem regresyjnym.
Asercja na **typie** błędu, nie na „rzuciło": poprzednie zachowanie **też** rzucało, i
dokładnie dlatego wyglądało to na szum przez piętnaście przebiegów (`CTF-010`,
finding 1).

Mutation check — przywrócenie `ON CONFLICT (workspace_id)`:

```text
zmutowane   -> 2 failed | 3 passed, exit 1
przywrócone -> 5 passed, exit 0
```

Wpływ na bramkę „całe repo zielone", zmierzony:

```text
przed naprawą: 2086 testów, 1 failed  (ten flake, przechwycony)
po naprawie:   2164 testów, CZTERY kolejne przebiegi, 0 failed
```

---

## `CTF-014` — push brancha case'a nie przechodzi przez `ACTION_REGISTRY`

- Severity: **LOW** (rozjechanie kontraktu z komentarzem; brak osiągalnej eskalacji)
- Wykryty: `2026-08-21`, podczas `RA-024-WU-04` — przez **test**, nie przez przegląd
- Dotyczy: `packages/policy/src/policy-engine.ts` (RA-022),
  `packages/connector-gitlab/src/merge-request.ts` (RA-017)
- Status: **OTWARTY** — decyzja `defer`, domknięcie wymaga ADR
- Owner: właściciel (decyzja o zmianie zaakceptowanego kontraktu RA-022)

### Dowód

Komentarz w `ACTION_REGISTRY` mówi wprost:

```ts
// R2 — drafts and case-branch pushes: visible to the owner, reversible, and not
// yet communicated to anyone outside.
"gitlab.mr.draft.update": RiskTier.R2,
"gmail.draft.create": RiskTier.R2,
```

**Nie ma klucza dla pushu.** `grep` na ścieżce pushu:

```text
evaluatePolicy|ACTION_REGISTRY|RiskTier w connector-gitlab/src, git-lifecycle/src:
  (brak trafień)
```

Wykryte przez `test/security/least-privilege.test.ts`, który sprawdza, że każdy write
scope wskazuje akcję **obecną** w rejestrze: `write_repository → gitlab.branch.push`
nie zrezolwował się. To jest wartość tego kierunku sprawdzenia — przegląd „czy każda
akcja ma scope?" tego nie widzi.

### Wpływ

To wzorzec `CTF-010`: komentarz opisuje gwarancję, której kod nie daje. Push **jest**
zapisem zewnętrznym i **nie** jest wyceniony przez policy engine, więc nie ma tieru,
nie ma `PolicyEvaluation.evidence` i nie ma wpisu w ścieżce approval.

**Nie oceniam tego na HIGH**, bo push jest zatrzymany trzema innymi warstwami,
sprawdzonymi w kodzie:

1. `project.writes_enabled` jest **domyślnie wyłączone** (`GITLAB_WRITES_DISABLED`);
2. `GitLabProjectAllowlist` jest **zamkniętą** listą projektów;
3. allowlista argv w `git-lifecycle` dopuszcza **dziewięć** subkomend, więc
   `push --force` ani `branch -D` **nie da się złożyć** — allowlista, nie denylista.

Ryzykiem jest więc **brak dowodu policy dla realnego zapisu**, nie eskalacja. Dotyczy
to `RA-026` AC8 („wszystkie R3/R4 mają policy evidence, approval i receipt"): push nie
jest R3/R4, ale audytor RA-026 powinien wiedzieć, że jest zapisem poza rejestrem.

### Wymagana zmiana

Rozstrzygnąć jako ADR, bo dodanie klucza do `ACTION_REGISTRY` zmienia zaakceptowany
kontrakt RA-022 i wymaga migracji ścieżki wykonania. Dwie opcje:

1. dopisać `gitlab.branch.push` jako `R2` (zgodnie z tym, co komentarz **już
   twierdzi**) i przeprowadzić push przez executor — spójne, ale dotyka RA-017;
2. **usunąć fragment komentarza** o „case-branch pushes" i zapisać jawnie, że push
   jest zatrzymany przez `writes_enabled` + allowlistę projektów + allowlistę argv,
   a nie przez policy engine — tańsze i uczciwe, ale zostawia zapis bez policy
   evidence.

Rekomendacja: **opcja 2 przed RA-026, opcja 1 jako osobny task**, jeżeli właściciel
chce policy evidence dla pushu. Nie robię tego w RA-024: hardening nie jest miejscem
na zmianę zaakceptowanego kontraktu.

---

## `CTF-015` — sześć nieodnotowanych kolizji type-level poza `packageName`

- Severity: **LOW** (nieosiągalne; brak wspólnego barrela)
- Wykryty: `2026-08-21`, sondą type-level w final task gate RA-024
- Dotyczy: `agent-orchestrator`, `bedrock-runtime`, `workspace-runner`,
  `implementation-tools`, `mcp-tool-broker`, `connector-jira`
- Status: **OTWARTY** — decyzja `accept`
- Owner: `CTF-002-U1` (guardrail), który wyłapie je automatycznie

### Dowód

Sonda type-level (`ts.Program` + `checker.getExportsOfModule`, z rozwijaniem aliasów,
żeby legalny re-eksport **tej samej** deklaracji nie dawał fałszywego alarmu), 19
pakietów z `dist/index.d.ts`:

```text
ModelIdentity      <- agent-orchestrator, bedrock-runtime        (2 deklaracje)
OperationRecord    <- implementation-tools, workspace-runner     (2 deklaracje)
RetryPolicy        <- bedrock-runtime, connector-jira            (2 deklaracje)
RuntimeOptions     <- agent-orchestrator, bedrock-runtime        (2 deklaracje)
ToolManifest       <- agent-orchestrator, mcp-tool-broker        (2 deklaracje)
WorkspaceFence     <- agent-orchestrator, workspace-runner       (2 deklaracje)
packageName        <- 7 pakietów                                 (znane, CTF-002)
```

`CTF-002` notował wyłącznie `packageName`. **Sześć pozostałych jest nowych** —
powstały w RA-007..RA-021 i nie zostały wychwycone, bo wcześniejsze bramki używały
sondy **wartościowej**, a to są typy bez wartości runtime.

### Wpływ

Identyczny jak w `CTF-002`: przy `export *` z dwóch pakietów w jednym barrelu ESM
**cicho usuwa** niejednoznaczną nazwę, bez błędu kompilacji. Sprawdziłem
osiągalność — **nie ma** dziś takiego barrela ani konsumenta importującego
kolidującą parę:

```text
skan konsumentów agent-orchestrator + (workspace-runner|bedrock-runtime|mcp-tool-broker):
  (brak trafień)
```

Więc nieosiągalne, dokładnie jak `packageName`. Istotne jest co innego: **to
najmocniejszy dotychczasowy argument za `CTF-002-U1`.** Wpis `CTF-002` uzasadniał
guardrail jednym przykładem i dowodem z RA-022; tu jest **sześć** kolizji, które
przeszły przez wszystkie zwykłe bramki w pięciu taskach, bo ręczna sonda była
uruchamiana tylko tam, gdzie plan o niej pamiętał.

### Wymagana zmiana

Decyzja: **`accept`** dla samych nazw (nieosiągalne, a przemianowanie sześciu typów w
pakietach `DONE` wymagałoby pełnego cyklu audytowego × 5 bez zysku bezpieczeństwa),
**`fix` dla mechanizmu** — czyli `CTF-002-U1` jako guardrail w `test/guardrails/`,
używający type-checkera, nie skanu wartości. Sonda z tego wpisu jest gotowym
implementacyjnym szkicem.

Do czasu jego powstania obowiązuje wniosek z `CTF-002`: **final task gate musi
uruchamiać sondę type-level, nie tylko wartościową.**
