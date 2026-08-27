# RA-045 — AUDIT-01

- Task: `RA-045` Kwalifikacja iOS/Xcode na sondermind-ios
- Data: `2026-08-27`
- Bazowy commit: `9d8008e56da108ac94a0496234b9df9f39edb727`
- Commit implementacji: `2c627b4`
- Audyt: pełny diff od bazowego commita, wszystkie pliki nieśledzone, produkcyjny composition path,
  wynik live Bedrock/PostgreSQL/Git/Xcode i samodzielnie uruchomiona pełna bramka zgodnie z
  `ADR-0007`

## 1. Uruchomiona bramka audytowa

Po odczycie pełnego diffu, korekcie prywatności logów i odporności journalu uruchomiono od początku:

```text
. scripts/dev/env.sh                    Node 24.19.0; PostgreSQL reachable
pnpm lint                               exit 0; tylko znane warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        2861 passed, 1 opt-in live skip;
                                        226 files passed, 1 skipped; exit 0
pnpm run typecheck --force              40/40, 0 cached, exit 0
pnpm workflow:validate                  OK — 47 tasks, exit 0
git diff --check                        exit 0
```

Live smoke został wykonany osobno z opt-in flagą przed bramką: `1/1`, exit `0`, `533,36 s`.
Użył prawdziwego Bedrock, PostgreSQL, Git i Xcode, zakończył się dokładnie jednym lokalnym commitem
`9bf102e5f13d962d39d84e126f93b0f26c437cda` w izolowanym worktree i nie wykonał push/MR/merge.

## 2. Kryteria akceptacji

1. **Environment preflight:** spełnione. Evidence wiąże Xcode `26.1.1`, Swift `6.2.1`, przypięty
   simulator `iPhone 17 Pro`, bazę `6ef7ec4e7dc4a9fbe6920055ee7516283ea9fcf6` i config digest.
   Adapter wymaga kanonicznego `xcodebuild`, destination, DeveloperDir oraz disposable output roots;
   brak lub mismatch kończy się odmową, nie skip/pass.
2. **Rzeczywiste baseline i gates:** spełnione. `mobl-2021-contract` był `FAILED` na baseline i
   `PASSED` na current. Targeted Xcode był `PASSED`, exit `0`, `393704 ms`, `44` testy i `0`
   failures. Receipty mają duration, log digest oraz exact tree/config binding.
3. **Pełny cykl i commit:** spełnione. Produkcyjna ścieżka proposal/grant, worker handler,
   `SupervisorRuntime`, planning, bounded implementation, gates, fresh review, final verification i
   evidence-bound LOCAL_COMMIT zakończyła się jednym commitem z exact parentem. Source checkout
   pozostał czysty.
4. **Celowy RED i restore GREEN:** spełnione. Baseline kontraktu realnie zwrócił exit `1`, current
   exit `0`. Dodatkowo usunięcie exact cleanup scratch SwiftPM dało RED na post-tree digest, a po
   restore adapter/disposable suite wróciła do GREEN `13/13`.
5. **Prywatność i redakcja:** spełnione. Model context, evidence i journal nie zawierają sekretów,
   host paths, surowych promptów, patch bytes, model prose, request IDs ani chain-of-thought.
   Pre-audyt usunął surowe query/Zod/stage error z stdout. Closed-schema journal zapisuje wyłącznie
   structural metadata i error digest; test z canary oraz permissive-field mutations są load-bearing.
6. **Brak publikacji:** spełnione. Xcode adapter i Git lifecycle nie wystawiają push/MR/merge w tym
   flow. Live wynik ma jeden lokalny commit, nie zmienił remota ani źródłowego checkoutu.
7. **Raport i pełna bramka:** spełnione. Evidence zawiera wywołanie, exit codes, duration, digests,
   commit SHA, stat diffu, usage oraz ograniczenia. Pełny niecache'owany łańcuch powyżej wraz z
   `workflow:validate` i diff-check zakończył się exit `0`.

## 3. Efektywność i debugowalność Engineering

Implementer ma server-owned allowed paths/required gates, bounded indeks nazw, limit discovery,
machine-readable feedback dla błędnych tool inputs i exact replacement patch. Pusta pierwsza
implementacja przy niespełnionym objective kończy się `NO_PROGRESS`; identyczna korekta nadal
dochodzi do exact review no-change terminalu. Git pustego declared surface ma poprawny read-only
diff zamiast błędu `check-attr`.

Każda odpowiedź modelu raportuje rzeczywiste provider usage. MOBL-2021 zużył `48604` input +
`6356` output = `54960` tokenów w `6` odpowiedziach, wobec celu `55k–130k`; warning zaczyna się
powyżej `150k`, a code-owned hard stop przed `250k` uwzględnia rezerwę na następne wywołanie.

Każde wejście Engineering tworzy osobny plik `engineering-<digest>.jsonl` mode `0600` z
monotoniczną sekwencją: binding/start, stage, usage, bounded tool shape/result, changed-path
metadata, durable operations/artifacts/gates i terminal status/commit. Dziennik opisuje
obserwowalne decyzje i skutki, nie prywatny tok rozumowania. Błąd końcowego diagnostic read/close
jest best-effort i nie może zmienić ukończonego wyniku workflow.

## 4. Mutation checks i findings

Realne RED→GREEN objęły: canonical Xcode/destination/output isolation, scratch cleanup, structured
output normalization, structural tool feedback, repeated invalid input, planning constraints,
bounded discovery, pusty Git diff, empty implementation, token stage attribution/hard stop,
unikalny journal, strict content-free schema, monotonic sequence, handler/transport wiring oraz
odporność ukończonego workflow na awarię diagnostyki. Korekta broad empty-implementation guard
również miała osobny full-handler RED i restore GREEN.

Wcześniejsze smoke ujawniły rzeczywiste defekty: błędny podobny ekran, brak testów/action, zły enum,
companion prose przy output-tool, szesnaście tur samych read/search, pusty declared Git surface oraz
nadmierne `234022` tokeny. Wszystkie naprawiono mechanizmem i load-bearing testem; nie ukryto ich
przez zwiększenie limitu ani ręczną korektę patcha.

Po końcowym odczycie diffu i pełnej bramce nie pozostał finding klasy BLOCKER, HIGH ani MEDIUM.
Nie powstał nowy finding przekrojowy do `CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie siedem kryteriów RA-045 jest spełnionych, a pełna niecache'owana bramka zakończyła się
exit code `0`.
