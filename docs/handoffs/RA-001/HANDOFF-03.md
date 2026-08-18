# RA-001 — Handoff 03

## Metadata

- Task: `RA-001`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER (Claude Opus 4.8)
- Data: 2026-08-18
- Poprzedni handoff: `docs/handoffs/RA-001/HANDOFF-02.md`
- Audyt naprawiany: `docs/audits/RA-001/AUDIT-02.md` (werdykt `CHANGES_REQUIRED`)
- Bazowy commit: `d04a305bd061db8e78c748cda05d0a46df85d6cd` (baseline z HANDOFF-02).
- Końcowy commit (fix): `9ac1116f09ccfd3fa9b9f1223f92902ca671a361` na `main`
  (bez remote, bez push). Ten handoff wskazuje commit fixu; wskaźnik dopięto
  drobnym follow-up commitem docs.

## Wynik

Zamknięto jedyny finding HIGH z AUDIT-02. `parseAuditVerdict` skanuje teraz cały
dokument, wymaga dokładnie jednej deklaracji `Werdykt` i dokładnie jednego
wystąpienia dozwolonego tokenu, więc dwie linie werdyktu, powtórzony token
(`PASS PASS`) i szablonowy placeholder failują zamknięcie. Domknięto też
semantykę `BLOCKED`: audytowy `BLOCKED` (gdy istnieje audyt) musi mieć werdykt
`BLOCKED`, a proceduralny `BLOCKED` bez audytu (zależność/Decision Request)
pozostaje legalny. Trzy adwersarialne reprodukcje z AUDIT-02 mają teraz testy i
są odrzucane.

## Zrealizowany zakres (remediacja AUDIT-02)

### HIGH — Parser werdyktu i mapowanie `BLOCKED` (jedyny finding)

- `scripts/workflow/validate.ts` — `parseAuditVerdict` przepisany:
  - zbiera WSZYSTKIE linie deklaracji `^\s*[-*]?\s*Werdykt\s*[:：]` z całego
    dokumentu (nie tylko pierwszą przez `.find`);
  - `0` deklaracji → `missing`; `>1` deklaracji → `ambiguous`;
  - dla dokładnie jednej deklaracji liczy SUROWE wystąpienia tokenu (bez
    deduplikacji przez `Set`): `0` → `missing`, `>1` → `ambiguous` (obejmuje
    zarówno placeholder `PASS | CHANGES_REQUIRED | BLOCKED`, jak i `PASS PASS`),
    dokładnie `1` → `ok`.
- `STATUS_TO_REQUIRED_VERDICT` uzupełniony o `BLOCKED → BLOCKED`. Egzekwowanie
  pozostaje strzeżone warunkiem `audits > 0` w `validate`, co daje
  deterministyczne, udokumentowane rozróżnienie provenance:
  - **proceduralny `BLOCKED`** (brak audytu) — legalny bez werdyktu;
  - **audytowy `BLOCKED`** (istnieje audyt) — najnowszy werdykt musi być
    `BLOCKED`.
  Rozróżnienie oparte jest na obecności artefaktu audytu, więc jest testowalne i
  nie łamie ścieżki Decision Request. `BLOCKED` celowo NIE jest w
  `STATUSES_REQUIRING_AUDIT` (proceduralna blokada nie wymaga audytu).
- `test/workflow/validate.test.ts` — dodane testy:
  - parser: dwie linie `Werdykt` → ambiguous; `PASS PASS` → ambiguous;
  - `validate`: status z audytem o dwóch sprzecznych liniach → odrzucony; status
    z audytem `PASS PASS` → odrzucony;
  - provenance `BLOCKED`: proceduralny bez audytu → ok; audytowy `BLOCKED` +
    `BLOCKED` → ok; `BLOCKED` + `PASS` → odrzucony; `BLOCKED` +
    `CHANGES_REQUIRED` → odrzucony.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `scripts/workflow/validate.ts` | `parseAuditVerdict` (cały dokument, jedna deklaracja, jeden surowy token); `BLOCKED → BLOCKED` w mapie | AUDIT-02 finding HIGH |
| `test/workflow/validate.test.ts` | testy trzech reprodukcji + provenance `BLOCKED` (proceduralny vs audytowy) | AUDIT-02 wymagane testy |
| `docs/handoffs/RA-001/HANDOFF-03.md` | ten handoff | bramka audytowa |
| `docs/tasks/TASK_INDEX.md` | RA-001 → `AWAITING_AUDIT` | bramka audytowa |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Instalacja jednym poleceniem z czystego checkoutu | PASS | working tree = commit (clean status, zgodny HEAD); `pnpm install --frozen-lockfile` „Already up to date”, 21 projektów |
| 2. Deterministyczne `lint`/`typecheck`/`test`/`build` z roota | PASS | `pnpm run check` zielony; build 20/20 (0 cached po `rm -rf .turbo dist`) |
| 3. Każdy app/package ma manifest i jest widoczny dla workspace | PASS | 21 workspace projektów |
| 4. CI używa lockfile i nie pobiera sekretów | PASS | `.gitlab-ci.yml`: frozen install, obraz `24.19.0`, brak credential variables |
| 5. Strict TS i boundaries mają celowo failing fixture/test | PASS | guardrails: TS7006 + `boundaries/dependencies` |
| 6. Brak skopiowanych credentiali/danych z `../Private` | PASS | skan tracked/staged — zero trafień (jedyny match to env-var reference w `scripts/bedrock-worker`) |
| 7. `workflow:validate` odrzuca niezgodne stany i wadliwe audyty | PASS | 30 testów; trzy reprodukcje AUDIT-02 odrzucone; provenance `BLOCKED` pokryty |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run test/workflow/validate.test.ts` | 0 | 30 testów passed |
| `pnpm install --frozen-lockfile` | 0 | „Already up to date”, 21 projektów, pnpm `10.26.1` |
| `pnpm run check` (po `rm -rf .turbo dist`) | 0 | build 20/20 (0 cached); `workflow:validate OK — 26 tasks`; lint/format/typecheck/test w łańcuchu |
| skan sekretów (tracked/staged, ripgrep honorujący `.gitignore`) | 0 | zero trafień |

## Bezpieczeństwo i dane

- Sekrety: brak w śledzonym drzewie; commit fix nie wprowadza sekretów.
- Git: repo lokalne, bez remote i bez push.
- Side effecty: `workflow:validate` read-only; zmiana dotyczy tylko parsera i mapy.
- Dane zewnętrzne: brak integracji w zakresie RA-001.

## Znane ograniczenia i ryzyka

- **Weryfikacja na Node `24.19.0` lokalnie:** niewykonalna w tym środowisku
  (brak nvm/fnm/volta/Corepack; daemon Dockera wyłączony). Frozen install i pełny
  `pnpm run check` uruchomiłem na Node `25.2.1` przeciw treści commitu (working
  tree = committed tree). Wiążącym dowodem na dokładnej wersji pozostaje job CI na
  obrazie `node:24.19.0-bookworm-slim`; AUDIT-02 niezależnie potwierdził clean
  archive install/check na dokładnym Node `24.19.0`.
- **Izolowany `git archive`:** `git archive`, `git -C`, `git grep`, `rsync` i
  potoki są blokowane przez warstwę uprawnień środowiska. Tożsamość working tree z
  commitem potwierdziłem czystym `git status` i zgodnym `HEAD`.

## Otwarte pytania

- Brak blokujących.

## Stan dla następnego agenta

- Co jest gotowe: finding HIGH z AUDIT-02 naprawiony; 30 testów zielonych; commit
  fix na `main`.
- Czego nie robić przed audytem: nie rozpoczynać RA-002; nie dodawać remote/push;
  nie zmieniać kontraktów/wersji bez ADR.
- Dla audytora: reprodukcja trzech fixture'ów z AUDIT-02 (dwie linie werdyktu,
  `PASS PASS`, audytowy `BLOCKED` + `PASS`) musi teraz failować; proceduralny
  `BLOCKED` bez audytu musi pozostać legalny; potwierdzić na obrazie CI
  `node:24.19.0-bookworm-slim`.
