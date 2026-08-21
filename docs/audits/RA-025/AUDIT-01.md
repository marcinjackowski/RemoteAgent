# RA-025 — AUDIT-01

- Task: `RA-025` AWS deployment and disaster recovery
- Data: `2026-08-22`
- Bazowy commit: `d461958` (stan po domknięciu RA-024)
- Rola: jedna rola wykonawcza (ADR-0007)

Werdykt jest w §9.

## 1. Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run          (całe repo)
  → 2264/2264, 158 plików, exit 0, CZTERY przebiegi z rzędu, zero `Errors`

RA_REQUIRE_POSTGRES=1 pnpm vitest run test/infra
  → 100/100, 3 pliki, exit 0

pnpm run lint                              → exit 0
pnpm run format                            → exit 0
node …/tsc.js -p tsconfig.json --noEmit    → exit 0
pnpm run typecheck --force                 → 36 successful, 0 cached
pnpm run build --force                     → 26 successful, 0 cached
git diff --check                           → exit 0
```

**ŻADNEGO wywołania AWS. Żadnego deploymentu. Żadnych credentiali.** To nie jest
ograniczenie, z którym się zderzyłem — to była pierwsza rzecz, którą **zmierzyłem**,
i ona zdeterminowała cały projekt taska (§2).

## 2. Ustalenie, które zdefiniowało ten task

Zanim napisałem jakikolwiek stack, sprawdziłem czy `synth` działa bez AWS:

```text
AWS_PROFILE= AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY= tsx probe.ts
  → 24 zasoby, exit 0
```

Działa — pod warunkiem jawnego `env` (account + region) na każdym stacku. To
znaczy, że **AC1 i AC2 są w pełni weryfikowalne na tej maszynie**, i to zamienia je
z kryteriów „do sprawdzenia w pipeline" w kryteria z uruchomioną komendą.

Konsekwencja projektowa, nie kosmetyczna: **żadnego `DockerImageAsset`.** Docker na
tej maszynie jest zepsuty (`AGENTS.md`), więc asset uczyniłby `synth` niewykonalnym,
a oba kryteria nieweryfikowalnymi. Obrazy są referowane przez repozytorium i tag —
co jest zresztą lepszym kształtem deploymentu: build i deploy stają się osobnymi
krokami, a `synth` przestaje zależeć od lokalnego cache Dockera.

Zapisuję to jako pierwszy punkt audytu, bo to jedyny sposób, w jaki ograniczenie
środowiska mogło **poprawić** projekt zamiast go okaleczyć.

## 3. Kryteria akceptacji — każde osobno

### AC1 — synth/diff deterministyczny, przechodzi security policy checks

**Spełnione.** `test/infra/synth.test.ts`, 50 testów.

Determinizm: brak zegara, losowości, zmiennych środowiskowych i lookupów SSM;
jawne `account` i `region`, więc brak pseudo-parametrów `Fn::GetAZs`. Weryfikacja
przez **dwukrotny synth i porównanie bajtów**, dla wszystkich trzech środowisk.

Test **negatywny** też jest, i jest istotny: zmiana `imageTag` **musi** zmienić
template. Test determinizmu, który przechodzi, bo template ignoruje swoje wejścia,
byłby bezwartościowy — a to najłatwiejszy sposób, w jaki taka asercja staje się
pusta.

Dodatkowo asercja strukturalna: żaden timestamp ani wartość losowa w żadnym
template. Porównanie bajtów przeszłoby również wtedy, gdyby wartość była stabilna w
jednym procesie i różna między przebiegami; to łapie ten kształt pomyłki.

### AC2 — IAM per component, bez szerokich wildcardów bez ADR

**Spełnione.** Trzy task role z **rozłącznymi** grantami, plus jedna execution role,
która nigdy nie uruchamia kodu aplikacji.

Rozdział jest granicą bezpieczeństwa, nie porządkiem:

| Rola | Ma | **Nie ma** — i dlaczego |
|---|---|---|
| `worker` | Bedrock, artefakty | **żadnego credentiala providera** — uruchamia kod z repozytorium i czyta tekst z Jiry, oba `UNTRUSTED_DATA` |
| `executor` | credentiale providerów | **Bedrocka** — nie zawiera żadnego reasoningu modelu, więc grant mógłby być tylko nadużyciem |
| `ingress` | sekrety podpisów webhooków | **consume z SQS** — komponent dostępny z internetu, który mógłby przejmować joby, wpływałby na to, jaka praca się wykonuje |

Wildcardy: żadnego `Action: "*"` ani `service:*`. `Resource: "*"` tylko dla akcji z
**jawnej allowlisty** rzeczy, które w AWS nie mają ARN-u (`ecr:GetAuthorizationToken`,
`cloudwatch:PutMetricData`, describe/list na EC2). Allowlista, nie denylista —
`CTF-010` finding 2.

Checki czytają **zsyntetyzowany template**, nie drzewo konstruktów, i ta różnica
jest merytoryczna: `grantReadWrite` zawiera po cichu `s3:DeleteObject`, czego nie
widać w miejscu wywołania. Dlatego grant workera na bucket jest **wyliczony** —
worker, który może usuwać dowody, to nie jest to, co „read write artifacts" ma
znaczyć. Ta sama logika co `CTF-011`: testuj to, co się wdraża.

### AC3 — fresh environment z repo i udokumentowanych prerequisites

**Spełnione dokumentacyjnie, nie wykonaniem** — i tak jest to zapisane.
`docs/operations/RUNBOOK.md` §0 wymienia pięć prerequisites z uzasadnieniem, czego
**nie ma** w kodzie i dlaczego (ID kont, certyfikaty ACM, obraz, bootstrap, wartości
sekretów).

Nie twierdzę, że utworzyłem świeże środowisko. Twierdzę, że lista jest kompletna i
weryfikowalna `pnpm vitest run test/infra`, a realne utworzenie wymaga zgody
właściciela (§7).

### AC4 — restore odtwarza cases/checkpoints/audit i uzgadnia jobs

**Spełnione dla części decydującej, z jawnie zapisanym ograniczeniem.**

`packages/database/src/restore.ts` + `test/infra/restore-drill.test.ts` (28 testów)
przeciwko **realnemu** PostgreSQL-owi. `verifyRestoredEvidence` sprawdza dowody
**przez liczby**, bo „baza odpowiada" to nie „baza odtworzona" — pusta baza
odpowiada na każde zapytanie.

**Ograniczenie, które stawiam wprost:** sam mechanizm restore AWS (PITR snapshot do
świeżego konta) **nie był ćwiczony**. Żadnego wywołania AWS w tym tasku. Ćwiczona
jest część, która decyduje, **czy zapis wykona się dwa razy** — czyli dokładnie to,
o czym jest AC5 — i to przeciwko realnej bazie, nie mockowi.

### AC5 — po restore żaden ambiguous write nie jest powtórzony

**Spełnione. Najważniejsze kryterium tego taska.**

Restore jest najniebezpieczniejszym momentem w życiu systemu, i powód jest
konkretny: odtworzona baza to zdjęcie **przeszłości**, a świat zewnętrzny szedł
dalej. Akcja w stanie `EXECUTING` opisuje wywołanie providera, którego wyniku nikt
nie zapisał — a receipt mógł być w odrzuconej części historii.

**Kuszący i błędny ruch** to requeue wszystkiego: lease'y są oczywiście stale,
workery oczywiście nie istnieją. To rozumowanie jest **poprawne dla jobów i
katastrofalne dla akcji.**

Dlatego klasyfikacja jest **asymetryczna**:

| Klasa | Działanie |
|---|---|
| job z leasem | zwolnij, `PENDING` — side effecty pilnuje ledger i outbox, które są w snapshocie |
| akcja `EXECUTING` | → `AMBIGUOUS`, **koniec**. Nigdy `PROPOSED` (to byłby blind replay), nigdy `FAILED` (to twierdziłoby „brak efektu") |
| refresh credentiala | raportowany, **nie ponawiany** |
| watch | raportowany, **nie odnawiany** |
| `DEAD_LETTER` | bez zmian |

**Kolejność jest load-bearing:** akcje są przytrzymywane **przed** requeue jobów.
Odwrotnie worker mógłby podnieść joba i dosięgnąć akcji nadal w `EXECUTING`,
zostawiając guard `NOT_EXECUTABLE` w executorze jako **ostatnią** linię obrony.

Fencing token **nie jest cofany** — nauka `CTF-005`: monotonicznego faktu nie wolno
rewindować.

### AC6 — rollback nie cofa destrukcyjnie danych/migracji

**Spełnione, i to jako właściwość TYPU, nie zdania w dokumencie.**

`planRollback` **nie ma jak wyrazić** rewersji migracji — nie ma opcji
`revertMigrations`, nie ma kroku `migrateDown`. Runbookowe zdanie „nie uruchamiaj
`migrateDown`" nie da się mutation-testować i jest dokładnie tym zdaniem, które
operator pomija o 3 w nocy.

`IRREVERSIBLE_MIGRATIONS` nazywa cztery migracje i **dla każdej podaje, co jej
`down` niszczy**. Najbardziej samobójcza jest `032`: usuwa `retention_runs`, czyli
zapis o tym, że dane zostały zniszczone.

Migracje idą **przed** kodem. Odwrotnie nowa wersja startuje na starym schemacie i
pada na pierwszym zapytaniu. Okno między krokami ma nowy schemat i stary kod, co
działa dopóki każda migracja jest addytywna — i `assertRollbackSafe` to
**sprawdza**, traktując migrację **nieklasyfikowaną** jako obawę, nie jako zaliczenie
(`CTF-010` finding 4).

### AC7 — Discord, watches/webhooks i secrets mają udokumentowany recovery order

**Spełnione.** `RUNBOOK.md` §6, dziewięć kroków, **kolejność a nie lista**, każdy z
uzasadnieniem zależności.

Dwa najmniej oczywiste, więc zapisuję je tu:

- **kill switch jest krokiem 1**, przed czymkolwiek innym: odtworzona baza zawiera
  akcje `AMBIGUOUS`, a worker, który wstanie wcześniej, może zacząć od efektu
  zewnętrznego;
- **Discord jest krokiem 8, nie 1**, choć to kanał kontrolny właściciela. Właściciel
  **może** czytać status w każdej chwili (odczyt nigdy nie był zatrzymany), ale
  gateway wysyłający pytania decyzyjne dla nieuzgodnionych case'ów tworzy zgody na
  akcje, których stanu nie znamy.

## 4. Cztery cykle cross-stack — zmierzone, nie przewidziane

CDK odmówił synth **czterokrotnie**, i każda odmowa czegoś nauczyła. Zapisuję to,
bo dwie „oczywiste" naprawy **przesunęły** cykl, nie usunęły go — co wyglądało jak
postęp.

```text
1. ALB security group referujące workload group między stackami
   → przeniesiona do network stacku, gdzie mieszka jej peer
2. secret.grantRead(role) / bucket.grantReadWrite(role) mutują TEŻ resource policy
   → statements po stronie ROLI (wystarczające w tym samym koncie)
3. auto-tworzona execution role ECS dostała ten sam resource-side grant
   → jedna jawna execution role
4. EcsSecret.fromSecretsManager grantuje na resource policy NIEZALEŻNIE od tego
   → secret importowany po ARN; import nie ma resource policy do zmutowania
```

Próby 2 i 3 przesunęły cykl. To jest nauka: w CDK „grant" jest dwustronny, a
kierunek referencji między stackami jest tym, co decyduje.

## 5. Findingi tego audytu

### DEFEKT ZNALEZIONY WŁASNYMI POLICY CHECKAMI

Auto-generowany sekret credentiala bazy miał `DeletionPolicy: Delete`, podczas gdy
sama instancja miała `Retain`. To **najgorsza z możliwych kombinacji**: `cdk destroy`
zostawia bazę działającą (dobrze) z usuniętym jedynym credentialem (bezużytecznie),
więc zachowane dane są nieosiągalne bez resetu hasła przez API RDS.

Nie znalazłem tego czytając kod. Znalazł to check `stateful-retained`, który
napisałem w tym samym tasku — co jest najlepszym argumentem za tym, że checki
czytają template, a nie intencję autora.

Naprawione przez L1 escape hatch, bo `Credentials.fromGeneratedSecret` nie wystawia
własnego removal policy.

### `CTF-016` — `hookTimeout` na 10s przy `testTimeout` 120s

Wykryty w **dwóch z trzech** przebiegów bramki. `vitest.config.ts` podnosił
`testTimeout` do 120s i zostawił `hookTimeout` na domyślnych 10s, podczas gdy suity
integracyjne **usuwają** bazę PostgreSQL w teardownie — co w pełnym przebiegu czeka
za połączeniami innych workerów.

Objaw to `Hook timed out in 10000ms` na **losowej** suicie, czyli najgorszy kształt
flake'a: wskazuje winnego, który nim nie jest. Zamknięty; cztery kolejne przebiegi
zielone.

### `CTF-017` — `process-runner` czytał żywotność wnuka raz, bez pollingu

Ta sama klasa co `CTF-003` i **w tym samym pliku**: jednorazowy odczyt tam, gdzie
potrzebny jest polling. Fix `CTF-003` dodał pętlę na **powstanie** `child.pid` i
zostawił asercję na **zniknięcie procesu** bez niej, dwie linie niżej.

Nauka, którą zapisałem w rejestrze: **naprawa pollingu w jednym miejscu pliku nie
jest naprawą wzorca w tym pliku.** Przy zamykaniu flake'a warto przejrzeć pozostałe
asercje tego samego testu.

## 6. Mutation checki

`AGENTS.md` wymaga mutation checku dla każdego mechanizmu bezpieczeństwa.
Uruchomione **52** mutacje w dziewięciu modułach:

```text
infra (33):    data-stack, network egress, IAM separation, health probes,
               ingress narrowing, queue/alarmy, promotion boundaries,
               oraz same policy checks
restore (19):  status akcji, lease'y, fencing token, zegar, ordering, locking,
               atomowość, oraz plan deployu/rollbacku
```

Wszystkie czerwone i przywrócone do zielonego, **z wyjątkiem trzech, które są
NIEOSIĄGALNE** — i to jest część, którą warto przeczytać:

1. `storageEncrypted: false` — CDK **wymusza** `StorageEncrypted: true`, gdy ustawiony
   jest klucz KMS. Sondowałem template, bo musiałem wiedzieć, czy check jest słaby,
   czy mutacja nieosiągalna. Zapisane w kodzie.
2. `FOR UPDATE` usunięty z zapytań restore — zwykły `UPDATE` w tej transakcji **już**
   bierze lock wiersza, więc współbieżny `FOR UPDATE NOWAIT` dostaje `55P03` tak czy
   inaczej. Sondowane osobnym testem, potem usunięte. Klauzula zostaje, bo czyni
   intencję czytelną i trzyma lock od momentu **odczytu**.

**Osiem mutacji początkowo przeżyło, i siedem z nich ujawniło słaby test mój
własny:**

- trzy asercje policy checków były postaci „violations jest puste", co **pozostaje
  prawdą, gdy checker zostanie wypatroszony**. Teraz każdy check dostaje template,
  który **musi** go naruszyć, plus przypadki przeciwne, żeby nie był nadwrażliwy;
- grant sekretów workera asertowałem szukając stringa `connection-jira` — ale
  referencje cross-stack syntetyzują się jako tokeny `Fn::ImportValue`, więc literał
  **nigdy się nie pojawia**. Mutacja dająca workerowi wszystkie siedem sekretów
  przeszła. Teraz asercja na **liczbie** ARN-ów;
- fixture `DEAD_LETTER` nie miał `lease_owner`, więc klauzula `lease_owner IS NOT
  NULL` wykluczała wiersz **niezależnie** od filtra statusu. Mutacja poszerzająca
  filtr przeszła;
- zegar bazy vs zegar procesu — nic nie odczytywało zapisanej wartości.

Zapisuję to szczegółowo, bo to najużyteczniejsza rzecz z tego audytu: **pierwsza
wersja wszystkich siedmiu testów przechodziła i wyglądała na dokładną.**

## 7. Czego ten task NIE zrobił

Zapisane jawnie, bo „nie wspomniane" czyta się jak „pokryte". Wymóg planu:
„brak Dockera musi być jawnie odnotowany, jeśli blokuje weryfikację — nie pomijany
milczeniem".

1. **Żadnego deploymentu, żadnego wywołania AWS.** `cdk deploy`,
   `restore-db-instance` i sandbox smoke test wymagają **jawnej, odrębnej zgody
   właściciela** (wymóg taska). Synth i policy checks są w pełni zweryfikowane.
2. **Mechanizm restore AWS nie był ćwiczony** — patrz AC4. Ćwiczona jest część
   decydująca o duplikacie zapisu.
3. **Container scanning: NIE.** Docker zepsuty na tej maszynie. SBOM jest
   (270 komponentów, wszystkie z hashami integralności), skan obrazu nie.
4. **`pnpm audit` celowo NIE jest bramką.** Wymaga sieci i zwraca inną odpowiedź
   każdego dnia; build padający, bo w nocy opublikowano advisory, nie jest buildem
   odtwarzalnym. Zamiast tego `dependency-audit.ts` sprawdza właściwości
   **decydowalne z lockfile'a** bez sieci: hash integralności dla każdego komponentu,
   brak zależności git/tarball/`file:`, kompatybilność engine. Każda z nich jest
   właściwością tego, **co się zainstaluje**, więc każda legalnie jest bramką.
5. **Region/service failure simulation** — na poziomie runbooka, nie ćwiczona.
6. **Certyfikat ACM i ID kont to placeholdery.** Świadomie: synth, którego wynik
   zależy od tego, kto go uruchamia, nie da się zdiffować. Właściciel podstawia
   wartości jako **recenzowalną zmianę**.
7. **`exactOptionalPropertyTypes` wyłączony dla `infra/cdk`** — z zapisanym
   uzasadnieniem w tsconfigu. `aws-cdk-lib` deklaruje własne interfejsy `I*` z
   **wymaganymi** polami, których implementacje są `T | undefined`, więc przekazanie
   `Vpc` tam, gdzie oczekiwany jest `IVpc`, jest błędem typu. Każde obejście wstawia
   `as unknown as` w każdym punkcie wiring — co jest gorsze, bo ukrywa realne
   niezgodności. Flaga pozostaje włączona dla wszystkich 19 pakietów aplikacji.

## 8. Zgodność z zasadami implementacji

- **Kontrakty i architektura** — bez zmian bez ADR. `packages/policy`,
  `ACTION_REGISTRY` i istniejące migracje **nietknięte**; `deployment.ts` i
  `restore.ts` to nowe moduły, nie modyfikacje.
- **Model nie jest warstwą autoryzacji** — RA-025 nie dodaje żadnego callera
  `evaluatePolicy`.
- **Sekrety** — żaden nie występuje w template. Credential bazy jest generowany
  przez Secrets Manager i wstrzykiwany jako **referencja**, nigdy jako plaintext env
  (co byłoby czytelne dla każdego z `ecs:DescribeTaskDefinition`); test to asertuje.
- **Idempotencja** — `reconcileAfterRestore` jest idempotentna, sprawdzone testem:
  drugi przebieg nie zmienia niczego.
- **Jeden writer** — jeden task executora i jeden gateway Discorda, i to
  **poprawność, nie skalowanie**: drugi gateway odbierałby każdą interakcję dwa razy.
- **Komentarz nie jest dowodem** — trzy findingi tego audytu (`hookTimeout`,
  `process-runner`, sekret bazy) wykryła uruchomiona komenda, nie przegląd.

## 9. Werdykt

Wszystkie siedem kryteriów akceptacji spełnione, każde z uruchomioną komendą i
podanym exit code. AC3 i AC4 spełnione z **jawnie zapisanymi** ograniczeniami (§7):
żadnego deploymentu ani wywołania AWS, zgodnie z wymogiem taska, że real deploy
wymaga odrębnej zgody właściciela.

Dwa nowe findingi przekrojowe, oba **zamknięte w tym tasku** (`CTF-016`, `CTF-017`).
Zero BLOCKER, zero HIGH, zero MEDIUM.

Bramka „całe repo zielone" jest teraz stabilna na poziomie, jakiego ten projekt
jeszcze nie miał: 2264 testy, **cztery** kolejne przebiegi, zero faili, zero
`Errors` — po zamknięciu dwóch ostatnich znanych flake'ów harnessu.

- Werdykt: `PASS`
