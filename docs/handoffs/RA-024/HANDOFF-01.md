# RA-024 — HANDOFF-01

- Task: `RA-024` Security, privacy and observability hardening
- Data: `2026-08-21`
- Bazowy commit: `03b252a`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Najważniejsze w jednym zdaniu

**Dwie bramki repozytorialne były czerwone na `main`** i obie zreprodukowałem na
czystym drzewie bazowym przed jakąkolwiek zmianą. `RA-026` opiera dowodowość na
zielonych bramkach, więc zaczynałby od dwóch czerwonych — dlatego `WU-00` istnieje.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `packages/observability/src/secret-patterns.ts` | **`CTF-006` domknięty** — jedna tabela wzorców, trzy konsumenty delegują |
| `packages/observability/src/trust-boundaries.ts` | rejestr 11 granic; kompletność sprawdzana wobec enuma `Provider` |
| `packages/observability/src/tracing.ts` | `event→case→run→tool→action→receipt`; redakcja na granicy eksportu |
| `packages/observability/src/metrics.ts` | liczniki i gauge'y; etykiety zamknięte (brak `case_id` w telemetrii) |
| `packages/observability/src/alerts.ts` | **cztery klasy AC4** jako predykaty, nie konfiguracja dashboardu |
| `packages/observability/src/health.ts` | liveness **nie** zależy od bazy; readiness zależy |
| `packages/observability/src/backpressure.ts` | concurrency + token bucket + circuit breaker; odmawiają, nie kolejkują |
| `packages/observability/src/privileges.ts` | rejestr least privilege z decyzjami over-grantów |
| `packages/database/migrations/032_retention.*.sql` | retencja, która **da się uruchomić**, z jednym wąskim wyjątkiem |
| `scripts/security/sbom.ts` | SBOM z lockfile'a, CycloneDX 1.5, deterministyczny |
| `docs/security/THREAT_MODEL.md` | AC1, sprawdzany testem w obie strony |
| `docs/security/LEAST_PRIVILEGE.md` | AC-adjacent; over-granty z kontrolami kompensującymi |
| `test/security/**` (9 plików, 266 testów) | suite przekrojowa |

## Bramka

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run     2164/2164, 155 plików, TRZY przebiegi, exit 0
RA_REQUIRE_POSTGRES=1 … test/security      266/266, 9 plików, exit 0
pnpm run lint                              exit 0   (było: 3 errors, exit 1)
pnpm run format                            exit 0
node …/tsc.js -p tsconfig.json --noEmit    exit 0   (było: RangeError, exit 1)
pnpm run typecheck --force                 36 successful, 0 cached
pnpm run build --force                     26 successful, 0 cached
git diff --check                           exit 0
```

Mutation checki: **36 mutacji** w sześciu modułach, wszystkie czerwone i przywrócone.

## Findingi zamknięte

| ID | Severity | Jak |
|---|---|---|
| `CTF-006` | HIGH | jedna tabela w `observability`; wszystkie trzy konsumenty delegują |
| `CTF-013` | MEDIUM | przyczyna to instantiation expression w `Parameters<>`, nie limit stosu |
| `CTF-008` | LOW | `argsIgnorePattern` + dwie realne poprawki; konwencja i bramka zgodne |
| `CTF-012` | LOW | zdiagnozowany: `ON CONFLICT` pokrywał jeden z **dwóch** unique constraintów |

## Findingi nowe

| ID | Severity | Decyzja |
|---|---|---|
| `CTF-014` | LOW | `defer` — push brancha case'a nie ma wpisu w `ACTION_REGISTRY`; wymaga ADR |
| `CTF-015` | LOW | `accept` nazwy, `fix` mechanizm — sześć nowych kolizji type-level |

Plus jeden defekt **naprawiony w tym tasku**: `.env.local` nie był ścieżką chronioną
(`isProtectedPath` dopasowywał `.env` jako dokładny segment).

## Wejściowe ustalenia dla RA-025

Rzeczy, które RA-025 **musi** wiedzieć i których nie wyczyta z kodu:

1. **Trzy elementy zakresu RA-024 zostały świadomie przekazane do RA-025:**
   dependency/container/IaC **scanning** (SBOM jest zrobiony), dashboardy, oraz
   eksporter/sampling OpenTelemetry. Uzasadnienia są w `AUDIT-01` §7 — najkrócej:
   `pnpm audit` wymaga sieci i zwraca inną odpowiedź każdego dnia, więc nie może być
   bramką artefaktu; container scanning wymaga Dockera, zepsutego na tej maszynie;
   IaC scanning wymaga stacków, które RA-025 dopiero tworzy.
2. **`@opentelemetry/api` jest już zależnością `observability`**, SDK **nie**.
   Podłączenie `TracerProvider` nie wymaga zmiany żadnego call site — `TraceRecorder`
   produkuje spany o kształcie W3C z tą samą strukturą parent/child/attributes.
   **Nie dodawaj SDK do `observability`**: pakiet musi zostać importowalny z każdego
   miejsca, co `CTF-006` pokazał jako własność bezpieczeństwa, nie wygodę.
3. **Progi w `DEFAULT_ALERT_THRESHOLDS` i `DEFAULT_BACKPRESSURE` są celowo niskie i
   należą do RA-025 jako konfiguracja.** Kształt jest ustalony, wartości nie.
   Uwaga na jedną: `throttleThreshold: 1` jest **decyzją**, nie placeholderem —
   provider mówiący „za szybko" nie jest szumem do uśrednienia.
4. **`liveness` NIE MOŻE zależeć od PostgreSQL-a.** Raportowanie unhealthy przy awarii
   bazy zapętliłoby restart każdego workera dokładnie wtedy, gdy jego leasy w locie i
   logi są jedynym dostępnym dowodem — zamieniając awarię odzyskiwalną w utratę
   dowodów. Jest to zapisane w kodzie **i** w teście strukturalnym (`postgres` nie
   może pojawić się w raporcie liveness).
5. **Migracja `032` wprowadza flagę transakcyjną `ra.retention_purge`.** Jeżeli
   RA-025 wprowadza role bazodanowe, `ra_retention_purge_raw_payload` jest
   `SECURITY DEFINER` i **musi** pozostać jedyną ścieżką retencji — test asertuje
   wobec `pg_proc`, że istnieją dokładnie dwie funkcje `ra_retention%`.
6. **Rollback aplikacji nie może uruchamiać `migrateDown`** (to już było ustalenie
   planu RA-025). Migracja `032` wzmacnia powód: jej `down` **najpierw** przywraca
   bezwarunkowy trigger, żeby nie istniało okno z rozluźnionym triggerem bez checków
   kolumnowych.

## Wejściowe ustalenia dla RA-026

1. **AC2 (brak otwartych BLOCKER/HIGH/MEDIUM) jest teraz spełnialny.** Po tym tasku
   rejestr nie ma **żadnego** otwartego MEDIUM ani HIGH. Otwarte: `CTF-002`
   (CZĘŚCIOWO, mechanizm), `CTF-004` (CZĘŚCIOWO), `CTF-009`, `CTF-011` (wzorzec),
   `CTF-014`, `CTF-015` — wszystkie LOW z decyzjami.
2. **AC3 (każdy LOW ma ownera i decyzję)** — kolumna „Status" w rejestrze niesie teraz
   decyzje `accept`/`defer` jawnie dla `CTF-014` i `CTF-015`. Pozostałe LOW-y wymagają
   przejrzenia i **jawnego** zapisania decyzji; nie zrobiłem tego za RA-026, bo to
   jego kryterium i wymaga oceny właściciela.
3. **Bramka „całe repo zielone" jest teraz stabilna** — 155 plików, 2164 testy, trzy
   kolejne przebiegi bez faila i bez `Errors`. `CTF-012` był ostatnim znanym flake'em
   i jest zdiagnozowany, nie „nie reprodukuje się". Nadal podawaj **liczbę
   przebiegów** w raporcie: to konsekwencja `CTF-003`, która nie wygasa.
4. **DWIE rzeczy dotykają AC8** („wszystkie R3/R4 mają policy evidence, approval i
   receipt"), i obie trzeba ocenić przed `PASS` całego projektu:

   - **`CTF-014`** — push brancha **nie jest** R3/R4, więc formalnie AC8 nie jest
     naruszone, ale jest to zapis zewnętrzny **poza** rejestrem akcji. Rekomendacja:
     opcja 2 (poprawić komentarz i zapisać realny mechanizm) przed RA-026; opcja 1
     (dodać klucz i przeprowadzić push przez executor) jako osobny task.
   - **`PolicyEvaluation.evidence` nie jest utrwalane w `audit_log`.** To zawężenie
     zakresu `WU-05` **względem mojego własnego planu**, opisane w `AUDIT-01` §7.6 i w
     `WORK_UNITS.md`. `evidence` jest produkowane i porównywane
     (`policyEvaluationsAgree`), więc TOCTOU jest zamknięte — brakuje **trwałości
     dowodu po restarcie procesu**. Luka w dowodowości, nie w autoryzacji. Wymaga
     wywołania **wewnątrz** `executeAction` i decyzji, co audytować przy odmowie, a
     nie tylko przy sukcesie.
5. **Release manifest (AC5) ma teraz źródło dla części „schema" i „dependencies":**
   najwyższa migracja to `032`, a `scripts/security/sbom.ts --json` daje
   deterministyczny SBOM (`RA_SBOM_SERIAL` i `RA_SBOM_TIMESTAMP` czynią go
   odtwarzalnym w CI).
6. **`test/security/` jest gotowym miejscem na suite akceptacyjną.** Wzorce, które
   warto powtórzyć: asercja na **kodzie** odmowy nie na klasie wyniku; licznik
   wywołań adaptera, nie zwrócony outcome; wiersz w tabeli **przed** asercją, że
   DELETE jest odrzucony.

## Ślepe uliczki i rzeczy, które okazały się nieprawdą

Najużyteczniejsza część tego handoffu.

1. **Diagnoza `CTF-013` w rejestrze była błędna.** Wpis mówił „limit stosu, nie błąd
   typów" i proponował podniesienie `--stack-size` albo rozbicie root `tsconfig.json`.
   **Obie opcje były obok przyczyny.** Winowajcą jest jedno wyrażenie typu —
   instantiation expression zagnieżdżone w `Parameters<>`. Bisekcja: crash wymaga
   **składniowo kompletnego** pliku, więc nie jest to jedna linia ani kumulacja
   rozmiaru.
2. **Usunięcie tego crashu ujawniło błędy, które maskował.** `RangeError` przerywał
   program, więc `tsc` nigdy nie doszedł do raportowania `TS2322`. Zielona bramka po
   naprawie crashu **nie** była automatyczna — trzeba było jeszcze rozstrzygnąć
   src-vs-dist.
3. **Pierwsza sonda retencji dała fałszywy finding.** Raportowała
   `DELETE FROM audit_log: ALLOWED`, co wyglądało poważnie. Tabela była **pusta**, a
   trigger `FOR EACH ROW` nie odpala się przy zerowej liczbie wierszy. Wniosek
   obowiązujący dalej: **„odmówiono" na pustej tabeli nie jest dowodem** — wstaw
   wiersz i asertuj, że nadal tam jest. Jeden z moich własnych testów padł potem z
   dokładnie tego powodu.
4. **Dwie mutacje przeżyły pierwszą wersję testów**, obie na agregacji gauge'ów. `[0, 7]`
   przeszło mutację „last wins" (najgorsza wartość przypadkiem na końcu), a `[0, 7]` +
   `[7, 0]` przeszły „pierwszy niezerowy wygrywa" (`7` jedyną niezerową w obu).
   Potrzebne są **trzy różne niezerowe wartości w trzech kolejnościach**.
5. **Mój własny test `neutralizeMentions` był źle napisany.** Asertowałem, że funkcja
   **usuwa** zero-width space, gdy **wstawienie** U+200B po `@` JEST obroną.
   Zdejmowanie ZWSP przed asercją testuje nic.
6. **Rejestr granic cytował cztery nieistniejące ścieżki** przy pierwszym napisaniu.
   Test „każda kontrola musi być plikiem, który istnieje" jest tam z tego powodu.
7. **`redactCommandOutput` nie potrzebował swojej tabeli od dawna.** Notatka
   `Transitional` wymieniała dwa obstacles (brak zależności, słaby `SecretRedactor`) —
   pierwszy był kwestią jednej linii w `package.json`.

## Stan drzewa

Czyste. Wszystko zacommitowane w logicznych commitach (implementacja, potem `docs`).
`push`, MR i merge **nie** zostały wykonane i wymagają osobnej zgody.
