# ADR-0001 — Foundation tooling and pinned versions

- Status: Accepted
- Date: 2026-08-18
- Task: RA-001

## Kontekst

RA-001 tworzy fundament monorepo, na którym budują wszystkie kolejne taski.
Master Plan wymaga: monorepo TypeScript na `pnpm` workspaces z lekką orkiestracją,
przypiętych wersji runtime i package managera, strict TypeScript, walidacji
kontraktów runtime oraz osobno wdrażalnych aplikacji. Potrzebna jest jedna
deterministyczna ścieżka install/lint/typecheck/test/build oraz walidacja kolejki
tasków.

## Decyzja

- **Package manager:** `pnpm@10.26.1`, deklarowany polem `packageManager` i
  aktywowany przez Corepack w CI. Determinizm gwarantuje `pnpm-lock.yaml` oraz
  `pnpm install --frozen-lockfile`.
- **Runtime Node:** przypięty do dokładnej wersji `24.19.0` spójnie w
  `engines.node`, `.nvmrc`, obrazie CI (`node:24.19.0-bookworm-slim`), README i
  tym ADR. `engine-strict` pozostaje wyłączony, więc deweloper na innej lokalnej
  wersji dostaje ostrzeżenie, a nie twardy błąd instalacji; wiążącym dowodem
  reprodukowalności jest install/check uruchomiony w obrazie CI na `24.19.0`.
- **Orkiestracja:** Turborepo `2.10.10` dla `build` i `typecheck` (kolejność
  topologiczna + cache). `lint` i `test` uruchamiane raz z roota (jedna wspólna
  konfiguracja ESLint/Vitest) — deterministyczne i bez duplikacji konfiguracji.
- **TypeScript:** `5.9.3` w trybie strict + dodatkowe flagi
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noUnused*`). Moduły `NodeNext`, `verbatimModuleSyntax`, `isolatedModules`.
  Uwaga: `typescript-eslint@8.67` wspiera TypeScript `<6.1.0`, więc nie używamy
  najnowszego `typescript@7` (native port), aż lint go wesprze.
- **Lint:** ESLint `10.8.1` flat config, `typescript-eslint@8.67`,
  `eslint-config-prettier` i `eslint-plugin-boundaries@7.2` dla granic zależności
  (reguła `boundaries/dependencies`).
- **Format:** Prettier `3.9.6`.
- **Testy:** Vitest `4.1.11` (+ `vite@8.2.1` jako peer). Konwencja
  `*.test.ts` z podziałem na warstwy w `test/` oraz przy pakietach.
- **Uruchamianie narzędzi TS:** `tsx@4.23.12` dla skryptów (`workflow:validate`).
- **Lokalna infrastruktura:** Docker Compose z `postgres:17.2-alpine`; wyłącznie
  lokalne, nie-sekretne wartości logowania.
- **Granice zależności:** apps nie importują apps; packages nie importują apps;
  infra zależy tylko od packages. Reguła jest egzekwowana przez ESLint i chroniona
  celowo failującym fixture w `test/guardrails`.
- **Walidacja workflow:** `scripts/workflow/validate.ts` sprawdza ID, linki,
  statusy, zależności, cykle oraz wymagane pliki handoff/audit dla statusu.

## Dlaczego dokładne wersje bezpośrednich devDependencies

Bezpośrednie devDependencies są przypięte do dokładnych wersji (bez `^`), a
`pnpm-lock.yaml` przypina graf tranzytywny. Instalacja `--frozen-lockfile` w CI
uniemożliwia dryf wersji bez zmiany w repo. `.npmrc` celowo nie jest dodawany —
plik ten bywa nośnikiem tokenów; determinizm zapewniamy jawnymi wersjami i
lockfile, a nie konfiguracją mogącą przechowywać sekrety.

## Alternatywy

- **npm/yarn workspaces:** odrzucone; Master Plan wskazuje `pnpm` i jego twardy
  store/lockfile daje najlepszy determinizm.
- **Nx zamiast Turborepo:** cięższy; Master Plan mówi o „lekkiej orkiestracji”.
- **`no-restricted-imports` zamiast `eslint-plugin-boundaries`:** trudniej wyrazić
  granice na poziomie typów elementów (app/package/infra).
- **`typescript@7` (native):** najnowszy, ale nieobsługiwany jeszcze przez
  `typescript-eslint@8.67`; wstrzymane do czasu wsparcia w lint.
- **Lint/test przez Turborepo per-package:** wymagałoby 20× duplikacji
  konfiguracji; wybrano pojedynczą konfigurację z roota.

## Konsekwencje

- Jedna udokumentowana instalacja (`pnpm install --frozen-lockfile`) i cztery
  root commands (`lint`, `typecheck`, `test`, `build`) plus `workflow:validate`.
- Każdy przyszły task dokłada workspace bez zmiany konfiguracji bazowej.
- Aktualizacja bleeding-edge (TS 7, eslint majors) wymaga świadomej rewizji.

## Migracja i rollback

- Migracja: brak — to pierwszy fundament.
- Rollback: usunięcie dodanych plików konfiguracyjnych i workspace przywraca stan
  sprzed RA-001; brak migracji danych, brak stanu trwałego poza lokalnym Dockerem.
