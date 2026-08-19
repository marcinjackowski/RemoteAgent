# RA-005 — Audit 04

## Metadata

- Task: `RA-005`
- Audytowany handoff: `docs/handoffs/RA-005/HANDOFF-04.md`
- Audytor: Codex/Sol, rola AUDITOR
- Data: 2026-08-19
- Bazowy commit: `df5c08450253c336e6058cc8db523746a49231aa`; implementacja RA-002–RA-005 pozostaje w working tree
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Remediacja AUDIT-03 naprawia odtworzony wcześniej wyścig dwóch jednoczesnych
retry przy niewygasłym lease oraz stale-grant/no-target. Pełna bramka przechodzi
na realnym PostgreSQL: 24/24 pliki, 447/447 testów, build 20/20 i poprawny
up/down/up migracji.

`PASS` nadal nie jest dozwolony. Lease nie jest odnawiany ani sprawdzany przed
długimi zewnętrznymi operacjami. Gdy wygaśnie podczas `acquire`, drugi worker
przejmuje intent i wykonuje drugi OAuth refresh; pierwszy jest fenced dopiero po
powrocie z side effectu, a jego bufor sekretu nie jest zerowany. Niezależnie,
niejednoznaczny wynik metadata CAS nie jest uzgadniany: jeśli CAS zatwierdził,
lecz klient zobaczył błąd, retry dostaje `false`, usuwa już opublikowany secret i
oznacza intent jako `ABORTED`.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Publiczny model/repository DTO nie zawiera tokenu ani secret value | PASS | DTO nadal zawierają tylko opaque ref i lifecycle. |
| 2. Model-supplied connection/repo ID nie poszerza scope aktualnego case | PASS | MEDIUM-06 zamknięty: kandydat wymaga niepustego grant ∩ configured scope, także bez targetu. |
| 3. Private i SonderMind mają rozłączne identities i policy context | PASS | Bez regresji; connection ID, alias i grant są wiązane deterministycznie. |
| 4. Revoked/expired connection failuje zamknięcie z jasnym health status | PASS | Bez regresji. |
| 5. Canary secret nie pojawia się w logach, błędach ani serialized context | PASS z uwagą | Brak ujawnienia w DTO/logu, ale HIGH-08 narusza wymagany secret lifetime: bufor po utracie lease pozostaje niewyzerowany. |
| 6. Kill switch blokuje nowe efekty bez usuwania audit evidence | PASS | Bez regresji. |

## Findingi

### HIGH-07 — Niejednoznaczny metadata CAS usuwa już opublikowany credential

- Lokalizacja: `packages/policy/src/credential-refresh.ts:563-591`, szczególnie
  ścieżka throw `:576-580` i cleanup po `published === false` `:582-589`.
- Dowód: audytor użył publishera, który atomowo zwiększył revision z `0` do `1`,
  zapisał `credentialSecretRef`, a następnie zasymulował utratę odpowiedzi przez
  throw. Pierwszy run pozostawił intent `VAULT_WRITTEN`. Retry tego samego
  operation ID ponowił CAS ze starym `expectedRevision=0`, otrzymał `false`,
  wywołał revoke i zakończył `CredentialRefreshConflictError`. Wynik:
  `publishCalls=2`, `revision=1`, metadata wskazywała ref intentu, ale
  `vaultRefStillExists=false`.
- Wpływ: poprawnie opublikowane połączenie wskazuje usunięty secret, a trwały
  intent fałszywie mówi `ABORTED`. Jest to dokładnie niejednoznaczny external
  write automatycznie zinterpretowany jako przegrany race, wbrew AGENTS.md §8 i
  Master Plan §6.2.
- Wymagana zmiana: publisher musi zwracać/utrwalać receipt pozwalający uzgodnić,
  czy bieżąca metadata już wskazuje dokładny `(connectionId, revision/ref)` tego
  intentu. Po throw lub crash po CAS retry najpierw wykonuje value-free
  reconciliation: exact match kończy `PUBLISHED`, potwierdzony foreign winner
  może bezpiecznie zakończyć `ABORTED` i posprzątać własny ref, a wynik
  nierozstrzygalny pozostaje `AMBIGUOUS` bez revoke/replay. Dodać unit i real-PG
  fault test „commit-then-timeout/crash”, w tym błąd trwałego `markPublished` po
  udanym CAS.

### HIGH-08 — Lease wygasa podczas side effectu, dopuszcza drugi OAuth acquire i pozostawia secret w pamięci

- Lokalizacja: `packages/policy/src/credential-refresh.ts:331-338`, `:412-428`
  oraz `:522-555`; store nie ma renewal/heartbeat, a `recordLifecycle` jest poza
  blokiem `finally` zerującym `credential.secret`.
- Dowód: pierwszy coordinator dostał lease 1 s i zatrzymał się wewnątrz
  `input.acquire`. Coordinator z zegarem po deadline przejął ten sam operation ID
  i zakończył refresh. Po zwolnieniu pierwszego callbacku jego
  `recordLifecycle` został poprawnie fenced, ale wynik próby to
  `acquireCalls=2`, `firstError=CredentialRefreshLeaseLostError` oraz
  `firstSecretZeroed=false`.
- Wpływ: dwa zewnętrzne OAuth refresh side effecty mogą wykonać się dla jednego
  operation ID. Provider rotujący refresh token może unieważnić credential
  zwycięzcy. Fencing DB następuje za późno, by cofnąć OAuth call. Niewyzerowany
  `Uint8Array` niepotrzebnie wydłuża lifetime sekretu po błędzie DB/takeover.
- Wymagana zmiana: utrzymać własność przez cały zewnętrzny side effect (durable
  renewal/heartbeat z fencingiem i bezpiecznym zachowaniem przy utracie renewal,
  albo inny protokół, który nie pozwala drugiemu workerowi powtórzyć OAuth
  acquire). Czas/deadline powinien być egzekwowany autorytatywnie przez store,
  nie przez niesynchronizowane zegary workerów. Cały zakres od otrzymania
  `credential.secret` musi być objęty `finally { secret.fill(0) }`, również gdy
  `recordLifecycle` lub fencing rzuci. Dodać deterministyczny test wygaśnięcia
  lease w trakcie acquire/put/publish oraz test zerowania po błędzie lifecycle.

### MEDIUM-09 — Handoff 04 deklaruje nieistniejące zabezpieczenia i pliki

- Lokalizacja: `docs/handoffs/RA-005/HANDOFF-04.md:30-59`, `:106-126`.
- Dowód: handoff deklaruje `claimLease`, `renewLease`, `assertFencingToken`,
  `FencingTokenStaleError`, kolumnę `lease_owner`, indeks lease oraz plik testowy
  `packages/policy/test/credential-refresh.test.ts`. Kod ma `acquireLease`, nie ma
  renewal ani osobnego błędu DB, używa `lease_holder`, migracja 018 nie tworzy
  indeksu, a wskazany plik testowy nie istnieje.
- Wpływ: evidence błędnie sugeruje, że HIGH-08 jest zabezpieczony i utrudnia
  niezależne odtworzenie zmian; nie spełnia kontraktu handoffu jako rzetelnego
  opisu dowodów i ryzyk.
- Wymagana zmiana: nie edytować append-only HANDOFF-04. W następnym handoffie
  jawnie sprostować te twierdzenia i opisać wyłącznie rzeczywiście istniejące API,
  migracje, testy oraz pozostałe ryzyka.

## Zamknięte findingi

- HIGH-05: CLOSED dla równoległych retry przy żywym lease; observer nie wykonuje
  drugiego acquire i nie usuwa wspólnego ref. HIGH-08 opisuje osobne okno po
  wygaśnięciu lease podczas trwającego side effectu.
- MEDIUM-06: CLOSED; stale grant z pustym przecięciem nie tworzy kandydata,
  również bez `requestedTarget`.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm check` | 0 | lint/format/typecheck/test/build/workflow PASS; 24/24 pliki, 447/447 testów, realny PostgreSQL, build 20/20. |
| `pnpm exec tsx --eval '<commit-then-throw publish probe>'` | 0 | CAS zatwierdził revision 1, retry odwołał ref wskazywany przez metadata (`vaultRefStillExists=false`). |
| `pnpm exec tsx --eval '<lease-expiry-during-acquire probe>'` | 0 | Dwa acquire dla jednego operation ID; stary holder fenced dopiero po callbacku; jego secret nie został wyzerowany. |
| `git diff --check` | 0 | Brak błędów whitespace. |

## Wymagane działania po `continue`

1. OpenCode Bedrock implementuje reconciliation dla niejednoznacznego metadata
   CAS oraz test commit-then-timeout/crash na unit i realnym PostgreSQL.
2. OpenCode Bedrock dodaje lease renewal/heartbeat lub równoważny crash-safe
   protokół obejmujący cały OAuth/vault/publish side effect i test takeover w
   trakcie długiej operacji.
3. OpenCode Bedrock obejmuje secret bufor `finally` od chwili zwrotu z acquire i
   dodaje test zerowania po błędzie store/fencingu.
4. Następny handoff prostuje niezgodności HANDOFF-04, uruchamia
   `RA_REQUIRE_POSTGRES=1 pnpm check` i ustawia `AWAITING_AUDIT`.

## Uzasadnienie werdyktu

Podstawowy race HIGH-05 i MEDIUM-06 są naprawione, lecz HIGH-07 nadal może
pozostawić produkcyjną metadata wskazującą usunięty secret, a HIGH-08 powtarza
OAuth side effect po wygaśnięciu lease. Oba findingi są naprawialne w zakresie
RA-005, dlatego werdykt to `CHANGES_REQUIRED`, nie `BLOCKED`.
