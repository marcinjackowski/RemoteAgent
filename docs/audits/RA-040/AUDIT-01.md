# RA-040 — AUDIT-01

- Task: `RA-040` Context compiler i trzywarstwowa pamięć
- Data: `2026-08-26`
- Bazowy commit: `8d69796dc45c9bf117403adc4167d875fe11586c`
- Audyt: pełny diff, kod wywołujący i własne bramki Sol; raporty bounded implementacji Luny były
  wyłącznie wejściem, nie dowodem

## 1. Uruchomiona bramka

Po odczycie pełnego diffu od bazowego commita oraz istotnych granic DB, compilera, workera,
redaktora i metrics wykonano od początku:

```text
. scripts/dev/env.sh                    Node 24.19.0; PG15/5432 reachable
pnpm lint                               exit 0; tylko istniejące warnings boundaries
pnpm format                             exit 0
pnpm build --force                      26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm test         2583/2583, 201/201 plików, exit 0
pnpm typecheck --force                  38/38, 0 cached, exit 0
pnpm workflow:validate                  OK — 45 tasks, exit 0
git diff --check                        exit 0
```

Nie wystąpił flake ani cichy skip PostgreSQL. Pierwszy pełny przebieg ujawnił przed typecheckiem dwa
testowe problemy typów; zostały naprawione jako `CTF-023`, po czym całą komendę powtórzono.

## 2. Kryteria akceptacji

1. **Stage allowlist i izolacja:** spełnione. Zamknięta, frozen policy rozróżnia 18 source types;
   authority i komplet integration scope są wyprowadzane z exact run/work-unit/case/connection
   chain. Realny test odrzuca obcy case/ownera i caller-supplied authority.
2. **Trust bez eskalacji:** spełnione. Case/provider/repo/tool evidence i working projection są
   `UNTRUSTED_DATA`. Source type determinuje warstwę i dozwoloną selection class; treść nie ustala
   policy, tools, process ani gate catalogu. Mutacje allowlisty, warstwy i trust guardów dały RED.
3. **Wersjonowana projekcja i restart:** spełnione. Snapshot wiąże checkpoint revision i cutoff runu,
   ma deterministyczny digest; ponowny odczyt daje identyczny packet. `MemoryUpdate` wymaga exact
   run/case/revision, source watermark i evidence allowlist, a raw źródła zachowują ref/digest.
4. **Brak full-history replay:** spełnione. Produkcyjny worker nie importuje
   `CaseMessageRepository` ani `listRecent(20)`. DB używa oddzielnych byte-bounded recent/relevance
   lanes i przypina najnowsze owner steering. Baseline >20 zachowuje starą relewantną wiadomość.
5. **Bounded diff/log:** spełnione. Redact-before-clip działa na pełnych code points, respektuje limit
   UTF-8 i dodaje zweryfikowany marker z opaque full ref oraz digestem pełnego artefaktu.
6. **Metryki i baseline:** spełnione. Packet/layer bytes, compaction, estimate, cache state i provider
   actual usage są odrębnymi seriami. Brak sygnału cache to `NOT_OBSERVED`, nie zgadywany miss.
   Evidence: full `4053 B/~1014`, legacy20 `2935/~734`, compiled `2764/~691`.
7. **Fresh boundary zachowuje stan:** spełnione. Mandatory objective i checkpoint zawierający aktywne
   decyzje/open issues są dobierane przed evidence; overflow protected sources failuje jawnie.
8. **Redakcja:** spełnione. Wspólna tabela sekretów/PII/host topology jest użyta przed packetem,
   manifestem, projection i telemetry. Sensitive/known-literal IDs/refs failują zamknięcie, tekst
   jest maskowany. Canary oraz pięć niezależnie powtórzonych mutacji dały RED→GREEN.
9. **Bramki:** spełnione; pełna komenda i `workflow:validate` zakończyły exit `0`.

## 3. Architektura, trwałość i bezpieczeństwo

Nie powstał drugi orchestrator, model runner ani journal. `buildContext()` pozostaje jedynym
selektorem, a compiler dodaje source policy, scope i manifest. Snapshot jest jednym
`REPEATABLE READ READ ONLY`; nie wykonuje efektów i nie przyjmuje authority od modelu/callera.
Run cutoff stabilizuje wiadomości i Jira receipts, artefakty są strict-parsowane oraz sprawdzane
przez exact case/run/revision/digest.

Produkcyjny packet jest renderowany wyłącznie z sanitized compiled fragments i compiled manifestu;
test seam dowodzi braku powrotu do raw snapshotu. Bearer znany procesowi trafia jako known literal do
loggera, metrics i compiler boundary. Label values są redagowane oraz freeze-copy przy zapisie i
lookupie; case/owner/ref/content nie są labelami. Nie zmieniono write policy, approval ani side
effect paths.

## 4. Mutation evidence

Każda mutacja była przywrócona, a odpowiednia zielona bramka ponowiona:

| Mechanizm | Przykładowa mutacja | Dowód RED |
|---|---|---|
| stage/source/layer | usunięcie allowlisty albo layer guard | celowany test RED |
| exact snapshot | usunięcie case guard lub cutoff | realny PG RED |
| determinism | odwrócenie binary tie-break | realny PG RED |
| latest owner | usunięcie role guard albo protected selection | realny PG/builder RED |
| memory freshness | pominięcie watermark/evidence membership | celowany test RED |
| actual usage | zastąpienie provider usage estymacją | `137` zamiast `37`, RED |
| prompt/projection | pominięcie wspólnej redakcji | canary RED |
| telemetry | pominięcie safe-label boundary | canary RED |
| ref i clipping | wyłączenie ref guard/markera lub code-point slicing | canary/emoji RED |

## 5. Findings i zakres

W toku zamknięto pozorny ranking coarse-kind, raw packet bypass oraz pięć problemów fixture/test
design opisanych w work units. Pełna bramka wykryła `CTF-023`; fix ogranicza się do dokładnego typu
`NodeJS.ProcessEnv` i jawnego test-only source/dist bridge. Rejestr nie zawiera otwartego
BLOCKER/HIGH/MEDIUM.

Plan i allowed paths powstały przed implementacją. Bounded implementacja nie tworzyła audytu,
handoffu ani commita; korekty Sol zostały opisane i zweryfikowane. Nie wykonano zewnętrznego write,
AWS call, push, MR ani merge.

## 6. Werdykt

- Werdykt: `PASS`

Wszystkie dziewięć kryteriów RA-040 jest spełnionych, load-bearing granice mają mutation evidence,
pełna bramka ma exit code `0`, a po audycie nie pozostaje finding BLOCKER, HIGH ani MEDIUM.
