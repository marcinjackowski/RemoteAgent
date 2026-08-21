# RA-021 — Work units

## Metadata

- Task: `RA-021`
- Plan revision: `2`
- Plan status: `READY` — task jest `READY`, wszystkie zależności `DONE`
  (RA-005, RA-007, RA-009, RA-013, RA-016, RA-017, RA-019, RA-020 zweryfikowane w
  `docs/tasks/TASK_INDEX.md` przy starcie `2026-08-21`).
- Rola: jedna rola wykonawcza (ADR-0007). Rewizja `1` była pisana pod ADR-0005
  (rozdział koordynator/implementer) i pod status `BLOCKED_BY_DEPENDENCIES`; ta
  rewizja usuwa oba założenia i zachowuje ustalenia techniczne z rewizji `1`.
- Base commit: `a19811a944a90bf24f38f69fbb9d4d71abaadf12`
- Base tree: `381a88c850e23b604fa450261fba4d1ec307f3d9`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test`

## Global boundaries

- In scope: jedyna kontrolowana brama między agentami a internal/remote MCP tools —
  registry, manifest per rola, server-side scope injection, bounded transport,
  ledger, circuit breaker.
- Out of scope: external writes, Discord approval, decyzja o konkretnych AgentCore
  targets (RA-022, RA-023).
- **Model nie ma bezpośredniego dostępu do credentiali ani do MCP.** Brama jest
  jedyną drogą.
- **`tools/list` jest `UNTRUSTED_DATA`, nie authority.** Zdalny opis narzędzia nie
  może nadpisać policy ani prompt authority.

## Warunki wejścia — sprawdzone przy starcie (`2026-08-21`)

1. **`RA-012-WU-01B` wykonany.** `packages/implementation-tools/src/contracts.ts`
   eksportuje `implementationToolIntent` / `implementationToolResult`;
   `grep "export const toolIntent"` po `packages/*/src` trafia wyłącznie w
   `packages/contracts/src/tool.ts:31`. Warunek wejścia z `CTF-002` spełniony —
   RA-021 może konsumować `contracts.toolIntent` bez kolizji barrelowej.
2. **Kontrakty brokera istnieją i są zaakceptowane** — `packages/contracts/src/tool.ts`
   (95 linii): `toolIntent` (bez pola scope), `resolvedToolScope`,
   `resolvedToolIntent`, `toolResult` z `output.trust` przypiętym literałem.
   AC1 i AC6 budują na nich; **drugiego zestawu nie tworzymy**.
3. **`packages/mcp-tool-broker` to sam szkielet z RA-001** — `src/index.ts` zawiera
   wyłącznie `packageName`. Cała domena do napisania. `package.json` nie ma jeszcze
   ani jednej zależności ani `tsconfig.test.json`.
4. **Authority dla AC1 już istnieje i jest zaakceptowana** — `resolveConnectionScope`
   (`packages/policy/src/scope.ts`) plus tabela `case_connection_scopes`
   (migracja `016`). Resolver zwraca **wyłącznie** przecięcie case grants i
   konfiguracji connection, odrzuca `requestedConnectionId` poza scope i
   `requestedTarget` poza allowlistą. RA-021 **konsumuje** tę authority; nie pisze
   drugiej.
5. **Artifact boundary dla AC4 istnieje** — `LocalArtifactStore`
   (`packages/test-evidence/src/artifact-store.ts`) redaguje na wejściu, obcina
   bajty, zachowuje `digest`/`original_byte_length`/`complete: false`. Dokładnie
   kształt wymagany przez AC4.
6. **Wolny numer migracji: `028`.** Najwyższa zajęta to `027` (RA-012). Brak
   równoległego taska konkurującego o numer.
7. **`CTF-009` — rozstrzygnięte dla tego taska.** Read tools RA-021 są
   provider-facing (Jira/Gmail/Calendar/GitLab REST), nie filesystem-facing, więc
   `isForbiddenPath` z `repository-planner` nie jest na ich ścieżce. To trzeba
   **potwierdzić w bramce** (brak importu `createPlannerReadPort` /
   `isForbiddenPath` w tym pakiecie), a nie założyć: gdyby jakikolwiek tool zaczął
   zwracać ścieżki repozytorium, obowiązuje `isProtectedPath` z
   `implementation-tools`, nie dziedziczenie cudzego predykatu.

## Korekty po red-teamie (utrzymane z rewizji 1)

1. **`tools/list` jest `UNTRUSTED_DATA`, nie authority.** Zdalny serwer nie
   definiuje, co wolno — registry jest server-owned.
2. **Timeout po możliwym wykonaniu calla daje `AMBIGUOUS`, nigdy blind replay.**
   Ta sama zasada co w RA-012 i RA-017. AC5 wprost tego wymaga.
3. **Provider packages nie mogą tworzyć cyklu zależności z brokerem.**
   `eslint.config.mjs` pozwala `package → package`, więc cyklu nie wyłapie
   boundaries — wymaga własnej kontroli w bramce.
4. **Sealed credential-use** — credentiale nie przechodzą przez model ani przez
   argumenty narzędzia. Wzorzec: `CredentialBroker.use()` z
   `connector-gitlab/src/merge-request.ts` (callback, nie getter).

## Unit index

| Unit | Status | Result | Komenda weryfikacyjna |
|---|---|---|---|
| `RA-021-WU-01` | `READY` | strict broker contracts nad `contracts/tool.ts` | `pnpm vitest run packages/mcp-tool-broker/test/contracts.test.ts` |
| `RA-021-WU-02` | `READY` | server-owned registry + manifest per rola + scope injection | `pnpm vitest run packages/mcp-tool-broker/test/registry.test.ts` |
| `RA-021-WU-03` | `READY` | durable tool-call ledger (`028`) + artifact binding | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test/ledger.integration.test.ts` |
| `RA-021-WU-04` | `READY` | bounded transport executor, timeout → `AMBIGUOUS` | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test/executor.integration.test.ts` |
| `RA-021-WU-05` | `READY` | sealed credential-use + jawne fallback adapters | `pnpm vitest run packages/mcp-tool-broker/test/credential.test.ts` |
| `RA-021-WU-06` | `READY` | malicious protocol/conformance proof | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test/malicious.integration.test.ts` |
| `RA-021-WU-07` | `READY` | read-only provider integration: Jira/Gmail/Calendar/GitLab | `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/mcp-tool-broker/test` |

## Mapa kryteriów akceptacji na units

- **AC1 (model nie wybierze connection/repo spoza scope przez argumenty)** →
  `WU-02`, oparte na `resolvedToolIntent` i `resolveConnectionScope`. Test
  adwersarialny: argument z `connection_id` innego ownera musi być **odrzucony**,
  nie zignorowany i nie użyty.
- **AC2 (role widzą minimalny manifest)** → `WU-02`; manifest per rola/case, wzór
  sealed context z RA-011 (`WeakSet` + `deepFreeze`).
- **AC3 (remote schema/description nie nadpisze policy ani prompt authority)** →
  `WU-06`; fake malicious server z prompt injection w `description` i schema drift
  między `tools/list` i `tools/call`.
- **AC4 (oversized/malformed output ograniczony i zachowany jako artifact)** →
  `WU-03` + `WU-06`; artifact store z RA-013.
- **AC5 (timeout/retry nie zmienia read failure w fałszywy success)** → `WU-04`;
  timeout po możliwym wykonaniu → `AMBIGUOUS`; test dowodzący braku blind replay.
- **AC6 (każdy call ma intent, validated args, result digest, latency, trace)** →
  `WU-03`; durable ledger, nie log.

## Final task gate

Pełna suite pakietu na prawdziwym PostgreSQL, całe repo bez regresji,
`typecheck`/`build` z `--force`, scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, **sonda przecięcia eksportów** (`CTF-002` — w tym tasku
kolizja jest osiągalna), kontrola braku cyklu provider↔broker, mutation check dla
każdego mechanizmu bezpieczeństwa, oraz osobna weryfikacja sześciu kryteriów
akceptacji — w szczególności cross-scope przez argumenty, prompt injection w
`tools/list` i timeout dający `AMBIGUOUS` zamiast retry.
