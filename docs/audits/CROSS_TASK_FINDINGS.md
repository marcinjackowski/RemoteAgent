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
| `CTF-001` | MEDIUM | OTWARTY | `RA-023-WU-00` |
| `CTF-002` | MEDIUM | **CZĘŚCIOWO** — `packageName` 5/6 otwarte (RA-017 usunął swój) | `RA-012-WU-01B` wykonany; guardrail `CTF-002-U1` otwarty |
| `CTF-005` | MEDIUM | OTWARTY — kształt rozstrzygnięty (`checkpoint_revision`, backfill fail-closed) | RA-022 |
| `CTF-006` | **HIGH** | OTWARTY — właściciel potwierdził domknięcie w RA-024 | RA-024 (hardening); obejście lokalne w RA-012-WU-05 |
| `CTF-003` | LOW | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-018 | naprawiony w `cfc3a15` |
| `CTF-004` | LOW | OTWARTY | unit repozytorialny; 6 z 11 pakietów bez pokrycia |
| `CTF-007` | LOW | **ZAMKNIĘTY** — potwierdzony `AUDIT-01` RA-018 | naprawiony w `cfc3a15`; miał za sobą realny defekt produkcyjny |
| `CTF-011` | LOW | **ZAMKNIĘTY dla RA-018** — wzorzec otwarty | bramka mogła przejść na starym buildzie |
| `CTF-008` | LOW | OTWARTY | `pnpm run lint` czerwony na `main`; przed RA-018/RA-026 |
| `CTF-010` | LOW | **ADRESOWANY procesowo** (ADR-0007) | wzorzec: komentarz != zachowanie; 5 defektów HIGH |
| `CTF-009` | LOW | OTWARTY — mechanizm domknięty w RA-012 | `isForbiddenPath` nie zna plików instrukcji; RA-015/RA-021 |

---

## `CTF-001` — dwie różne klasy `CredentialRefreshConflictError` / `CredentialRefreshIdentityError`

- Severity: **MEDIUM**
- Wykryty: `2026-08-20`, podczas planowania RA-013/RA-017 (audyt przekrojowy
  eksportów, nie zgłoszony przez żadnego implementera)
- Dotyczy: `packages/database`, `packages/policy` (RA-003, RA-005)
- Status: **OTWARTY**

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
