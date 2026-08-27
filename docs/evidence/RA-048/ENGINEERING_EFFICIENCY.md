# RA-048 — Engineering efficiency evidence

Data: `2026-08-27`

## Baseline MOBL-2023

Poprzednia próba zapisana w
`engineering-41a06d02e37563c8724e6fd5d4c4a98c9a23e833f3bb5720ce666b714627c4e5.jsonl`
zakończyła się przed pierwszym gate:

- provider responses: `14`;
- input tokens: `225478`;
- output tokens: `10545`;
- total tokens: `236023`;
- tool results: `36`;
- końcowy błąd: `ToolLimitError` w `SLICE_IMPLEMENTATION`;
- durable artifacts: `ContextManifest`, `SliceContract`; bez gate bundle i bez
  local commit.

Wcześniejsze określenie „16 tur” dotyczyło obserwowanego tool-loop. Provider
usage ma dokładnie `14` odpowiedzi; to ta liczba i `236023` tokenów są bazą
porównania.

## Nowy budżet i oczekiwanie

Code-owned journal i guardy używają:

- target: `250000` total provider tokens;
- warning: `400000`;
- hard limit: `600000`;
- final-call reserve: `35000`;
- implementation: maksymalnie `8` rounds, `32` calls i `3` rounds rezerwy na
  mutację/final report; trzy najnowsze pary narzędzi zachowują exact treść,
  starsze przechodzą do content-free projection;
- maksymalnie `4` write roots na slice.

Dla taska rozmiaru MOBL-2023 oczekiwany zdrowy zakres to około
`80000–120000` tokenów. Target `120000` jest o `116023` tokenów, czyli około
`49.2%`, niższy od baseline. Baseline przekraczał target o około `96.7%` i
warning nie był przekroczony. Limit warning służy teraz jako sygnał dla
złożonego, wieloslice'owego zadania, a nie jako blokada pierwszej poprawnej
implementacji.

## Wprowadzone mechanizmy

- strict ordered slice blueprints i server materialization zamiast swobodnego
  replanningu każdego slice;
- test-first mutation chronology i create-only/large-diff guards;
- FAST gates przed FULL;
- receipt-bound code-owned generators w disposable copy;
- rezerwa tur oraz deterministyczna kompakcja working context;
- jeden prywatny plik JSONL `0600` na invocation, bez promptu, raw bytes, model
  prose i chain-of-thought;
- heartbeat zachowujący configured lease zamiast skracania jej do `30s`.

## Weryfikacja repozytorium

Pełna komenda:

`. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`

Wynik: exit `0`; build `26/26` i typecheck `40/40` przy `0 cached`; Vitest
`227` plików passed + `1` opt-in live skipped oraz `2926` testów passed + `1`
skipped; `workflow:validate` zwrócił `OK — 53 tasks`.

## Ponowny live smoke

Wcześniejsza diagnoza IAM/`AccessDenied` była błędna. Projekt używa istniejącego
bearer/API key z `AWS_BEARER_TOKEN_BEDROCK`; wszystkie miarodajne próby miały
`AWS_REGION=us-east-1`, `RA_MODEL_ID=us.anthropic.claude-opus-4-8` i usunięty
`BEDROCK_MODEL_ID`. Provider zwracał usage, więc nie jest potrzebne nadawanie
roli IAM.

Dwa pełne runy dochodziły do gate boundary, lecz kończyły po około `6s` jako
`INFRASTRUCTURE`. Journal przechowuje tylko content-free error digest. Jego exact
dopasowanie do code-owned komunikatów wykazało rozbieżność między powielonym
`RA_XCODE_DESTINATION` a `-destination` w server-owned gate catalog. Ręczne
uruchomienie tego samego adaptera z bearer key i wartością katalogową zwróciło
`FAILED/65`, durable artifact i identyczny before/after tree digest.

Live harness nie przyjmuje już `RA_XCODE_DESTINATION`: wyprowadza jedną exact
wartość z katalogu przed model call i odrzuca brak lub konflikt. Mutation
odłączająca conflict guard dała exit `1`; po restore adapter `4/4`, forced
typecheck `15/15` przy `0 cached` i diff-check zakończyły się exit `0`.

Po tej poprawce invocation
`engineering-2ed31f8106f7b358595c44abeb3341b820b557077b40be4ff40c26f4e859e00a.jsonl`
wykonała realny `xcodebuild` przez `358948ms`. Durable gate receipt miał
`outcome=FAILED`, `exit_code=65` oraz compiler log; workflow prawidłowo przeszedł
do correction attempt `2`. Provider usage:

- responses: `13`;
- input tokens: `168041`;
- output tokens: `17920`;
- total tokens: `185961` (`WARNING`);
- local commit: `0`.

Korekta zakończyła się `Maximum tool iterations exceeded`. Model kilka razy
użył create-only `write` dla plików z poprzedniego attempt; odmowy
`WRITE_REQUIRES_NEW_FILE` były poprawne. Content-free projection zachowała kod
błędu, ale nie powiązaną ścieżkę. Prompt korekty otrzymuje teraz sorted
server-observed `existingAgentPaths` i dla tych ścieżek wymaga wyłącznie
`patch.replacement_files` z exact old content. Mutation usuwająca informację
dała exit `1`; restore zakończył focused Engineering/Xcode `11/11`, forced
typecheck `15/15` przy `0 cached` i diff-check exit `0`.

Następny run zużył `218339` tokenów (`199083` input + `19256` output) w `13`
odpowiedziach. Realny Xcode gate przeszedł po korekcie, ale strict review
odrzucił niezakotwiczone blocking evidence. Po load-bearing poprawce promptu i
degradacji unsupported finding do LOW focused gate zakończyła się `98/98`, a
forced typecheck `40/40` przy `0 cached`.

Ostatni invocation został przerwany na jawne polecenie właściciela podczas
Xcode gate. W chwili przerwania usage wynosiło `557109` tokenów (`526738` input
+ `30371` output) w `26` odpowiedziach. Nie powstał commit ani terminalny
sukces. Journal
`engineering-24bb973118e2b3f46486f32ea6ae55812a2be9ffa541c655b7eff371f84d4f2f.jsonl`
i izolowany worktree zostały zachowane. Live Bedrock tests pozostają wstrzymane
do osobnej jawnej decyzji właściciela.

## Izolacja

Seed worktree pozostaje czysty i zachowany:

- path: `/Users/marcinjackowski/.remoteagent/live-mobl-2023/seed-worktree`;
- branch: `remoteagent/mobl-2023-asset-seed`;
- commit: `cd46c82de01d6ec4c5e614bcab9dc15f07560642`.

Nie wykonano push, MR, operacji Jira ani Discord. Źródłowy checkout SonderMind
nie został użyty jako live workspace.
