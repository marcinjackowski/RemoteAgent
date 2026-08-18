# RA-001 — Handoff 04

## Metadata

- Task: `RA-001`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER (Claude Opus 4.8)
- Data: 2026-08-18
- Poprzedni handoff: `docs/handoffs/RA-001/HANDOFF-03.md`
- Audyt naprawiany: `docs/audits/RA-001/AUDIT-03.md` (werdykt `CHANGES_REQUIRED`)
- Bazowy commit: `161bb31` (stan z HANDOFF-03, potwierdzony clean-archive
  przez AUDIT-03 na dokładnym Node `24.19.0`).
- Końcowy commit (fix): `64ab1a73a99f48eabe09c9904b561833438e97fb` na `main`
  (bez remote, bez push). Ten handoff oraz przełączenie statusu na
  `AWAITING_AUDIT` dopięto drobnym follow-up commitem docs.

## Wynik

Zamknięto jedyny finding MEDIUM z AUDIT-03. Provenance statusu `BLOCKED` nie
zależy już od samego istnienia audytu (`audits > 0`), lecz od NAJNOWSZEGO
artefaktu porównanego po numerze rewizji `HANDOFF-NN`/`AUDIT-NN`. Dzięki temu
legalny proceduralny Decision Request utworzony po wcześniejszym
`CHANGES_REQUIRED` jest akceptowany, a przestarzały audyt nie jest brany za
przyczynę bieżącej blokady. Fail-closed dla nieudokumentowanego,
niejednoznacznego lub sprzecznego `BLOCKED` pozostaje w mocy, podobnie jak
wszystkie zamknięcia parsera z AUDIT-02.

## Zrealizowany zakres (remediacja AUDIT-03)

### MEDIUM — Historyczny audyt błędnie traktowany jako provenance `BLOCKED`

- `scripts/workflow/validate.ts`:
  - Usunięto `BLOCKED → BLOCKED` z `STATUS_TO_REQUIRED_VERDICT`. Ta mapa
    obejmuje teraz wyłącznie statusy jednoznacznie audytorskie
    (`CHANGES_REQUESTED → CHANGES_REQUIRED`, `AUDIT_PASSED → PASS`,
    `DONE → PASS`), których provenance jest zawsze werdyktem audytu.
  - Dodano `checkBlockedProvenance(handoffDir, auditsDir, id, where)`
    rozstrzygające źródło blokady deterministycznie po najnowszym artefakcie:
    - `latestAuditRev >= latestHandoffRev` → blokada audytowa: najnowszy audyt
      musi mieć werdykt `BLOCKED` (inaczej `declares no verdict` /
      `ambiguous verdict` / `verdict is X (expected BLOCKED)`);
    - najnowszy artefakt to handoff → blokada proceduralna: ten handoff musi
      zawierać marker `Decision Request` (inaczej `declares no Decision
      Request`);
    - brak artefaktów → `no handoff or audit documents the block`.
  - Dodano helpery `latestArtifactRevision()` (najwyższa rewizja lub `0`) i
    `hasDecisionRequest()` (wykrywa linię zaczynającą się od `Decision Request`
    po zdjęciu dekoracji markdown: `#`, `-`, `*`, `>`, `_`).
  - `BLOCKED` nadal celowo NIE jest w `STATUSES_REQUIRING_AUDIT` (blokada
    proceduralna nie wymaga audytu).
- `test/workflow/validate.test.ts` — nowy blok
  `validate — BLOCKED provenance by newest artifact` (8 testów) plus rozszerzone
  `buildRepo` o `HandoffSpec { rev, decisionRequest, raw }`:
  - proceduralny blok z Decision Request bez audytu → ok;
  - proceduralny blok po wcześniejszym `CHANGES_REQUIRED` (HANDOFF-01,
    AUDIT-01 CR, HANDOFF-02 Decision Request) → ok;
  - audytowy blok (najnowszy audyt `BLOCKED`) → ok;
  - stary audyt CR + nowszy handoff bez Decision Request → odrzucony;
  - konflikt: stary audyt `BLOCKED` + nowszy handoff bez Decision Request →
    odrzucony;
  - brak artefaktów → odrzucony (fail-closed);
  - audytowy blok z najnowszym werdyktem `PASS` → odrzucony;
  - audytowy blok z najnowszym werdyktem `CHANGES_REQUIRED` → odrzucony.
  Zachowano testy parsera i konfliktów werdyktu z AUDIT-02.
- `docs/workflow/EXECUTION_AND_AUDIT.md` — sekcja `Decision Request` wymaga teraz
  jawnego markera `Decision Request` w najnowszym handoffie; nowa podsekcja
  `Provenance blokady (BLOCKED)` dokumentuje deterministyczny kontrakt
  rozstrzygania po najnowszym artefakcie.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `scripts/workflow/validate.ts` | usunięcie `BLOCKED` z mapy werdyktów; `checkBlockedProvenance` + helpery `latestArtifactRevision`/`hasDecisionRequest` | AUDIT-03 finding MEDIUM |
| `test/workflow/validate.test.ts` | 8 testów provenance po najnowszym artefakcie; `HandoffSpec` z rev/Decision Request | AUDIT-03 wymagane testy |
| `docs/workflow/EXECUTION_AND_AUDIT.md` | marker Decision Request + kontrakt provenance `BLOCKED` | AUDIT-03 „udokumentować kontrakt” |
| `docs/audits/RA-001/AUDIT-03.md` | dołączony artefakt audytora | append-only ślad audytu |
| `docs/handoffs/RA-001/HANDOFF-04.md` | ten handoff | bramka audytowa |
| `docs/tasks/TASK_INDEX.md` | RA-001 → `AWAITING_AUDIT` | bramka audytowa |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Instalacja jednym poleceniem z czystego checkoutu | PASS | working tree = commit (clean status, zgodny HEAD); poprzedni clean-archive potwierdzony przez AUDIT-03 na Node `24.19.0` |
| 2. Deterministyczne `lint`/`typecheck`/`test`/`build` z roota | PASS | `pnpm run check` zielony po `rm -rf .turbo dist`; build 20/20 (0 cached); `workflow:validate OK — 26 tasks` |
| 3. Każdy app/package ma manifest i jest widoczny dla workspace | PASS | 20 build-tasków / 21 workspace projektów |
| 4. CI używa lockfile i nie pobiera sekretów | PASS | bez zmian względem HANDOFF-03; `.gitlab-ci.yml` frozen install, obraz `24.19.0` |
| 5. Strict TS i boundaries mają celowo failing fixture/test | PASS | guardrails: 2/2 zielone |
| 6. Brak skopiowanych credentiali/danych | PASS | skan zmienionych/nowych plików — jedyny match to tytuł taska „Connections, secrets…”; brak sekretów |
| 7. `workflow:validate` zachowuje wszystkie legalne stany workflow | PASS | proceduralny Decision Request po `CHANGES_REQUIRED` akceptowany; 34 testy validatora zielone |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run test/workflow/validate.test.ts` | 0 | 34 testy passed |
| `pnpm exec vitest run` | 0 | 36 testów passed (34 validator + 2 guardrails) |
| `pnpm run check` (po `rm -rf .turbo dist`) | 0 | build 20/20 (0 cached); lint/format/typecheck/test w łańcuchu; `workflow:validate OK — 26 tasks` |
| skan sekretów zmienionych/nowych plików | 0 | brak sekretów (tylko tytuł taska RA-005) |

## Bezpieczeństwo i dane

- Sekrety: brak w śledzonym drzewie; commit fix nie wprowadza sekretów.
- Git: repo lokalne, bez remote i bez push (`git remote -v` puste).
- Side effecty: `workflow:validate` read-only; zmiana dotyczy tylko logiki
  provenance i helperów odczytu.
- Dane zewnętrzne: brak integracji w zakresie RA-001.

## Znane ograniczenia i ryzyka

- **Weryfikacja na Node `24.19.0` lokalnie:** niewykonalna w tym środowisku
  (brak nvm/fnm/volta/Corepack; daemon Dockera wyłączony). Frozen install i pełny
  `pnpm run check` uruchomiłem na Node `25.2.1` przeciw treści commitu (working
  tree = committed tree); silnik `24.19.0` daje jedynie `WARN`, nie błąd. Wiążącym
  dowodem na dokładnej wersji pozostaje job CI na obrazie
  `node:24.19.0-bookworm-slim`; AUDIT-03 niezależnie potwierdził clean archive
  install/check na dokładnym Node `24.19.0` dla poprzedniego commitu.
- **Izolowany `git archive`:** `git archive`, `git -C`, `git grep`, `git restore
  --staged`, `git reset`, `rsync` i potoki są blokowane przez warstwę uprawnień
  środowiska. Tożsamość working tree z commitem potwierdziłem czystym
  `git status` i zgodnym `HEAD`. Z powodu blokady `git reset`/`restore` commit
  fix `64ab1a7` zawiera także przełączenie `TASK_INDEX` na `IN_PROGRESS` z fazy
  remediacji; przejście na `AWAITING_AUDIT` dopięto follow-up commitem docs razem
  z tym handoffem.

## Otwarte pytania

- Brak blokujących.

## Stan dla następnego agenta

- Co jest gotowe: finding MEDIUM z AUDIT-03 naprawiony; 34 testy validatora / 36
  łącznie zielone; commit fix `64ab1a7` na `main`.
- Czego nie robić przed audytem: nie rozpoczynać RA-002; nie dodawać remote/push;
  nie zmieniać kontraktów/wersji bez ADR.
- Dla audytora: fixture `HANDOFF-01 → AUDIT-01 CHANGES_REQUIRED → HANDOFF-02
  Decision Request → BLOCKED` musi teraz zwracać `ok: true`; audytowy `BLOCKED`
  bez werdyktu `BLOCKED` oraz konflikt (stary audyt `BLOCKED` + nowszy handoff bez
  Decision Request) muszą failować; potwierdzić pełny gate na obrazie CI
  `node:24.19.0-bookworm-slim`.
