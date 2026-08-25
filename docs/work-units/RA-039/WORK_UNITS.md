# RA-039 — WORK_UNITS

- Task: `RA-039` Generyczne structured output dla etapów Bedrock
- Bazowy commit: `750b1479197943e7b5f7db587d7092f0aff1ecac`
- Status: `DONE`
- ADR: `ADR-0011`, `ADR-0013`

## Inwariant projektu

`RuntimeTransport`, retry/timeout i `runToolLoop` pozostają jednym transportem.
Nowe API nie przyjmuje rozłącznych parser/JSON-schema, nie tworzy drugiego klienta
Bedrock i nie zmienia modelu w warstwę autoryzacji. Schema definition jest
server-owned; stage, expected digest i prompt version są pinowanym inputem
operacji. Repair nie może ponownie wykonać tools ani implementera.

## RA-039-WU-00 — Typed schema definition i formalny start

**Status:** DONE

**Rezultat:** `defineStructuredContract()` przyjmuje strict versioned Zod schema
i z tego samego obiektu wyprowadza typed parser, provider JSON Schema oraz
canonical digest. Definicja ma zweryfikowane name/version; mismatch między
deklarowaną wersją i `schema_version` outputu failuje. Test compile/runtime używa
co najmniej dwóch różnych engineering contracts bez `unknown` castu omijającego
walidację.

**Allowed paths:**

- `packages/bedrock-runtime/package.json`
- `pnpm-lock.yaml`
- `packages/bedrock-runtime/src/structured-completion.ts`
- `packages/bedrock-runtime/test/structured-completion.test.ts`
- `docs/work-units/RA-039/WORK_UNITS.md`

**Weryfikacja:**

```bash
pnpm exec vitest run packages/bedrock-runtime/test/structured-completion.test.ts && pnpm --filter @remoteagent/bedrock-runtime typecheck
```

**Dowód wykonania (`2026-08-26`):**

- dokładna bramka: exit `0`; Vitest `12/12`, typecheck pakietu exit `0`;
- mutacja strict boundary: pominięcie wymogu `additionalProperties: false` dało
  exit `1` (`1 failed | 11 passed`); po przywróceniu bramka GREEN;
- mutacja version pin: pominięcie porównania JSON Schema `const` z deklarowaną
  wersją dało exit `1` (`1 failed | 11 passed`); po przywróceniu bramka GREEN;
- dwa rzeczywiste kontrakty `engineeringProgramDesign` i
  `engineeringReviewDecision` używają jednego obiektu Zod do inferencji typu,
  parse, provider JSON Schema i canonical digest; test nie castuje outputu z
  `unknown`.

## RA-039-WU-01 — Generic runner, provenance i fail-closed identity

**Status:** DONE

**Rezultat:** `runStructuredContract<TSchema>()` zwraca typed value oraz model,
stage, schema name/version/digest, prompt version, request ID, usage, transport
calls, tool counts, repair flag i per-call metadata. Expected schema digest jest
sprawdzany przed transportem; każda odpowiedź musi mieć dokładnie pinowany
provider/model przed parse lub tool execution.

**Allowed paths:**

- `packages/bedrock-runtime/src/errors.ts`
- `packages/bedrock-runtime/src/structured-completion.ts`
- `packages/bedrock-runtime/test/structured-completion.test.ts`
- `packages/bedrock-runtime/test/tool-loop.test.ts`
- `docs/work-units/RA-039/WORK_UNITS.md`

**Weryfikacja:**

```bash
pnpm exec vitest run packages/bedrock-runtime/test/structured-completion.test.ts packages/bedrock-runtime/test/tool-loop.test.ts && pnpm --filter @remoteagent/bedrock-runtime typecheck
```

**Dowód wykonania (`2026-08-26`):**

- dokładna bramka: exit `0`; Vitest `24/24` w `2` plikach, typecheck pakietu
  exit `0`; `git diff --check` exit `0`;
- `runStructuredContract<TSchema>()` zwraca typed `value` oraz pinowane stage,
  schema name/version/digest, prompt version, model/request/usage, transport/tool
  counters, repair flag i per-call `modelCompletions`;
- mutacja model pin: wyłączenie porównania provider/model dało exit `1`
  (`2 failed | 22 passed`), w tym wykonaną niedozwoloną tool-use i zaakceptowaną
  podmianę modelu w późniejszej odpowiedzi; po restore bramka GREEN;
- mutacja expected digest guard: wyłączenie porównania przed transportem dało
  exit `1` (`1 failed | 23 passed`) i realny transport call; po restore bramka
  GREEN;
- błędy identity nie zawierają expected/actual digest ani provider/model;
  `StructuredModelIdentityError` jest fatalny i wrapper transportu odrzuca
  odpowiedź przed przekazaniem tool-use do istniejącego `runToolLoop`.

## RA-039-WU-02 — Stage-owned repair i operacyjne błędy

**Status:** DONE

**Rezultat:** read-only engineering stage może wykonać dokładnie jeden repair z
pełną historią, output schema i bez tools. `SLICE_IMPLEMENTATION` po malformed
output kończy się sanitizowanym structured-output error bez drugiego transport
call. Abort i timeout zachowują własne klasy/kody i nigdy nie są mapowane na
invalid JSON. Repair metadata jest jawne i bounded.

**Allowed paths:**

- `packages/bedrock-runtime/src/errors.ts`
- `packages/bedrock-runtime/src/structured-completion.ts`
- `packages/bedrock-runtime/test/structured-completion.test.ts`
- `packages/bedrock-runtime/test/cancellation.test.ts`
- `packages/bedrock-runtime/test/limits.test.ts`
- `docs/work-units/RA-039/WORK_UNITS.md`

**Weryfikacja:**

```bash
pnpm exec vitest run packages/bedrock-runtime/test/structured-completion.test.ts packages/bedrock-runtime/test/cancellation.test.ts packages/bedrock-runtime/test/limits.test.ts && pnpm --filter @remoteagent/bedrock-runtime typecheck
```

**Dowód wykonania (`2026-08-26`):**

- dokładna bramka: exit `0`; Vitest `42/42` w `3` plikach, typecheck pakietu
  exit `0`; scoped ESLint exit `0`; `git diff --check` exit `0`;
- `SLICE_IMPLEMENTATION` po malformed output zwraca sanitizowany
  `StructuredContractOutputError` po jednym model response i bez repair;
  pozostałe stages mają najwyżej jeden tools-off repair;
- repair test dowodzi pełnego `loop.history`, identycznego `outputSchema`, braku
  tools oraz poprawnych `transportCalls=3`, `toolIterations=1`, `toolCalls=1`,
  `modelCompletions=3` po wcześniejszym tool-use;
- initial i repair `RuntimeCancelledError`/`RuntimeTimeoutError` zachowują ten sam
  instance oraz odpowiednio kod `CANCELLED`/`TIMEOUT`; identity error z repair
  również nie jest mapowany na output error;
- mutacja implementer no-repair: dopuszczenie repair dla
  `SLICE_IMPLEMENTATION` dało exit `1` (`1 failed | 41 passed`); po restore pełna
  bramka GREEN.

## RA-039-WU-03 — Legacy compatibility, mutations i pełna bramka

**Status:** DONE

**Rezultat:** `runStructuredCompletion`/`runAgentCompletion`, `Runtime` structured
mode i worker role→persist→reply pozostają kompatybilne. Mutacje usunięcia model
pin, expected schema digest i implementer no-repair dają RED, po restore targeted
oraz pełna niecache'owana bramka są zielone.

**Allowed paths:**

- `packages/bedrock-runtime/src/structured-completion.ts`
- `packages/bedrock-runtime/src/runtime.ts`
- `packages/bedrock-runtime/test/structured-completion.test.ts`
- `packages/bedrock-runtime/test/runtime.contract.test.ts`
- `packages/bedrock-runtime/test/runtime.integration.test.ts`
- `apps/agent-worker/src/roles.ts`
- `apps/agent-worker/test/role-context.test.ts`
- `apps/agent-worker/test/handlers.integration.test.ts`
- `apps/agent-worker/test/completion-reply.integration.test.ts`
- `docs/tasks/RA-039.md`
- `docs/work-units/RA-039/WORK_UNITS.md`

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm turbo run build --force && RA_REQUIRE_POSTGRES=1 pnpm test && pnpm turbo run typecheck --force && pnpm workflow:validate
```

**Dowód wykonania (`2026-08-26`):**

- targeted compatibility po świeżym buildzie `bedrock-runtime`: exit `0`,
  Vitest `53/53` w `6` plikach (`structured-completion`, Runtime contract/
  integration oraz worker role-context/handlers/completion-reply);
- legacy `runStructuredCompletion` i alias `runAgentCompletion` nadal zwracają
  `.completion` bez `.value`; `Runtime` structured mode nadal ma
  `{ mode: "structured", completion, repaired, toolIterations, toolCalls, ... }`;
  worker nadal używa legacy API, a rzeczywista ścieżka role→persist jest zielona
  bez zmian konsumenta;
- pre-audit Sol wykrył, że frozen definition nadal miała parser domknięty nad
  mutowalnym obiektem wejściowym. `defineStructuredContract()` snapshotuje teraz
  name/version/schema/description przed wyprowadzeniem provider schema, digestu
  i parsera. Test zmienia wejściowe version/schema/name/description po define i
  dowodzi, że tożsamość, digest oraz parser pozostają kontraktem pierwotnym;
- mutacja przywracająca closure parsera do `input.schema`/`input.version` dała
  exit `1` (`1 failed | 26 passed`) dokładnie w teście immutable snapshot; po
  restore targeted structured tests `27/27`, package typecheck, scoped ESLint i
  `git diff --check` zakończyły się exit `0`;
- pełna skorygowana bramka dokładnie z sekcji Weryfikacja: exit `0`; lint exit
  `0`; format exit `0`; build `26/26`, `0 cached`; test `2533/2533` w `194`
  plikach, bez flake; typecheck/dependency-build `38/38`, `0 cached`;
  `workflow:validate OK — 45 tasks`;
- po naprawie snapshotu ponowiona pełna skorygowana bramka zakończyła się exit
  `0`: lint/format exit `0`, forced build `26/26` (`0 cached`), forced
  typecheck/dependency-build `38/38` (`0 cached`) i workflow validate `45`
  tasków. Ponowiona bramka testowa z krótkim reporterem potwierdziła dokładne
  `2534/2534` w `194` plikach, exit `0`, bez flake;
- końcowe `git diff --check`: exit `0`; zmienione ścieżki implementacji/testów
  mieszczą się w allowed paths WU-00..03, a pliki statusu taska/kolejki są
  istniejącymi zmianami Sol;
- mutation RED→GREEN guardów pozostaje dowiedziona w WU-00..02: strict/version,
  model pin (`2/24` RED), expected digest (`1/24` RED) i implementer no-repair
  (`1/42` RED); finalna pełna bramka po restore jest GREEN.

## Następny task

Po `PASS`, handoffie, `DONE`, logicznych commitach i czystym drzewie Sol wybiera
pierwszy task `READY` z kolejki — RA-040 — i kontynuuje bez pauzy.
