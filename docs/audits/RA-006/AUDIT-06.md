# RA-006 — Audit 06

## Metadata

- Task: `RA-006`
- Audytowany handoff: `docs/handoffs/RA-006/HANDOFF-06.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja pozostaje w working tree
- Werdykt: `PASS`

## Podsumowanie

Remediacja zamyka HIGH-23. Każda generacja socketu ma odrębną epokę kolejki,
drenera i flagi zatrzymania. Wynik starego `onDispatch` jest po `await` odrzucany
przez fencing tożsamości epoki i numeru generacji, zanim może zmienić watermark,
kolejkę, `halted`, log błędu albo socket nowej sesji. Nie pozostały findingi klasy
BLOCKER, HIGH ani MEDIUM.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Ten sam outbox event nie tworzy dwóch wiadomości ani threadów | PASS | Pełne testy dispatcher/receipt oraz real-PG bez regresji. |
| 2. Nieautoryzowany user/guild/channel jest ignorowany i audytowany bez danych | PASS | Test autoryzacji i real-PG denial audit przechodzą. |
| 3. Dwa cases mogą prowadzić niezależne rozmowy równolegle | PASS | Testy izolacji i współbieżności przechodzą. |
| 4. Wiadomości jednego case zachowują kolejność po retry/reconnect | PASS | Per-generation `DispatchEpoch`; niezależne probe success/failure zachowują świeże `s=2`. |
| 5. Decision button jest związany z decision ID i checkpoint revision | PASS | Testy kontraktu `custom_id` przechodzą bez regresji. |
| 6. `/stop` dotyczy wyłącznie wskazanego case | PASS | Testy intake i thread-to-case przechodzą bez regresji. |

## Zamknięcie HIGH-23

- Lokalizacja: `apps/discord-bot/src/gateway-session.ts:88-117`, `:217-224`,
  `:308-399`.
- `#connect` tworzy nowy `DispatchEpoch` dla każdej generacji; nowa sesja nie
  współdzieli kolejki, `draining` ani `halted` ze starym drenerem.
- `#drainDispatch(epoch)` sprawdza `#isCurrent(epoch)` przed pracą, przed kolejną
  iteracją oraz po obu możliwych wynikach `await onDispatch`.
- Stary sukces nie aktualizuje `lastProcessedSeq` ani nie przesuwa nowej kolejki.
  Stary błąd nie ustawia `halted`, nie emituje bieżącego failure i nie wywołuje
  `#forceResume()` na nowym sockecie.
- Fencing działa także między `onClose` a następnym `#connect`, ponieważ zamknięcie
  natychmiast zwiększa `#generation`.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | lint/format/typecheck; 39/39 plików i 579/579 testów; build 21/21; workflow OK; diff clean. |
| Exact stale-success probe | 0 | new READY → old success → new `s=2`: `fresh=[2]`, socket otwarty, 0 duplicate/failure. |
| Exact stale-failure probe | 0 | new READY → old failure → new `s=2`: `fresh=[2]`, socket otwarty, 0 duplicate/failure. |
| Code/caller inspection | 0 | Sprawdzono pełny lifecycle, composition root i produkcyjny handler inbound. |

Probe audytora wykonywał dokładną kolejność z AUDIT-05: old `s=100` in-flight →
reconnect → `INVALID_SESSION false` → new `READY s=1` → old success/failure →
new `s=2`. W obu wariantach nowe zdarzenie zostało zastosowane, a nowy socket
nie został zamknięty.

Kontrolowane pliki miały SHA-256:

- `gateway-session.ts`: `43a405592ed58ef7704bb98d0933e24ff2b5621547c310ba0aec820af7a04efc`
- `gateway-session.test.ts`: `9b2f8069b1871086e69fbb0e6312fc739cabba3c148e6d9aae1377019b424fc8`
- `HANDOFF-06.md`: `18b4cf234710c888cdfc5ff663abc5ec3f36d8bb20384a3bff18de3d50eeab63`

## Uwagi nieblokujące

- Repo deklaruje Node `24.19.0`, natomiast lokalna bramka działała na `25.2.1` i
  emitowała ostrzeżenie `engines`; wszystkie wymagane kontrole zakończyły się 0.

## Uzasadnienie werdyktu

HIGH-23 jest usunięty zarówno w kodzie, jak i w niezależnym odtworzeniu wyścigu.
Wcześniej zamknięte findingi nie uległy regresji, wszystkie kryteria RA-006 mają
dowody, a pełna bramka z realnym PostgreSQL przechodzi.
