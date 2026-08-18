# RA-001 — trwały stan sesji koordynatora

Aktualizacja: 2026-08-18 23:35 CEST

## Cel i ograniczenie

- Doprowadzić `RA-001` do `DONE`, z niezależnym audytem `PASS`.
- Nie rozpoczynać `RA-002`.
- Jednocześnie tylko jeden implementer zapisuje do workspace tego case'a.
- Koordynator/Codex wykonuje niezależny audyt; implementer nie audytuje swojej
  pracy.
- Dzienny limit OpenCode ustalony przez właściciela na 2026-08-18 wynosi
  `50.00 USD`. Po każdym workerze odświeżyć koszt i nie uruchamiać następnego,
  jeśli limit został osiągnięty albo pozostały margines nie pokrywa bezpiecznie
  następnego wywołania. To limit maksymalny; `RA-001 DONE` kończy pracę wcześniej.

## Stan Git i workflow

- Branch: `main`; repo nie ma remote ani push.
- Bazowy HEAD remediacji: `2561311 docs: resume RA-001 after AUDIT-06`.
- `RA-001`: `IN_PROGRESS`.
- Ostatni audyt: `docs/audits/RA-001/AUDIT-06.md`, werdykt
  `CHANGES_REQUIRED`.
- Ostatni handoff: `docs/handoffs/RA-001/HANDOFF-06.md`.
- Zmodyfikowane przez bieżącą remediację: validator, jego testy oraz dwa
  kontrakty workflow (`EXECUTION_AND_AUDIT.md`, `AUDIT_CHECKLIST.md`).
- Ten dokument oraz `docs/BEDROCK_USAGE.txt` zostały dodane na żądanie
  właściciela, aby wznowienie nie zależało od kontekstu rozmowy.

## Zrealizowana remediacja AUDIT-06

1. Causality artefaktów:
   - `AWAITING_AUDIT` wymaga najnowszego handoffu nowszego od audytu;
   - `CHANGES_REQUESTED`, `AUDIT_PASSED` i `DONE` wymagają audytu co najmniej
     tak nowego jak najnowszy handoff.
2. Statusy zależności:
   - statusy wykonywalne/terminalne wymagają wszystkich istniejących zależności
     w `DONE`;
   - `BLOCKED_BY_DEPENDENCIES` wymaga co najmniej jednej istniejącej,
     nieukończonej zależności;
   - `BLOCKED` pozostaje jawnym wyjątkiem, a unknown dependency nadal daje
     własny jednoznaczny błąd.
3. Parser Queue:
   - dokładnie jedna sekcja `## Queue`;
   - ścisły pięciokolumnowy header, separator i każdy body row;
   - kolejność dokładnie `1..N` bez luk i duplikatów;
   - `Depends on` to dokładnie `—` albo pełne, unikalne tokeny `RA-NNN`;
   - błędy wskazują linię i offending value;
   - header/separator wymagają zewnętrznych pipe'ów, separator ma co najmniej
     trzy myślniki na komórkę z opcjonalnym wyrównaniem.

Lokalna weryfikacja zmian jest zielona:

- `pnpm exec prettier --check scripts/workflow/validate.ts test/workflow/validate.test.ts`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm exec vitest run test/workflow/validate.test.ts` — `82/82` testów.
- `pnpm run typecheck`, `pnpm run test` (`84/84`), `pnpm run build` i
  `pnpm run workflow:validate` — exit `0`.
- Zbiorcze `pnpm run check` w bieżącym katalogu zatrzymało się wyłącznie na
  ignorowanym, lokalnym `.claude/settings.local.json`; pliku nie ma w Git i nie
  należy go modyfikować. Wiążący pełny gate będzie uruchomiony z czystego
  archiwum commita.

## Decyzja o runnerze Bedrock

OpenCode jest obecnie preferowany zamiast Claude CLI. Przy krótkich,
jednoznacznych zadaniach kończył pracę w około 1–3 minuty i nie wpadał w serię
`ECONNRESET`/API resetów obserwowaną w Claude CLI. Używany model:

`amazon-bedrock/us.anthropic.claude-opus-4-8`

Sprawdzony wzorzec wywołania:

```sh
opencode run --auto --variant low \
  --model 'amazon-bedrock/us.anthropic.claude-opus-4-8' \
  '<jedno wąskie zadanie, konkretne pliki, testy i warunek STOP>'
```

`--auto` usuwa interaktywne pytania o permissions, więc wolno go używać tylko
w zaufanym repo i z wąskim promptem. Nie uruchamiać równolegle kilku writerów
dla `RA-001`; wcześniejsze trzy sesje Claude powodowały resety API. Szeroki
prompt również wydłużał pracę — zadania należy podawać sekwencyjnie.

Statystyki OpenCode:

```sh
opencode stats --days 1 --models --project ''
opencode stats --days 1 --models
```

Dzienne użycie wszystkich uruchomień zapisuje `docs/BEDROCK_USAGE.txt`.

## Następne kroki

1. Zacommitować zreviewowaną implementację, testy, dokumentację i pliki stanu.
2. Uruchomić pełny clean-archive gate na dokładnym
   Node `24.19.0` i pnpm `10.26.1`.
3. Implementer tworzy `HANDOFF-07`, przełącza `RA-001` na
   `AWAITING_AUDIT`, uruchamia validator, commit i STOP.
4. Codex wykonuje niezależny `AUDIT-07`. Przy findings wracamy do wąskich
   poprawek OpenCode; przy `PASS` audytor ustawia `AUDIT_PASSED`.
5. Implementer finalizuje `RA-001` jako `DONE` i aktualizuje status zależnego
   `RA-002` zgodnie z validatorem, ale nie rozpoczyna RA-002.

Najbliższy prompt dla implementera powinien obejmować wyłącznie krok 1: bez
edycji treści, commit dokładnie jawnie wymienionych sześciu plików i STOP.

## Ustawienia koordynatora

Domyślny reasoning effort Codex zmieniono z `xhigh` na `high` w
`~/.codex/config.toml`; ustawienie obowiązuje nowe sesje. Nie zmienia modelu ani
effortu już uruchomionego procesu.
