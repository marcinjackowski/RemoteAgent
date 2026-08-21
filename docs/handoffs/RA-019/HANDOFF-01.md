# RA-019 — Handoff 01

## Metadata

- Task: `RA-019`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Data: `2026-08-21`
- Bazowy commit: `98b85c8`
- Końcowy commit: `d3d1d04`
- Full-task verification: `pnpm vitest run packages/connector-gmail/test`

## Wynik

`@remoteagent/connector-gmail` przestał być szkieletem: rejestr dwóch kont, sync po
`historyId`, niezależne odnawianie `watch`, reconciliation dla utraconych
notification i dostęp do treści za polityką.

## Kryteria akceptacji

| # | Status | Dowód |
|---|---|---|
| 1. Notification z samym history ID odtwarza zmiany | PASS | replay startuje ze **stored cursor**, nie z notification (asercja na `startHistoryId` przekazanym do API) |
| 2. Duplicate/out-of-order nie duplikują | PASS | dwa niezależne mechanizmy testowane osobno: cursor tylko w przód + per-account seen-set |
| 3. Watch każdego konta odnawiany niezależnie, z health | PASS | prywatne wygasłe, służbowe zdrowe → **dokładnie jedna** rejestracja, dla prywatnego |
| 4. Lost notification odnalezione przez reconciliation | PASS | notification w ogóle nie dostarczony; zmiana i tak dociera |
| 5. Private nigdy nie trafia do SonderMind i odwrotnie | PASS | typ brandowany; kanał z **refa**, nie ze zdarzenia; odpowiedź kłamiąca o swoim koncie odrzucona; obcy cursor i obcy watch odrzucone; rejestr odrzuca wspólny kanał/connection/subscription |
| 6. Body/attachment bez potrzeby i provenance | PASS | purpose z zamkniętego zbioru wymagany; redakcja przed przeniesieniem; provenance w **rekordzie**, nie w logu; treść załącznika domyślnie wyłączona |
| 7. Invalid cursor → kontrolowany resync bez utraty audit trail | PASS | `resynced: true` + `resynced_from` z cursorem, który zawiódł |

## Kluczowe decyzje

- **Izolacja jako typ, nie kontrola.** `GmailAccountRef` jest brandowany, jedynym
  producentem jest `resolve`. Jedna przeciekła wiadomość jest nieodwracalna, gdy
  dotrze na zły kanał, więc nie zostawiam tego kontroli w review.
- **Rejestr odrzuca wspólny kanał/connection/subscription.** To jedyna
  misconfiguracja, która pokonałaby wszystkie pozostałe testy izolacji, bo routing
  byłby „poprawny" na kanał, który jest zły.
- **Notification to podpowiedź, nie zmiana.** Replay ze stored cursora jest tą samą
  własnością, która odzyskuje utracony notification.
- **`compareHistoryIds` nie używa `Number`.** Id Gmaila przekraczają 2^53:
  `Number("20000000000000001") === Number("...002")`, więc porównanie numeryczne
  uznałoby dwa różne punkty historii za równe i **cicho zgubiło lukę** między nimi.

## Findingi z własnego audytu (naprawione przed handoffem)

1. **Nazwa załącznika niosła token** (MEDIUM). Body czyste, treść nieczytana, a
   `glpat-....txt` przechodziło dosłownie do rekordu. Naprawa: redakcja nazwy.
2. **Seen-set bez eviction** (LOW, realny wyciek pamięci). Engine ma działać
   tygodniami. Naprawa: bound 10 000 kluczy; bezpieczne, bo forward-only cursor jest
   główną obroną, a klucz musi przeżyć tylko nakładające się okna Gmaila i
   crash-replay.

## Testy i kontrole

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/connector-gmail/test` | 0 | 31/31 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1419/1419, 125 plików** |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| repo lint error count | — | 3 (baseline `CTF-008`, bez zmian) |

## Mutation testing

| Mutacja | Wynik |
|---|---|
| `assertSameAccount` jako no-op | 3 testy FAIL |
| rejestr dopuszcza wspólny kanał | 1 FAIL |
| `compareHistoryIds` przez `Number` | 1 FAIL |
| replay startuje z notification, nie z cursora | 1 FAIL |
| seen-set usunięty | 1 FAIL |
| nazwa załącznika nieredagowana | 1 FAIL |
| eviction czyści cały set zamiast nadwyżki | 2 FAIL |

## Znane ograniczenia

- **Gmail API jest fake'em** (nagrywającym), zgodnie z `Required verification`
  („Pub/Sub/watch/history fixtures"). Live OAuth wymaga credentiali, których nie ma.
  **Nie przetestowano wobec prawdziwego Gmaila** — to realna luka, nie formalność.
- **OAuth revoke/refresh/rate-limit** nie są tu zaimplementowane: `packages/policy`
  ma już `CredentialRefreshCoordinator` z RA-005, a ten connector celowo nie tworzy
  drugiego mechanizmu. Spięcie należy do RA-021.
- **Brak persystencji**: `InMemoryGmailCursorStore` jest referencyjną implementacją;
  wersja bazodanowa (i migracja) należy do taska spinającego connectory. Numer `028`
  wolny.
- **Prompt injection**: treści są przypięte do `UNTRUSTED_DATA` na poziomie schematu,
  ale obrona po stronie promptu należy do RA-021/RA-024. Ten connector gwarantuje
  **etykietę i granicę**, nie odporność modelu.
- `CTF-012` (nowy, LOW, **niezdiagnozowany**) — flake `recovery.integration` w innym
  pakiecie; nie blokuje tego taska, ale obniża wartość pojedynczego zielonego
  przebiegu całego repo.

## Stan dla audytu

Working tree czysty, `d3d1d04`. Audyt powinien szukać dalszych ścieżek cross-account
i dalszych kanałów, którymi treść maila wychodzi nieredagowana — dwa znalezione dotąd
przechodziły wszystkie testy.
