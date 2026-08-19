# Work units

`TASK_INDEX.md` przechowuje makro-taski i ich zależności. Ten katalog zawiera
przygotowany przez Sol, wykonywalny podział taska dla Luny:

```text
docs/work-units/<TASK_ID>/WORK_UNITS.md
```

Plan jest trwałym stanem koordynacji, ale nie zastępuje taska, handoffu ani
audytu. Wyłącznie Sol tworzy plan, zmienia stan units i dopisuje fix units.
Luna czyta tylko wskazany unit i nie edytuje tego katalogu.

## Statusy unit

- `DRAFT` — przygotowany z wyprzedzeniem, wymaga walidacji Sol po odblokowaniu taska;
- `BLOCKED` — zależność albo decyzja nie pozwala go uruchomić;
- `READY` — kompletny kontrakt, można uruchomić jedną sesję Luny;
- `RUNNING` — jedyny aktualnie wykonywany unit;
- `IMPLEMENTED` — Luna zakończyła, Sol jeszcze nie zaakceptował;
- `ACCEPTED` — Sol sprawdził diff i ponowił weryfikację;
- `FAILED` — wynik nie spełnia kontraktu; potrzebny mniejszy fix unit;
- `CANCELLED` — Sol jawnie wycofał unit z uzasadnieniem.

W jednym planie może istnieć najwyżej jeden `READY`, `RUNNING` albo
`IMPLEMENTED`. Concurrency implementera wynosi `1` z powodu single-writer.

Użyj `docs/templates/WORK_UNITS_TEMPLATE.md`. Limity i sposób uruchomienia
opisują `AGENTS.md` oraz `docs/workflow/LUNA_IMPLEMENTER.md`.
