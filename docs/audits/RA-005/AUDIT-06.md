# RA-005 — Audit 06

## Metadata

- Task: `RA-005`
- Audytowany handoff: `docs/handoffs/RA-005/HANDOFF-06.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja RA-002–RA-005 pozostaje w working tree
- Werdykt: `PASS`

## Podsumowanie

Remediacja zamyka HIGH-10, HIGH-11 i MEDIUM-12. Reconciliation publikacji jest
obowiązkową częścią kontraktu, a defensywny runtime guard przy niezgodnym
adapterze kończy operację jako `AMBIGUOUS` bez usuwania secretu. Trwały stan
`ACQUIRING` uniemożliwia peerowi powtórzenie nierozstrzygniętego OAuth acquire,
a lease nie może być odnowiony po swoim deadline.

Audytor niezależnie odtworzył wszystkie trzy exploity z AUDIT-05 i potwierdził,
że są zamknięte. Pełna bramka przechodzi na realnym PostgreSQL: 24/24 pliki,
463/463 testy i build 20/20. Nie pozostały findingi klasy BLOCKER, HIGH ani
MEDIUM.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Publiczny model/repository DTO nie zawiera tokenu ani secret value | PASS | Niezależny przegląd publicznych DTO i eksportów nie wykazał wartości secretów; używane są opaque refs i lifecycle metadata. |
| 2. Model-supplied connection/repo ID nie poszerza scope aktualnego case | PASS | Policy przecina żądany scope z serwerowym grantem case; testy scope escalation i real-PG pozostają zielone. |
| 3. Private i SonderMind mają rozłączne identities i policy context | PASS | Rozdzielne connection IDs, owner aliases i policy context są weryfikowane testami bez cross-account leakage. |
| 4. Revoked/expired connection failuje zamknięcie z jasnym health status | PASS | Lifecycle gating odrzuca revoked/expired credentials; refresh race nie omija health state ani fencingu. |
| 5. Canary secret nie pojawia się w logach, błędach ani serialized context | PASS | Testy redaction/canary przechodzą; bufor acquire jest zerowany także po błędzie lifecycle lub utracie lease. |
| 6. Kill switch blokuje nowe efekty bez usuwania audit evidence | PASS | Testy globalnego, providerowego i connection-level kill switch przechodzą; istniejący evidence pozostaje zachowany. |

## Weryfikacja findingów z AUDIT-05

### HIGH-10 — CLOSED

- `CredentialMetadataPublisher.reconcile` jest wymagane typowo.
- Defensywny przypadek runtime bez reconciliatora oraz błąd reconciliatora
  przechodzą do `AMBIGUOUS` bez revoke i bez automatycznego replay.
- Niezależny probe commit-then-lost dla niezgodnego publishera zakończył oba
  wywołania `CredentialWriteAmbiguousError`; `calls=1`, metadata pozostała na
  opublikowanym refie, a `vaultRefStillExists=true`.

### HIGH-11 — CLOSED

- Fenced `markAcquiring` trwale zapisuje `ACQUIRING` przed `input.acquire()`.
- Takeover `ACQUIRING` nie wywołuje acquire ponownie: dokładny ocalały vault
  object wznawia publish, a brak lub mismatch kończy się `AMBIGUOUS`.
- Niezależny probe pause/lease-expiry dał `acquireCalls=1`; peer zakończył
  `CredentialWriteAmbiguousError`, a pierwotny worker został fenced przez
  `CredentialRefreshLeaseLostError`.
- Niezależny probe renewal po deadline dał `renewedAfterExpiry=false`, po czym
  peer uzyskał status `ACQUIRED`.
- DB i in-memory store wymagają niewygasłego lease przy renewal, a heartbeat
  latch jest sprawdzany przed kolejnymi efektami i mutacjami.

### MEDIUM-12 — CLOSED

HANDOFF-06 jawnie prostuje trzy nieścisłości poprzedniego handoffu, deklaruje
zmiany publicznych kontraktów i opisuje dokładne outcome/status/cleanup zarówno
dla publikacji metadanych, jak i takeover stanu `ACQUIRING`.

## Migracja i trwałość

- Addytywna migracja 019 rozszerza nazwany constraint statusu o `ACQUIRING`.
- Test migracji przechodzi cykl up/down/up; down failuje zamknięcie, jeśli nadal
  istnieje stan niereprezentowalny w starszym schemacie.
- Targetowane testy migrations oraz case/scope/refresh: 2/2 pliki, 22/22 testy.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check && git diff --check` | 0 | lint/format/typecheck/test/build/workflow PASS; realny PostgreSQL; 24/24 pliki, 463/463 testy; build 20/20; diff clean. |
| `pnpm --filter @remoteagent/database exec vitest run migrations case-scope-and-refresh` | 0 | 2/2 pliki, 22/22 testy; migracja up/down/up i 15 testów integracyjnych RA-005. |
| `pnpm exec tsx --eval '<missing-reconcile commit-then-lost probe>'` | 0 | `calls=1`, oba runy ambiguous, opublikowany ref nadal istnieje. |
| `pnpm exec tsx --eval '<paused ACQUIRING lease-expiry probe>'` | 0 | `acquireCalls=1`; peer nie powtórzył OAuth side effectu, właściciel został fenced. |
| `pnpm exec tsx --eval '<renew expired lease probe>'` | 0 | `renewedAfterExpiry=false`; peer przejął lease. |

## Ryzyka rezydualne

- `AMBIGUOUS` po crashu w nierozstrzygalnym oknie `ACQUIRING` wymaga ręcznej
  reconciliacji. Jest to zamierzony fail-closed trade-off: system nie powtarza
  potencjalnie wykonanej, nieidempotentnej rotacji OAuth.
- Downgrade migracji 019 wymaga wcześniejszego rozstrzygnięcia wierszy
  `ACQUIRING`; constraint celowo blokuje utratę semantyki.

## Uzasadnienie werdyktu

Wszystkie kryteria akceptacji RA-005 są spełnione, wymagane testy przechodzą,
a wcześniejsze scenariusze destrukcyjnego cleanupu, podwójnego OAuth acquire i
wskrzeszenia wygasłego lease są niezależnie zamknięte. Brak findingów BLOCKER,
HIGH i MEDIUM pozwala wydać werdykt `PASS`.

