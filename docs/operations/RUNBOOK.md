# RemoteAgent — runbook operatorski

- Task: `RA-025-WU-10` (AC3, AC7)
- Ustalone: `2026-08-22`
- Bramka: `pnpm vitest run test/infra`
- Wymóg `RA-026` AC4: **świeży operator wykonuje start, stop, restore i credential
  revoke z tego dokumentu**, bez pytania autora.

## Zasada nadrzędna tego dokumentu

Każda procedura poniżej podaje **komendę i oczekiwany wynik**, nie opis intencji.
Runbook, który mówi „zweryfikuj, że system działa", jest bezużyteczny o 3 w nocy.

Trzy rzeczy, których ten runbook **nigdy** nie każe zrobić, bo są nieodwracalne albo
niszczą dowody:

1. **Nie uruchamiaj `migrateDown` w ramach rollbacku aplikacji.** Rollback jest
   code-only. `planRollback` nie ma jak wyrazić rewersji migracji — to właściwość
   typu, nie zdanie w dokumencie.
2. **Nie powtarzaj automatycznie zapisu w stanie `AMBIGUOUS`.** Provider mógł już
   go przyjąć. Rozstrzyga `reconcileAmbiguousAction`, który **czyta** providera.
3. **Nie ponawiaj przerwanego refreshu credentiala.** Provider mógł już wydać nowy
   token i unieważnić stary; retry niszczy nowy, a system zostaje bez żadnego.

## 0. Prerequisites (AC3 — fresh environment)

Wymagane **przed** pierwszym deployem. Wszystko poza punktem 1 jest w repozytorium.

| # | Wymóg | Dlaczego nie jest w kodzie |
|---|---|---|
| 1 | Trzy konta AWS (`dev`, `drill`, `prod`) i ich ID w `infra/cdk/src/config.ts` | Granicą promocji jest **konto**, nie prefiks nazwy. Prefiks nikogo nie zatrzymał przed wpisaniem złego `--profile` |
| 2 | Certyfikat ACM per środowisko, ARN w `config.ts` | Walidacja DNS wymaga hosted zone, której ta aplikacja nie posiada; tworzenie go w synth uzależniłoby synth od stanu DNS i złamało AC1 |
| 3 | Obraz kontenera w ECR pod tagiem, który podasz jako `imageTag` | Docker jest zepsuty na maszynie deweloperskiej (`AGENTS.md`); build i deploy są **osobnymi** krokami, co jest zresztą lepszym kształtem |
| 4 | `cdk bootstrap` na każdym koncie | Jednorazowo, per konto/region |
| 5 | Wartości credentiali w siedmiu sekretach `ra-<env>-data-connection-*` | Same sekrety tworzy CDK; **wartości wprowadza właściciel**, nigdy IaC — inaczej trafiłyby do historii gita |

Weryfikacja gotowości, bez wdrażania czegokolwiek:

```bash
. scripts/dev/env.sh
pnpm vitest run test/infra          # 78 testów: synth + policy checks + restore drill
```

## 1. Deploy

**Kolejność jest decyzją:** migracje **przed** kodem. Odwrotnie nowa wersja
startuje na starym schemacie i pada na pierwszym zapytaniu. Tak — okno między
krokami ma nowy schemat i stary kod, co działa, dopóki każda migracja jest
addytywna (i to jest sprawdzane, nie założone).

```bash
# 1. Stan wyjściowy. Deploy, który nie wie, skąd startuje, nie ma jak wrócić.
pnpm --filter @remoteagent/database db:status

# 2. Migracje. Advisory lock + checksum drift + transakcja per migracja.
RA_DATABASE_URL=<env> pnpm --filter @remoteagent/database db:migrate

# 3. Kod.
pnpm --filter @remoteagent/infra-cdk exec cdk deploy \
  --context environment=<env> --context imageTag=<tag> --all

# 4. Weryfikacja: READINESS, nie liveness.
curl -fsS https://<alb>/readyz     # oczekiwane: {"state":"UP"}
```

Krok 4 używa readiness **celowo**: readiness zależy od PostgreSQL-a, więc dowodzi,
że nowy kod dosięga zmigrowanego schematu. Liveness przeszedłby, nawet gdyby nie
dosięgał.

## 2. Rollback

```bash
pnpm --filter @remoteagent/infra-cdk exec cdk deploy \
  --context environment=<env> --context imageTag=<PREVIOUS-tag> --all
curl -fsS https://<alb>/readyz
```

**To wszystko.** Schemat zostaje **dokładnie** taki, jaki jest.

Migracje `029`, `030`, `031` i `032` mają destrukcyjne skrypty `down` —
`IRREVERSIBLE_MIGRATIONS` podaje dla każdej, co konkretnie niszczy. Najbardziej
samobójcza jest `032`: jej `down` usuwa `retention_runs`, czyli **zapis o tym, że
dane zostały zniszczone**. Rewersja którejkolwiek jest osobną operacją na danych,
za zgodą właściciela, nigdy częścią rollbacku aplikacji.

ECS ma włączony circuit breaker z rollbackiem, więc task, który nie przechodzi
health checku, cofa serwis do poprzedniej definicji **automatycznie**. Ten cofnięcie
jest code-only, tak samo jak powyższe.

## 3. Stop — kill switch (AC6)

Zatrzymuje **efekty zewnętrzne**, zachowując odczyt i dowody. Nie jest to wyłączenie
systemu i celowo nie powinno nim być: w trakcie incydentu potrzebujesz czytać audit
log i uzgadniać akcje.

```sql
INSERT INTO kill_switch_events (event_id, scope_level, enabled, reason, changed_by)
VALUES (gen_random_uuid()::text, 'GLOBAL', true, '<powód>', '<operator>');
```

Poziomy: `GLOBAL`, `PROVIDER` (wymaga `provider`), `CONNECTION` (wymaga `owner_id`,
`provider`, `connection_id`). Tabela jest append-only — zdjęcie stopu to **nowy
event** z `enabled = false`, nie `UPDATE`.

Co dokładnie się dzieje, dowiedzione drillem
(`test/security/kill-switch-drill.test.ts`, 13 testów przeciwko realnemu executorowi):

| Zachowanie | Stan |
|---|---|
| adapter providera **nie jest wywołany** | licznik wywołań = 0, nie tylko „odmowa" |
| akcja **nie** przechodzi w `EXECUTING` | zostaje `APPROVED` |
| zgoda właściciela **nie jest zużyta** | `consumed = false` |
| `audit_log` czytelny **i zapisywalny** | inaczej sam drill byłby nieudokumentowany |
| liveness i readiness **bez zmiany** | stop nie jest awarią procesu |

Zdjęcie stopu:

```sql
INSERT INTO kill_switch_events (event_id, scope_level, enabled, reason, changed_by)
VALUES (gen_random_uuid()::text, 'GLOBAL', false, '<powód>', '<operator>');
```

Uwaga: akcja zaproponowana **przed** stopem nie wykona się po zdjęciu na starej
evaluacji — dostanie `POLICY_CHANGED` i wymaga ponownej propozycji. To jest
zamierzone: świat zmienił się dwa razy pod zgodą właściciela.

## 4. Credential revoke

```sql
-- 1. Zablokuj connection natychmiast. Guard RA-005 odmawia każdego efektu.
UPDATE connections
   SET health_status = 'REVOKED', oauth_revoked_at = now(), last_health_check_at = now()
 WHERE connection_id = '<id>' AND health_status <> 'REVOKED';

-- 2. Zapisz to. Destrukcyjna operacja bez atrybucji nie jest audytowalna.
INSERT INTO audit_log (actor, action, outcome, target_kind, target_id, detail)
VALUES ('<operator>', 'connection.revoked', 'SUCCESS', 'connections', '<id>',
        jsonb_build_object('reason', '<powód>'));
```

Potem unieważnij credential **u providera** i wprowadź nowy do
`ra-<env>-data-connection-<slug>`.

Kolejność jest istotna: najpierw baza, potem provider. Odwrotnie — między
unieważnieniem u providera a zapisem w bazie — system uważa connection za zdrowy i
próbuje go użyć, produkując błędy zamiast czystej odmowy.

## 5. Restore (AC4, AC5)

**Najniebezpieczniejszy moment w życiu systemu.** Odtworzona baza to zdjęcie
przeszłości; świat zewnętrzny szedł dalej.

```bash
# 1. Odtwórz do OSOBNEGO środowiska. Nigdy w miejsce działającego.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier ra-dev-data-postgres \
  --target-db-instance-identifier ra-drill-data-postgres \
  --restore-time <ISO8601> --profile ra-drill

# 2. Uzgodnij. JEDNA transakcja: albo wszystko, albo nic.
RA_DATABASE_URL=<drill> node -e "
  const { Database, reconcileAfterRestore } = require('@remoteagent/database');
  ..."   # zob. reconcileAfterRestore

# 3. Sprawdź dowody PRZEZ LICZBY. Pusta baza odpowiada na każde zapytanie.
#    verifyRestoredEvidence(db, { cases, checkpoints, auditEntries, receipts })
```

Co robi uzgodnienie, **asymetrycznie** i celowo:

| Klasa | Działanie | Dlaczego |
|---|---|---|
| job z leasem | zwolnij lease, `PENDING` | Każdy lease w snapshocie jest stale **z definicji** — trzymał go proces, który nie istnieje. Side effecty joba pilnuje ledger i outbox, które są w snapshocie |
| akcja `EXECUTING` | → `AMBIGUOUS`, **koniec** | Provider mógł już skomentować issue albo zmergować MR, a receipt był w odrzuconej części historii |
| akcja `AMBIGUOUS` | zostaje, raportowana osobno | Wymaga `reconcileAmbiguousAction`, który **czyta** providera i dopasowuje idempotency key |
| refresh credentiala | raportowany, **nie ponawiany** | Retry niszczy token, który provider mógł już wydać |
| watch/webhook | raportowany, **nie odnawiany** | Odnowienie to wywołanie providera; ta funkcja nie robi żadnego |
| job `DEAD_LETTER` | bez zmian | Wyczerpał wszystkie retry; wskrzeszenie ponowiłoby przyczynę |

Fencing token **nie jest cofany** — to nauka `CTF-005`: monotonicznego faktu nie
wolno rewindować.

Niepusta lista `heldActions` po restore jest **normalna** i nie jest błędem. To
uczciwy stan: tyle zapisów ma nieustalony wynik.

## 6. Recovery order po restore (AC7)

**Kolejność, nie lista.** Każdy krok zależy od poprzedniego, a odwrócenie dwóch
pierwszych powoduje zapisy do providerów, których nikt jeszcze nie sprawdził.

```
1. KILL SWITCH ON (GLOBAL)
   Zanim cokolwiek wystartuje. Odtworzona baza zawiera akcje `AMBIGUOUS`, a worker,
   który wstanie przed tym krokiem, może zacząć od efektu zewnętrznego.

2. SECRETS
   Wprowadź wartości do siedmiu sekretów. Nic inne nie zadziała bez nich, a próba
   użycia pustego sekretu wygląda jak awaria providera.

3. reconcileAfterRestore
   Jedna transakcja. Zwolnij lease'y, przytrzymaj akcje.

4. verifyRestoredEvidence
   Liczby, nie „baza odpowiada".

5. reconcileAmbiguousAction dla KAŻDEJ akcji z `heldActions`
   Czyta providera, dopasowuje idempotency key. Ręcznie i świadomie, jedna po
   drugiej. To jedyny krok, który może rozstrzygnąć `AMBIGUOUS`.

6. CREDENTIAL REFRESH — ręcznie, po sprawdzeniu u providera
   Dla każdego wpisu z `heldCredentialRefreshes`: sprawdź NAJPIERW, czy provider
   już wydał nowy token. Dopiero potem odnów.

7. WATCH / WEBHOOK RE-REGISTRATION
   Dla każdego z `staleWatches`. Do tego momentu **żaden event nie przychodzi** —
   to cicha awaria, którą właśnie dlatego pilnuje alert `renewals.failed`.

8. DISCORD
   Gateway wstaje ostatni. Wcześniej właściciel widziałby pytania decyzyjne dla
   case'ów, których stan nie jest jeszcze uzgodniony.

9. KILL SWITCH OFF
   Dopiero teraz. Wcześniej nie ma sensu: kroki 1-8 nie potrzebują efektów
   zewnętrznych, a krok 5 celowo tylko czyta.
```

Dlaczego Discord jest ósmy, a nie pierwszy, choć to kanał kontrolny: właściciel
**może** czytać status w każdej chwili (odczyt nigdy nie był zatrzymany), ale
gateway wysyłający pytania decyzyjne dla nieuzgodnionych case'ów tworzy zgody na
akcje, których stanu nie znamy.

## 7. Alerty — co robić

Cztery klasy z `RA-024`, każda z runbookiem **w kodzie**
(`packages/observability/src/alerts.ts`), żeby nie rozjechał się z progiem.

| Alarm | Pierwszy ruch |
|---|---|
| `dlq` (CRITICAL) | `JobStore.listDeadLettered` → `attemptHistory` → napraw przyczynę → requeue **świadomie**. **Nie** requeue masowo: job, który dead-letterował po częściowym efekcie zewnętrznym, wymaga najpierw uzgodnienia z providerem |
| `renewal-failure` (CRITICAL) | Sprawdź health i expiry connection. **Niejednoznaczny zapis credentiala nie jest ponawiany automatycznie** |
| `stale-lease` (WARNING) | Reaper requeue'uje sam. Alarm jest o **wzorcu**: powracający stale lease znaczy, że workery umierają, nie kończą |
| `cost-anomaly` | Porównaj `model.invocations` z `actions.succeeded`. Wysoki stosunek = tool loop retry'uje bez zbieżności. Kill switch zatrzymuje efekty natychmiast |
| `no-heartbeat` | Jedyny alarm, dla którego brak metryki **sam jest awarią**. Sprawdź ECS events, potem `/readyz` — awaria bazy czyni workery `UNREADY`, ale nadal `ALIVE` |

## 8. Czego ten runbook nie obejmuje

Zapisane jawnie, bo „nie wspomniane" czyta się jak „pokryte".

1. **Realny deploy nie został wykonany.** Żadnego wywołania AWS w tym tasku. Synth i
   policy checks są w pełni zweryfikowane; `cdk deploy`, `restore-db-instance` i
   sandbox smoke test wymagają **jawnej, odrębnej zgody właściciela**.
2. **Mechanizm restore AWS nie był ćwiczony.** Drill weryfikuje część, która decyduje,
   czy zapis wykona się dwa razy — czyli dokładnie AC5 — przeciwko realnemu
   PostgreSQL-owi. Sam PITR snapshot do świeżego konta nie.
3. **Container scanning.** Docker zepsuty na tej maszynie; SBOM jest
   (`scripts/security/sbom.ts`), skan obrazu nie.
4. **Region/service failure simulation** — na poziomie tego runbooka, nie ćwiczona.
