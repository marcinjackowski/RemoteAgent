# Runbook M3 — golden path

Jak uruchomić i odczytać dowód milestone'u M3. Powstał w RA-018; obowiązuje jako
punkt wejścia dla RA-026 i dla każdego, kto musi odtworzyć ten wynik.

## Warunki wstępne

```sh
. scripts/dev/env.sh          # pinuje działający node i pnpm, sprawdza PostgreSQL
pnpm run build --force        # OBOWIĄZKOWE — patrz „Dlaczego build jest wymagany"
```

`env.sh` musi zaraportować `pg up on 127.0.0.1:5433`. Jeżeli nie:

```sh
/opt/homebrew/opt/postgresql@17/bin/pg_ctl \
  -D /opt/homebrew/var/postgresql@17 \
  -l /opt/homebrew/var/log/postgresql@17.log \
  -o "-p 5433 -h 127.0.0.1" start
```

`brew services start postgresql@17` uruchamia serwer na **5432**, nie 5433, więc
integracyjne bramki go nie znajdą. Docker na tej maszynie jest niesprawny (niezgodny
client/engine) i nie jest do niczego potrzebny.

## Bramka

```sh
RA_REQUIRE_POSTGRES=1 pnpm vitest run test/golden-path        # 11 testów
RA_REQUIRE_POSTGRES=1 pnpm vitest run                        # całe repo
pnpm run typecheck --force && pnpm run build --force
pnpm exec prettier --check . && pnpm workflow:validate
```

`RA_REQUIRE_POSTGRES=1` jest obowiązkowe: bez niego niedostępny PostgreSQL daje
**ciche skipy**, a suite raportuje sukces, nie uruchomiwszy integracji.

`--force` jest obowiązkowe dla `typecheck`/`build`: `turbo` raportuje `FULL TURBO` z
cache, nie uruchamiając kompilatora.

## Dlaczego build jest wymagany

`test/golden-path` importuje pakiety przez `node_modules`, więc ćwiczy `dist/` — czyli
artefakty, które załadowałby deployment. Stary build oznacza, że suite certyfikuje kod,
którego już nie ma (`CTF-011`).

Suite sama tego pilnuje: `assertPackagesAreCurrent` odmawia uruchomienia, gdy
którykolwiek z ośmiu ćwiczonych pakietów ma `dist/` starszy niż `src/`, i podaje
komendę naprawczą. Komunikat wygląda tak:

```text
golden path would test a STALE build for: implementation-tools.
Run `pnpm run build --force` first.
```

## Co ten dowód pokrywa

| Kryterium | Gdzie |
|---|---|
| dwa taski realnie równolegle | bariera zwalniana tylko przez drugi case + `peakInside === 2` |
| jeden writer na case | scope fence ledgera; wspólny root → jeden `SUCCEEDED` |
| restart nie traci stanu | świeże repozytorium nad tą samą bazą; MR z remote'a po parze branchy |
| crash → `AMBIGUOUS` | zaklaimowana operacja bez receiptu; bajty nietknięte |
| MR wskazuje evidence i SHA | receipty w commit receipt i w opisie MR |
| decyzja wznawia właściwy case | dwa oczekujące pytania, odpowiedź na jedno |
| redelivery bez duplikatów | 3 × webhook → 1 accept; 3 × publish → 1 MR |

## Czego ten dowód NIE pokrywa

Trzeba to czytać razem z wynikiem, bo zielona suite nie mówi tego sama:

1. **Live GitLab.** Jira i GitLab są nagrywającymi fake'ami. Zakres taska przewiduje
   sandbox tylko przy jawnie udzielonych credentialach — nie było ich.
2. **Discord send.** Manual acceptance script nie został wykonany; wymaga zgody
   właściciela. Domyślny transport jest fake.
3. **Orkiestracja w `apps/`.** RA-018 dowodzi kontraktów i przepływu między pakietami.
   Spięcie w produkcyjnym runtime należy do RA-021+.

## Odczyt wyniku

Zielona suite bez tych trzech zastrzeżeń nie jest kompletnym dowodem M3 i nie należy
jej tak raportować. Sygnatura poprawnego przebiegu:

```text
Test Files  124 passed (124)
     Tests  1388 passed (1388)
```

**Zero `Errors` jest częścią sygnatury.** `Errors 1` przy zielonych testach oznaczało
`CTF-007` (nieobsłużony `57P01` z bezczynnego połączenia) — domknięty w `cfc3a15`, ale
gdyby wrócił, testy nadal byłyby zielone. Liczba `Errors` różna od zera jest
regresją, nawet jeśli wszystkie testy przechodzą.
