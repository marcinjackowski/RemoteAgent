# RA-006 — Audit 05

## Metadata

- Task: `RA-006`
- Audytowany handoff: `docs/handoffs/RA-006/HANDOFF-05.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

HIGH-20 oraz MEDIUM-21/22 są zamknięte: dowolny transport rejection jest
normalizowany bez credentiali, owner zapisuje prawdziwy terminal po expiry, a
legacy STARTED jest backfillowany. Numeric Resume po READY także działa. Pozostał
jednak jeden blokujący wyścig lifecycle: async drainer nie jest związany z
generacją socketu. Handler starej sesji może zakończyć się po `INVALID_SESSION` i
nowym `READY`, nadpisać watermark nowej sesji i spowodować utratę świeżych eventów.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Ten sam outbox event nie tworzy dwóch wiadomości ani threadów | PASS | Owner-fenced intenty i exact markers bez regresji. |
| 2. Nieautoryzowany user/guild/channel jest ignorowany i audytowany bez danych | PASS | Real-PG denial audit przechodzi. |
| 3. Dwa cases mogą prowadzić niezależne rozmowy równolegle | PASS | Testy izolacji/równoległości przechodzą. |
| 4. Wiadomości jednego case zachowują kolejność po retry/reconnect | FAIL | HIGH-23: stale async completion zatruwa watermark świeżej sesji i odrzuca jej event. |
| 5. Decision button jest związany z decision ID i checkpoint revision | PASS | Bez regresji. |
| 6. `/stop` dotyczy wyłącznie wskazanego case | PASS | Bez regresji. |

## Status findingów AUDIT-04

- HIGH-19: CZĘŚCIOWO ZAMKNIĘTY — Resume po READY ma poprawne `seq=1`, lecz
  HIGH-23 nadal łamie recovery na granicy starej i nowej sesji.
- HIGH-20: ZAMKNIĘTY — nowy allowlistowany error nie kopiuje dowolnych pól i
  zachowuje wyłącznie jawnie bezpieczne klasy retry.
- MEDIUM-21: ZAMKNIĘTY — real-PG expiry+safe failure kończy RETRYABLE, a
  expiry+success kończy SUCCEEDED z jedną kopią.
- MEDIUM-22: ZAMKNIĘTY — upgrade 021→022 konserwatywnie backfilluje legacy
  STARTED i zachowuje pozostałe statusy.

## Findingi

### HIGH-23 — Stary async drainer może zatruć watermark nowej sesji

- Lokalizacja: `apps/discord-bot/src/gateway-session.ts:189-204`, `:243-270`,
  `:299-337`.
- Dowód: socket callbacks są generation-fenced, ale element kolejki i
  `#drainDispatch()` nie przechowują generacji. `#connect`/`INVALID_SESSION`
  podmieniają wspólną kolejkę i watermark, podczas gdy stare `await onDispatch`
  nadal działa. Niezależny probe: stara sesja `READY s=99`, handler `s=100`
  zatrzymany; reconnect → `INVALID_SESSION false` → nowa sesja `READY s=1`;
  następnie stary handler kończy sukcesem i zapisuje `lastProcessedSeq=100`.
  Świeże `s=2` nowej sesji zostało zalogowane jako `gateway.dispatch_duplicate`.
  Wynik: `applied=[100]`, a event nowej sesji 2 nie został wykonany.
- Wpływ: wiadomość ownera, decision, approval lub `/stop` z nowej sesji może
  zostać bezpowrotnie utracone po reconnect/re-identify; bezpośrednie naruszenie
  AC4 i pierwotnego HIGH-13.
- Wymagana zmiana: związać każdy queued item/drain z generacją lub session epoch.
  Po każdym `await` stary drainer nie może modyfikować kolejki, watermarku,
  `halted` ani zamykać socketu nowszej generacji. Nowa generacja musi mieć własny
  drainer/queue albo deterministycznie zaczekać na zakończenie starego. Dodać test
  dokładnego wyścigu old in-flight → reconnect → INVALID_SESSION false → new
  READY → old success/failure → new s=2; oba warianty muszą zachować nowy event i
  nie zamknąć nowego socketu.

## Uwaga o teście HIGH-19

Test `gateway-session.test.ts:284-331` prawidłowo sprawdza numeric `d.seq`, ale po
`INVALID_SESSION false` sam ręcznie wstrzykuje dawny event do świeżej sesji.
Identify nie dowodzi replayu zdarzeń starej sesji, więc komentarz „nothing is
permanently lost” nie jest dowodem. Test HIGH-23 powinien sprawdzać rzeczywistą
izolację epochów i nie zakładać, że świeża sesja odtworzy stare eventy.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | 39/39 plików, 577/577 testów; build 21/21; workflow OK; diff clean. |
| Stale-drainer/new-session probe | 0 | `applied=[100]`; new `s=2` sklasyfikowane jako duplicate i utracone. |
| Code/test inspection | 0 | Queue/drainer nie ma generation/epoch; testy obejmują stale close, nie stale async completion. |

## Uzasadnienie werdyktu

Remediacja zamknęła bezpieczeństwo credentiali, terminal races i migrację, lecz
pozostały HIGH może usuwać inbound event po typowym reconnect/re-identify. Problem
jest lokalny i naprawialny w zakresie RA-006, dlatego task wraca do implementera.
