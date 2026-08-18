# RA-001 — Audit 03

## Metadata

- Task: `RA-001`
- Audytowany handoff: `docs/handoffs/RA-001/HANDOFF-03.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-18
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Poprawka zamyka trzy reprodukcje z AUDIT-02: dwie deklaracje werdyktu,
powtórzony token oraz audytowy `BLOCKED` z werdyktem `PASS` są teraz odrzucane.
Commit `161bb31` przechodzi pełny clean-archive gate na dokładnym Node `24.19.0`:
32/32 testy i 20/20 buildów bez cache. Nie można jednak wydać `PASS`, ponieważ
obecność dowolnego historycznego audytu jest traktowana jako źródło bieżącego
`BLOCKED`. Legalny Decision Request utworzony podczas napraw po wcześniejszym
`CHANGES_REQUIRED` jest przez to odrzucany.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, Master Plan, protokół wykonania i audytu,
  checklist audytora, RA-001, AUDIT-01/02 i HANDOFF-01/02/03.
- Sprawdzony diff/commity: `d04a305..161bb31`, w szczególności commit fixu
  `9ac1116f09ccfd3fa9b9f1223f92902ca671a361` i follow-up docs `161bb31`.
- Uruchomione kontrole: testy validatora, sześć fixture'ów adwersarialnych,
  clean `git archive HEAD`, frozen install i pełny gate na Node `24.19.0`, skan
  sekretów wszystkich tracked blobów, Docker Compose, Git integrity i ignore set.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Clean checkout instaluje się jednym poleceniem | PASS | `git archive 161bb31` do pustego katalogu; Node `v24.19.0`, pnpm `10.26.1`; frozen install exit 0. |
| 2. Root lint/typecheck/test/build są deterministyczne | PASS | Clean archive `pnpm run check` exit 0; 32/32 testy, 20/20 typecheck i build, 0 cache. |
| 3. Wszystkie app/package manifests są w workspace | PASS | 21 projektów pozostaje poprawnie wykrywanych. |
| 4. CI używa lockfile i nie wymaga sekretów | PASS | Przypięty obraz i pnpm, frozen install, brak credential variables. |
| 5. Strict TS i dependency boundaries mają failing fixtures | PASS | Oba guardraile przechodzą w clean archive. |
| 6. Brak credentiali i danych lokalnych w Git | PASS | Skan 133 blobów: 0 content findings, 0 podejrzanych nazw; 0 tracked artefaktów runtime/build. |
| 7. Validator zachowuje wszystkie legalne stany workflow | FAIL | Proceduralny `BLOCKED` po wcześniejszym `CHANGES_REQUIRED` i nowym HANDOFF-02 z Decision Request jest odrzucany jako „expected BLOCKED” dla starego audytu. |

## Findingi

### MEDIUM — Historyczny audyt jest błędnie traktowany jako provenance bieżącego `BLOCKED`

- Lokalizacja: `scripts/workflow/validate.ts:52`,
  `scripts/workflow/validate.ts:57`, `scripts/workflow/validate.ts:292`,
  `test/workflow/validate.test.ts:345`.
- Dowód: fixture reprezentujący poprawny przebieg
  `HANDOFF-01 -> AUDIT-01 CHANGES_REQUIRED -> HANDOFF-02 Decision Request ->
  status BLOCKED` zwraca `ok: false` i błąd: latest audit verdict is
  `CHANGES_REQUIRED` (expected `BLOCKED`). Jednocześnie proceduralny `BLOCKED`
  bez żadnego audytu zwraca `ok: true`, co potwierdza, że jedynym rozróżnieniem
  jest warunek `audits > 0`, a nie źródło bieżącego przejścia.
- Wpływ: po pierwszym cyklu review implementer nie może legalnie zatrzymać się z
  pytaniem decyzyjnym. `workflow:validate` blokuje wymagany przez protokół handoff,
  mimo że nowa blokada nie pochodzi od audytora. To przerywa trwały one-shot
  continuation loop i może zmuszać agenta do pominięcia pytania albo pozostawienia
  repo w stanie niewalidowalnym.
- Wymagana zmiana: provenance bieżącego `BLOCKED` musi być jawne albo wynikać z
  deterministycznej kolejności najnowszych artefaktów, a nie z istnienia
  jakiegokolwiek audytu. Akceptowalne rozwiązanie może np. wymagać najnowszego
  handoffu z jednoznacznym markerem/sekcją Decision Request dla blokady
  proceduralnej oraz werdyktu `BLOCKED` w najnowszym audycie dla blokady
  audytowej. Należy zachować fail-closed dla nieudokumentowanego lub
  niejednoznacznego `BLOCKED`. Dodać co najmniej testy: proceduralny blok przed
  audytem; proceduralny blok po wcześniejszym `CHANGES_REQUIRED`; audytowy blok;
  stary audyt bez nowszego Decision Request; konflikt obu źródeł.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm exec vitest run test/workflow/validate.test.ts` | 0 | 30/30 testów validatora. |
| Adwersarialny harness sześciu stanów | 0 | Trzy obejścia AUDIT-02 odrzucone; proceduralny bez audytu i audytowy `BLOCKED` zaakceptowane; proceduralny po starym audycie błędnie odrzucony. |
| `git archive HEAD` do pustego katalogu | 0 | 133 pliki z commita `161bb31`. |
| Exact Node/pnpm frozen install + `pnpm run check` w archiwum | 0 | Node `v24.19.0`, pnpm `10.26.1`; 32/32 testy, 20/20 buildów, 0 cache; workflow OK. |
| Skan wzorców sekretów na `git ls-tree -r HEAD` | 0 | 133 bloby; 0 content findings i 0 suspicious filenames. |
| `git ls-files` dla runtime/build/cache/log pathspecs | 0 | 0 śledzonych artefaktów. |
| `docker compose config --quiet` | 0 | Konfiguracja poprawna. |
| `git fsck --full` | 0 | Repo integralne; brak remote; working tree był czysty przed audytem. |

## Ryzyka przekrojowe

- Security/privacy: wcześniejsze fail-open zostały zamknięte; tracked tree jest
  czyste. Nowy finding jest fail-closed, ale blokuje wymagany przepływ decyzji.
- Idempotencja/recovery: foundation pozostaje odtwarzalny z commita i lockfile.
- Współbieżność: bez zmian w tym zakresie.
- Observability: poza zakresem RA-001.
- Kompatybilność: poprawka provenance musi obsłużyć istniejący append-only układ
  `HANDOFF-NN`/`AUDIT-NN` i nie zmieniać historycznych dokumentów.

## Wymagane działania po `continue`

1. Zastąpić heurystykę `audits > 0` rzeczywistym, deterministycznym provenance
   bieżącej blokady i udokumentować kontrakt w protokole workflow.
2. Dodać test proceduralnego Decision Request po wcześniejszym
   `CHANGES_REQUIRED` oraz wymienione testy konfliktów i brakujących dowodów.
3. Zachować wszystkie testy zamykające wielokrotne werdykty i audytowy
   `BLOCKED`; nie osłabiać fail-closed parsera.
4. Uruchomić full gate na Node `24.19.0`, przeskanować staged/tracked content,
   zapisać poprawkę w lokalnym Git i sprawdzić clean archive finalnego commita.
5. Utworzyć `HANDOFF-04`, ustawić RA-001 na `AWAITING_AUDIT` i zatrzymać się bez
   rozpoczynania RA-002.

## Uzasadnienie werdyktu

Kod jest reprodukowalny, a wszystkie wcześniejsze obejścia bramki zostały
zamknięte. Pozostała luka odrzuca jednak legalny i ważny przebieg Decision
Request po wcześniejszym audycie — dokładnie mechanizm wymagany do rozmowy z
właścicielem między one-shot runami. Jest to naprawialny finding MEDIUM w
zakresie RA-001, więc zgodnie z AGENTS.md werdykt to `CHANGES_REQUIRED`.
