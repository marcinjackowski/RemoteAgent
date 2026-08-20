# RA-026 — Work units

## Metadata

- Task: `RA-026`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES` (RA-025 niedokończony).
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: pełny acceptance suite; komenda do ustalenia przy starcie

## Global boundaries

- In scope: końcowy, dowodowy odbiór systemu względem Master Planu i decyzja
  go/no-go **bez ukrywania nierozwiązanych ryzyk**.
- Out of scope: rozszerzenia nieobecne w zaakceptowanym Master Planie.
- **`PASS` nie oznacza zgody na produkcyjne uruchomienie.** Production enablement
  pozostaje osobną, jawną decyzją właściciela po audycie (AC6).
- Audytor ma **zakwestionować dowody** i wykonać reprezentatywne testy samodzielnie.

## Macierz kryteriów systemowych — Master Plan §13

RA-026 AC1 wymaga niezależnego dowodu dla każdego z dziesięciu kryteriów. Mapowanie
na taski, które je wytwarzają (stan `2026-08-20`):

| # | Kryterium §13 | Dowód pochodzi z | Status źródła |
|---:|---|---|---|
| 1 | dwa Jira taski równolegle w izolowanych workspace | RA-018-WU-02 | `BLOCKED_BY_DEPENDENCIES` |
| 2 | restart w każdej fazie nie traci checkpointu ani eventu | RA-018-WU-03 | `BLOCKED_BY_DEPENDENCIES` |
| 3 | niejednoznaczny write nie jest automatycznie powtarzany | RA-012 (`AMBIGUOUS`), RA-017, RA-021, RA-022 | RA-012 `IN_PROGRESS` |
| 4 | właściciel odpowiada na trwałe pytanie decyzyjne przez Discord | RA-008 `DONE`, RA-018-WU-04 | częściowo gotowe |
| 5 | branch, commity, evidence, review i MR powiązane z jednym case | RA-013, RA-014, RA-015, RA-017 | wszystkie `BLOCKED_BY_DEPENDENCIES` |
| 6 | konta private i SonderMind nie przeciekają | RA-019, RA-020 | `BLOCKED_BY_DEPENDENCIES` |
| 7 | webhooki/watch odnawiane i uzgadniane | RA-016 `DONE`, RA-019, RA-020 | częściowo gotowe |
| 8 | wszystkie R3/R4 mają policy evidence, approval i receipt | RA-022 | `BLOCKED_BY_DEPENDENCIES` |
| 9 | backup/restore oraz kill switch sprawdzone ćwiczeniem | RA-024, RA-025 | `BLOCKED_BY_DEPENDENCIES` |
| 10 | końcowy audyt bezpieczeństwa i niezawodności ma `PASS` | RA-026 sam | — |

Ta macierz jest punktem wejścia `WU-01` i musi zostać odtworzona z aktualnym stanem
przy starcie taska — powyższa wersja jest zdjęciem z `2026-08-20`, nie wyrokiem.

## Ustalenia przed planowaniem (2026-08-20)

1. **AC2 wymaga braku otwartych BLOCKER/HIGH/MEDIUM.** Rejestr
   `docs/audits/CROSS_TASK_FINDINGS.md` zawiera obecnie dwa findingi MEDIUM
   (`CTF-001`, `CTF-002`) i jeden MEDIUM (`CTF-005`), plus dwa LOW (`CTF-003`,
   `CTF-004`). **Wszystkie MEDIUM muszą być domknięte przed `PASS` RA-026** — to
   nie jest opcjonalne, bo AC2 mówi wprost o braku otwartych MEDIUM.
2. **AC3 wymaga, by każdy znany LOW miał ownera i decyzję accept/fix/defer.**
   Rejestr przekrojowy jest właściwym miejscem tej ewidencji — do rozszerzenia o
   kolumnę decyzji przy starcie taska.
3. **AC5 (release manifest odtwarzający dokładną wersję)** musi objąć wersje
   schema (numer najwyższej migracji), modelu, promptów, toolsetu i IaC. Uwaga:
   tożsamość modelu zmieniła się w trakcie budowy (ADR-0004 → ADR-0005), więc
   manifest musi to odzwierciedlać, a nie udawać jednorodność.
4. **Znane ryzyko dla wiarygodności bramki:** `CTF-003` (flake `process-runner`)
   sprawia, że „całe repo zielone" nie jest deterministyczne. Dla taska, którego
   istotą jest dowodowość, to musi być domknięte wcześniej.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-026-WU-01` | `DRAFT` | macierz wymagań Master Planu → test/evidence/owner | RA-025 DONE |
| `RA-026-WU-02` | `DRAFT` | pełny acceptance suite: dwa równoległe cases end-to-end | WU-01 |
| `RA-026-WU-03` | `DRAFT` | chaos/retry/DLQ/ambiguous/reconciliation scenarios | WU-01 |
| `RA-026-WU-04` | `DRAFT` | cross-account i cross-repo isolation suite | WU-01 |
| `RA-026-WU-05` | `DRAFT` | backup/restore i kill-switch drill z evidence | WU-01 |
| `RA-026-WU-06` | `DRAFT` | operator/user docs, onboarding, known limitations | WU-02..WU-05 |
| `RA-026-WU-07` | `DRAFT` | release manifest (schema/model/prompt/tool/IaC) | WU-06 |

Praca własna koordynatora, **nie work unit implementera**: niezależny final
security/reliability audit, porównanie wszystkich wymagań, ADR-ów, handoffów i
deferred findings, oraz werdykt go/no-go. Audytor kwestionuje dowody i wykonuje
reprezentatywne testy sam — z definicji nie może tego delegować.

## Wymagania do rozdzielenia na units

- **AC1 (każde kryterium §13 ma niezależny dowód)** → `WU-01` + wszystkie kolejne.
- **AC2 (brak otwartych BLOCKER/HIGH/MEDIUM)** → warunek wejścia do audytu;
  sprawdzić `CROSS_TASK_FINDINGS.md` i wszystkie audyty tasków.
- **AC3 (każdy LOW ma ownera i decyzję)** → `WU-01`; ewidencja w rejestrze.
- **AC4 (fresh operator wykona start/stop/restore/revoke z runbooka)** → `WU-06`;
  test „świeżym okiem", nie przeczytanie własnego runbooka.
- **AC5 (release manifest odtwarza wersję)** → `WU-07`.
- **AC6 (production enablement to osobna decyzja właściciela)** → nie unit;
  koordynator **nie udziela tej zgody sam** i nie traktuje `PASS` jako zgody.

## Final task gate

Bramka końcowa. Koordynator uruchamia pełny acceptance suite, całe repo bez
regresji (po domknięciu `CTF-003`), wszystkie bramki jakościowe, oraz wykonuje
niezależny final security/reliability audit. `PASS` jest dozwolony wyłącznie, gdy:
wszystkie dziesięć kryteriów §13 ma niezależny dowód, rejestr przekrojowy nie ma
otwartych MEDIUM ani wyżej, każdy LOW ma decyzję, a manifest odtwarza wersję.
**`PASS` nie jest zgodą na produkcyjne uruchomienie** — ta decyzja należy do
właściciela i musi być odnotowana osobno.
