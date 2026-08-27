# RA-045 — iOS Engineering smoke evidence

## Wynik

Bezpośredni smoke MOBL-2021 zakończył się sukcesem `2026-08-27`. Wejściem był opis taska
przekazany jako `UNTRUSTED_DATA`; Jira i Discord nie brały udziału w wywołaniu. Produkcyjny
Engineering Control Plane wykonał planning, bounded implementation, gates, fresh pre-commit
review, final verification i jeden lokalny commit w izolowanym worktree. Nie wykonano push, MR,
merge ani zewnętrznej wiadomości.

- baza `sondermind-ios`: `6ef7ec4e7dc4a9fbe6920055ee7516283ea9fcf6`;
- branch: `remoteagent/engineering-d5612121055d467f32c96b0560d960ca`;
- commit: `9bf102e5f13d962d39d84e126f93b0f26c437cda`;
- parent: `6ef7ec4e7dc4a9fbe6920055ee7516283ea9fcf6`;
- commit count od bazy: `1`;
- diff: `7` plików, `45` insertions, `11` deletions;
- źródłowy checkout po smoke: czysty i nadal na bazowym SHA;
- config digest: `sha256:93a564fd7807bc2db470a26acf4db6b8ebbe7bd64e36bd1141809049e42d7685`.

## Środowisko

- Xcode `26.1.1` (`17B100`);
- Swift `6.2.1` (`swiftlang-6.2.1.4.8`, `clang-1700.4.4.1`);
- destination: code-owned iOS Simulator `iPhone 17 Pro` o przypiętym UUID;
- `xcodebuild` był kanonicznym plikiem wybranego `DEVELOPER_DIR`;
- HOME, TMPDIR, DerivedData i SourcePackages były jednorazowe i znajdowały się w disposable
  output root;
- pełne wartości sekretów i host paths nie są częścią tego dokumentu ani model contextu.

Komenda wywołania, z obowiązkowo zredagowanymi sekretami i lokalnymi ścieżkami konfiguracyjnymi:

```sh
. scripts/dev/env.sh && \
RA_RUN_LIVE_IOS_ENGINEERING=1 \
RA_LIVE_ENGINEERING_OBJECTIVE='<MOBL-2021 description>' \
RA_ENGINEERING_CONFIG_PATH='<server-owned config>' \
RA_XCODEBUILD_PATH='<canonical xcodebuild>' \
DEVELOPER_DIR='<selected Xcode Developer directory>' \
RA_REQUIRE_POSTGRES=1 \
pnpm exec vitest run apps/agent-worker/test/engineering-live-ios.integration.test.ts
```

Wynik: exit `0`; `1/1`; czas testu `533,36 s`.

## Gate receipts

| Gate | Target | Wynik | Exit | Czas | Log digest |
| --- | --- | --- | ---: | ---: | --- |
| `mobl-2021-contract` | `BASELINE` | `FAILED` | 1 | 43 ms | `sha256:60f8cd695483d1cea9c65e784262920873e32673950a4ded2bd8586f813cba78` |
| `mobl-2021-contract` | `CURRENT` | `PASSED` | 0 | 35 ms | `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `ios-targeted-tests` | `CURRENT` | `PASSED` | 0 | 393704 ms | `sha256:b9096f568a74cb2cc17d4c0ac535dff85255cf3d628e48f845403ca8191f5213` |

Xcode wykonał `44` testy (`26` AgentAISettingsViewModelTests i `18`
CareTeamSharingIntroViewModelTests), `0` failures, a log zakończył się `TEST SUCCEEDED`.

Celowa mutacja narzutu SwiftPM: wyłączenie cleanup exact katalogu
`project.xcworkspace/xcshareddata/swiftpm/configuration` dało exit `1` na niezgodnym post-tree
digest. Po restore targeted adapter/disposable gate zakończył się exit `0`, `13/13`, a inne
chronione ścieżki nadal pozostają load-bearing.

## Tokeny i changelog

Provider zaraportował `48604` input i `6356` output, razem `54960` tokenów w `6` odpowiedziach.
Porównawczy budżet przed runem wynosił `55k–130k`, warning `>150k`, hard stop `250k`. Wynik jest
praktycznie na dolnej granicy prognozy i wielokrotnie niższy od pierwszego mierzonego smoke
(`234022`).

Każde wywołanie ma osobny JSONL. Dla sukcesu:
`engineering-207ca4118958e40883ae77d8a9d97a4fe174755ea3fb365d4eb77a2bbabca9d2.jsonl`.
Plik ma mode `0600` i `26` monotonicznych rekordów: start, cumulative model usage, bounded tool
results, batched patch metadata, durable artifacts/operations, gate receipts i final commit.
Świadomie nie zapisuje ukrytego chain-of-thought ani surowej treści promptów/modelu; debugowalny
jest obserwowalny proces, decyzje strukturalne, koszty i skutki.

## Zweryfikowany diff

Commit zmienia wyłącznie:

- heading i dwa footer labels w lokalizacji oraz checked-in generated accessor;
- układ `Privacy Policy · Terms of Service` na ekranie Sonder Preferences;
- nową akcję/output ViewModelu;
- routing `.terms` w obu istniejących flow;
- focused ViewModel test nowego outputu.

Nie zmienia konfiguracji projektu, zależności, repo policy, remote ani kodu publikowania.

## Ograniczenia

- smoke używał prawdziwego Bedrock/PostgreSQL/Git/Xcode, ale nie automatyzował wizualnej inspekcji
  simulatora ani snapshotu UI;
- test był bezpośrednim wywołaniem Engineering bez Jira/Discord, zgodnie z decyzją właściciela;
- commit pozostaje lokalny w izolowanym worktree do ręcznej inspekcji; nie został wypchnięty.
