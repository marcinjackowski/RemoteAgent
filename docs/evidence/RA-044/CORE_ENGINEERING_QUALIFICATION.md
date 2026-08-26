# RA-044 — kwalifikacja core Engineering Control Plane

- Data wykonania: `2026-08-26`
- Bazowy commit taska: `458a0e938172655159462ea6fd33277ec10198f0`
- Zakres: deterministyczny core na realnym PostgreSQL, throwaway Git repositories i produkcyjnym
  composition root `apps/agent-worker`
- Poza zakresem tego dokumentu: live Bedrock/AWS, `sondermind-ios`, Xcode, push, MR i merge

Ten dokument zapisuje wyniki uruchomionych bramek WU-00..WU-04. Nie zastępuje pełnej bramki,
odczytu diffu ani audytu Sol i nie deklaruje wykonania live Xcode.

## Kwalifikowana granica produkcyjna

Scenariusze przechodzą przez istniejącą ścieżkę:

```text
worker handler
  -> createWorkerHandlers
  -> SupervisorRuntime
  -> createProductionEngineeringRuntimePort
  -> durable PostgreSQL control plane
  -> Git/worktree, code-owned gates i review loop
```

Fake zastępuje wyłącznie zewnętrzny transport modelu, reviewer session albo code-owned gate
executable. Nie istnieje alternatywny orchestrator, drugi ledger, procesowa mapa recovery ani
fixture-only persistence. Repozytoria Git i bazy danych są jednorazowe; źródłowe repozytorium
RemoteAgent nie jest workspace'em kwalifikacyjnym.

## Uruchomione scenariusze

| Zakres | Dowiedzione zachowanie | Wynik |
|---|---|---|
| WU-00 control state | Durable cancellation jest odświeżane pomiędzy stages, ale nie maskuje rozpoczętego unknown write; projection deletion nie usuwa cancellation. Production structural fingerprints osiągają `NO_PROGRESS` i `OSCILLATION` bez fałszywego postępu od attempt/revision. | `75/75`, `3/3`, exit `0`; full-handler boundary suite niżej |
| WU-01 process classes | `SMALL` ma baseline-red/current-green; `MEDIUM` ma combined design i dwa slices; `LARGE_OR_HIGH_RISK` wymaga Outcome/System/Program Design oraz exact durable write Approval przed workspace/write. Każdy slice ma manifest i exact EvidenceBundle. | exact WU: `4/4`, `2/2`, exit `0`; rozszerzona regresja `46/46`, `5/5`, exit `0` |
| WU-02 recoverability | Retry-safe model intent/STARTED, gate inner receipts, artifact-only, completion-only, projection deletion, LOCAL_COMMIT, deadline/cancel priority, lease loss i case concurrency. Potwierdzone receipts są odzyskiwane bez replay; unknown mutating effect pozostaje `AMBIGUOUS`. Osiągalne recovery boundaries i synthetic completion-only corruption przechodzą przez pełny handler. Same-current-lease recovery nie deklaruje Scheduler fail/reclaim ani cross-fence continuation — to zakres RA-047. | implementer `73/73`, `3/3`; niezależna rozszerzona bramka Sol `94/94`, `4/4`; final recovery+boundary `26/26`, `2/2`; exit `0` |
| WU-03 adversarial/policy/trace | Strict malformed output, foreign scope, stage/kind, stale evidence, failed/missing gate, prompt injection i server-owned path cap. Ordered metadata-only trace ma exact scope; telemetry nie zawiera promptu, host path, canary ani high-cardinality IDs. Pełny handler dodatkowo dowodzi NO_PROGRESS, OSCILLATION, slice-local correction→fresh PASS, retry-safe MODEL_CALL oraz stale/missing/foreign granice. | bazowa bramka `99/99`, `8/8`; implementer boundary gate `22/22`, `4/4`; niezależnie wszystkie qualification suites `38/38`, `6/6`; final recovery+boundary `26/26`, `2/2`; exit `0` |
| WU-04 legacy reply loop | Fresh checkpoint-less conversational case przechodzi przez realny handler i `SupervisorRuntime`: exact `AgentCompletion`, system baseline `0`, revision `1`, `RunCompletionRepository`, completion outbox, typing event, Discord thread reply i trusted conversation entry. Nie jest konstruowany engineering runtime i nie powstaje żaden engineering operation/artifact/event. | `20/20`, `4/4`, exit `0` |

Szczegółowe nazwy testów, wszystkie mutacje i wcześniejsze komendy są zapisane przy odpowiadających
unitach w `docs/work-units/RA-044/WORK_UNITS.md`.

## WU-04 — dokładna uruchomiona bramka

```sh
. scripts/dev/env.sh && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run \
  apps/agent-worker/test/engineering-qualification-reply.integration.test.ts \
  apps/agent-worker/test/baseline-checkpoint-gap.integration.test.ts \
  apps/agent-worker/test/completion-reply.integration.test.ts \
  apps/agent-worker/test/handlers.integration.test.ts && \
pnpm --filter @remoteagent/agent-worker typecheck
```

Pierwszy kompletny przebieg po restore zakończył się exit `0`: Vitest `20/20` w `4/4` plikach z
`RA_REQUIRE_POSTGRES=1`; `@remoteagent/agent-worker` typecheck również exit `0`.

Load-bearing test `preserves the legacy AgentCompletion reply path without constructing an
engineering runtime` sprawdza stan trwały, nie tylko resolve handlera:

- jeden exact `run_completions` z niezmienionym conversational `AgentCompletion`;
- checkpointy `[0, 1]`, `cases.checkpoint_revision = 1` i wyczyszczony `active_run_id`;
- `agent.completion.recorded`, `discord.thread_typing` i `discord.thread_message` z exact body;
- `case_messages` zawiera trusted odpowiedź `AGENT`;
- zero wierszy w `engineering_operations`, `engineering_artifact_revisions` i
  `engineering_stage_events`, a jawnie wstrzyknięty engineering factory ma zero wywołań.

Mutation RED→GREEN, każda osobno i przywrócona przed bramką:

- przekazanie lease `case.resume` jako writer/engineering route: `1/1` RED;
- usunięcie lazy system baseline dla świeżego case'a: `1/1` RED;
- usunięcie projection odpowiedzi Discord po completion: `1/1` RED;
- po restore: `1/1` GREEN, a następnie dokładna bramka WU `20/20` GREEN.

## Ograniczenia kwalifikowanego core

- Transport modelu jest deterministycznym provider fake. Ta kwalifikacja nie dowodzi dostępu,
  konfiguracji, limitów ani zachowania live Bedrock/AWS.
- Approval consumer, immutable authority binding i recovery są kwalifikowane, ale produkcyjny
  approval ingress `Discord -> grant -> writer job` należy do RA-046.
- Joby i approval użyte do kwalifikacji consumera są seedowane przez fixture do realnego
  PostgreSQL. Nie jest to fixture-only persistence, ale nie dowodzi nieistniejącego jeszcze
  produkcyjnego producenta approval/job; tę osiągalność zamyka RA-046.
- Lease loss po niepełnym efekcie zatrzymuje przebieg bezpiecznie jako `RECONCILING`; automatyczna
  cross-fence continuation należy do RA-047 i nie jest deklarowana tutaj.
- Projection odpowiedzi Discord jest idempotentna po `run_id`, lecz pozostaje osobną transakcją po
  completion. Crash pomiędzy tymi transakcjami może zgubić reply bez duplikatu; to istniejące,
  jawne ograniczenie conversational path, nie nowe twierdzenie o atomowości.
- Nie wykonano push, MR, merge ani zewnętrznego write. Żaden wynik core nie jest dowodem działania
  na `sondermind-ios`.
- Pełna repozytorialna bramka RA-044, odczyt całego diffu i audyt należą do Sol i muszą zostać
  zapisane osobno; wyniki WU nie są ich zamiennikiem. Finalny przebieg został wykonany:
  lint/format exit `0`, build `26/26` z `0 cached`, Vitest `2757/2757` w `217/217`, typecheck
  `40/40` z `0 cached`, `workflow:validate OK — 47 tasks` i diff-check exit `0`.

## Jawne wymagania RA-045 — iOS/Xcode

RA-045 może rozpocząć live smoke dopiero po RA-046 i RA-047 oraz po potwierdzeniu przez właściciela
dokładnego małego taska i dozwolonego lokalnego side effectu. Wymagane są:

1. host macOS z działającymi Xcode i Swift oraz jawnie wybranym simulator destination;
2. dostępne live AWS/Bedrock i PostgreSQL;
3. lokalny checkout `sondermind-ios`, zatwierdzony base SHA i server-owned write-path cap;
4. repo-specific code-owned gate catalog dla build, test, lint/format i opcjonalnej inspekcji
   simulator/UI, rozwiązywany jako executable + argv;
5. profile DerivedData, simulatorów, SPM/cache/dependency roots, network policy, timeoutów oraz
   redakcji host paths, credentials i danych prywatnych;
6. produkcyjny approval ingress RA-046 i cross-fence recovery RA-047 — ręczny insert DB lub
   fixture-only grant nie jest dowodem live composition;
7. realne baseline i required gates z exit code, duration, log digest i tree/config binding;
8. celowo czerwony test iOS, który nie może zakończyć runu jako `COMPLETED`, oraz zielony przebieg
   tego samego gate po restore;
9. pełny design/slices/gates/review i wyłącznie lokalny evidence-bound commit receipt;
10. raport live z wersjami Xcode/Swift, destination, komendami, exit codes, commit SHA, diffem i
    ograniczeniami profilu; brak wymagania ma dać `BLOCKED`, nigdy skip/pass.

Live status Xcode/`sondermind-ios`: **NIE URUCHOMIONO w RA-044**.
