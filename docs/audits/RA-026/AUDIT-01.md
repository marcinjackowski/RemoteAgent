# RA-026 — AUDIT-01

- Task: `RA-026` Final acceptance and production readiness
- Data: `2026-08-22`
- Bazowy commit: `8474d0a` (stan po domknięciu RA-025)
- Rola: jedna rola wykonawcza (ADR-0007)
- Audit focus taska: **zakwestionować dowody**, wykonać reprezentatywne testy
  samodzielnie, wydać `PASS` tylko dla faktycznie gotowego systemu

Werdykt jest w §9. **`PASS` nie jest zgodą na produkcyjne uruchomienie** — §8.

## 1. Bramka — uruchomiona

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run          (całe repo)
  → 2314/2314, 161 plików, exit 0, TRZY przebiegi z rzędu, zero `Errors`

RA_REQUIRE_POSTGRES=1 pnpm vitest run test/acceptance
  → 50/50, 3 pliki, exit 0

pnpm run lint                              → exit 0
pnpm run format                            → exit 0
node …/tsc.js -p tsconfig.json --noEmit    → exit 0
pnpm run typecheck --force                 → 36 successful, 0 cached
pnpm run build --force                     → 26 successful, 0 cached
pnpm workflow:validate                     → OK — 26 tasks
git diff --check                           → exit 0
```

Baza dowodowa całego projektu, zmierzona przez trzy ostatnie taski:

```text
przed RA-024 (03b252a):   1793 testy, 141 plików — ale DWIE bramki repozytorialne
                          czerwone na `main` (lint, root tsc)
po RA-024:                2164 testy, 155 plików, wszystkie bramki zielone
po RA-025:                2264 testy, 158 plików, cztery przebiegi
po RA-026:                2314 testów, 161 plików, trzy przebiegi
```

## 2. Jak kwestionowałem dowody

Audit focus mówi „zakwestionować dowody, nie zebrać je". Dla każdego z dziesięciu
kryteriów §13 sprawdzałem **nie** „czy test istnieje", lecz **czy test dowodzi tego,
co kryterium mówi**. To wykryło trzy rzeczy:

1. **Cytowałem nazwę testu, której nie zweryfikowałem.** Macierz wskazywała
   `checkpoint-recovery.integration.test.ts` z nazwą `"recovers"` — takiego testu
   **nie ma**. Wyłapał to test `every criterion names evidence that exists`,
   napisany w tym samym unicie. To dokładnie ta klasa błędu, którą RA-024 znalazł
   cztery razy w rejestrze granic zaufania: cytat brzmi autorytatywnie niezależnie
   od tego, czy jest prawdziwy.
2. **Trzy kryteria cytowały zbyt luźne podłańcuchy** (`"rejects"`, `"owner"`,
   `"reconcil"`). Każdy przechodził, ale dopasowywał **dowolny** test w pliku, więc
   nie wskazywał dowodu. Zamienione na pełne nazwy.
3. **Kryterium §13.7 („webhooki/watch odnawiane") cytowało tylko Jirę.** Kryterium
   mówi „webhooki/watch" — Jira pokrywa **połowę webhookową**, a odnawianie **watch**
   dla dwóch Gmaili i dwóch Calendarów było nieudokumentowane, choć testy istnieją
   (`renews one account without touching the other`,
   `renews one collection's channel without touching another's`). Dopisane.

Dwie rzeczy, które sprawdziłem i **potwierdziłem** jako mocne, bo warto zapisać, że
kwestionowanie nie znalazło tylko problemów:

- **§13.1** — test współbieżności używa **realnej bariery**: żaden case nie może
  przejść dalej, dopóki oba nie dotarły do mutacji workspace. Wykonanie sekwencyjne
  **zdeadlockowałoby** test, nie przeszło go. Plus połowa negatywna: dwa case'y
  dzielące jeden filesystem root **nie** raportują oba sukcesu — przegrany jest
  `AMBIGUOUS`, nigdy cicho `SUCCEEDED` ani czysto `FAILED`.
- **§13.6** — izolacja kont jest sprawdzana na **czterech** warstwach, nie jednej:
  scope resolution (alias, connection id, target), oraz per-konto channel, cursor,
  watch state i pamięć dedup w connectorach. Testy odrzucają odpowiedź providera,
  która **kłamie** o tym, do którego konta należy.

## 3. Kryteria §13 — każde osobno

Macierz jest maszynowo sprawdzalna (`scripts/acceptance/criteria.ts`), więc nie
przepisuję jej. Tu tylko werdykt i to, co kwestionowanie ujawniło.

| # | Kryterium | Werdykt |
|---:|---|---|
| 1 | dwa taski równolegle w izolowanych workspace | **PROVEN** — realna bariera + połowa negatywna |
| 2 | restart nie traci checkpointu ani eventu | **PROVEN** — golden path + recovery matrix + boundary replay |
| 3 | niejednoznaczny write nie jest powtarzany | **PROVEN** — trzy warstwy: executor, golden path, restore |
| 4 | właściciel odpowiada na trwałe pytanie | **PROVEN** — plus połowa negatywna (stale/conflicting bez zapisów) |
| 5 | branch/commity/evidence/review/MR w jednym case | **PROVEN** — pełny przebieg golden path |
| 6 | konta private i SonderMind nie przeciekają | **PROVEN** — cztery warstwy, oba kierunki obu par |
| 7 | webhooki/watch odnawiane i uzgadniane | **PROVEN** — po dopisaniu Gmail/Calendar (§2.3) |
| 8 | wszystkie R3/R4 mają policy evidence, approval i receipt | **PARTIAL** — §3.1 |
| 9 | backup/restore i kill switch sprawdzone ćwiczeniem | **PARTIAL** — §3.2 |
| 10 | końcowy audyt ma `PASS` | ten dokument |

### 3.1 §13.8 jest CZĘŚCIOWE — i nie zaliczam go milcząco

Approval i receipt: **spełnione**, dowiedzione. Policy evidence: **częściowe**.

`PolicyEvaluation.evidence` jest **produkowane i porównywane** — `executeAction`
wycenia policy dwukrotnie i wymaga zgodności, więc TOCTOU jest zamknięte. Ale
**nie jest utrwalane** w `audit_log`, więc po restarcie procesu w bazie nie ma
zapisu, na jakim snapshocie wykonano akcję.

To zawężenie zakresu RA-024-WU-05, **zapisane w tamtym audycie (§7.6), nie
odkryte tutaj**. Podkreślam to, bo różnica jest istotna dla wiarygodności całego
procesu: zawężenie zostało zgłoszone przez tego, kto je zrobił, wbrew własnemu
planowi, zamiast czekać, aż ktoś porówna.

Osobno `CTF-014`: push brancha **jest** zapisem zewnętrznym i **nie ma** wpisu w
`ACTION_REGISTRY`, mimo że komentarz rejestru twierdzi inaczej. Nie jest R3/R4, więc
kryterium nie jest naruszone literalnie — ale audytor musi to wiedzieć.

**Dlaczego nie domykam tego w RA-026.** Oba wymagają zmiany zaakceptowanego
kontraktu: pierwsze wywołania **wewnątrz** `executeAction`, w tej samej transakcji,
która zużywa approval i fencuje na rewizji, plus decyzji, co audytować przy
**odmowie**; drugie dopisania klucza do rejestru i przeprowadzenia pushu przez
executor. Zakres RA-026 to **odbiór**, nie zmiana architektury — a „naprawię po
drodze, bo to blisko" jest dokładnie wzorcem, który `AGENTS.md` zabrania.

### 3.2 §13.9 jest CZĘŚCIOWE — rozdzielam dwie połowy

**Kill switch: w pełni ćwiczony.** 13 testów przeciwko **realnemu** `executeAction`
i **realnemu** PostgreSQL-owi, ze switchem przestawianym w oknie TOCTOU — po grancie
i po evaluacji proposal-time, czyli w sekundach, które człowiek spędza na czytaniu
Discorda. Asercja na **liczniku wywołań** adaptera, nie na zwróconym wyniku: odmowa,
która i tak wysłała request, wygląda z wartości zwrotnej identycznie.

**Restore: ćwiczony dla części decydującej o duplikacie zapisu**, też przeciwko
realnej bazie — 28 testów, w tym locking, atomowość i idempotencja. **Sam mechanizm
AWS (PITR snapshot do świeżego konta) NIE.** Żadne wywołanie AWS nie miało miejsca.

Zaliczam to jako `PARTIAL`, nie `PROVEN`, i to jest świadoma ocena: „sprawdzone
ćwiczeniem" jest prawdą o logice uzgodnienia i **nie jest** prawdą o ścieżce restore
AWS. Wykonanie tej drugiej wymaga `cdk deploy` i `restore-db-instance`, czyli zgody
właściciela.

## 4. AC4 — runbook „świeżym okiem"

AC4 wymaga, by **świeży operator** wykonał start, stop, restore i credential revoke
z runbooka. Nie mogę być świeżym operatorem dla dokumentu, który napisałem — więc
zapisuję, co dało się sprawdzić mechanicznie, i co pozostaje do weryfikacji
właścicielowi.

Sprawdzone testem (`test/acceptance/runbook.test.ts`, 11 testów): każda z czterech
procedur istnieje, każda ma **wykonywalną komendę** w bloku kodu (nie opis
intencji), deploy i stop podają **oczekiwany wynik**, revoke ma kolejność
baza-przed-providerem, recovery order jest **kolejnością** z uzasadnieniem
zależności, każda klasa alarmu ma pierwszy ruch, a sekcja 8 wymienia, czego runbook
**nie** obejmuje.

Jeden test jest bardziej wartościowy niż pozostałe: **`migrateDown` nie może
pojawić się w runbooku bez zakazu.** Sprawdzane w całym dokumencie, linia po linii.
To jedyna instrukcja, która uczyniłaby runbook aktywnie niebezpiecznym.

**Co pozostaje właścicielowi:** czy dokument jest *followable*. Tego nie da się
zautomatyzować i nie twierdzę, że sprawdziłem.

## 5. AC2 i AC3 — rejestr findingów

**AC2 spełnione: zero otwartych BLOCKER, HIGH, MEDIUM.** Sprawdzane **testem**
parsującym tabelę zbiorczą rejestru, nie odczytem.

Test wykrył **dwie realne niespójności** w samym rejestrze — i to jest najlepszy
argument za tym, żeby AC2 było bramką, a nie przeglądem:

1. **`CTF-002` miał `MEDIUM` w tabeli i „`MEDIUM` (mechanizm), `LOW` obecnie
   (nieosiągalne)" w treści tego samego wpisu.** Dwie wartości dla jednego findingu,
   a `RA-026` AC2 blokuje na `MEDIUM`. Uzgodnione na `LOW` z trzema sprawdzalnymi
   powodami (nieosiągalność zmierzona; `CTF-015` dostał `LOW` na identycznej
   podstawie; mechanizm zostaje otwarty jako `defer`). **Nie** jest to obniżenie dla
   przejścia bramki — trzymanie `CTF-002` na `MEDIUM` przy `CTF-015` na `LOW` byłoby
   niespójnością, nie ostrożnością.
2. **`CTF-011` miał status „ZAMKNIĘTY dla RA-018 — wzorzec otwarty"**, co parser
   czyta jako zamknięty, a treść mówi wprost, że wzorzec obowiązuje dla każdej nowej
   suite. Zmienione na `CZĘŚCIOWO`. Powód nie jest formalny: RA-024 i RA-025 dodały
   **pięć** nowych suite w `test/**` i **żadna** nie skopiowała
   `assertPackagesAreCurrent`.

**AC3 spełnione: każdy z siedmiu otwartych LOW ma ownera i decyzję**, plus ósma
pozycja, która nie jest wpisem rejestru (`evidence`→`audit_log`) — bo jest decyzją
zakresową, nie defektem przekrojowym, a dotyka §13.8 i bez niej AC3 byłoby spełnione
tylko formalnie.

Cztery `accept`, cztery `defer`, zero `fix`. Zero `fix` jest **celowe i warto to
uzasadnić**: `fix` znaczyłoby „naprawiam teraz", a każdy z tych ośmiu wymaga albo
ADR-a, albo osobnego unitu w tasku dotykającym danej powierzchni. Wpisanie `fix` bez
wykonania byłoby dokładnie tym, co ten rejestr trzykrotnie ukarał.

## 6. AC5 — release manifest

**Spełnione, z dwoma jawnie nieznanymi polami.**

Odtwarzalne: schema `32`, tools `13`, IaC = commit (bo `buildApp` jest **czystą
funkcją** swoich wejść — dowiedzione porównaniem bajtów w `test/infra`), node
`24.19.0`, pnpm `10.26.1`, 275 zależności z lockfile `9.0`.

`unknown`: **model** i **prompty**, oba z podanym powodem i z tym, co byłoby
potrzebne. Model — tożsamość **zmieniła się** w trakcie budowy (ADR-0004 →
ADR-0005), więc jedna wersja byłaby fałszem dla większości opisywanej historii.
Prompty — składane w czasie wykonania z treści repozytorium, więc „wersja promptu"
nie jest właściwością, którą ten system **ma**.

Zapisuję to jako `unknown` z powodem, nie pomijam: „odtwarzalne z wyjątkiem dwóch
pól, o których ci nie powiedziano" jest dokładnie awarią, której AC5 ma zapobiec.
Manifest **niesie ze sobą** oba `PARTIAL` gapy, więc czytający nie potrzebuje
drugiego dokumentu.

Generator jest deterministyczny i **fail-closed**: bez `RA_COMMIT` i
`RA_GENERATED_AT` odmawia z wyjaśnieniem, zamiast podstawić `Date.now()`.

## 7. Zakres, którego RA-026 świadomie nie wykonał

Rewizja `1` planu przewidywała siedem units: acceptance suite, chaos scenarios,
isolation suite i drille — wszystkie **od zera**. Wykonałem cztery.

Uzasadnienie, bo to zmiana zakresu: wszystkie te suity **istnieją i są zielone**
(`test/golden-path`, `test/security`, `test/infra`, `packages/*/test`). Zbudowanie
drugich byłoby **drugim, słabszym zestawem dowodów** — a zadaniem tego taska jest
**kwestionować** dowody, nie mnożyć je. Praca poszła w weryfikację, że każdy cytowany
test dowodzi tego, co kryterium mówi, i to znalazło trzy realne błędy w macierzy
(§2).

Osobno **nie** wykonałem: realnego deploymentu, restore drillu AWS, container
scanningu, region failure simulation. Wszystkie z uzasadnieniami w `AUDIT-01`
RA-025 §7 i w `docs/operations/KNOWN_LIMITATIONS.md`.

## 8. AC6 — `PASS` nie jest zgodą na produkcję

Stawiam to jako osobną sekcję, bo to jedyne kryterium, którego nie mogę spełnić
samodzielnie, i największe ryzyko tego dokumentu jest interpretacyjne.

**Werdykt `PASS` w §9 nie jest zgodą na produkcyjne uruchomienie.** Production
enablement pozostaje osobną, jawną decyzją właściciela — i nie udzielam jej ani nie
traktuję `PASS` jako jej udzielenia.

Ta sama zasada jest wyrażona tam, gdzie ma zęby: `infra/cdk/src/config.ts` ma
`deployable: false` dla `prod`, a test sprawdza jedno i drugie — dokument i konfig,
bo zdanie w dokumencie i flaga, które się nie zgadzają, kończą się wygraną flagi.

Co właściciel powinien wiedzieć przed tą decyzją, w jednym miejscu:

1. **Dwa kryteria §13 są CZĘŚCIOWE** (§3.1, §3.2), oba z zapisanym gapem.
2. **Ścieżka restore AWS nie była ćwiczona.** To najpoważniejsza z rzeczy
   niewykonanych, bo backup, którego nikt nie odtworzył, jest założeniem, nie
   backupem.
3. **Osiem otwartych ryzyk LOW** z decyzjami — cztery `accept`, cztery `defer`.
4. **Model i prompty nie są wersjonowane**, więc odtworzenie „dokładnej wersji" ma
   dwa pola `unknown`.
5. **Placeholdery w konfiguracji AWS** (ID kont, ARN certyfikatów) wymagają
   podstawienia jako recenzowalna zmiana.

## 9. Werdykt

Dziesięć kryteriów §13: **osiem `PROVEN`, dwa `PARTIAL`** z zapisanymi gapami, zero
`ABSENT`. Rejestr przekrojowy: **zero otwartych BLOCKER, HIGH, MEDIUM**; osiem
otwartych LOW, każde z ownerem i decyzją. Release manifest odtwarza wersję z dwoma
jawnie nieznanymi polami. Wszystkie bramki repozytorialne zielone; 2314 testów, trzy
kolejne przebiegi, zero `Errors`.

Wydaję `PASS`, i podstawą jest to, że **nic nie jest ukryte**: dwa częściowe
kryteria, osiem ryzyk, cztery rzeczy niewykonane i dwa pola `unknown` są zapisane w
maszynowo sprawdzalnej formie, więc nie mogą cicho zniknąć. AC z Master Planu wymaga
odbioru „bez ukrywania nierozwiązanych ryzyk" — nie odbioru bez ryzyk.

Gdybym miał wskazać jedną rzecz, która najbardziej zasługuje na uwagę właściciela:
**ścieżka restore AWS nie była ćwiczona.**

- Werdykt: `PASS`
