# RA-001 — Handoff 01

## Metadata

- Task: `RA-001`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER (Claude Opus 4.8)
- Data: 2026-08-18
- Bazowy commit lub stan początkowy: brak commitów; repozytorium zawierało tylko
  dokumenty planu (`AGENTS.md`, `CLAUDE.md`, `docs/**`, `scripts/bedrock-worker*`).
- Końcowy commit lub stan working tree: bez commitu (git root to
  `/Users/marcinjackowski/Private`, brak historii). Zmiany istnieją w working tree
  katalogu `RemoteAgent/`. Zob. sekcja „Znane ograniczenia i ryzyka”.

## Wynik

Powstał minimalny, powtarzalny fundament monorepo. Z czystego checkoutu jedno
polecenie instaluje zależności, a cztery deterministyczne komendy z roota
(`lint`, `typecheck`, `test`, `build`) plus `workflow:validate` przechodzą.
Wszystkie aplikacje i pakiety z Master Planu istnieją jako widoczne dla workspace
szkielety bez logiki domenowej. Granice zależności i strict TypeScript są
egzekwowane i chronione celowo failującymi fixture'ami.

## Zrealizowany zakres

- `pnpm` workspaces (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `infra/*`),
  package manager przypięty (`packageManager: pnpm@10.26.1`), Turborepo
  (`turbo.json`) dla `build`/`typecheck`.
- Strict TypeScript (`tsconfig.base.json`) z rozszerzonymi flagami; wspólne
  konfiguracje lint (ESLint flat + `typescript-eslint` + `eslint-config-prettier`),
  format (Prettier), test (Vitest) i build (tsc per workspace).
- Szkielety 6 apps, 13 packages i `infra/cdk` — każdy z `package.json`,
  `tsconfig.json` i minimalnym `src/index.ts` bez logiki produktowej.
- Vitest z konwencją warstw (`test/**`, plus `*.test.ts` przy pakietach).
- Docker Compose dla lokalnego PostgreSQL (wartości wyłącznie lokalne, nie-sekretne).
- GitLab CI (`.gitlab-ci.yml`) uruchamiający install (`--frozen-lockfile`), lint,
  format, typecheck, test, build i `workflow:validate` bez pobierania sekretów.
- Reguły dependency boundaries (ESLint `boundaries/dependencies`): zakaz
  app→app, package→app; infra tylko → package.
- `workflow:validate` (`scripts/workflow/validate.ts`) walidujący ID, linki,
  statusy, zależności, cykle oraz wymagane pliki handoff/audit wg statusu.
- ADR `docs/decisions/ADR-0001-foundation-tooling.md` z wersjami i wyborami.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `package.json` (root) | manifest workspace, przypięte devDeps, skrypty root, `pnpm.onlyBuiltDependencies` | jedno źródło komend i wersji |
| `pnpm-workspace.yaml` | definicja workspace | wykrywalność apps/packages/infra |
| `tsconfig.base.json`, `tsconfig.json` | strict base + root config narzędzi | wspólny, hermetyczny typecheck |
| `turbo.json` | taski `build`/`typecheck` | lekka orkiestracja topologiczna |
| `eslint.config.mjs` | flat config + dependency boundaries | egzekwowanie granic |
| `.prettierrc.json`, `.prettierignore` | format kodu; wyłączenie prozy/plików nieautorowanych | deterministyczny format bez ruszania cudzej prozy |
| `vitest.config.ts` | konfiguracja testów | jedna konfiguracja testowa |
| `apps/*`, `packages/*`, `infra/cdk` | szkielety (`package.json`, `tsconfig.json`, `src/index.ts`) | struktura z Master Planu bez logiki |
| `scripts/workflow/validate.ts` | walidator kolejki tasków | kryterium 7 |
| `test/workflow/validate.test.ts` | pozytywne i negatywne fixtures walidatora | dowód działania walidatora |
| `test/guardrails/**` | fixtures + spec strict/boundary | kryterium 5 |
| `docker-compose.yml` | lokalny PostgreSQL | lokalne zależności |
| `.gitlab-ci.yml` | pipeline kontroli | kryterium 4 |
| `.gitignore` | node_modules/dist/.turbo/coverage/logi | brak artefaktów w repo |
| `.nvmrc` | `24` (referencyjny Node dla CI) | reprodukowalność |
| `README.md` | sekcja „Rozwój (foundation)” | jedno udokumentowane polecenie i komendy |
| `docs/decisions/ADR-0001-foundation-tooling.md` | ADR toolingu | zapisane decyzje |
| `docs/tasks/TASK_INDEX.md` | RA-001 → `AWAITING_AUDIT` | bramka audytowa |

## Decyzje i uzasadnienie

- **TypeScript `5.9.3`, nie `7.x`:** `typescript-eslint@8.67` wspiera TS `<6.1.0`.
  Najnowszy natywny `typescript@7` złamałby lint. Świadomy wybór, opisany w ADR.
- **Lint/test z roota, build/typecheck przez Turborepo:** pojedyncza konfiguracja
  ESLint/Vitest zamiast 20× duplikacji; Turbo daje kolejność i cache dla tsc.
- **Brak `.npmrc`:** narzędzie zaproponowało go, ale plik bywa nośnikiem tokenów i
  jest oznaczony jako sensitive. Determinizm zapewniają dokładne wersje devDeps +
  `pnpm-lock.yaml` + `pnpm install --frozen-lockfile` w CI.
- **`engines.node >= 22`, `.nvmrc` = 24:** lokalny runtime (Node 25.2) nie może
  blokować instalacji; CI używa `node:24-bookworm-slim`.
- **Prettier tylko dla kodu/konfiguracji:** proza Markdown i pre-istniejące pliki
  bedrock-worker (schema, IAM policy) są wyłączone, aby nie przeformatowywać
  treści spoza zakresu RA-001 (zasada zachowania cudzych zmian).
- **`esbuild` w `onlyBuiltDependencies`:** vitest/vite wymagają zbudowanego
  binarium esbuild; bez zgody build-script instalacja jest niekompletna.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Instalacja jednym poleceniem z czystego checkoutu | PASS | `pnpm install --frozen-lockfile` → „Already up to date”; README dokumentuje polecenie |
| 2. Deterministyczne `lint`/`typecheck`/`test`/`build` z roota | PASS | lint exit 0; typecheck „20 successful”; test „14 passed”; build „20 successful” |
| 3. Każdy app/package ma manifest i jest widoczny dla workspace | PASS | `pnpm ls -r`: root + 6 apps + 13 packages + `infra/cdk` = 21 projektów |
| 4. CI używa lockfile i nie pobiera sekretów | PASS | `.gitlab-ci.yml`: `pnpm install --frozen-lockfile`, brak `variables` z sekretami |
| 5. Strict TS i boundaries mają celowo failing fixture/test | PASS | `test/guardrails`: tsc→TS7006, eslint→`boundaries/dependencies`; oba asercje w spec |
| 6. Brak skopiowanych credentiali/danych z `../Private` | PASS | skan wzorców sekretów w drzewie `RemoteAgent/` — brak trafień |
| 7. `workflow:validate` błąd przy złym statusie/braku pliku/cyklu/braku handoff-audit | PASS | 12 testów walidatora (6 negatywnych) + realne repo „OK — 26 tasks” |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | Already up to date; lockfile spójny |
| `pnpm run lint` | 0 | ESLint czysty (flat config + boundaries) |
| `pnpm run format` | 0 | „All matched files use Prettier code style” |
| `pnpm run typecheck` | 0 | root tsc + 20 workspace typecheck OK |
| `pnpm run test` | 0 | 2 pliki, 14 testów passed (workflow + guardrails) |
| `pnpm run build` | 0 | 20 workspace build OK |
| `pnpm run workflow:validate` | 0 | „workflow:validate OK — 26 tasks” |
| `pnpm exec tsc -p test/guardrails/fixtures/strict/tsconfig.json` | 2 | oczekiwany fail: TS7006 (noImplicitAny) |
| eslint na fixture boundary | 1 | oczekiwany fail: `boundaries/dependencies` |
| skan sekretów (grep wzorców) | — | brak trafień w `RemoteAgent/` |

## Snapshoty i artefakty

- Brak snapshotów. Artefakty buildu (`dist/`, `.turbo/`) są ignorowane przez Git.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak. `.npmrc` celowo pominięty; CI bez sekretów.
- Izolacja kont/scope: poza zakresem RA-001 (brak integracji).
- Side effecty i idempotencja: `workflow:validate` jest read-only; brak side
  effectów zewnętrznych. Instalacja jest idempotentna dzięki lockfile.
- Dane zewnętrzne: brak; nie ma połączeń z Jira/Gmail/Calendar/GitLab/Discord.
- Docker Compose: hasło PostgreSQL to jawnie oznaczona lokalna wartość deweloperska.

## Znane ograniczenia i ryzyka

- **Git root:** `git rev-parse --show-toplevel` = `/Users/marcinjackowski/Private`,
  a nie `RemoteAgent/`, i repozytorium nie ma commitów. Nie inicjalizowałem ani
  nie zmieniałem gita (byłoby to poza zakresem i potencjalnie destrukcyjne dla
  wielu innych projektów w `Private/`). „Skan plików śledzonych przez Git”
  wykonałem jako skan drzewa roboczego `RemoteAgent/`, bo nic nie jest tracked.
  **Rekomendacja dla właściciela:** zdecydować, czy `RemoteAgent/` ma mieć własne
  repozytorium (`git init` w katalogu) przed pierwszym commitem/CI.
- **Bleeding-edge tooling:** eslint 10, vite 8, TS 5.9 są bardzo świeże; przyszłe
  aktualizacje mogą wymagać rewizji (opisane w ADR).
- **`node:24` w CI vs Node 25.2 lokalnie:** różnica wersji między CI a lokalnym
  środowiskiem; łagodzona przez `engines >= 22` i lockfile.

## Otwarte pytania

- Brak blokujących. Jedyna decyzja właściciela (własne repo git dla `RemoteAgent/`)
  nie blokuje RA-001 i została opisana jako rekomendacja, nie `Decision Request`.

## Stan dla następnego agenta

- Co jest gotowe: cały fundament; wszystkie kontrole zielone; walidator z testami.
- Czego nie robić przed audytem: nie rozpoczynać RA-002; nie zmieniać kontraktów
  ani wersji bez ADR; nie reformatować pre-istniejącej prozy docs.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: findingi audytu →
  `IN_PROGRESS`, poprawki w zakresie RA-001, ponowne uruchomienie `pnpm run check`
  i nowy `HANDOFF-02.md`.
