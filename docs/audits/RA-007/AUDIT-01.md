# RA-007 — Audit 01

## Metadata

- Task: `RA-007`
- Audytowany handoff: `docs/handoffs/RA-007/HANDOFF-01.md`
- Audytor: Sol, rola `AUDITOR`
- Implementer model/transport: `GPT-5.6 Luna / medium`
- Work-units plan: `docs/work-units/RA-007/WORK_UNITS.md`, revision `03`
- Data: 2026-08-20
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Zakres funkcjonalny i standardowa macierz 89 testów przechodzą, ale dwa
adversarialne przypadki łamią kryteria taska. Anulowanie publicznego streamu może
pozostać nierozstrzygnięte na zawsze podczas cleanupu providera. Ponadto
structured tool/repair loop usuwa metadane wszystkich pośrednich completion,
pozostawiając wyłącznie finalny request ID i usage. `PASS` nie jest dozwolony.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, `RA-007.md`, plan work units, handoff,
  `AUDIT_CHECKLIST.md`, odpowiednie sekcje `MASTER_PLAN.md`.
- Sprawdzony diff/commity: pełny diff od
  `7b68cc45e5aeff88d02296b38692a054dbc985d8` do `d6b8768`.
- Uruchomione kontrole: build contracts, 89 testów pakietu, typecheck, build,
  credential scan, dwa niezależne probe adversarial.
- Potwierdzenie: audytor nie edytował ocenianego kodu implementacji.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Brak server-side conversation memory | PASS | pełne `messages` w każdym request |
| 2. Pełna identity i usage przy każdym completion | FAIL | MEDIUM-02: zachowany tylko finalny repair |
| 3. Invalid schema repair bez ponownego tools | PASS | historia zachowana, tools absent, side effect raz |
| 4. Cancel przerywa stream i daje jednoznaczny status | FAIL | HIGH-01: publiczna promise nadal pending |
| 5. Retry nie powtarza tool side effectu | PASS | adversarial counters i granica retry transportu |
| 6. Model/tool limits dają kontrolowany błąd | PASS | typed timeout/cancel/tool-limit tests |

## Findingi

### HIGH-01 — Cancellation może zawisnąć na `iterator.return()`

- Lokalizacja: `packages/bedrock-runtime/src/stream.ts:96-99`.
- Dowód: kontrolowany iterator rozpoczął blokujące `next()`, a jego `return()`
  zwracał nigdy nierozstrzyganą promise. Po abort `return()` został wywołany raz,
  lecz po 25 ms wynik `converseStream()` nadal miał stan `STILL_PENDING` zamiast
  `RuntimeCancelledError`.
- Wpływ: cancel nie pozostawia jednoznacznego statusu runu; worker może wisieć
  bez końca na cleanupie providera. Odrzucenie `return()` może też nadpisać
  właściwy błąd cancellation/transportu.
- Wymagana zmiana: cleanup iteratora ma być best-effort, wywołany najwyżej raz,
  ale nie może opóźniać ani zastępować wyniku głównej operacji. Dodać testy dla
  `return()` pending oraz rejecting, bez unhandled rejection.

### MEDIUM-02 — Tool/repair loop gubi metadane pośrednich model completion

- Lokalizacja: `packages/bedrock-runtime/src/tool-loop.ts:60-82`,
  `structured-completion.ts:104-137`, `runtime.ts:161-180`.
- Dowód: trzy poprawnie zakończone calls miały kolejno request IDs
  `tool`, `invalid`, `repair` i usage `1`, `2`, `3`. Publiczny wynik zawierał
  wyłącznie `requestId=repair`, `usage.totalTokens=3`, `transportCalls=3` i nie
  zawierał per-completion trace.
- Wpływ: caller nie może zapisać identity/usage każdego model call zgodnie z
  RA-007 AC2 i `MASTER_PLAN.md` §3.3; koszt tool turnu i wadliwego outputu znika.
- Wymagana zmiana: dodać provider-neutralną, beztreściową listę metadanych model
  completion i propagować ją przez text, stream, tool loop, repair oraz publiczny
  runtime. Każdy element zachowuje model, usage, request ID i liczbę prób danego
  zakończonego calla. Test repair musi dowodzić kolejności wszystkich trzech.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| contracts build + pełne testy + typecheck + build | 0 | 11/11 plików, 89/89 testów |
| `git diff --check` | 0 | clean |
| credential/source scan | 0 | tylko testowe canaries i bezpieczne nazwy pól |
| hanging `iterator.return()` probe | 0 procesu | `STILL_PENDING`, `return()` wywołane raz |
| three-completion metadata probe | 0 procesu | widoczny tylko finalny repair, brak trace |

Raporty Luny i unit gates nie zastępują powyższych, ponowionych kontroli.

## Ryzyka przekrojowe

- Security/privacy: nie znaleziono wycieku credentials ani surowego błędu SDK.
- Idempotencja/recovery: transport retry nie obejmuje executora; bez regresji.
- Współbieżność: HIGH-01 może zatrzymać zasób workera po cancel.
- Observability: MEDIUM-02 zaniża usage/koszt wielu calls.
- Kompatybilność: fix ma być addytywny na publicznym wyniku runtime.

## Fix work units po `CHANGES_REQUIRED`

1. `RA-007-WU-09A` — non-blocking stream cleanup z testem pending/rejecting
   `iterator.return()`.
2. `RA-007-WU-09B` — beztreściowy per-completion metadata trace przez wszystkie
   tryby, tool loop i repair.

## Uzasadnienie werdyktu

Oba findingi są reprodukowalne bez timing luck i bez sieci. HIGH-01 łamie
jednoznaczność cancellation, a MEDIUM-02 wprost uniemożliwia spełnienie wymogu
rejestracji usage każdego completion. Zakres jest naprawialny w dwóch małych
unitach i nie wymaga decyzji właściciela.
