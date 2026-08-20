# RA-023 — Work units

## Metadata

- Task: `RA-023`
- Plan revision: `1`
- Plan owner: `COORDINATOR_AUDITOR`
- Implementer: `Claude Opus 5 / high / IMPLEMENTER` (zob. [ADR-0005](../../decisions/ADR-0005-opus5-coordinator-and-implementer.md))
- Plan status: `DRAFT` — task jest `BLOCKED_BY_DEPENDENCIES`. Zależności `DONE`:
  RA-010, RA-016. Niedokończone: RA-021, RA-022.
  Plan nie zmienia statusu taska ani nie omija zależności.
- Base commit/tree: do zapisania przy starcie
- Full-task verification: do ustalenia przy starcie (pakiet zależy od decyzji
  adopt/defer/reject)

## Global boundaries

- In scope: weryfikacja i — **tylko gdzie bezpieczne** — wdrożenie AgentCore
  Gateway/Identity jako managed MCP boundary, plus capability matrix i fallbacki.
- Out of scope: usunięcie własnych ingress connectorów i przeniesienie source of
  truth do AgentCore. **Postgres pozostaje authority.**
- **Model nie otrzymuje refresh ani access tokenów** (AC5).
- **Brak live contract testów i brak jakiegokolwiek deploymentu bez jawnej
  autoryzacji właściciela** (AC z Required verification: „contract tests live tylko
  po jawnej autoryzacji właściciela").

## Ustalenia z kodu przed planowaniem (2026-08-20)

1. **KRYTYCZNE: refresh/credential lifecycle JUŻ ISTNIEJE.**
   `packages/policy/src/credential-refresh.ts` zawiera `RefreshLease`,
   `RefreshedCredential`, `RefreshIntent`, `BeginRefreshIntentInput`,
   `CredentialRefreshIntentStore`, `CredentialMetadataPublisher`,
   `assertSameIntentIdentity`, plus typed błędy (`CredentialRefreshConflictError`,
   `CredentialRefreshIdentityError`, `CredentialRefreshLeaseLostError`).
   `packages/policy/src/credential-vault.ts` zawiera `CredentialVault`,
   `CredentialWriteAmbiguousError`, `CredentialUsageError`.
   **RA-023 NIE może zbudować drugiego silnika tokenów** — ma się oprzeć na tym
   lifecycle. Duplikat byłby findingiem BLOCKER: dwa niezależne mechanizmy refresh
   nad tymi samymi credentialami to gwarantowany wyścig i utrata tokenu.
2. **`CTF-001` dotyczy dokładnie tej granicy.** `packages/policy` i
   `packages/database` definiują dwie różne klasy `CredentialRefreshConflictError`
   i `CredentialRefreshIdentityError`; `instanceof` między nimi zwraca `false`.
   RA-023 spina te warstwy, więc **`CTF-001` powinien być domknięty przed tym
   taskiem** albo jako jego pierwszy unit.
3. **`packages/workspace-runner` ma już fencing i recovery**
   (`fencing.ts`, `recovery.ts`, `WorkspaceFence`). Spike AgentCore Runtime musi
   traktować sesję jako **transport/cache**, nie authority — checkpoint zostaje w
   Postgresie (AC6).
4. **Werdykty `ADOPT/DEFER/REJECT`, maturity i capabilities wymagają świeżej
   weryfikacji oficjalnej dokumentacji.** Preflight z handoffu transferowego wprost
   to zaznacza. Stan Preview/Beta zmienia się szybko; werdykt oparty na pamięci
   modelu jest bezwartościowy. To praca badawcza z cytowanymi źródłami, nie
   implementacyjna.

## Korekty po red-teamie (z preflightu, do utrzymania)

1. **Opaque OAuth/credential session boundary oparta na ISTNIEJĄCYM refresh
   lifecycle — bez drugiego silnika tokenów.**
2. **One-shot AgentCore Runtime/session handoff:** Postgres/checkpoint pozostaje
   authority, sesja jest tylko transportem/cache.
3. **Werdykty i capabilities wymagają świeżej weryfikacji oficjalnej dokumentacji.**
4. **Bez live contract testów i bez deploymentu bez jawnej autoryzacji właściciela.**

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-023-WU-00` | `DRAFT` | domknięcie `CTF-001` (jedna definicja klas `CredentialRefresh*Error`) | RA-022 DONE |
| `RA-023-WU-01` | `DRAFT` | target contracts/config/capability registry | WU-00 |
| `RA-023-WU-02` | `DRAFT` | health/conformance discovery + deterministyczny fallback | WU-01 |
| `RA-023-WU-03` | `DRAFT` | opaque OAuth/credential session **nad istniejącym** refresh lifecycle | WU-01 |
| `RA-023-WU-04` | `DRAFT` | one-shot Runtime/session handoff (Postgres jako authority) | WU-03 |
| `RA-023-WU-05` | `DRAFT` | final fake Gateway conformance proof | WU-02, WU-04 |

Osobno, jako praca badawcza koordynatora (nie work unit implementera):
**capability/status matrix i ADR z werdyktami `ADOPT/DEFER/REJECT`** dla Atlassian
Rovo MCP, Google Gmail/Calendar MCP, GitLab MCP i opcjonalnego Slack MCP — oparte
na świeżo zweryfikowanej oficjalnej dokumentacji, z cytatami i datą weryfikacji.
Implementer nie wykonuje research; koordynator nie deleguje decyzji architektonicznej.

## Wymagania do rozdzielenia na units

- **AC1 (każdy provider ma udokumentowany werdykt i dowody)** → praca badawcza
  koordynatora + ADR; nie unit implementera.
- **AC2 (Preview/Beta target ma działający, testowany fallback)** → `WU-02`;
  fallback deterministyczny, nie „spróbuj i zobacz".
- **AC3 (Gateway policy nie poszerzy lokalnej policy ani owner/case scope)** →
  `WU-01` + `WU-05`; podwójna warstwa policy jest w audit focus — test
  adwersarialny, w którym Gateway zwraca szerszy scope niż lokalny.
- **AC4 (OAuth revoke i schema drift wykrywane, fail-closed)** → `WU-02` + `WU-03`;
  mocked revoke i drift.
- **AC5 (model nie otrzymuje refresh/access tokenów)** → `WU-03`; wzór
  `token.fill(0)` z RA-016; test, że token nie występuje w żadnej powierzchni
  model-facing.
- **AC6 (Runtime restart nie traci case state — odtwarza z Postgresa)** → `WU-04`;
  test stop/resume z zewnętrznym checkpointem.

## Final task gate

Koordynator uruchamia pełną suite, całe repo bez regresji,
typecheck/build/scoped lint/format, `pnpm workflow:validate`, `git diff --check`,
sondę przecięcia eksportów, oraz osobno weryfikuje sześć kryteriów akceptacji — w
szczególności brak drugiego silnika refresh (przegląd kodu, nie tylko testy),
Gateway próbujący poszerzyć scope, oraz restart Runtime bez utraty state.
**Żaden live contract test ani deployment nie jest wykonywany bez jawnej
autoryzacji właściciela.** Następnie handoff i niezależny audyt.
