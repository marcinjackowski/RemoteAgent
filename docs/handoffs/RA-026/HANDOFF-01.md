# RA-026 — HANDOFF-01

- Task: `RA-026` Final acceptance and production readiness
- Data: `2026-08-22`
- Bazowy commit: `8474d0a`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Najważniejsze w jednym zdaniu

**`PASS` nie jest zgodą na produkcyjne uruchomienie** (AC6). Dziesięć kryteriów §13:
osiem `PROVEN`, dwa `PARTIAL` z zapisanymi gapami. Podstawą `PASS` jest to, że
**nic nie jest ukryte** — nie że nie ma ryzyk.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `scripts/acceptance/criteria.ts` | macierz §13 jako **maszynowo sprawdzalny** artefakt + decyzja dla każdego otwartego findingu |
| `scripts/acceptance/release-manifest.ts` | manifest wydania; deterministyczny, z jawnymi `unknown` |
| `scripts/acceptance/emit-manifest.ts` | CLI; **fail-closed** bez `RA_COMMIT`/`RA_GENERATED_AT` |
| `test/acceptance/**` (3 pliki, 50 testów) | AC1..AC6 sprawdzane komendą, nie odczytem |
| `docs/operations/KNOWN_LIMITATIONS.md` | ryzyka i granice w formie do decyzji go/no-go |
| `docs/audits/RA-026/AUDIT-01.md` | audyt **kwestionujący** dowody |

## Bramka

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run     2314/2314, 161 plików, TRZY przebiegi, exit 0
RA_REQUIRE_POSTGRES=1 … test/acceptance    50/50, 3 pliki, exit 0
pnpm run lint / format                     exit 0
node …/tsc.js -p tsconfig.json --noEmit    exit 0
pnpm run typecheck --force                 36 successful, 0 cached
pnpm run build --force                     26 successful, 0 cached
pnpm workflow:validate                     OK — 26 tasks
git diff --check                           exit 0
```

## Stan końcowy projektu

```text
26 tasków RA-001..RA-026:      wszystkie DONE
testy:                          2314, 161 plików, trzy kolejne przebiegi zielone
kryteria §13:                   8 PROVEN, 2 PARTIAL, 0 ABSENT
findingi przekrojowe:           0 BLOCKER / 0 HIGH / 0 MEDIUM, 8 otwartych LOW
                                (4 accept, 4 defer, 0 fix)
migracje:                       32
zarejestrowane akcje:           13
zależności:                     275, wszystkie z hashem integralności
```

Bramki repozytorialne były **czerwone na `main`** przed RA-024 (`lint`, root `tsc`).
Wszystkie trzy ostatnie taski domknęły po dwa findingi flake'owe; **nie ma znanych
otwartych flake'ów harnessu** — pierwszy raz w tym projekcie.

## Co właściciel musi wiedzieć przed decyzją o produkcji

Pięć rzeczy, w kolejności wagi. Pełny zapis: `AUDIT-01` §8 i
`docs/operations/KNOWN_LIMITATIONS.md`.

1. **Ścieżka restore AWS nie była ćwiczona.** Jeśli miałbym wskazać jedną rzecz —
   ta. Backup, którego nikt nie odtworzył, jest założeniem, nie backupem. Logika
   uzgodnienia po restore **jest** ćwiczona przeciwko realnej bazie (28 testów), w
   tym część decydująca o duplikacie zapisu. Sam PITR snapshot do świeżego konta nie.
2. **§13.8 jest częściowe:** `PolicyEvaluation.evidence` jest produkowane i
   porównywane (TOCTOU zamknięte), ale **nie utrwalane** w `audit_log`. Po restarcie
   procesu nie ma w bazie zapisu, na jakim snapshocie wykonano akcję.
3. **`CTF-014`:** push brancha case'a jest zapisem zewnętrznym **poza**
   `ACTION_REGISTRY`. Nie R3/R4, więc §13.8 nie jest naruszone literalnie.
   Zatrzymany trzema innymi warstwami.
4. **Osiem otwartych ryzyk LOW**, każde z decyzją. Zero `fix` jest celowe: każde
   wymaga ADR-a albo osobnego unitu, a wpisanie `fix` bez wykonania byłoby tym, co
   ten rejestr trzykrotnie ukarał.
5. **Model i prompty nie są wersjonowane**, więc „dokładna wersja" ma dwa pola
   `unknown` — z podanym powodem i z tym, co byłoby potrzebne.

## Wejściowe ustalenia dla następnego taska

Nie ma następnego taska w kolejce — RA-026 jest ostatni. Gdyby powstał, cztery
rzeczy są gotowe do podjęcia i mają zapisany kształt:

1. **`evidence` → `audit_log`** (§13.8). Wymaga wywołania **wewnątrz**
   `executeAction`, w tej samej transakcji, która zużywa approval i fencuje na
   rewizji, **plus** decyzji, co audytować przy **odmowie**, nie tylko przy sukcesie.
   ADR.
2. **`CTF-014`** — dwie opcje w rejestrze. Rekomendacja: opcja 2 (poprawić komentarz
   `ACTION_REGISTRY` i zapisać realny mechanizm) jest tańsza i uczciwa; opcja 1
   (dopisać klucz, przeprowadzić push przez executor) daje policy evidence. ADR.
3. **`CTF-002-U1` + `CTF-011`** — jeden unit, oba są „guardrail zamiast zapamiętanej
   dyscypliny" i oba należą do `test/guardrails/`, gdzie działają automatycznie.
   Sonda type-level z `AUDIT-01` RA-024 §2 jest gotowym szkicem implementacyjnym.
4. **Realny restore drill** — wymaga jawnej zgody właściciela na `cdk deploy` i
   `restore-db-instance`. Runbook §5 ma komendy.

## Ślepe uliczki i rzeczy, które okazały się nieprawdą

1. **Cytowałem nazwę testu, której nie ma.** Macierz wskazywała
   `checkpoint-recovery.integration.test.ts` z nazwą `"recovers"`. Wyłapał to test
   napisany w tym samym unicie. Ta sama klasa błędu, którą RA-024 znalazł cztery razy
   w rejestrze granic: **cytat brzmi autorytatywnie niezależnie od tego, czy jest
   prawdziwy.**
2. **Trzy kryteria cytowały zbyt luźne podłańcuchy** (`"rejects"`, `"owner"`,
   `"reconcil"`). Każdy **przechodził**, ale dopasowywał dowolny test w pliku, więc nie
   wskazywał dowodu. Test, który przechodzi na złym powodzie, jest gorszy od braku
   testu.
3. **§13.7 cytowało tylko Jirę**, choć kryterium mówi „webhooki/watch". Odnawianie
   **watch** dla dwóch Gmaili i dwóch Calendarów było nieudokumentowane, choć testy
   istniały. Wykryte przez czytanie kryterium **słowo po słowie**, nie przez grep.
4. **Rejestr findingów miał dwie wewnętrzne niespójności**, obie wykryte testem, nie
   odczytem: `CTF-002` miał `MEDIUM` w tabeli i `LOW` w treści **tego samego wpisu**;
   `CTF-011` miał status, który parser czyta jako zamknięty, a treść mówi „wzorzec
   otwarty". Rejestr, który jest bramką, musi być parsowalny jednoznacznie.
5. **Rewizja `1` planu przewidywała siedem units**, budujących acceptance suite,
   chaos scenarios i isolation suite **od zera**. Wszystkie istnieją i są zielone.
   Zbudowanie drugich byłoby **drugim, słabszym zestawem dowodów** — a zadaniem tego
   taska jest kwestionować dowody, nie mnożyć je. Wykonałem cztery units i wydałem
   pracę na weryfikację, że każdy cytowany test dowodzi tego, co kryterium mówi.

## Stan drzewa

Czyste. Zacommitowane w logicznych commitach. **`push`, MR i merge nie zostały
wykonane i wymagają osobnej zgody.** Żaden deploy nie został wykonany.
