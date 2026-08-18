# RA-001 — Handoff 05

## Metadata

- Task: `RA-001`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER (Claude Opus 4.8)
- Data: 2026-08-18
- Poprzedni handoff: `docs/handoffs/RA-001/HANDOFF-04.md`
- Audyt naprawiany: `docs/audits/RA-001/AUDIT-04.md` (werdykt `CHANGES_REQUIRED`)
- Bazowy commit: `0f9bb95` (stan z HANDOFF-04, potwierdzony clean-archive przez
  AUDIT-04 na dokładnym Node `24.19.0`).
- Końcowy commit (fix): `10b67d80351e45e8fb0f82d2daf5727f38f9ead4` na `main`
  (bez remote, bez push). Ten handoff oraz przełączenie statusu na
  `AWAITING_AUDIT` dopięto drobnym follow-up commitem docs.

## Wynik

Zamknięto jedyny finding HIGH z AUDIT-04. Numery rewizji artefaktów mają teraz
dokładnie jedną kanoniczną reprezentację, a validator jawnie odrzuca nazwy
niekanoniczne oraz dowolne dwa pliki wskazujące ten sam numer, zanim cokolwiek
wybierze „najnowszy” artefakt. Dzięki temu konfliktowy lub przypadkowo źle
wyzerowany plik (`AUDIT-001.md` obok `AUDIT-01.md`) nie może już cicho przywrócić
fail-open `AUDIT_PASSED` ani zależeć od kolejności `readdirSync`. Wybór najnowszej
rewizji jest deterministyczny i oparty na wartości liczbowej (`10 > 09`).

## Zrealizowany zakres (remediacja AUDIT-04)

### HIGH — Niejednoznaczne numery rewizji

- `scripts/workflow/validate.ts`:
  - Usunięto `listArtifacts`/`artifactRevision`/`countArtifacts` z regexem
    `^PREFIX-\d{2,}\.md$` (dopuszczał `AUDIT-01` i `AUDIT-001` jako tę samą
    rewizję, a wybór zależał od kolejności katalogu).
  - Dodano `canonicalRevision(n)` (`String(n).padStart(2, "0")`) i
    `isCanonicalRevision(digits)`: rewizja jest kanoniczna, gdy liczba `≥ 1` i
    `digits === canonicalRevision(n)`. Odrzuca `00`, `1`, `001`, `010`; akceptuje
    `01…09`, `10…99`, `100`+.
  - Dodano `scanArtifacts(dir, prefix, relBase, where): ArtifactScan`. Grupuje
    wszystkie pasujące pliki po wartości liczbowej, więc `AUDIT-01` i `AUDIT-001`
    są widziane jako ta sama rewizja. Zgłasza dwa niezależne błędy:
    - nazwa niekanoniczna (`... has a non-canonical revision name ...`);
    - więcej niż jeden plik dla tego samego numeru
      (`... has N files for revision R (...)`).
    Do `byRevision` trafia wyłącznie kanoniczny, jednoznacznie ponumerowany plik;
    każda niejednoznaczność failuje całą walidację (fail-closed), nic nie jest
    cicho wybierane.
  - `latestRevision`/`latestArtifactPath` operują teraz na `byRevision` (wybór po
    maksymalnej wartości liczbowej), a nie na kolejności `readdirSync`.
  - `validate()` uruchamia `scanArtifacts` raz na wiersz dla handoffów i audytów,
    dokłada ich błędy do wyniku i przekazuje skany do logiki werdyktu oraz do
    `checkBlockedProvenance` (który dostaje teraz `ArtifactScan` zamiast ponownie
    czytać katalog).
- `test/workflow/validate.test.ts` — `HandoffSpec`/`AuditSpec` dostały pole
  `fileName` (dosłowna nazwa pliku, z pominięciem kanonicznego szablonu). Nowy
  blok `validate — canonical artifact revision names` (7 testów):
  - konfliktowy `AUDIT-01` + `AUDIT-001` przy `AUDIT_PASSED` → duplikat rewizji 1
    i nazwa niekanoniczna; `ok: false` (PASS nie może przesłonić
    CHANGES_REQUIRED);
  - konfliktowy `HANDOFF-01` + `HANDOFF-001` → analogicznie odrzucony;
  - `AUDIT-02` + `AUDIT-002` → `files for revision 2` + non-canonical;
  - `HANDOFF-00` → non-canonical i brak liczonego handoffu;
  - `HANDOFF-1` (bez paddingu) → non-canonical;
  - `AUDIT-09` vs `AUDIT-10` → rewizja `10` wygrywa numerycznie (obie strony
    werdyktu);
  - `HANDOFF-100` → kanoniczny, akceptowany.
  Zachowano wszystkie testy parsera werdyktu i provenance `BLOCKED`.
- `docs/workflow/EXECUTION_AND_AUDIT.md` — sekcja `Handoff revisions` dokumentuje
  kanoniczny kontrakt nazewnictwa (padding do dwóch cyfr, potem `10, 11, …, 100`;
  bez `00` i nadmiarowych zer; odrzucanie duplikatów; wybór po numerze).

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `scripts/workflow/validate.ts` | `scanArtifacts` + `canonicalRevision`/`isCanonicalRevision`; deterministyczny `latestArtifactPath`; threading skanów | AUDIT-04 finding HIGH |
| `test/workflow/validate.test.ts` | pole `fileName`; 7 testów kanonicznych nazw i porównania `09/10` | AUDIT-04 wymagane testy |
| `docs/workflow/EXECUTION_AND_AUDIT.md` | kontrakt kanonicznego nazewnictwa rewizji | AUDIT-04 „zdefiniować i egzekwować kanoniczną reprezentację” |
| `docs/audits/RA-001/AUDIT-04.md` | dołączony artefakt audytora | append-only ślad audytu |
| `docs/handoffs/RA-001/HANDOFF-05.md` | ten handoff | bramka audytowa |
| `docs/tasks/TASK_INDEX.md` | RA-001 → `AWAITING_AUDIT` | bramka audytowa |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Instalacja jednym poleceniem z czystego checkoutu | PASS | working tree = commit (clean status, zgodny HEAD); poprzedni clean-archive potwierdzony przez AUDIT-04 na Node `24.19.0` |
| 2. Deterministyczne `lint`/`typecheck`/`test`/`build` z roota | PASS | `pnpm run check` zielony po `rm -rf .turbo dist`; build 20/20 (0 cached); `workflow:validate OK — 26 tasks` |
| 3. Każdy app/package ma manifest i jest widoczny dla workspace | PASS | 20 build-tasków / 21 workspace projektów |
| 4. CI używa lockfile i nie pobiera sekretów | PASS | bez zmian względem HANDOFF-04 |
| 5. Strict TS i boundaries mają celowo failing fixture/test | PASS | guardrails 2/2 zielone |
| 6. Brak skopiowanych credentiali/danych | PASS | skan zmienionych/nowych plików — jedyny match to tytuł taska „Connections, secrets…”; brak sekretów |
| 7. `workflow:validate` odrzuca niejednoznaczne artefakty i stany | PASS | 41 testów validatora; konfliktowe/niekanoniczne/duplikaty odrzucone; wybór latest deterministyczny |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run test/workflow/validate.test.ts` | 0 | 41 testów passed |
| `pnpm run check` (po `rm -rf .turbo dist`) | 0 | eslint clean; `prettier --check` clean; 43 testy (41 validator + 2 guardrails); build 20/20 (0 cached); `workflow:validate OK — 26 tasks` |
| skan sekretów zmienionych/nowych plików | 0 | brak sekretów (tylko tytuł taska RA-005) |

## Bezpieczeństwo i dane

- Sekrety: brak w śledzonym drzewie; commit fix nie wprowadza sekretów.
- Git: repo lokalne, bez remote i bez push (`git remote -v` puste).
- Side effecty: `workflow:validate` read-only; zmiana dotyczy tylko parsowania
  nazw artefaktów i wyboru najnowszej rewizji.
- Dane zewnętrzne: brak integracji w zakresie RA-001.

## Znane ograniczenia i ryzyka

- **Weryfikacja na Node `24.19.0` lokalnie:** niewykonalna w tym środowisku (brak
  nvm/fnm/volta/Corepack; daemon Dockera wyłączony). Frozen install i pełny
  `pnpm run check` uruchomiłem na Node `25.2.1` przeciw treści commitu (working
  tree = committed tree); silnik `24.19.0` daje jedynie `WARN`, nie błąd. Wiążącym
  dowodem na dokładnej wersji pozostaje job CI na obrazie
  `node:24.19.0-bookworm-slim`; AUDIT-04 niezależnie potwierdził clean archive
  install/check na dokładnym Node `24.19.0` dla poprzedniego commitu.
- **Izolowany `git archive` i staging:** `git archive`, `git -C`, `git grep`,
  `git restore --staged`, `git reset`, `rsync` i potoki są blokowane przez
  warstwę uprawnień środowiska. Tożsamość working tree z commitem potwierdziłem
  czystym `git status` i zgodnym `HEAD`. Commit fix `10b67d8` stagowałem po
  jawnych ścieżkach (bez `TASK_INDEX`), a przejście na `AWAITING_AUDIT` dopięto
  follow-up commitem docs razem z tym handoffem.

## Otwarte pytania

- Brak blokujących.

## Stan dla następnego agenta

- Co jest gotowe: finding HIGH z AUDIT-04 naprawiony; 41 testów validatora / 43
  łącznie zielone; commit fix `10b67d8` na `main`.
- Czego nie robić przed audytem: nie rozpoczynać RA-002; nie dodawać remote/push;
  nie zmieniać kontraktów/wersji bez ADR.
- Dla audytora: fixture `AUDIT-01.md (CHANGES_REQUIRED)` + `AUDIT-001.md (PASS)`
  przy `AUDIT_PASSED` musi teraz zwracać `ok: false` (duplikat rewizji 1 +
  non-canonical); `AUDIT-09` vs `AUDIT-10` musi wybierać `10`; `HANDOFF-100`
  pozostaje legalny; potwierdzić pełny gate na obrazie CI
  `node:24.19.0-bookworm-slim`.
