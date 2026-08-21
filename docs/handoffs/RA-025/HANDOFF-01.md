# RA-025 — HANDOFF-01

- Task: `RA-025` AWS deployment and disaster recovery
- Data: `2026-08-22`
- Bazowy commit: `d461958`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Najważniejsze w jednym zdaniu

**`cdk synth` nie potrzebuje credentiali AWS ani sieci** — zmierzone **zanim**
napisałem jakikolwiek stack — co zamieniło AC1 i AC2 z „do sprawdzenia w pipeline"
w kryteria z uruchomioną komendą, i zdeterminowało cały projekt taska.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `infra/cdk/src/config.ts` | trzy środowiska; wszystko, co mogłoby się różnić w synth, jest tu |
| `infra/cdk/src/network-stack.ts` | VPC, egress 443-only, VPC endpoints, flow logs; **wszystkie** reguły SG-do-SG tutaj |
| `infra/cdk/src/data-stack.ts` | PostgreSQL z PITR, S3 z lifecycle, KMS, siedem sekretów connection |
| `infra/cdk/src/queue-stack.ts` | SQS + transport DLQ + **cztery alarmy AC4** + heartbeat |
| `infra/cdk/src/compute-stack.ts` | trzy task role z **rozłącznymi** grantami + jedna execution role |
| `infra/cdk/src/ingress-stack.ts` | ALB HTTPS-only, webhook ingress; najwęższa rola w systemie |
| `infra/cdk/src/policy-checks.ts` | checki nad **zsyntetyzowanym template**, nie nad drzewem konstruktów |
| `packages/database/src/deployment.ts` | migracje jako krok deployu; **rollback bez `migrateDown`** |
| `packages/database/src/restore.ts` | uzgodnienie po restore; asymetryczne (AC5) |
| `scripts/security/dependency-audit.ts` | deterministyczne checki z lockfile'a, bez sieci |
| `docs/operations/RUNBOOK.md` | start/stop/rollback/restore/revoke + **recovery order** |
| `test/infra/**` (3 pliki, 100 testów) | synth, policy checks, restore drill, dependency audit |

## Bramka

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run     2264/2264, 158 plików, CZTERY przebiegi, exit 0
RA_REQUIRE_POSTGRES=1 … test/infra         100/100, 3 pliki, exit 0
pnpm run lint / format                     exit 0
node …/tsc.js -p tsconfig.json --noEmit    exit 0
pnpm run typecheck --force                 36 successful, 0 cached
pnpm run build --force                     26 successful, 0 cached
git diff --check                           exit 0
```

Mutation checki: **52** mutacje, wszystkie czerwone poza trzema **nieosiągalnymi**
(udowodnionymi sondą, nie założonymi).

**Żadnego wywołania AWS. Żadnego deploymentu. Żadnych credentiali.**

## Findingi

| ID | Severity | Status |
|---|---|---|
| `CTF-016` | LOW | **ZAMKNIĘTY** — `hookTimeout` 10s przy `testTimeout` 120s |
| `CTF-017` | LOW | **ZAMKNIĘTY** — `process-runner` bez pollingu na zniknięcie procesu |

Plus jeden defekt **znaleziony własnymi policy checkami i naprawiony**:
auto-generowany sekret credentiala bazy miał `DeletionPolicy: Delete`, gdy instancja
miała `Retain` — `cdk destroy` zostawiłby działającą bazę z usuniętym jedynym
credentialem.

## Wejściowe ustalenia dla RA-026

Rzeczy, których RA-026 nie wyczyta z kodu.

1. **Bramka „całe repo zielone" jest teraz stabilna.** 2264 testy, cztery kolejne
   przebiegi, zero faili, zero `Errors`. Po `CTF-016` i `CTF-017` **nie ma znanych
   otwartych flake'ów harnessu** — pierwszy raz w tym projekcie. `CTF-003`, `CTF-007`
   i `CTF-012` są zamknięte i zdiagnozowane, nie „nie reprodukują się". Nadal podawaj
   **liczbę przebiegów**: wniosek `CTF-003` nie wygasa.
2. **AC5 (release manifest) ma teraz źródła dla trzech z pięciu pól:**
   - schema: `deploymentSchemaState(db).highestApplied` → `32`;
   - dependencies: `scripts/security/sbom.ts --json` (deterministyczny; `RA_SBOM_SERIAL`
     i `RA_SBOM_TIMESTAMP` czynią go odtwarzalnym w CI);
   - IaC: commit + `imageTag`, bo `buildApp` jest czystą funkcją swoich wejść.
   Brakuje wersji **modelu** i **promptów**. Uwaga z planu RA-026 nadal obowiązuje:
   tożsamość modelu zmieniła się w trakcie budowy (ADR-0004 → ADR-0005), więc manifest
   musi to odzwierciedlać, a nie udawać jednorodność.
3. **AC4 (świeży operator wykonuje start/stop/restore/revoke z runbooka)** —
   `docs/operations/RUNBOOK.md` jest napisany pod ten wymóg: każda procedura ma
   **komendę i oczekiwany wynik**, nie opis intencji. Sekcja 8 wymienia jawnie, czego
   runbook **nie** obejmuje. Zweryfikuj go **czytając jak operator**, nie jak autor —
   to jedyny sposób, w jaki ten wymóg da się sprawdzić.
4. **AC1 §13.9 („backup/restore oraz kill switch sprawdzone ćwiczeniem")** —
   kill switch drill jest **wykonany** (RA-024, 13 testów przeciwko realnemu
   executorowi). Restore drill jest wykonany **dla części decydującej o duplikacie
   zapisu**, przeciwko realnej bazie; sam PITR snapshot do świeżego konta **nie**.
   To jest granica, którą RA-026 musi ocenić, a nie odziedziczyć jako zaliczoną.
5. **Trzy rzeczy zakresu RA-025 pozostają niewykonane i mają uzasadnienia**
   (`AUDIT-01` §7): container scanning (Docker zepsuty), region/service failure
   simulation (poziom runbooka), i realny deploy (wymaga zgody właściciela).
   `pnpm audit` **celowo** nie jest bramką — uzasadnienie w §7.4, i to jest decyzja
   projektowa, nie brak.
6. **`CTF-014` i brak utrwalenia `PolicyEvaluation.evidence`** (oba z RA-024)
   pozostają otwarte i **oba dotykają AC8** RA-026. To najważniejsze dwie rzeczy do
   oceny przed `PASS` całego projektu — patrz `HANDOFF-01` RA-024 §4.

## Ślepe uliczki i rzeczy, które okazały się nieprawdą

Najużyteczniejsza część tego handoffu.

1. **CDK odmówił synth CZTERY razy, i dwie „oczywiste" naprawy przesunęły cykl
   zamiast go usunąć.** `secret.grantRead(role)` mutuje **też** resource policy — więc
   granty po stronie roli. Potem auto-tworzona execution role ECS dostała ten sam
   resource-side grant — więc jawna execution role. Potem
   `EcsSecret.fromSecretsManager` grantuje na resource policy **niezależnie** — więc
   import sekretu po ARN. W CDK „grant" jest dwustronny, a kierunek referencji między
   stackami jest tym, co decyduje.
2. **`exactOptionalPropertyTypes` jest niekompatybilny z `aws-cdk-lib`.** Nie moim
   błędem: biblioteka deklaruje własne interfejsy `I*` z **wymaganymi** polami, których
   implementacje są `T | undefined`. Wyłączone **tylko** dla `infra/cdk`, z
   uzasadnieniem w tsconfigu; wszystkie inne strict checki zostają.
3. **`secretName` na konstrukcie `Secret` jest TOKENEM, nie literałem.**
   `secretName.endsWith("connection-discord")` jest **zawsze** false. Ujawnił to
   fail-closed guard w `ComputeStack`, który rzucił własny błąd — co jest jedynym
   powodem, dla którego to zauważyłem, zamiast po cichu nie nadać uprawnienia.
   Dlatego sekrety są kluczowane jawnym `slug` z typem literalnym.
4. **Ta sama pułapka trafiła moje TESTY.** Asercje szukające `connection-jira` w
   template konsumującym są zawsze fałszywe, bo referencje cross-stack to
   `Fn::ImportValue`. Mutacja dająca workerowi wszystkie siedem sekretów **przeszła**.
   Teraz asercje na **liczbie** ARN-ów.
5. **Trzy policy checki miały tylko asercje „violations jest puste"**, co pozostaje
   prawdą, gdy checker zostanie wypatroszony. Mutacje wyłączające trzy z nich
   przeszły. Każdy check dostaje teraz template, który **musi** go naruszyć, plus
   przypadek przeciwny.
6. **Fixture `DEAD_LETTER` nie miał `lease_owner`**, więc klauzula
   `lease_owner IS NOT NULL` wykluczała go **niezależnie** od filtra statusu — i
   mutacja poszerzająca filtr przeszła. Fixture, który nie dociera do warunku, testuje
   ten warunek pozornie.
7. **Dwie mutacje są NIEOSIĄGALNE, i to trzeba było sprawdzić sondą, nie założyć.**
   CDK wymusza `StorageEncrypted: true`, gdy ustawiony jest klucz KMS. Zwykły `UPDATE`
   bierze lock wiersza, więc usunięcie `FOR UPDATE` nie zmienia zachowania
   współbieżnego (`55P03` tak czy inaczej). Obie zapisane w kodzie — „przeżyła mutacja"
   bez wyjaśnienia to gorsza informacja niż brak mutacji.
8. **`CTF-017` jest tym samym wzorcem co `CTF-003`, w tym samym pliku, dwie linie
   niżej.** Fix `CTF-003` dodał polling na **powstanie** pliku i zostawił asercję na
   **zniknięcie procesu** bez niego. Naprawa pollingu w jednym miejscu pliku **nie**
   jest naprawą wzorca w tym pliku.

## Stan drzewa

Czyste. Zacommitowane w logicznych commitach. `push`, MR i merge **nadal wymagają
osobnej zgody**. Żaden deploy nie został wykonany.
