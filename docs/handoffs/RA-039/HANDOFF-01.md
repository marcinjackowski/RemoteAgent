# RA-039 — HANDOFF-01

- Task: `RA-039` Generyczne structured output dla etapów Bedrock
- Data: `2026-08-26`
- Bazowy commit: `750b1479197943e7b5f7db587d7092f0aff1ecac`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Rezultat

Bedrock runtime ma schema-owned `defineStructuredContract()` i generyczny
`runStructuredContract<TSchema>()` nad istniejącym transportem/tool-loopem.
Kontrakt zwraca typed value z pełnym provenance, failuje przed efektem przy
schema/model mismatch i rozróżnia bounded read-only repair od implementera,
którego nie wolno ponowić w celu naprawy JSON.

## Kontrakty, które muszą przetrwać

- Jeden obiekt Zod jest parserem i źródłem provider JSON Schema/digestu; input
  definicji jest snapshotowany przed konstrukcją.
- Expected schema digest jest sprawdzany przed pierwszym transport call.
- Provider/model jest pinowany na każdej odpowiedzi przed parse/tool execution.
- `SLICE_IMPLEMENTATION` nie ma repair; pozostały stage ma najwyżej jeden
  tools-off repair z pełnym history.
- Cancellation/timeout/identity errors zachowują własną klasę i nie stają się
  `StructuredContractOutputError`.
- Legacy `AgentCompletion` API i workerowy reply-loop nadal używają `.completion`.

## Dowód

```text
structured targeted                    27/27, exit 0
runtime/worker compatibility           53/53, exit 0
pełne testy                            2534/2534, 194/194 pliki, exit 0
build --force                          26/26, 0 cached, exit 0
typecheck --force                      38/38, 0 cached, exit 0
lint / format / diff-check             exit 0
workflow:validate                      OK — 45 tasks
type-level public export probe         brak nowych kolizji
mutations                              6 mechanizmów RED→GREEN
```

## Wejście do RA-040

RA-040 jest pierwszym `READY`: buduje deterministic context compiler i
trzywarstwową pamięć. Ma używać durable artifact revisions/projection z RA-038,
ale raw evidence pozostaje authority. Nie powinien tworzyć nowego model runnera;
gdy modelowa projekcja jest potrzebna, korzysta z schema-owned API RA-039.
Expected schema digest, stage i prompt version muszą pochodzić z server-owned
registry/configu, nigdy z tekstu modelu.

## Stan zewnętrzny

Nie wykonano AWS/Bedrock call, zewnętrznego write, push, MR ani merge. Task jest
zamykany dwoma logicznymi commitami (implementacja, następnie docs/status), po
których Sol automatycznie przechodzi do RA-040.
