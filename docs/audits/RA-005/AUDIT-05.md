# RA-005 — Audit 05

## Metadata

- Task: `RA-005`
- Audytowany handoff: `docs/handoffs/RA-005/HANDOFF-05.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja RA-002–RA-005 pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

HIGH-07 jest naprawiony wyłącznie dla publisherów, które opcjonalnie implementują
`reconcile`; real-PG fixture pokazuje poprawne zachowanie tej ścieżki. Pełna
bramka przechodzi: 24/24 pliki, 456/456 testów, build 20/20 i realny PostgreSQL.
Zeroizacja po błędzie lifecycle również jest poprawiona.

`PASS` nie jest dozwolony. Publiczny kontrakt nadal zezwala pominąć `reconcile`,
a fallback dokładnie odtwarza HIGH-07 i usuwa secret wskazywany przez metadata.
Heartbeat zmniejsza prawdopodobieństwo takeover podczas długiej operacji, ale nie
zapewnia crash/pause safety: gdy timer nie wykona się przed TTL, drugi worker
ponawia OAuth acquire. Store pozwala też odnowić lease już po deadline, co łamie
semantykę wygaśnięcia.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Publiczny model/repository DTO nie zawiera tokenu ani secret value | PASS | Bez regresji. |
| 2. Model-supplied connection/repo ID nie poszerza scope aktualnego case | PASS | MEDIUM-06 pozostaje zamknięty. |
| 3. Private i SonderMind mają rozłączne identities i policy context | PASS | Bez regresji. |
| 4. Revoked/expired connection failuje zamknięcie z jasnym health status | PASS | Bez regresji. |
| 5. Canary secret nie pojawia się w logach, błędach ani serialized context | PASS | Bufor otrzymany z acquire jest teraz zerowany także przy błędzie lifecycle/fencingu. |
| 6. Kill switch blokuje nowe efekty bez usuwania audit evidence | PASS | Bez regresji. |

## Findingi

### HIGH-10 — Opcjonalny reconciler pozostawia dokładnie tę samą destrukcyjną ścieżkę HIGH-07

- Lokalizacja: `packages/policy/src/credential-refresh.ts:103-124` i
  `:738-747`; `CredentialMetadataPublisher.reconcile` jest opcjonalne, a
  `publish() === false` bez niego wykonuje revoke i `ABORTED`.
- Dowód: publisher bez `reconcile` zatwierdził CAS (`revision=1`, metadata
  wskazywała ref intentu), po czym rzucił błąd utraconej odpowiedzi. Pierwszy run
  zwolnił lease. Retry dostał `false`, wszedł w fallback bez reconciliatora i
  usunął ref. Wynik audytora: `calls=2`, `revision=1`,
  `CredentialRefreshConflictError`, `vaultRefStillExists=false`.
- Wpływ: każda implementacja zgodna z publicznym interfejsem, lecz bez opcjonalnej
  metody, może pozostawić połączenie wskazujące usunięty secret. Gwarancja
  run-safety nie może zależeć od dobrowolnej funkcji adaptera.
- Wymagana zmiana: uczynić value-free reconciliation obowiązkową częścią
  kontraktu każdego publishera używanego przez coordinator albo usunąć
  destrukcyjny fallback. Brak reconciliatora/awaria odczytu musi kończyć
  `AMBIGUOUS` bez revoke i bez automatycznego replay. Dodać test kompilacyjny lub
  runtime dla publishera bez reconciliatora oraz adversarial test zachowania
  fail-closed; wszystkie realne adaptery muszą implementować exact-ref/current-
  revision reconciliation.

### HIGH-11 — Heartbeat nie zabezpiecza crash/pause podczas OAuth acquire

- Lokalizacja: `packages/policy/src/credential-refresh.ts:284-330`, `:505-601`
  i `:643-683`; `input.acquire()` rozpoczyna się bez trwałego stanu „side effect
  started”, a takeover po TTL ponownie wchodzi w tę samą ścieżkę. DB renewal
  `packages/database/src/repositories/credential-refresh-intent.ts:169-190` nie
  wymaga, aby `lease_expires_at > now()`.
- Dowód 1: audytor zatrzymał heartbeat (model process pause/crash) podczas
  pierwszego `input.acquire`, przesunął autorytatywny zegar store poza TTL i
  uruchomił drugi worker. Drugi przejął intent i wykonał kolejny acquire. Wynik:
  `acquireCalls=2`; drugi opublikował, pierwszy został fenced dopiero po powrocie
  callbacku.
- Dowód 2: po deadline ten sam holder wywołał `renewLease` zanim peer zdążył
  claim. Store zwrócił `renewedAfterExpiry=true`, a peer `OBSERVER`. Real-PG test
  implementera wręcz utrwala tę semantykę, odnawiając zero-duration lease.
- Wpływ: przy crashu/pauzie po wysłaniu OAuth refresh, lecz przed zapisem wyniku,
  provider może obrócić token; takeover powtarza side effect i może unieważnić
  credential zwycięzcy. Heartbeat jest mechanizmem liveness, nie dowodem, że
  niepotwierdzony external write nie nastąpił. Odnowienie po deadline zaciera
  jednoznaczną granicę własności.
- Wymagana zmiana: przed `input.acquire` trwale zapisać stan rozpoczęcia external
  side effectu. Takeover po wygaśnięciu takiego stanu nie może automatycznie
  powtórzyć acquire: musi wykonać provider-specific value-free reconciliation,
  jeśli jest możliwy, albo zakończyć `AMBIGUOUS`/manual reconciliation. Renewal
  musi atomowo wymagać niewygasłego lease (`lease_expires_at > now()`), a utrata
  lub błąd heartbeat ma zostać zalatchowany i sprawdzony przed każdym kolejnym
  zewnętrznym efektem. Dodać unit i real-PG test pause/crash w trakcie acquire,
  test zakazu renewal po deadline oraz test braku drugiego acquire.

### MEDIUM-12 — HANDOFF-05 nadal opisuje zachowanie odwrotnie do kodu

- Lokalizacja: `docs/handoffs/RA-005/HANDOFF-05.md`, sekcje Metadata i HIGH-07.
- Dowód: handoff mówi „bez zmian kontraktów”, choć zmieniono publiczne interfejsy
  store i publishera. Twierdzi też, że `PUBLISHED_OTHER` nie kontynuuje revoke,
  podczas gdy kod `credential-refresh.ts:766-771` bezpiecznie revokuje własny,
  nieopublikowany ref. Dla `NOT_PUBLISHED` kod również revokuje i kończy
  `ABORTED`, a nie opisane niejednoznaczne „przejście”.
- Wpływ: kolejny artefakt evidence ponownie nie odpowiada kodowi i zaciemnia
  dokładną granicę bezpiecznego cleanupu.
- Wymagana zmiana: nie edytować append-only HANDOFF-05. Następny handoff ma jawnie
  sprostować te trzy stwierdzenia i opisać dokładną tabelę outcome → status →
  cleanup.

## Zamknięte findingi z AUDIT-04

- Część HIGH-07: CLOSED dla adaptera z poprawnym `reconcile`; commit-then-throw i
  błąd `markPublished` uzgadniają się do `PUBLISHED_THIS` bez revoke.
- Część HIGH-08: CLOSED dla zeroizacji sekretu po błędzie lifecycle/fencingu oraz
  dla użycia czasu DB przy acquire/deadline.
- MEDIUM-09: CLOSED; HANDOFF-05 sprostował wcześniejsze nieistniejące symbole i
  pliki.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | lint/format/typecheck/test/build/workflow PASS; realny PostgreSQL; build 20/20. |
| `RA_REQUIRE_POSTGRES=1 pnpm test` | 0 | 24/24 pliki, 456/456 testów. |
| `pnpm exec tsx --eval '<publisher without reconcile, commit-then-throw probe>'` | 0 | Retry usunął ref wskazywany przez metadata (`vaultRefStillExists=false`). |
| `pnpm exec tsx --eval '<paused heartbeat during acquire probe>'` | 0 | Lease wygasł, peer wykonał drugi OAuth acquire (`acquireCalls=2`). |
| `pnpm exec tsx --eval '<renew expired lease probe>'` | 0 | `renewedAfterExpiry=true`, peer pozostał observerem. |

## Wymagane działania po `continue`

1. OpenCode Bedrock usuwa opcjonalny/destrukcyjny fallback reconciliatora i
   zapewnia fail-closed zachowanie każdego publishera.
2. OpenCode Bedrock dodaje trwały stan external-acquire-started oraz bezpieczny
   takeover bez automatycznego powtórzenia nierozstrzygniętego OAuth side effectu.
3. OpenCode Bedrock zabrania renewal po deadline i dodaje fault tests na local i
   realnym PostgreSQL.
4. HANDOFF-06 prostuje MEDIUM-12, zapisuje pełne evidence i ustawia
   `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Nowe testy pokrywają szczęśliwy heartbeat i reconciler, lecz publiczny fallback
nadal odtwarza awarię HIGH-07, a crash/pause w trakcie OAuth acquire nadal może
powtórzyć nieidempotentny side effect. Findingi są naprawialne w zakresie RA-005,
więc werdykt to `CHANGES_REQUIRED`, nie `BLOCKED`.
