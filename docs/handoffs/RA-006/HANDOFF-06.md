# RA-006 — Handoff 06

## Metadata

- Task: `RA-006`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: OpenCode, rola IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja w working tree
- Zakres: remediacja `AUDIT-05` (wyłącznie HIGH-23)

## Wynik

Zamknięto jedyny blokujący finding `AUDIT-05` (HIGH-23) bez zmiany zakresu innych
tasków ani wcześniejszych poprawek. Kolejka dispatch i drener są teraz związane z
generacją/epoką socketu. Stary handler kończący się PO reconnect →
`INVALID_SESSION false` → nowym `READY` nie modyfikuje już kolejki, watermarku,
flagi `halted` ani socketu nowej generacji i nie może zamknąć nowego socketu.
Numeryczny Resume (HIGH-19) i pozostałe poprawki AUDIT-04 nietknięte.

## Zrealizowany zakres i uzasadnienie

- HIGH-23 (`gateway-session.ts`): wprowadzono per-generacyjną `DispatchEpoch`
  (`queue`, `draining`, `halted`, `generation`). `#connect` mintuje ŚWIEŻĄ epokę
  wraz z nową generacją, więc każdy socket ma własny stan drenera/kolejki (wprost
  wymagane przez AUDIT-05). `#drainDispatch(epoch)` operuje wyłącznie na PRZEKAZANEJ
  epoce (lokalna referencja kolejki), a po każdym `await onDispatch` sprawdza
  `#isCurrent(epoch)` (identyczność obiektu epoki ORAZ zgodność `generation ===
  #generation`). Gdy epoka nie jest już bieżąca, staly handler — zarówno przy
  SUKCESIE, jak i BŁĘDZIE — natychmiast `return` bez: (a) zapisania
  `lastProcessedSeq`, (b) ustawienia `halted`/wyczyszczenia kolejki, (c) wywołania
  `#forceResume()` (czyli bez zamknięcia nowego socketu), (d) `shift()` na nowej
  kolejce (shiftuje tylko własną, martwą). `#isCurrent` zwraca `false` także w
  oknie między `onClose`/`stop()` a kolejnym `#connect`, bo obie te ścieżki bumpują
  `#generation`. Watermark `#lastProcessedSeq` pozostaje session-scoped (potrzebny
  do RESUME), więc go NIE przeniosłem do epoki; chroni go wyłącznie bramka
  `#isCurrent` przed zapisem starego handlera. Wszystkie miejsca resetujące dawną
  `#dispatchQueue` (`INVALID_SESSION false`, `reidentify` close, fail-closed
  `#resume`) czyszczą teraz `#epoch.queue`.

## Zmiany

| Ścieżka | Co | Finding |
|---|---|---|
| `apps/discord-bot/src/gateway-session.ts` | `DispatchEpoch` per generacja; `#drainDispatch(epoch)` + `#isCurrent(epoch)` fencing po `await`; reset `#epoch.queue` w INVALID_SESSION/reidentify/resume | HIGH-23 |
| `apps/discord-bot/test/gateway-session.test.ts` | 2 testy wyścigu: staly handler SUCCESS oraz FAILURE po reconnect→INVALID_SESSION false→new READY | HIGH-23 |

## Kryteria akceptacji

| Kryterium | Status | Dowód |
|---|---|---|
| 1. Brak duplikatów | PASS | brak regresji |
| 2. Nieautoryzowany bez danych | PASS | brak regresji |
| 3. Dwa cases równolegle | PASS | brak regresji |
| 4. Kolejność po retry/reconnect | PASS | HIGH-23: staly handler nie zatruwa watermarku ani nie gubi s=2 nowej sesji |
| 5. Decision button ID/rev | PASS | bez zmian |
| 6. `/stop` tylko wskazany case | PASS | bez zmian |

## Testy i kontrole

| Komenda | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS (realny PG na :5433) |
| test (vitest) | 0 | 39/39 plików, 579/579 testów (+2 nowe HIGH-23) |
| build (turbo) | 0 | 21/21 |
| `pnpm workflow:validate` | 0 | `OK — 26 tasks` |
| `git diff --check` | 0 | clean |

Weryfikacja skuteczności testów: tymczasowe wyłączenie każdej z dwóch bramek
`#isCurrent` (wariant success i failure) powoduje FAIL odpowiedniego testu —
success: staly zapis `lastProcessedSeq=100` deduplikuje świeże `s=2/3` (utrata
eventu); failure: staly błąd `halted`+`#forceResume()` zamyka nowy socket. Po
przywróceniu bramek oba testy przechodzą.

## Bezpieczeństwo i dane

- Izolacja epok: nowa generacja ma własny `queue`/`draining`/`halted`; stary
  drener po `await` dotyka wyłącznie własnej, odłączonej epoki.
- Recovery: watermark nowej sesji seedowany z `READY`; s=2 nowej sesji stosowane
  dokładnie raz w obu wariantach wyścigu, nowy socket pozostaje otwarty.
- Sekrety: brak nowych logów; token nadal nigdy nie trafia do loggera.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Gotowe: pełna remediacja AUDIT-05 (HIGH-23), cała bramka zielona na realnym PG.
- Nie robić przed audytem: nie zaczynać kolejnego taska, nie zmieniać implementacji.
- Po `continue` (gdyby audyt zażądał zmian): findingi nowego audytu i ścieżka
  `apps/discord-bot/src/gateway-session.ts` + jej testy.
