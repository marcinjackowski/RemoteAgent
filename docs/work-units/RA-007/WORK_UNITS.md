# RA-007 — Work units

## Metadata

- Task: `RA-007`
- Plan revision: `03`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `ACTIVE`
- Base commit/tree: `7b68cc45e5aeff88d02296b38692a054dbc985d8`
- Full-task verification: `pnpm vitest run packages/bedrock-runtime/test && pnpm --filter @remoteagent/bedrock-runtime typecheck`

## Global boundaries

- In scope: wyłącznie `@remoteagent/bedrock-runtime`, jego testy oraz konieczne
  deklaracje zależności.
- Out of scope: business tools, MCP, role prompts, orchestrator i AgentCore.
- Każdy unit używa nowej sesji; Luna nie edytuje tego planu ani statusu taska.
- Sol przed aktywacją potwierdza publiczny runtime interface i nazwy plików.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-007-WU-01` | `ACCEPTED` | kontrakty runtime i konfiguracja modelu | — |
| `RA-007-WU-02` | `ACCEPTED` | fake transport i non-streaming Converse | WU-01 |
| `RA-007-WU-03` | `ACCEPTED` | produkcyjny adapter AWS SDK bez wycieku credentials | WU-02 |
| `RA-007-WU-04` | `READY` | streaming i jednoznaczne cancellation | WU-02 |
| `RA-007-WU-05` | `BLOCKED` | ograniczony client-side tool loop | WU-02 |
| `RA-007-WU-06` | `BLOCKED` | schema validation i tools-disabled repair | WU-05 |
| `RA-007-WU-07` | `BLOCKED` | bezpieczna klasyfikacja retry i limitów | WU-03, WU-05 |
| `RA-007-WU-08` | `BLOCKED` | zintegrowany runtime z pełną metrybką completion | WU-04, WU-06, WU-07 |

## `RA-007-WU-01` — Runtime contracts and configuration

- Status: `ACCEPTED`
- Result: model-neutralny publiczny interface, konfiguracja i typed errors.
- Allowed paths: `packages/bedrock-runtime/src/types.ts`, `config.ts`, `errors.ts`,
  `index.ts`, `packages/bedrock-runtime/test/config.test.ts`.
- Context pack: `AGENTS.md`, `RA-007.md`, `agent-completion.ts`, `agent-run.ts`,
  aktualny `bedrock-runtime/index.ts`.
- Acceptance: brak hardcodowanego providera; jawne timeout/tool limits; credentials
  nie są częścią konfiguracji przekazywanej do logów.
- Verification: `pnpm vitest run packages/bedrock-runtime/test/config.test.ts`.
- Out of scope: AWS SDK, sieć, streaming i tool loop.
- Sol gate: zgodność API z kontraktami RA-002 i brak provider-specific types na
  publicznej granicy.

Luna realizuje `WU-01` jako jeden spójny slice. Tymczasowy podział `WU-01A/B`
wprowadzony dla ograniczeń lokalnego modelu został wycofany: pięć plików i jeden
kontrakt konfiguracji mieszczą się w granicach Luny. Unit nie importuje
`@remoteagent/contracts` ani zewnętrznego walidatora; zgodność z RA-002 pozostaje
strukturalna do unitu dopuszczającego zmianę manifestu.

## `RA-007-WU-02` — Fake transport and Converse text

- Status: `ACCEPTED`
- Result: deterministyczny transport testowy i pojedynczy non-streaming turn.
- Allowed paths: `src/transport.ts`, `src/fake-transport.ts`, `src/converse.ts`,
  `test/converse.test.ts`, `src/index.ts` w pakiecie `bedrock-runtime`.
- Context pack: WU-01 files, `AgentCompletion` contract, task scope.
- Acceptance: cała historia jest wejściem requestu; fake skryptuje odpowiedzi;
  rezultat zachowuje model/request metadata.
- Verification: `pnpm vitest run packages/bedrock-runtime/test/converse.test.ts`.
- Out of scope: AWS SDK, stream, tools, repair i retry.
- Sol gate: brak server-side memory i deterministyczność fake.

## `RA-007-WU-03` — AWS SDK adapter

- Status: `ACCEPTED`
- Result: produkcyjny transport `Converse` korzystający z default credential chain.
- Allowed paths: `packages/bedrock-runtime/package.json`, `pnpm-lock.yaml`,
  `src/aws-transport.ts`, `test/aws-transport.test.ts`, `src/index.ts`.
- Context pack: WU-01/02 transport contract, AWS SDK API typings, redaction helper.
- Acceptance: brak jawnych credentials w API; request/exception logs są
  zredagowane; adapter mapuje response do model-neutralnego wyniku.
- Verification: `pnpm vitest run packages/bedrock-runtime/test/aws-transport.test.ts`.
- Out of scope: prawdziwe wywołanie AWS, streaming i retry policy.
- Sol gate: skan diffu/logów pod credentials i brak globalnego klienta ze stanem rozmowy.

## `RA-007-WU-04` — Stream and cancellation

- Status: `READY`
- Result: `ConverseStream` składany do jednoznacznego success/cancel/failure.
- Allowed paths: `src/stream.ts`, `src/aws-stream-transport.ts`,
  `test/stream.test.ts`, `test/cancellation.test.ts`, `src/index.ts`.
- Context pack: WU-01/02 contracts, AWS stream event types, cancellation criterion.
- Acceptance: abort przerywa konsumpcję; race completion/cancel ma jeden wynik;
  częściowy output nie jest sukcesem.
- Verification: `pnpm vitest run packages/bedrock-runtime/test/stream.test.ts packages/bedrock-runtime/test/cancellation.test.ts`.
- Out of scope: tool loop i schema repair.
- Sol gate: niezależny test race z kontrolowanym schedulerem.

## `RA-007-WU-05` — Client-side tool loop

- Result: pętla `toolUse`/`toolResult` z limitem iteracji i wywołań.
- Allowed paths: `src/tool-loop.ts`, `src/types.ts`, `test/tool-loop.test.ts`,
  `src/index.ts`.
- Context pack: WU-01/02, `contracts/tool.ts`, Bedrock tool message shapes.
- Acceptance: tools wykonują się najwyżej raz na krok; wynik wraca do historii;
  limit kończy się typed error.
- Verification: `pnpm vitest run packages/bedrock-runtime/test/tool-loop.test.ts`.
- Out of scope: business tool implementation, retry i repair.
- Sol gate: test licznika side effectów, nie tylko liczby requestów modelu.

## `RA-007-WU-06` — Structured completion repair

- Result: walidacja `AgentCompletion` i pojedynczy repair call bez tools.
- Allowed paths: `src/structured-completion.ts`, `src/tool-loop.ts`,
  `test/structured-completion.test.ts`, `src/index.ts`.
- Context pack: WU-05, `agent-completion.ts`, JSON Schema eksport kontraktów.
- Acceptance: poprawny output nie jest naprawiany; wadliwy uruchamia jeden repair;
  repair request nie zawiera tools i nie odtwarza side effectów.
- Verification: `pnpm vitest run packages/bedrock-runtime/test/structured-completion.test.ts`.
- Out of scope: retry transportu i streaming.
- Sol gate: test z licznikiem tool execution pozostaje równy jeden.

## `RA-007-WU-07` — Retry classification and limits

- Result: jawna klasyfikacja throttling/transient/fatal i bezpieczne retry boundary.
- Allowed paths: `src/retry.ts`, `src/errors.ts`, `src/converse.ts`,
  `test/retry.test.ts`, `test/limits.test.ts`.
- Context pack: WU-03/WU-05, run-safety contract, task retry criteria.
- Acceptance: retry tylko przed możliwym tool side effectem; fatal nie retryuje;
  timeout/model/tool limits dają kontrolowany typed error.
- Verification: `pnpm vitest run packages/bedrock-runtime/test/retry.test.ts packages/bedrock-runtime/test/limits.test.ts`.
- Out of scope: business-level job retry.
- Sol gate: adversarial test potencjalnego side effectu nigdy nie jest powtarzany.

## `RA-007-WU-08` — Runtime integration and metadata

- Result: jeden publiczny runtime łączy text/stream/tools/repair/retry i zwraca
  pełną identity, usage, latency i request metadata przy każdym completion.
- Allowed paths: `src/runtime.ts`, `src/index.ts`, `test/runtime.contract.test.ts`,
  `test/runtime.integration.test.ts`, `packages/bedrock-runtime/package.json`.
- Context pack: publiczne API wszystkich zaakceptowanych units i RA-007 criteria.
- Acceptance: wspólny interface dla Converse/Stream; pełne metadata także po
  repair; cancellation i limity zachowują jednoznaczny status.
- Verification: `pnpm vitest run packages/bedrock-runtime/test`.
- Out of scope: orkiestrator i persistence runtime calls.
- Sol gate: pełna macierz kryteriów RA-007 i typecheck pakietu.

## Final task gate

Sol uruchamia pełną weryfikację z taska, sprawdza brak credentiali w błędach i
logach, pełny diff od base commit oraz cancellation/retry races. Dopiero potem
tworzy handoff i niezależny audyt RA-007.
