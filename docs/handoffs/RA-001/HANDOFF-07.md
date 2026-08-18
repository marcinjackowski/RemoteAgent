# RA-001 — Handoff 07

## Metadata

- Task: `RA-001`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER (OpenCode, Claude Opus 4.8)
- Data: 2026-08-18
- Poprzedni handoff: `docs/handoffs/RA-001/HANDOFF-06.md`
- Audyt naprawiany: `docs/audits/RA-001/AUDIT-06.md` (werdykt `CHANGES_REQUIRED`)
- Końcowy commit (fix): `f513b9604573a365434627084ec242d56de73f17` na `main`
  (bez remote, bez push).

## Wynik

Zamknięto trzy findingi z AUDIT-06 (dwa HIGH, jeden MEDIUM). Validator egzekwuje
teraz causality rewizji handoff/audit dla wszystkich statusów artefaktowych,
dwukierunkowe bramkowanie statusu zależności z jawnym wyjątkiem `BLOCKED` oraz
zamkniętą gramatykę sekcji `Queue`. Bramka sterująca pracą agentów nie
przepuszcza już niezaudytowanej pracy, nie uruchamia tasku przed jego
prerequisite i nie akceptuje malformed/niejednoznacznej kolejki.

## Zrealizowany zakres (remediacja AUDIT-06)

### HIGH — Nowszy handoff mógł zostać zatwierdzony przez starszy `PASS`

- `scripts/workflow/validate.ts`: dodano porównanie rewizji najnowszego handoffu
  z najnowszym audytem. `AWAITING_AUDIT` wymaga handoffu nowszego od audytu;
  `CHANGES_REQUESTED`, `AUDIT_PASSED` i `DONE` wymagają audytu nie starszego niż
  najnowszy handoff. Stale `PASS` po nowym handoffie jest twardym błędem.
- Dodano pozytywne i negatywne testy causality, w tym aktualny układ
  `HANDOFF-06`/`AUDIT-05` dla `AWAITING_AUDIT` oraz stale `PASS`.

### HIGH — Statusy robocze nie respektowały zależności tasków

- `scripts/workflow/validate.ts`: po zbudowaniu mapy tasków egzekwowany jest
  invariant zależności w obu kierunkach. Task z nierozstrzygniętą zależnością nie
  może wejść w stan wykonywalny/terminalny; `BLOCKED_BY_DEPENDENCIES` wymaga co
  najmniej jednej zależności niebędącej `DONE`. `BLOCKED` jest jawnie dopuszczony
  jako blokada z dowolnego stanu (wyjątek udokumentowany).
- Dodano macierz pozytywną i negatywną dla tasków bez zależności, z częścią i
  ze wszystkimi zależnościami `DONE`.

### MEDIUM — Malformed wiersze, zależności i numery kolejności

- `scripts/workflow/validate.ts`: sekcja `Queue` walidowana zamkniętą gramatyką.
  Każdy wiersz danych musi być parsowalny, `Order` dodatni, unikalny i ciągły
  `1..N`; komórka dependencies to `—` albo lista pełnych `RA-NNN` bez
  śmieci/duplikatów. Zachowano wykrywanie missing task file, unknown dependency
  i cyklu.
- Dodano fixture'y: duplicate/zero order, malformed dependency i dropped row.

### Kontrakt wykonania

- `docs/workflow/EXECUTION_AND_AUDIT.md` i `docs/workflow/AUDIT_CHECKLIST.md`
  zaktualizowane: opisują causality rewizji, dwukierunkowe bramkowanie
  zależności z wyjątkiem `BLOCKED` oraz zamkniętą gramatykę `Queue`.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `scripts/workflow/validate.ts` | causality rewizji, dwukierunkowe gating zależności z wyjątkiem `BLOCKED`, zamknięta gramatyka `Queue` | AUDIT-06 findingi HIGH×2, MEDIUM |
| `test/workflow/validate.test.ts` | regresje causality, zależności i parsera kolejki | AUDIT-06 wymagane regresje |
| `docs/workflow/EXECUTION_AND_AUDIT.md` | udokumentowany kontrakt causality/zależności/gramatyki | AUDIT-06 „jawny, udokumentowany kontrakt” |
| `docs/workflow/AUDIT_CHECKLIST.md` | dopasowanie checklisty do nowych invariantów | AUDIT-06 |
| `docs/audits/RA-001/AUDIT-06.md` | dołączony artefakt audytora | append-only ślad audytu |
| `docs/BEDROCK_USAGE.txt` | dzienny rejestr tokenów i kosztu Bedrock (OpenCode + Claude CLI) z zastrzeżeniami pomiaru i limitem OpenCode `50.00 USD` na 2026-08-18 | żądanie właściciela: śledzenie zużycia/kosztu i twardej granicy budżetu |
| `docs/RA-001_SESSION_STATE.md` | trwały stan sesji: cel, ograniczenia, stan Git/workflow, decyzja o runnerze i runbook wznowienia | żądanie właściciela: wznowienie niezależne od kontekstu rozmowy |
| `docs/handoffs/RA-001/HANDOFF-07.md` | ten handoff | bramka audytowa |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Instalacja jednym poleceniem z czystego checkoutu | PASS | clean `git archive` commitu `f513b96`; frozen install exit 0 na Node `v24.19.0`, pnpm `10.26.1` |
| 2. Deterministyczne `lint`/`typecheck`/`test`/`build` z roota | PASS | `pnpm run check` exit 0; typecheck 20/20 i build 20/20 (0 cached); `workflow:validate OK — 26 tasks` |
| 3. Każdy app/package ma manifest i jest widoczny dla workspace | PASS | 20 build-tasków; workspace poprawnie wykrywany |
| 4. CI używa lockfile i nie pobiera sekretów | PASS | frozen install, dokładne wersje; brak credential variables |
| 5. Strict TS i boundaries mają celowo failing fixture/test | PASS | guardrails zielone |
| 6. Brak skopiowanych credentiali/danych | PASS | archiwum commitu bez sekretów |
| 7. `workflow:validate` odrzuca niejednoznaczne artefakty i stany | PASS | 82 testy validatora / 84 łącznie; causality, dwukierunkowe zależności i zamknięta gramatyka kolejki odrzucane |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| frozen install (clean archive) | 0 | Node `v24.19.0`, pnpm `10.26.1` |
| `pnpm run check` (clean archive) | 0 | 84 testy (82 validator + 2 guardrails); typecheck 20/20 i build 20/20 (0 cached); `workflow:validate OK — 26 tasks` |

Dowody dostarczone niezależnie przez koordynatora na czystym `git archive`
commitu `f513b96`.

## Bezpieczeństwo i dane

- Sekrety: brak w archiwum commitu `f513b96`.
- Git: repo lokalne, bez remote i bez push.
- Side effecty: `workflow:validate` read-only; zmiana dotyczy tylko walidacji.
- Dane zewnętrzne: brak integracji w zakresie RA-001.

## Znane ograniczenia i ryzyka

- Lokalny plik `.claude/settings.local.json` jest ignorowany i nieobecny w
  archiwum; spowodował jedynie nieautorytatywny, roboczy błąd Prettiera w
  workspace. Wiążący gate na clean archive commitu `f513b96` przechodzi bez
  tego pliku.
- Weryfikacja wykonana na dokładnym runtime Node `v24.19.0` / pnpm `10.26.1`
  przeciw czystemu archiwum commitu, zgodnie z profilem CI.

## Otwarte pytania

- Brak blokujących.

## Stan dla następnego agenta

- Co jest gotowe: trzy findingi z AUDIT-06 naprawione; 82 testy validatora / 84
  łącznie zielone na clean archive; commit fix `f513b96` na `main`.
- Czego nie robić przed audytem: nie rozpoczynać RA-002; nie dodawać
  remote/push; nie zmieniać kontraktów/wersji bez ADR.
- Dla audytora: potwierdzić causality rewizji handoff/audit, dwukierunkowe
  gating zależności z wyjątkiem `BLOCKED` oraz zamkniętą gramatykę `Queue` na
  clean archive commitu `f513b96` (Node `v24.19.0`, pnpm `10.26.1`).
