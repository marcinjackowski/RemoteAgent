# RA-007 — Handoff 01

## Metadata

- Task: `RA-007`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: Sol, `COORDINATOR_AUDITOR`, na podstawie raportów implementera
- Implementer model/transport: `GPT-5.6 Luna / medium`
- Work-units plan: `docs/work-units/RA-007/WORK_UNITS.md`, revision `03`
- Zaakceptowane units: `WU-01`, `WU-02`, `WU-03`, `WU-04`, `WU-05`, `WU-06A`,
  `WU-06B`, `WU-07A`, `WU-07B`, `WU-08`
- Data: 2026-08-20
- Bazowy commit lub stan początkowy: `7b68cc45e5aeff88d02296b38692a054dbc985d8`
- Końcowy commit lub stan working tree: `6454ada`; working tree clean

## Wynik

Powstał model-neutralny pakiet Bedrock Converse z produkcyjnymi adapterami AWS,
deterministycznym transportem testowym, streamingiem, ograniczonym tool loop,
structured output z pojedynczym repair, bezpiecznym retry oraz publiczną fasadą
text/stream/structured.

## Zrealizowany zakres

- provider-neutralne kontrakty runtime, konfiguracja, błędy i limity;
- Converse i ConverseStream przez AWS SDK default credential chain;
- pełna historia przekazywana jawnie w każdym request;
- tool-use/tool-result z preflightem limitów i ochroną side effectu przed retry;
- JSON Schema `AgentCompletion`, walidacja i tools-disabled repair;
- bounded retry klas `THROTTLING`/`TRANSIENT`, timeout i cancellation;
- identity, usage, request ID, latency i liczba prób na publicznym wyniku runtime.

## Wykonanie work units

| Unit | Raport implementera | Sol gate | Wynik |
|---|---|---|---|
| WU-01 | kontrakty/config/errors | test, typecheck, diff | ACCEPTED |
| WU-02 | fake transport i text | test, pełna historia | ACCEPTED |
| WU-03 | adapter AWS | test, credential canary | ACCEPTED |
| WU-04 | stream/cancel | race tests | ACCEPTED |
| WU-05 | bounded tool loop | side-effect counter | ACCEPTED |
| WU-06A | JSON Schema transport | canonical schema tests | ACCEPTED |
| WU-06B | validation/repair | repair bez tools | ACCEPTED |
| WU-07A | retry classification | tabela błędów i redakcja | ACCEPTED |
| WU-07B | retry/timeout limits | kontrolowane timery | ACCEPTED |
| WU-08 | publiczna fasada | 9 testów contract/integration | ACCEPTED |

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/bedrock-runtime/src/` | kompletny runtime i adaptery | zakres RA-007 |
| `packages/bedrock-runtime/test/` | 89 testów unit/contract/integration | deterministyczne dowody kryteriów |
| `packages/bedrock-runtime/package.json` | AWS SDK i contracts | produkcyjny transport i schema |

## Decyzje i uzasadnienie Sol

Retry obejmuje wyłącznie transport i nigdy executor narzędzia. Streaming nie jest
retryowany po rozpoczęciu, ponieważ częściowy output czyni replay niebezpiecznym.
Repair jest dokładnie jednym kolejnym wywołaniem bez tools. Fasada przyjmuje
wstrzykiwane transporty, zegar i timery, aby testować wyścigi bez wall-clock.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| Brak server-side memory | PASS | każdy request niesie pełne `messages` |
| Identity i usage przy completion | DO_AUDYTU | testy zachowują metadane finalnego wyniku |
| Invalid schema repair bez tools | PASS | `structured-completion.test.ts` |
| Cancel stream ma jednoznaczny status | DO_AUDYTU | standardowe race tests przechodzą |
| Retry nie powtarza tool side effectu | PASS | licznik executora pozostaje równy 1 |
| Limity kończą kontrolowanym błędem | PASS | `limits.test.ts`, `tool-loop.test.ts` |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm --filter @remoteagent/contracts build` | 0 | PASS |
| `pnpm vitest run packages/bedrock-runtime/test` | 0 | 11 plików, 89 testów |
| `pnpm --filter @remoteagent/bedrock-runtime typecheck` | 0 | PASS |
| `pnpm --filter @remoteagent/bedrock-runtime build` | 0 | PASS |
| `git diff --check` | 0 | clean |

## Snapshoty i artefakty

- Brak snapshotów i artefaktów binarnych.

## Bezpieczeństwo i dane

- Dostęp do sekretów: credentials nie występują w publicznej konfiguracji;
  produkcja używa default credential chain AWS.
- Izolacja kont/scope: runtime nie ustala scope ani autoryzacji; pozostają poza
  modelem i poza zakresem taska.
- Side effecty i idempotencja: executory nie są objęte retry transportu.
- Dane zewnętrzne traktowane jako niezaufane: odpowiedź jest walidowana kontraktem
  przed zwróceniem structured completion.

## Znane ograniczenia i ryzyka

- Audyt końcowy musi adversarialnie sprawdzić cleanup iteratora, który nie kończy
  `return()`, oraz kompletność metadanych wielu completion w tool/repair loop.

## Otwarte pytania

- Brak decyzji właściciela wymaganych do wykonania audytu.

## Stan dla Sol po audycie

- Gotowe: pełny zakres implementacji i zielona bramka pakietu.
- Czego nie robić przed audytem: nie rozpoczynać RA-008.
- Jakie małe fix units utworzyć po `CHANGES_REQUIRED`: wynikną bezpośrednio z
  reprodukowalnych findingów audytora.
