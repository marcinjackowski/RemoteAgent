# RA-038 — AUDIT-01

- Task: `RA-038` Trwałe operacje, eventy i recovery Engineering Control Plane
- Data: `2026-08-26`
- Bazowy commit: `8c9708e3a2fcc2fc633c5897e8cb0184d779f663`
- Role: Sol — plan, odczyt pełnego diffu, własna weryfikacja i finalny audyt;
  Luna — bounded discovery/implementation

Werdykt w §8.

## 1. Uruchomione bramki

Celowane bramki na realnym PostgreSQL obejmowały migrację, repository, queue,
completion/checkpoint i composition root workera. Ostatni targeted run po
findingu lock-order:

```text
engineering-control-plane                    34/34, 1/1 plik, exit 0
database production+test typecheck           exit 0
mutation run→job lock order                  exit 1, lock_timeout (RED)
restore job→run                              1/1 targeted, exit 0
```

Pełna bramka uruchomiona przez Sol po ostatniej zmianie produkcyjnej:

```text
lint                                         exit 0
prettier --check                             exit 0
RA_REQUIRE_POSTGRES=1 vitest run             exit 0
turbo run typecheck --force                  38/38, 0 cached, exit 0
turbo run build --force                      26/26, 0 cached, exit 0
workflow:validate                            OK — 45 tasks, exit 0
```

Osobny finalny pełny przebieg testów z reporterem `dot` potwierdził dokładne
`2515/2515` testów w `194/194` plikach, exit `0`. Integracje użyły realnego
PG15/5432, wybranego przez `. scripts/dev/env.sh`; `RA_REQUIRE_POSTGRES=1`
wykluczał ciche skipy.

Pierwsza próba pełnej bramki zatrzymała się na formatowaniu jednego nowego
pliku. Druga poprawnie zatrzymała stale-build guard golden-path przed testowaniem
nieaktualnego `dist/database`. Po formatowaniu i `build --force` pełna komenda
została uruchomiona od początku i zakończyła się exit `0`; tych czerwonych prób
nie zaliczono jako dowodu końcowego.

## 2. Kryteria akceptacji — każde osobno

1. **Rollback migracji:** spełnione. Migracja `034` ma symetryczny down, a
   istniejący test lifecycle wykonał zero→up oraz up→down→up na izolowanej bazie.
2. **Write-once/idempotency:** spełnione. Operations, artifacts i events mają
   DB-level append-only/unique/FK; semantic replay zwraca ten sam rekord, a
   collision failuje. Mutacje triggera overwrite i rozdzielenia
   `operation_id`/idempotency dały RED.
3. **Intent-before-effect/AMBIGUOUS:** spełnione. Binding zapisuje istniejący
   `job_intent` i operation atomowo; `STARTED` jest singletonem commitowanym
   przed dispatch i nie może być użyty ponownie. Unknown mutating write bez
   receiptu jest zawsze `AMBIGUOUS`.
4. **Crash matrix:** spełnione. Real-PG testy obejmują intent bez `STARTED`,
   retry-safe `STARTED`, mutujący `STARTED`, completion/reconciliation bez
   projekcji oraz delete+rebuild. `CONFIRMED`, `ABSENT` i `UNRESOLVED` mają
   oddzielne wyniki.
5. **Scope/fence/digest:** spełnione. Kompozytowe FK wiążą case/owner/run/job/
   checkpoint/stage/attempt; live fence jest ponownie walidowany we wspólnej
   transakcji. Scope, fence, stale projection digest, foreign actor i artifact
   tamper failują zamknięcie.
6. **Rekonstrukcja:** spełnione. `engineering_run_projections` jest jedyną
   mutowalną/usuwalną tabelą; usunięcie i `prepareResume()` odtwarza identyczny
   canonical projection digest z niezmiennych ledgerów.
7. **Ownership map/kompatybilność:** spełnione. `job_intents`, completions i
   reconciliations pozostały źródłem prawdy efektów; `run_completions`, baseline
   checkpoint i outbox nie zmieniły semantyki. Ich regresja ma `24/24`, a pełny
   worker/golden-path jest zielony.
8. **Operator-safe port:** spełnione. Status jest owner-scoped i read-only;
   acknowledge/cancel/retry/reconcile wymagają actor ownership, aktualnego
   projection digest i idempotentnego action ID. Strict input odrzuca `SUCCESS`
   i caller-supplied receipt; reconcile używa wyłącznie `JobStore.reconcile()`.
9. **Identity/terminal state:** spełnione. Każdy rekord niesie run/case/op/stage/
   attempt. Cancel bez unknown write daje `CANCELLED`; unknown write zachowuje
   `AMBIGUOUS`; scope/fence/kill dają `BLOCKED`, deadline `EXHAUSTED`.
10. **CTF-022/środowisko:** spełnione. `env.sh` wykonuje bounded realny
    `psql -X -w ... SELECT 1`, szanuje URL/discrete aliases, nie loguje sekretu,
    nie fallbackuje po błędnej jawnej konfiguracji i wybiera lokalne 5432 bez
    syntetycznego URL-a. Harness ma `8/8`; realna DB integration `8/8`.

## 3. Diff, transakcje i architektura

Sol przeczytał pełny diff od bazowego commita, oba kierunki migracji, całe nowe
repository i jego testy oraz istotny `JobStore`. Powstały cztery struktury:
immutable operation binding, append-only artifacts, append-only stage/operator
events i odbudowywalna projection. Nie powstał filesystem store ani drugi
effect journal; nie zmieniono `SupervisorRuntime` ani Bedrock/context/workspace.

`recordIntentInTransaction()` zachowuje dotychczasowy publiczny wrapper, ale
umożliwia operation binding w tej samej transakcji. Crash przed binding commit
nie zostawia osieroconego intentu. Reconcile request i receipt są świadomie
dwoma transakcjami: request powstaje przed efektem, `actionId` jest attempt key,
a brak receipt po crashu można bezpiecznie odtworzyć bez wymyślania outcome.

## 4. Security i współbieżność

- Model/caller nie ustala case, owner, checkpoint, scope digest, fence ani
  receipt; wartości są wyprowadzane z autorytatywnych wierszy.
- Event API jest celowo wąskie — brak publicznego generic append dla `STARTED`
  lub completion/reconciliation receipt.
- Pre-dispatch ponownie sprawdza live lease, scope, case/cancel state, deadline i
  applicable kill switches.
- Audyt wykrył materialny lock-order finding: bind brał `agent_runs→jobs`, a
  operator/effect `jobs→agent_runs`. Zmieniono wszystkie ścieżki na
  `jobs→agent_runs`; test z trzema transakcjami dowodzi braku cyklu. Stara
  kolejność deterministycznie kończy test `lock_timeout`.
- Unknown mutating write ma pierwszeństwo nad cancel/scope/fence, więc nie jest
  zaciemniany bezpieczniejszą klasyfikacją.

## 5. Mutation evidence

Każdą mutację wykonano na rzeczywistym kodzie, przywrócono i ponowiono GREEN:

| Mechanizm | Mutacja | Dowód RED |
|---|---|---|
| append-only | usunięcie operations triggera | UPDATE/DELETE przestał failować |
| exact identity | usunięcie `operation_id=idempotency_key` | split identity przyjęte |
| atomic intent | osobna transakcja `recordIntent` | orphan intent po fault |
| live fence | pominięcie replayu lease przed `STARTED` | stary token zapisał event |
| owner auth | wyłączenie `actorId===owner_id` | obcy actor zapisał event |
| cancel guard | pominięcie cancel event przed dispatch | anulowany op dostał `STARTED` |
| missing STARTED | intent-only → `RECOVERED` | recovery test RED |
| unknown write | mutating `STARTED` → `RECOVERED` | AMBIGUOUS test RED |
| lock order | przywrócenie `run→job` | `lock_timeout` RED |
| env fallback | eksport portu `5432→5433` | fallback harness RED |

## 6. Operacyjność i findings

Operator może odczytać projekcję i wykonać bounded, audytowalne działania bez
ręcznej edycji DB. `CTF-022` jest zamknięty rzeczywistym probe i integracją.
Finding lock-order klasy MEDIUM został usunięty przed werdyktem i ma mutację
RED→GREEN. Nie powstał nowy finding przekrojowy. Po audycie nie pozostaje finding
BLOCKER, HIGH ani MEDIUM w zakresie RA-038.

Raport Luny nie był dowodem: werdykt wynika z odczytu pełnego diffu, własnych
celowanych mutacji i pełnych przebiegów uruchomionych przez Sol.

## 7. Zakres i stan zewnętrzny

Zmiany odpowiadają allowed paths WU-00..05. Aktualizacja `AGENTS.md` i CTF dotyczy
wyłącznie naprawionego środowiska WU-00. Nie wykonano AWS/Bedrock/Jira/Discord/
GitLab write, push, MR ani merge.

## 8. Werdykt

- Werdykt: `PASS`

Wszystkie dziesięć kryteriów RA-038 jest spełnionych, mechanizmy bezpieczeństwa
mają działające mutation evidence, pełna bramka ma exit code `0`, a po audycie
nie pozostał finding BLOCKER, HIGH ani MEDIUM.
