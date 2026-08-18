# RA-001 — Handoff 06

## Metadata

- Task: `RA-001`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER (Claude Opus 4.8)
- Data: 2026-08-18
- Poprzedni handoff: `docs/handoffs/RA-001/HANDOFF-05.md`
- Audyt naprawiany: `docs/audits/RA-001/AUDIT-05.md` (werdykt `CHANGES_REQUIRED`)
- Bazowy commit: `975b70c` (stan z HANDOFF-05, potwierdzony clean-archive przez
  AUDIT-05 na dokładnym Node `24.19.0`).
- Końcowy commit (fix): `f8c936183b70715c40c6be388737293806de9f39` na `main`
  (bez remote, bez push). Ten handoff oraz przełączenie statusu na
  `AWAITING_AUDIT` dopięto drobnym follow-up commitem docs.

## Wynik

Zamknięto jedyny finding HIGH z AUDIT-05. `scanArtifacts` nie ignoruje już cicho
wpisów, które nie pasują do kanonicznego `^PREFIX-NN.md$`. Taskowe katalogi
`docs/audits/<id>/` i `docs/handoffs/<id>/` mają teraz zamknięty kontrakt: każdy
wpis inny niż kanoniczny artefakt danego prefiksu (inny sufiks/rozszerzenie,
literówka w prefiksie, plik pomocniczy, podkatalog) jest twardym błędem. Dzięki
temu błędnie nazwany nowszy dokument audytora nie może zostać pominięty, a starszy
`PASS` nie pozostanie obowiązujący i nie przepuści `AUDIT_PASSED`.

## Zrealizowany zakres (remediacja AUDIT-05)

### HIGH — Malformed artefakt był cicho ignorowany

- `scripts/workflow/validate.ts` (`scanArtifacts`):
  - Zastąpiono `if (!m) continue;` twardym błędem
    `... ${relBase}/${f} is not an allowed ${prefix} artifact (only
    ${prefix}-NN.md is permitted here ...)`. Każdy wpis w katalogu, który nie jest
    dokładnie `<PREFIX>-<cyfry>.md`, kończy walidację, zamiast być pomijany.
  - Zachowano dotychczasową logikę: wpisy pasujące kształtem, ale niekanoniczne
    (`AUDIT-001`, `AUDIT-00`, `AUDIT-1`) → błąd non-canonical; dwa pliki o tym
    samym numerze → błąd duplikatu; wybór najnowszego po wartości liczbowej.
  - Zaktualizowano komentarze modułu i funkcji, aby opisywały zamknięty kontrakt
    dozwolonych wpisów.
- `test/workflow/validate.test.ts` — nowy blok
  `validate — disallowed (malformed) artifact entries` (5 testów):
  - kanoniczny `AUDIT-01: PASS` + błędnie nazwany nowszy `AUDIT-02-final.md:
    CHANGES_REQUIRED` przy `AUDIT_PASSED` → `ok: false` z błędem
    „AUDIT-02-final.md is not an allowed” (starszy `PASS` nie zostaje wybrany);
  - `AUDIT-final-02.md` → odrzucony;
  - `AUDIT-02.txt` (złe rozszerzenie) → odrzucony;
  - `AUDITT-02.md` (literówka w prefiksie) → odrzucony;
  - `README.md` w katalogu handoffów → odrzucony jako „not an allowed HANDOFF”.
  Zachowano testy duplikatów liczbowych, `09/10`, parsera werdyktu i provenance
  `BLOCKED`.
- `docs/workflow/EXECUTION_AND_AUDIT.md` — sekcja `Handoff revisions` dokumentuje
  zamknięty kontrakt: katalogi taskowe mogą zawierać wyłącznie kanoniczne
  `HANDOFF-NN.md`/`AUDIT-NN.md`; każdy inny wpis jest twardym błędem.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `scripts/workflow/validate.ts` | twardy błąd zamiast `continue` dla wpisów spoza kanonu; zaktualizowane komentarze | AUDIT-05 finding HIGH |
| `test/workflow/validate.test.ts` | 5 testów malformed prefix/sufiks/rozszerzenie + stale-PASS + stray file | AUDIT-05 wymagane regresje |
| `docs/workflow/EXECUTION_AND_AUDIT.md` | zamknięty kontrakt dozwolonych wpisów w katalogach taskowych | AUDIT-05 „jawny, udokumentowany kontrakt” |
| `docs/audits/RA-001/AUDIT-05.md` | dołączony artefakt audytora | append-only ślad audytu |
| `docs/handoffs/RA-001/HANDOFF-06.md` | ten handoff | bramka audytowa |
| `docs/tasks/TASK_INDEX.md` | RA-001 → `AWAITING_AUDIT` | bramka audytowa |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Instalacja jednym poleceniem z czystego checkoutu | PASS | working tree = commit (clean status, zgodny HEAD); poprzedni clean-archive potwierdzony przez AUDIT-05 na Node `24.19.0` |
| 2. Deterministyczne `lint`/`typecheck`/`test`/`build` z roota | PASS | `pnpm run check` zielony po `rm -rf .turbo dist`; build 20/20 (0 cached); `workflow:validate OK — 26 tasks` |
| 3. Każdy app/package ma manifest i jest widoczny dla workspace | PASS | 20 build-tasków / 21 workspace projektów |
| 4. CI używa lockfile i nie pobiera sekretów | PASS | bez zmian względem HANDOFF-05 |
| 5. Strict TS i boundaries mają celowo failing fixture/test | PASS | guardrails 2/2 zielone |
| 6. Brak skopiowanych credentiali/danych | PASS | skan zmienionych/nowych plików — jedyny match to tytuł taska „Connections, secrets…”; brak sekretów |
| 7. `workflow:validate` odrzuca niejednoznaczne artefakty i stany | PASS | 46 testów validatora; malformed/prefix/rozszerzenie i stray file odrzucone; brak cichego pomijania |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run test/workflow/validate.test.ts` | 0 | 46 testów passed |
| `pnpm run check` (po `rm -rf .turbo dist`) | 0 | eslint clean; `prettier --check` clean; 48 testów (46 validator + 2 guardrails); build 20/20 (0 cached); `workflow:validate OK — 26 tasks` |
| skan sekretów zmienionych/nowych plików | 0 | brak sekretów (tylko tytuł taska RA-005) |

## Bezpieczeństwo i dane

- Sekrety: brak w śledzonym drzewie; commit fix nie wprowadza sekretów.
- Git: repo lokalne, bez remote i bez push (`git remote -v` puste).
- Side effecty: `workflow:validate` read-only; zmiana dotyczy tylko walidacji
  wpisów katalogu artefaktów.
- Dane zewnętrzne: brak integracji w zakresie RA-001.

## Znane ograniczenia i ryzyka

- **Weryfikacja na Node `24.19.0` lokalnie:** niewykonalna w tym środowisku (brak
  nvm/fnm/volta/Corepack; daemon Dockera wyłączony). Frozen install i pełny
  `pnpm run check` uruchomiłem na Node `25.2.1` przeciw treści commitu (working
  tree = committed tree); silnik `24.19.0` daje jedynie `WARN`, nie błąd. Wiążącym
  dowodem na dokładnej wersji pozostaje job CI na obrazie
  `node:24.19.0-bookworm-slim`; AUDIT-05 niezależnie potwierdził clean archive
  install/check na dokładnym Node `24.19.0` dla poprzedniego commitu.
- **Izolowany `git archive` i staging:** `git archive`, `git -C`, `git grep`,
  `git restore --staged`, `git reset`, `rsync` i potoki są blokowane przez
  warstwę uprawnień środowiska. Tożsamość working tree z commitem potwierdziłem
  czystym `git status` i zgodnym `HEAD`. Commit fix `f8c9361` stagowałem po
  jawnych ścieżkach (bez `TASK_INDEX`); przejście na `AWAITING_AUDIT` dopięto
  follow-up commitem docs razem z tym handoffem.

## Otwarte pytania

- Brak blokujących.

## Stan dla następnego agenta

- Co jest gotowe: finding HIGH z AUDIT-05 naprawiony; 46 testów validatora / 48
  łącznie zielone; commit fix `f8c9361` na `main`.
- Czego nie robić przed audytem: nie rozpoczynać RA-002; nie dodawać remote/push;
  nie zmieniać kontraktów/wersji bez ADR.
- Dla audytora: fixture kanoniczny `AUDIT-01.md (PASS)` + błędnie nazwany
  `AUDIT-02-final.md (CHANGES_REQUIRED)` przy `AUDIT_PASSED` musi teraz zwracać
  `ok: false` (błąd „not an allowed”); warianty `AUDIT-final-02.md`,
  `AUDIT-02.txt`, `AUDITT-02.md` i stray `README.md` również muszą failować;
  potwierdzić pełny gate na obrazie CI `node:24.19.0-bookworm-slim`.
