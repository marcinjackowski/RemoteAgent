# RA-019 — Audit 01

## Metadata

- Task: `RA-019`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-019/HANDOFF-01.md`
- Data: `2026-08-21`
- Zakres diffu: `98b85c8..d3d1d04`
- **Werdykt: `PASS`**

## Podstawa werdyktu

`Audit focus`: account isolation, cursor correctness, watch renewal,
privacy/retention, MIME edge cases i odporność na prompt injection. Sprawdziłem
każde osobno, plus sondy adwersarialne. Sondy dały dwa findingi — **szósty task z
rzędu**.

## Kryteria akceptacji — każde sprawdzone osobno

| # | Werdykt | Jak sprawdzone |
|---|---|---|
| 1 | PASS | asercja na `startHistoryId` faktycznie przekazanym do API: `"500"` (stored), nie `"700"` (notified). Mutacja na start z notification wywala test |
| 2 | PASS | osobno: nakładające się okno historii (cursor cofnięty ręcznie, by wymusić replay) i notification starszy od cursora — drugi nie wykonuje **żadnego** wywołania API |
| 3 | PASS | prywatne wygasłe + służbowe zdrowe → **dokładnie jedna** rejestracja, i to dla prywatnego (asercja na nagranych wywołaniach, nie na wartości zwrotnej); `EXPIRING` istnieje, więc odnowienie wyprzedza przerwę w dostawie |
| 4 | PASS | notification pominięty całkowicie; reconciliation replayuje z cursora i znajduje `lost-msg`; drugi przebieg nie re-emituje |
| 5 | PASS | pięć niezależnych ścieżek: nieznany alias, odpowiedź kłamiąca o koncie, obcy cursor, obcy watch, wspólny kanał w rejestrze. Plus rozdzielne seen-sety |
| 6 | PASS | purpose wymagany (odmowa **przed** wywołaniem API — asercja na braku wywołań); redakcja body i nazwy załącznika; treść załącznika domyślnie off; bound + `truncated` |
| 7 | PASS | `resynced_from` niesie cursor, który zawiódł; resync także z reconciliation; pierwszy przebieg jako **zapisany** resync, nie cicha luka |

## Findingi

### Finding 1 — nazwa załącznika niosła sekret nieredagowany (MEDIUM, **naprawiony**)

Sonda:

```text
attachment FILENAME carries a token unredacted? !! YES
```

Body było czyste, treść załącznika nigdy nie czytana, a `glpat-....txt` przechodziło
dosłownie do rekordu jako metadana. Nazwa pliku jest tekstem kontrolowanym przez
nadawcę, a „trzymamy tylko metadane" nie jest powodem, by uznać ją za bezpieczną —
zwłaszcza że ten rekord idzie do kontekstu modelu.

**Naprawa.** Redakcja nazwy tym samym zestawem wzorców co body.

### Finding 2 — seen-set bez eviction (LOW, **naprawiony**)

Sonda odnotowała brak eviction. To realny, powolny wyciek pamięci: engine ma działać
tygodniami, a set rośnie o klucz na każdą zmianę.

**Naprawa.** Bound 10 000 kluczy per konto. Bezpieczne, bo forward-only cursor jest
główną obroną: klucz musi przeżyć tylko nakładające się okna Gmaila i crash-replay
przy tym samym cursorze — oba świeże z natury — a klucz sprzed miesiąca jest już
nieosiągalny. Test przepuszcza 20 zmian przez set o rozmiarze 5 i sprawdza **oba**
wymagania: każda realna zmiana nadal emitowana, świeże klucze nadal deduplikują.

### Probe'y bez findingu

- **`compareHistoryIds` na krawędziach**: `("","1") = -1`, `("0","0000") = 0`,
  `("9"×20, "1"+"0"×20) = -1`, `("10","9") = 1` — poprawne, w tym para przekraczająca
  2^53, gdzie `Number` daje równość;
- **ta sama wiadomość ponownie dodana pod nowym `history_id`** emituje się ponownie —
  i to jest **poprawne**: to realne re-add, nie duplikat. Warto zapisać, bo naiwna
  deduplikacja po `message_id` zgubiłaby to zdarzenie;
- **`routeGmailEvent` nie przepisuje pól untrusted** do trasy.

### Świadoma decyzja, którą potwierdzam

`gmailMessageSummary` **niesie** surowy subject/from/snippet, nieredagowane, przypięte
do `UNTRUSTED_DATA`. Uznaję to za właściwe: te pola są sensem zdarzenia (użytkownik
musi zobaczyć temat maila), a redakcja tematu uczyniłaby powiadomienie bezużytecznym.
Granicą jest **etykieta i bound**, nie redakcja. Redakcja obowiązuje tam, gdzie treść
jest pobierana celowo (body, nazwa załącznika), bo tam wielkość i ryzyko są inne.

Ten podział musi jednak zostać zrozumiany przez RA-021: `UNTRUSTED_DATA` jest
etykietą, nie sanityzacją, więc odporność na prompt injection w temacie maila należy
do warstwy promptu. Zapisane w handoffie jako ograniczenie, nie jako gwarancja.

Brak otwartych findingów BLOCKER/HIGH/MEDIUM na moment werdyktu.

## Kontrole wykonane samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/connector-gmail/test` | 0 | 31/31 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | 1419/1419, 125 plików |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| 7 mutacji | — | każda wykryta |
| sondy adwersarialne | — | **findingi 1 i 2** |

## Uwaga o stabilności bramki

W trakcie tej bramki `workspace-runner/test/recovery.integration.test.ts` zawiódł w
**2 z 13** pełnych przebiegów, potem przeszedł dziesięć razy z rzędu. Nie udało mi się
przechwycić komunikatu w sześciu celowych próbach.

Zapisałem to jako `CTF-012` **otwarte i niezdiagnozowane**, a nie jako „znany flake":
to inny test i inny objaw niż domknięte `CTF-003` i `CTF-007`, a jedno z tych dwóch
miało za sobą realny defekt produkcyjny. Nie mam prawa twierdzić, że jest
nieszkodliwy, bo nie znam jego trybu awarii.

**Nie blokuje RA-019:** dotyczy pakietu, którego ten task nie zmienia, a suite tego
pakietu jest zielona solo i w pełnym przebiegu. Ale raportowanie „całe repo zielone"
po jednym przebiegu jest od teraz słabszym twierdzeniem, niż było.

## Werdykt

- Werdykt: `PASS`

Siedem kryteriów spełnione i sprawdzone osobno. Jeden finding MEDIUM i jeden LOW
znalezione w tym audycie i naprawione z testami regresyjnymi przed werdyktem.

Status: `AUDIT_PASSED` → `DONE`. RA-020 pozostaje `READY` (niezależny).
