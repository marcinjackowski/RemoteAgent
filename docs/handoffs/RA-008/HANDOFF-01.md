# RA-008 — Handoff 01

## Metadata

- Task: `RA-008`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: Sol, `COORDINATOR_AUDITOR`, na podstawie raportów implementera i
  niezależnych unit gates
- Implementer model/transport: `GPT-5.6 Luna / medium`
- Work-units plan: `docs/work-units/RA-008/WORK_UNITS.md`, revision `28`
- Zaakceptowane units: `WU-01`, `WU-02`, `WU-03`, `WU-04A`, `WU-04B`, `WU-05A`,
  `WU-05B`, `WU-05C`, `WU-06`, `WU-07A`, `WU-07B`, `WU-08A`, `WU-08A-F1`,
  `WU-08A-F2`, `WU-08A-F3`, `WU-08B`, `WU-08B-F1`, `WU-08B-F2`, `WU-08C`
- Data: 2026-08-20
- Bazowy commit lub stan początkowy: `171d3c66c1a82266e11613b9d0d5dce575172061`
- Końcowy commit ocenianej implementacji: `f2f13158c2b6bbf8b7da72ea788b444cf946139e`

## Wynik

Powstał trwały, crash-safe przepływ checkpointów, kontekstu i decyzji. System
buduje deterministyczny scoped context, zapisuje completion atomowo, przechodzi
w trwałe oczekiwanie na odpowiedź, wznawia case dokładnie raz i odtwarza plan
wyłącznie z danych PostgreSQL bez pamięci poprzedniej sesji modelu.

## Zrealizowany zakres

- repozytoria decyzji, waiting, answer/resume, run completion i recovery snapshot;
- deterministyczny context builder z provenance, budżetem, redakcją i scope;
- czysta aplikacja checkpoint patch oraz transakcyjny optimistic apply;
- przygotowanie i trwała materializacja `DecisionRequest`;
- Markdown jako read-only projection checkpointu;
- deterministyczny compaction manifest bez utraty chronionych decyzji;
- recovery planner i pełna macierz crash/resume przez publiczne API.

## Wykonanie work units

| Zakres units | Raport implementera | Sol gate | Wynik |
|---|---|---|---|
| WU-01..03 | decisions, context, patch | targeted tests, typecheck, diff | ACCEPTED |
| WU-04A..05C | completion, waiting, answer/resume | real PostgreSQL, stale/concurrency proofs | ACCEPTED |
| WU-06..07B | projection i compaction | golden/negative tests, protected context | ACCEPTED |
| WU-08A..08C + fix units | durable snapshot, planner, crash matrix | 56 recovery tests i pełna regresja | ACCEPTED |

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/src/repositories/` | transakcyjne repozytoria decyzji, completion i recovery | trwałość, fencing i restart |
| `packages/agent-orchestrator/src/context/` | scoped builder, budget i compaction | deterministyczny, bezpieczny prompt context |
| `packages/agent-orchestrator/src/checkpoint/` | patch, completion preparation i Markdown projection | JSON source of truth i optimistic concurrency |
| `packages/agent-orchestrator/src/decisions/` | typed przygotowanie request/answer | model nie steruje stanem ani scope |
| `packages/agent-orchestrator/src/recovery.ts` | fail-closed recovery plan | wznowienie bez session memory i bez replay side effectu |
| `packages/discord/src/status.ts` | projekcja checkpoint/status | Discord nie zapisuje źródła prawdy |
| testy trzech pakietów | unit, real-PG, concurrency i crash/resume | dowód kryteriów RA-008 |

## Decyzje i uzasadnienie Sol

JSON checkpoint pozostaje jedynym źródłem prawdy, a rendering i compaction są
deterministycznymi projekcjami. Completion, checkpoint i przejście case zapisują
się w jednej transakcji z kontrolą oczekiwanej rewizji. Niepotwierdzony aktywny
run nie jest automatycznie replayowany; recovery zwraca jawny stan
`RECONCILIATION_REQUIRED`. Scope pochodzi z trwałych bindings, nigdy z modelu.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Decision request i odpowiedź przetrwają restart | PASS | decision waiting/resume i recovery integration tests |
| 2. Dwa completion nie nadpisują nowszego checkpointu | PASS | optimistic concurrency real-PG tests |
| 3. Stale/foreign answer jest odrzucone | PASS | decision-resume negative matrix |
| 4. `WAITING_FOR_USER` nie utrzymuje procesu ani lease | PASS | completion zamyka active run; job powstaje dopiero po answer |
| 5. Markdown nie nadpisuje JSON source of truth | PASS | czysty renderer i golden projection tests |
| 6. Context nie miesza connection scopes | PASS | binding/provider validation i cross-case recovery proofs |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| real-PG testy `agent-orchestrator`, `database`, Discord status | 0 | 25 plików, 311 testów PASS |
| focused recovery suites | 0 | 4 pliki, 56 testów PASS |
| typecheck i build trzech dotkniętych pakietów | 0 | PASS |
| scoped ESLint dla 38 zmienionych plików `.ts` | 0 | PASS |
| Prettier dla 49 zmienionych plików | 0 | PASS |
| `pnpm workflow:validate` | 0 | 26 tasków, PASS |
| `git diff --check` | 0 | clean |

## Snapshoty i artefakty

- Markdown rendering jest sprawdzany golden assertions; brak nowych binarnych
  snapshotów albo artefaktów wymagających akceptacji.

## Bezpieczeństwo i dane

- Dostęp do sekretów: context przechodzi przez redakcję; brak credentials w
  publicznych kontraktach, fixture i logach.
- Izolacja kont/scope: recovery snapshot odtwarza autorytatywne
  provider/connection bindings i failuje zamknięcie przy niespójności.
- Side effecty i idempotencja: completion, waiting i answer/resume mają trwałe
  klucze konfliktu oraz atomiczną materializację; stan niejednoznaczny nie jest
  automatycznie replayowany.
- Dane modelu i zewnętrzne pozostają `UNTRUSTED_DATA` w context/provenance.

## Znane ograniczenia i ryzyka

- RA-008 przygotowuje bezpieczny recovery plan, lecz harmonogram ról i writer
  lease należą do RA-009.
- Workspace i coding tools pozostają poza zakresem do RA-010/RA-012.

## Otwarte pytania

- Brak decyzji właściciela wymaganych do audytu.

## Stan dla Sol po audycie

- Gotowe: pełny zakres RA-008 i reprodukowalna bramka real-PG.
- Czego nie robić przed audytem: nie zmieniać ocenianej implementacji RA-008.
- Fix units po `CHANGES_REQUIRED`: utworzyć wyłącznie z reprodukowalnych
  findingów audytora.
