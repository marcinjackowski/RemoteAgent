# RA-021 — Work units

## Metadata

- Task: `RA-021`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES`. Zależności `DONE`:
  RA-005, RA-007, RA-009, RA-016. Niedokończone: RA-013, RA-017, RA-019, RA-020.
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
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

## Ustalenia z kodu przed planowaniem (2026-08-20)

1. **`packages/mcp-tool-broker` to sam szkielet z RA-001.** Cała domena do napisania.
2. **Kontrakty brokera już istnieją i są zaakceptowane** —
   `packages/contracts/src/tool.ts`:
   - `toolIntent` (`intent_id`, `tool_name`, `arguments` z `trust:
     UNTRUSTED_DATA`) — **celowo BEZ pola scope**, z komentarzem „authoritative
     scope must not originate from model output";
   - `resolvedToolScope` (`owner_id`, `connection_ids`, `repo_allowlist`);
   - `resolvedToolIntent` = propozycja modelu **plus** scope wstrzyknięty przez
     serwer; „Only the broker constructs this";
   - `toolResult` z `output.trust = z.literal(UNTRUSTED_DATA)`, `latency_ms`,
     `correlation_id`, `observed_at`.
   AC1 i AC6 opierają się na tych kontraktach — **nie tworzyć drugiego zestawu**.
3. **UWAGA — kolizja nazw:** `@remoteagent/implementation-tools` (RA-012) eksportuje
   **własne** `toolIntent`/`toolResult` o innym kształcie. Zob. `CTF-002` w
   `docs/audits/CROSS_TASK_FINDINGS.md` i `RA-012-WU-01B`. RA-021 jest tym taskiem,
   w którym ta kolizja staje się osiągalna, bo konsumuje `contracts.toolIntent`.
   **Przed startem RA-021 sprawdzić, czy `RA-012-WU-01B` został wykonany**; jeśli
   nie — to blokada, nie detal.
4. **Provider packages wystawiają ports/adapters.** Nie mogą importować brokera w
   sposób tworzący cykl zależności. `eslint.config.mjs` pozwala `package → package`,
   więc cykl nie zostanie wyłapany przez boundaries — wymaga własnej kontroli.
5. **Artifact boundary z RA-013 jest wymagany przez AC4** (oversized output
   zachowany jako artifact evidence) — stąd zależność od RA-013.

## Korekty po red-teamie (z preflightu, do utrzymania)

1. **`tools/list` jest `UNTRUSTED_DATA`, nie authority.** Zdalny serwer nie
   definiuje, co wolno — registry jest server-owned.
2. **Timeout po możliwym wykonaniu calla daje `AMBIGUOUS`, nigdy blind replay.**
   To ta sama zasada co w RA-012 i RA-017. AC5 wprost tego wymaga („timeout/retry
   nie zmienia read failure w fałszywy success").
3. **Provider packages nie mogą tworzyć cyklu zależności z brokerem.**
4. **Sealed credential-use** — credentiale nie przechodzą przez model ani przez
   argumenty narzędzia.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-021-WU-01` | `DRAFT` | strict broker contracts (nad `contracts/tool.ts`) | RA-020 DONE, RA-012-WU-01B |
| `RA-021-WU-02` | `DRAFT` | server-owned registry/manifest/scope resolution | WU-01 |
| `RA-021-WU-03` | `DRAFT` | durable tool-call ledger + rate/circuit state + artifact binding | WU-01 |
| `RA-021-WU-04` | `DRAFT` | bounded transport executor (timeout → `AMBIGUOUS`) | WU-02, WU-03 |
| `RA-021-WU-05` | `DRAFT` | sealed credential-use + explicit fallback adapters | WU-04 |
| `RA-021-WU-06` | `DRAFT` | malicious protocol/conformance proof | WU-04 |
| `RA-021-WU-07` | `DRAFT` | read-only provider integration: Jira/Gmail/Calendar/GitLab | WU-05, WU-06 |

## Wymagania do rozdzielenia na units

- **AC1 (model nie wybierze connection/repo spoza scope przez argumenty)** →
  `WU-02`; oparte na `resolvedToolIntent`; test adwersarialny: argument z
  `connection_id` innego ownera musi być odrzucony, nie użyty.
- **AC2 (role widzą minimalny manifest)** → `WU-02`; manifest per rola/case;
  wzór sealed manifest z RA-011.
- **AC3 (remote schema/description nie nadpisze policy ani prompt authority)** →
  `WU-06`; fake malicious server z prompt injection w `description` i schema drift.
- **AC4 (oversized/malformed output ograniczony i zachowany jako artifact)** →
  `WU-03` + `WU-06`; artifact store z RA-013.
- **AC5 (timeout/retry nie zmienia read failure w fałszywy success)** → `WU-04`;
  **timeout po możliwym wykonaniu → `AMBIGUOUS`**; test dowodzący braku blind
  replay.
- **AC6 (każdy call ma intent, validated args, result digest, latency, trace)** →
  `WU-03`; durable ledger, nie log.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, **sondę przecięcia eksportów** (kluczowe w tym tasku, zob.
`CTF-002`), kontrolę braku cyklu zależności provider↔broker, oraz osobno weryfikuje
sześć kryteriów akceptacji — w szczególności cross-scope przez argumenty, prompt
injection w `tools/list` i timeout dający `AMBIGUOUS` zamiast retry. Następnie
handoff i niezależny audyt.
