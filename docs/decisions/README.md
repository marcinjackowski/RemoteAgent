# Decision log

Materialne decyzje architektoniczne zapisujemy jako:

```text
docs/decisions/ADR-<NNNN>-<slug>.md
```

ADR zawiera: kontekst, decyzję, alternatywy, konsekwencje, sposób migracji i
rollback. Zmiana zaakceptowanej decyzji wymaga nowego ADR zastępującego poprzedni.

Aktualne decyzje:

- `ADR-0001` — foundation tooling i przypięte wersje;
- `ADR-0002` — SQL i migracje trwałego stanu;
- `ADR-0003` — historyczny workflow lokalnego implementera; zastąpiony przez ADR-0004.
- `ADR-0004` — Sol high koordynuje/audytuje, GPT-5.6 Luna medium implementuje.
