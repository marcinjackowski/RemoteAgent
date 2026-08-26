# RA-046 — HANDOFF-01

- Task: `RA-046` Engineering approval ingress: Discord → grant → writer job
- Data: `2026-08-26`
- Bazowy commit: `45a20f16264f426091900df69e6ffa7d218b43e6`
- Commit implementacji: `eee843d`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

High-risk engineering run jest produkcyjnie osiągalny bez ręcznego seedowania DB. Owner-only raw
Discord `/engineering` tworzy strict proposal i durable outbox; dedykowany GRANT atomowo tworzy
exact Approval, prealokowany work unit/run i jeden fenced `agent.implementer` job. Produkcyjny worker
ponownie dowodzi proposal/job/scope i wykonuje kwalifikowany Engineering Control Plane do jednego
evidence-bound lokalnego commita, bez push/MR/merge.

## Inwarianty do zachowania

- Generic DecisionAnswer, modelowe option ID, generic Approval i `external_actions` nigdy nie nadają
  engineering write authority.
- Discord actor jest tylko audytem; internal owner, repo/path ceiling i action digest pochodzą z
  locked case oraz code-owned deployment policy.
- Proposal+outbox i GRANT+Approval+work/run/job pozostają atomowe; replay zwraca exact durable IDs.
- Worker trzyma current lease row lock przez proposal verification i Approval consume. Candidate
  musi zawierać exact `proposalId`, ale żaden payload scope/digest nie jest authority.
- `/stop` działa bez deployment policy. Cancelled case zatrzymuje również wcześniej granted,
  claimowany job przed modelem/workspace/write.
- Migration 036 nie może być cofnięta przy danych ani aktywnym ingress writerze; exclusive NOWAIT
  lock poprzedza emptiness check i DROP.
- Production Discord process musi startować `startOutboxRelay`; samo zapisanie outbox nie oznacza
  dostarczenia przycisku.

## Dowód

```text
root Discord→worker E2E           4/4, exit 0
database ingress                  21/21, exit 0
migration lifecycle/race          11/11, exit 0
AC5 risk suite                    6/6, exit 0
pełna bramka PostgreSQL           2800/2800, 220/220, exit 0
build --force                     26/26, 0 cached, exit 0
typecheck --force                 40/40, 0 cached, exit 0
lint / format / diff-check        exit 0
workflow:validate                 OK — 47 tasks
audit                             AUDIT-01 PASS
```

## Wejście dalej

RA-047 może rozpocząć stage-aware cross-fence recovery. Obecna granica celowo pozostawia expired
partial writer w `RECONCILING`: zwykły token-2 claim nie może przejąć starej operacji ani naprawić
artifact/completion. RA-047 ma dodać code-owned recovery mode, exact descriptor/receipt authority i
single-writer continuation bez replay niepotwierdzonego mutating effectu.

Po RA-047 task RA-045 wykona live iOS/Xcode qualification. Owner review konkretnego ProgramDesign
oraz push/MR/merge nadal pozostają poza RA-046.

## Stan zewnętrzny

Nie wykonano live Discord, Bedrock, Xcode, push, MR ani merge. Implementacja jest w `eee843d`;
dokumenty/statusy zostaną zapisane osobnym commitem. Drzewo po domknięciu ma być czyste.
