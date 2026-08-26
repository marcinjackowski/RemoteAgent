# RA-047 — cross-fence recovery qualification

- Data: `2026-08-26`
- Bazowy commit: `2b35b3fd6c2c37ca5e92468a8a64e1ae87d991e6`
- Zakres: expired engineering lease → code-owned recovery job → dedicated continuation fence →
  istniejący production `createWorkerHandlers -> SupervisorRuntime`
- Pełna komenda:
  `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Wynik: exit code `0`; lint i Prettier exit `0`; forced build `26/26`, cache `0`; Vitest
  `224/224` plików i `2829/2829` testów przy wymaganym PostgreSQL; forced typecheck `40/40`, cache
  `0`; `workflow:validate OK — 47 tasks`; diff-check exit `0`.

## Granica authority i continuation

`jobs` pozostaje jedynym źródłem lease ownera, expiry i fencing tokenu. Expired, niedokończony
`agent.implementer` związany z exact RA-046 GRANTED proposal nie trafia do generic reap ani claim.
Code-owned coordinator parkuje go w `RECONCILING`, tworzy jeden case-less
`agent.engineering_recovery` i zapisuje immutable recovery binding oraz append-only eventy.
Recovery job nie ma case/write scope, bounded tools ani prawa uruchamiania commandu lub commita.

Po exact klasyfikacji i ewentualnej naprawie źródło przechodzi do `RECOVERY_PENDING`. Stan nie jest
widoczny dla generic claim, lecz nadal blokuje case serialization. Dedykowany continuation claim
nadaje temu samemu źródłowemu `job_id` nowy fence i kieruje go do istniejącego production handlera
na tym samym case/work unit/run. Błąd continuation wraca do `RECONCILING` i tworzy child recovery;
nie używa generic `PENDING` retry.

## Macierz crash/recovery

- przed intentem albo po ukończonym stage, lecz przed następnym intentem: brak `STARTED` dowodzi,
  że nie było dispatchu; continuation zachowuje ordered artifacts i outer run;
- intent/STARTED `MODEL_CALL` albo `READ_ONLY` bez artefaktu: retry wymaga exact immutable descriptor,
  config/schema/scope/deadline, ContextManifest/snapshot i digestu renderowanego packetu; przed
  dispatch zapisuje konserwatywną rezerwację budżetu oraz recovery-bound operation ID;
- outer GATE crash po durable inner receipt: recovery działa receipt-only, naprawia observation,
  składa jeden exact `EvidenceBundle`, zachowuje pierwotny `completion_id` i nie uruchamia commandu
  ponownie;
- inner GATE `STARTED` bez receiptu lub brak choć jednego wymaganego inner operation: kończy
  `AMBIGUOUS`, bez replacement commandu i bez success bundle;
- artifact bez completion/observation: dedykowana recovery-fenced granica dopisuje wyłącznie exact
  standardowy receipt i observation; completion-only bez rekonstruowalnego artefaktu pozostaje
  niejednoznaczny;
- LOCAL_COMMIT crash po utworzeniu commita, przed outer artifact: recovery wyłącznie obserwuje exact
  HEAD/parent/marker/tree/diff, zapisuje jeden receipt i pozostawia łączną liczbę commitów równą
  `1`; nie wywołuje `commit` drugi raz;
- niepotwierdzony `COMMAND`/`MUTATING_SIDE_EFFECT` pozostaje `AMBIGUOUS`; cancellation/deadline nie
  maskują unknown write. Dla nowego wykonania i następnego stage bieżący cancel/deadline kończy
  recovery bez modelu, gate lub Git side effectu;
- dwa recovery workery, replay publish oraz dwa continuation claimy mają dokładnie jednego zwycięzcę.

## Mutation evidence

Każda mutacja była chwilowa, dała RED i została przywrócona przed pełną bramką. Load-bearing
mutations objęły między innymi:

- generic reap omijający engineering classifier, przedwczesne `SUCCEEDED` bez outer completion,
  generic claim/reap recovery joba i pominięcie `RECOVERY_PENDING` w serialization;
- osłabienie source/proposal/operation/intent/fence binding, expiry, predecessor chain, recovery
  event authority, plan digest, context packet, config/schema/scope/policy/deadline albo budżetu;
- unfenced observation i repair, caller-supplied plan digest, obcy operation/artifact oraz
  nieidempotentny repair replay;
- GATE bez outer-stage filtra, z `recovery_only=false`, bez recovery observation callback albo z
  brakującym required inner operation; każdy wariant uruchomił nieuprawnioną ścieżkę lub nie
  terminalizował `AMBIGUOUS`;
- LOCAL_COMMIT recovery zmienione z `recover` na `execute`: drugi commit / błędny przebieg RED;
- continuation używający starego operation ID, kopiujący operation z poprzedniego fence,
  kierujący błąd do `jobs.fail/PENDING`, bez production lane lub bez durable publish;
- rollback 037 bez population guard albo pełnego `ACCESS EXCLUSIVE ... NOWAIT`: destrukcyjny down
  albo kontrolowany `drop-blocked` race RED.

Pierwszy pełny przebieg po implementacji zakończył się exit `1`: `222` pliki przeszły, `2` pliki
miały łącznie `4` deterministic failures, bo stare RA-044 fixture’y odczytywały dawny płaski
LOCAL_COMMIT descriptor. Fixture’y poprawiono do strict `descriptor.commit` i kompletnego
ContextManifest; targeted adjudication dał `18/18`. Nie był to flake. Pełną komendę uruchomiono od
początku ponownie i dopiero jej wynik `2829/2829`, exit `0`, jest wynikiem kwalifikacji.

## Granice dowodu

PostgreSQL, Git, filesystem, gate processy, queue/scheduler, repositories, worker composition i
SupervisorRuntime są rzeczywiste. Provider modelu jest deterministycznym skryptowanym boundary
fake. Crash jest symulowany przez utratę lease/fault injection oraz świeży scheduler/runtime/port w
tym samym procesie testowym; test nie zabija procesu OS w połowie instrukcji PostgreSQL. Recovery
nie wykonuje push, MR ani merge i nie uznaje niepotwierdzonego commandu za sukces.
