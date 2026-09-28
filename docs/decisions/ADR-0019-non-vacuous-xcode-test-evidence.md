# ADR-0019 — non-vacuous Xcode test evidence

- Status: `ACCEPTED`
- Data: `2026-09-05`
- Uzupełnia: `ADR-0007`, `ADR-0015`, `ADR-0017`, `ADR-0018`
- Task: `RA-055`

## Kontekst

Dotychczasowy adapter Xcode wiązał receipt z komendą, drzewem, configiem i
trwałym logiem, lecz `PASSED` wynikał z exit code `0`. Taki wynik nie dowodzi,
że wybrany test target odnalazł i wykonał choć jeden test. Tekst `xcodebuild`
jest nieufny, zależny od wersji i może zawierać podobny marker wypisany przez
sam test. W kwalifikacji MOBL-2023 wymagamy dokładnych wykonanych test IDs,
liczby przebiegów i pokrycia server-owned suite selectors.

## Decyzja

1. Nowy Xcode TEST run używa jednego canonical `-resultBundlePath` wewnątrz
   disposable `.remoteagent-xcode` oraz przypiętego schema
   `xcresulttool get test-results tests`.
2. Server-owned adapter czyta bounded JSON z wybranego toolchainu przed
   usunięciem build outputs. Stdout/stderr pozostaje wyłącznie diagnostyką i nie
   może tworzyć test evidence.
3. `PASSED` albo assertion `FAILED` z Xcode wymaga strict `test_evidence`:
   rozpoznanego schema/tool identity, digestu raw bounded payloadu, niepustych
   unikalnych executed test IDs, spójnego count, failed IDs oraz pokrycia
   wszystkich code-owned `-only-testing` suites.
4. Brak bundle, zero testów, brak wymaganej suite, malformed, truncation,
   przekroczenie boundu albo nieobsługiwany format klasyfikuje run jako
   `INFRASTRUCTURE`; nie wolno z tego wyprowadzić PASS ani typed assertion
   correction authority.
5. Dowód jest częścią identity `TestRun` i `VerificationGateReceipt`, razem z
   istniejącym bindingiem manifest/config/tree/command. Zmiana lub usunięcie
   evidence unieważnia receipt digest/ID.
6. Pole jest opcjonalne w historycznym kontrakcie v1, aby stare receipts nadal
   były czytelne. Opcjonalność nie jest fallbackiem: nowy adapter Xcode wymaga
   pola deterministycznie przed zwróceniem assertion outcome.
7. Parser ma zamknięte limity byte/node/depth/count/string i jawnie przypiętą
   wersję schema. Rozszerzenie wspieranych wersji wymaga test fixture oraz zmiany
   code-owned policy.

## Odrzucone alternatywy

- Exit code `0` albo `** TEST SUCCEEDED **`: nie dowodzi discovery ani count.
- Regex na tekstowym logu: dane są nieufne, możliwe do podrobienia i niestabilne.
- Sam aggregate count bez IDs: nie dowodzi wykonania wymaganych suites.
- Zachowanie całego `.xcresult` w source tree: bundle jest dużym mutable build
  outputem i narusza czysty tree receipt.
- Bezwarunkowe odrzucenie historycznych receipts: psuje durable recovery bez
  zwiększenia jakości nowych przebiegów.

## Konsekwencje

- Live katalog Xcode musi dodać canonical result bundle path i jawne suite
  selectors przed kolejnym invocation.
- Gate receipt może pokazać dokładne executed/failed test IDs i count bez
  zachowywania prywatnych logów w summary.
- Compile/discovery/harness failure bez kompletnego result bundle jest
  bezpiecznie inconclusive zamiast fałszywego assertion failure.

## Migracja

1. Dodać bounded `test_evidence` do TestRun i gate receipt oraz objąć je identity.
2. Dodać pinned xcresult parser i wymóg result bundle w adapterze Xcode.
3. Dodać zero/missing-suite/malformed/truncation/tamper regressions i mutacje.
4. Zaktualizować izolowany live catalog przed nowym MOBL-2023 invocation.

## Rollback

Rollback wyłącza Xcode PASS i kończy takie gates jako `INFRASTRUCTURE`; nie
przywraca exit-only ani log-regex evidence. Historyczne receipts pozostają
czytelne i nie są przepisywane.
