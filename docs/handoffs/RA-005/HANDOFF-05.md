# HANDOFF-05 — RA-005 Connections, secrets and scope isolation

## Metadata

- Task: RA-005 Connections, secrets and scope isolation
- Mode: IMPLEMENTER
- Handoff: HANDOFF-05
- Milestone: M0
- Status change: `IN_PROGRESS` -> `AWAITING_AUDIT`
- Scope: remediacja findingów HIGH-07 i HIGH-08 oraz korekta faktograficzna
  MEDIUM-09 z poprzedniego handoffa. Bez zmian kontraktów i architektury.

## Remediation

### HIGH-07 — reconciliation przed revoke (fail-closed)

`CredentialMetadataPublisher.reconcile` rozstrzyga stan publikacji metadanych
przed operacją revoke. Zwraca deterministyczny werdykt z domkniętym zbiorem
wartości:

- `PUBLISHED_THIS` — metadane opublikowane przez bieżący proces/lease,
- `PUBLISHED_OTHER` — publikacja pochodzi od innego właściciela,
- `NOT_PUBLISHED` — brak publikacji,
- `UNKNOWN` — stan niejednoznaczny.

Reconciliation jest fail-closed: dla `UNKNOWN` oraz `PUBLISHED_OTHER` revoke nie
jest kontynuowany, dzięki czemu nie dochodzi do usunięcia poświadczeń przy
niepewnym stanie metadanych. Tylko `PUBLISHED_THIS` i `NOT_PUBLISHED` prowadzą
do bezpiecznego, jednoznacznego przejścia.

### HIGH-08 — lease lifecycle i zeroization

Dodano pełny cykl życia lease dla operacji na poświadczeniach:

- `acquireLease` — pozyskanie dzierżawy,
- `renewLease` — odnowienie z aktualizacją heartbeat,
- `releaseLease` — zwolnienie dzierżawy.

Czas jest brany z bazy przez `now()` (DB-side), co eliminuje dryf zegara między
procesami. Heartbeat aktualizuje znacznik żywotności dzierżawy. Blok `finally`
gwarantuje zeroizację sekretu w pamięci niezależnie od ścieżki sukcesu czy
błędu, ograniczając okno ekspozycji materiału poufnego.

## Tests

Zakres testowy pokrywa oba findingi:

- unit: logika `reconcile` dla wszystkich czterech werdyktów oraz decyzja
  fail-closed przed revoke;
- real PG: scenariusz commit-then-throw (side effect utrwalony, następnie
  wyjątek) weryfikujący idempotencję i brak destrukcyjnego revoke;
- real PG: `markPublished` failure — zachowanie przy nieudanej publikacji
  metadanych;
- real PG: renewal — odnowienie dzierżawy i heartbeat przez `now()`;
- zeroization — potwierdzenie wyzerowania sekretu w bloku `finally`.

### Evidence

- `RA_REQUIRE_POSTGRES=1 pnpm check` — exit 0.
- 24 plików / 456 testów.
- build 20/20.
- diff-check clean.

## Correction

### MEDIUM-09 — korekta faktograficzna HANDOFF-04

HANDOFF-04 zawierał błędne nazwy i szczegóły implementacyjne. Prawidłowy stan:

| HANDOFF-04 (błędne) | Faktyczne |
|---|---|
| `claimLease` | `acquireLease` |
| `FencingTokenStaleError` | `CredentialRefreshLeaseLostError` |
| `assertFencingToken` | (brak — zastąpione mechanizmem lease) |
| kolumna `lease_owner` | kolumna `lease_holder` |
| dedykowany indeks | brak indeksu |
| `credential-refresh.test.ts` | `connection-security.test.ts` |

Korekta ma charakter wyłącznie dokumentacyjny; nie zmienia zaakceptowanych
kontraktów. Aktualny kod i testy odpowiadają wartościom z kolumny „Faktyczne”.

## Risks

- `UNKNOWN` reconciliation blokuje revoke z zasady fail-closed; może wymagać
  ręcznej interwencji operatora przy trwale niejednoznacznym stanie metadanych.
  Jest to świadomy trade-off na rzecz bezpieczeństwa.
- Zależność od `now()` po stronie bazy zakłada spójny zegar instancji PG; przy
  replikacji z opóźnieniem należy korzystać z instancji primary dla operacji
  lease.
- Zeroizacja w `finally` ogranicza, ale nie eliminuje całkowicie ekspozycji
  sekretu na poziomie GC/runtime; nie polegać na niej jako jedynej warstwie.
- Korekta MEDIUM-09 wskazuje, że wcześniejszy handoff był rozbieżny z kodem;
  audytor powinien niezależnie potwierdzić nazwy symboli i plików testowych.
