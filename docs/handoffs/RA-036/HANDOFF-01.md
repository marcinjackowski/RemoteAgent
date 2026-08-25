# RA-036 — HANDOFF-01

- Task: `RA-036` Discord UX: informacja o błędzie agenta w wątku
- Data: `2026-08-25`
- Bazowy commit: `a326464`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## W jednym zdaniu

Gdy owner-driven `case.resume` wyczerpie próby i przechodzi do DLQ, handler tuż przed rzutem
projektuje jedną user-safe wiadomość „⚠️ I ran into an error…" do wątku — więc zamiast ciszy
właściciel widzi, że coś się zepsuło i agent nie odpowiedział.

## Co powstało / zmienione

| Ścieżka | Rola |
|---|---|
| `apps/agent-worker/src/dead-letter-notice.ts` (NOWY) | `projectDeadLetterNotice` + `DEAD_LETTER_NOTICE_BODY` (mirror `completion-reply`) |
| `apps/agent-worker/src/handlers.ts` | wpięcie w terminalny rzut owner-driven `case.resume` |
| `apps/agent-worker/src/persistence.ts` | usunięty tymczasowy diagnostyk `[markAmbiguous]` |
| `apps/agent-worker/test/dead-letter-notice.integration.test.ts` (NOWY) | 4 testy |

## Kluczowe właściwości

- **Terminalność** wykrywana przez `lease.attempts >= lease.maxAttempts` — to samo porównanie co
  `JobStore.fail` (`job-store.ts:410`), więc ten rzut na pewno dead-letteruje.
- **Idempotencja** na `error:<jobId>` w `case_messages` — crash między enqueue a rzutem + re-claim
  nie tworzy duplikatu.
- **Best-effort**: nieudana projekcja jest łapana (`logger.warn`), pass rzuca dalej (retry/DLQ bez
  zmian). Brak wątku → `false`, brak wiadomości.
- **Gate** `reason === "owner_message"` — jak RA-035; recovery/implementer passy milczą.
- **User-safe body**: stała, bez ID/stack; detal błędu zostaje w `jobs.last_error`/DLQ dla operatora.

## Jak zobaczyć na żywo

3 procesy przez `bash scripts/dev/start-all.sh`. Aby wymusić błąd: ustaw model_id w
`agent_config` na niepoprawny (albo odetnij AWS token) → napisz w wątku KAN-* → po wyczerpaniu prób
w wątku pojawia się „⚠️ I ran into an error and couldn't finish responding…". `max_attempts`
domyślnie wysoki, więc do DLQ trzeba kilku retry (backoff) — może chwilę potrwać.

## Świadomy brzeg

Dead-lettery spoza handler-throw (czysty reap lease bez ponownego claimu) nie są notyfikowane
bezpośrednio; na re-claim handler przebiega ponownie i rzuca → pokryte. Pełny poller nad
`JobStore.listDeadLettered` (łapałby też reapy) był rozważany i odrzucony jako cięższy (nowy
periodic task + coupling schedulera do discorda) — do rozważenia dopiero gdyby reap-DLQ okazał się
realnym problemem w produkcji.

## Stan drzewa

Czyste po commicie. `push`/MR/deploy — osobna zgoda. Żaden zapis do Discorda/Jiry/Bedrock nie został
wykonany (zmiana lokalna + testy na throwaway DB).

## Następne

Kolejka: `RA-034` (IN_PROGRESS, wstrzymany przez właściciela — write loop) pozostaje następnym
dużym kawałkiem, gdy właściciel wznowi. Po RA-035/RA-036 pętla rozmowy ma pełny UX (typing + błąd).
