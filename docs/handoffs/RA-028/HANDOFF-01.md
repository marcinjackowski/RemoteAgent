# RA-028 — HANDOFF-01

- Task: `RA-028` Handlery workera: system wykonuje pracę
- Data: `2026-08-22`
- Bazowy commit: `88001ea` (stan po domknięciu RA-027)
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Najważniejsze w jednym zdaniu

**Worker wykonuje pracę end-to-end.** Job wchodzi do kolejki, uruchomiony proces sam go
podejmuje, woła model, zapisuje completion, awansuje checkpoint i pisze outbox — udowodnione
przeciwko realnemu PostgreSQL-owi. Przed tym taskiem ten sam job trafiał do DLQ.

## Jak uruchomić — komendy, które faktycznie działają

```bash
. scripts/dev/env.sh
pnpm run build --force

# Handlery i adapter persystencji
RA_REQUIRE_POSTGRES=1 pnpm vitest run apps/agent-worker/test        # 23 testy

# Golden path przez URUCHOMIONY proces (AC7)
RA_REQUIRE_POSTGRES=1 pnpm vitest run test/processes                # 33 testy
```

## Co powstało

| Ścieżka | Rola |
|---|---|
| `apps/agent-worker/src/persistence.ts` | `RuntimePersistence` nad PostgreSQL-em; promocja `PgRuntimeStore` z pliku testowego |
| `apps/agent-worker/src/roles.ts` | rola → transport modelu; transport **wstrzykiwany** |
| `apps/agent-worker/src/handlers.ts` | `case.resume`, `agent.implementer`, wstrzykiwalny renewal |
| `apps/agent-worker/src/worker.ts` | `handlers: {}` → realne handlery (zmiana jednej linii, reszta to jej konsekwencje) |
| `apps/agent-worker/test/persistence.integration.test.ts` | 9 testów, każda promowana metoda |
| `apps/agent-worker/test/handlers.integration.test.ts` | 14 testów, zachowanie handlerów |
| `test/processes/process-behaviour.integration.test.ts` | +1 test: golden path przez żywy proces |

## Bramka

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run     2398/2398, 168 plików, PIĘĆ przebiegów, exit 0
pnpm run lint / format                     exit 0
root tsc --noEmit                          exit 0
pnpm run typecheck --force                 38 successful, 0 cached
pnpm run build --force                     26 successful, 0 cached
git diff --check                           exit 0
```

Mutation checki: **13 mutacji**, 10 czerwonych, 3 ocalałe **wyjaśnione sondą**
(`AUDIT-01` §4.2). Jedna mutacja obaliła mój własny komentarz — §4.1.

## Trzy realne defekty, wszystkie wykryte uruchomionym testem

1. **`cases.active_run_id` nie było ustawiane przez ŻADEN kod produkcyjny.** Luka od RA-003.
   `RunCompletionRepository.apply()` wymaga tej kolumny; `grep` pokazał, że repozytorium ją
   tylko **czyści**. Każdy test, który dochodził do completion, ustawiał ją ręcznie — więc
   pierwszy realny pass failował z `run/case is not eligible for completion`. Naprawione w
   `start()`, z guardem, który robi z tego **durable single-writer gate**.
2. **Handler kończył się sukcesem, gdy praca się nie wykonała.** `pumpOnce()` nie rzuca przy
   failującym uniocie — łapie błąd i raportuje `ambiguous`/`blocked`. Handler robił `return`,
   czyli mówił `Scheduler`owi „udało się", i job nigdy nie był ponawiany. Teraz rzuca.
3. **Blind cast dawał wartość, która typechecku przechodzi i failuje w runtime.**
   `WorkUnitRow` ma `Date`, kontrakt wymaga stringów ISO. Wykrył to `WriterLeaseGuard`, który
   re-parsuje unit: writer był odrzucany **pod poprawnym leasem**.

## Wejściowe ustalenia dla następnego taska

Trzy rzeczy do podłączenia, w kolejności wartości. Kolejność się nie zmieniła od RA-027,
tylko pozycja 1 jest zrobiona:

1. **Katalog narzędzi dla roli.** Największa. `createRole` wysyła objective i odbiera
   `AgentCompletion` — agent **nie edytuje jeszcze workspace'u**.
   `runStructuredCompletion` już przyjmuje `tools` i `execute`; brakuje podłączenia
   `implementation-tools` i MCP brokera. To jest to, co zamienia „wykonuje pracę" w
   „przeprowadza task z Jiry do MR".
2. **`ProviderAdapter` per provider** dla executora — `executeAction` gotowe i audytowane;
   brakuje funkcji wołających Jirę, GitLaba, Gmaila, Calendar.
3. **Routy ingressu** — `ingestJiraWebhook` gotowe; brakuje `RawPayloadStore` i sekretu
   podpisu. Potem **taski schedulera**.

Plus: **zarejestrować `jira.webhook.renewal` w produkcyjnym `main()`.** Handler jest gotowy i
przetestowany, ale `main()` go nie rejestruje, bo wymaga `JiraWebhookConfig` i żywego tokenu —
więc dziś ten job trafia do DLQ. To decyzja konfiguracyjna, nie brakujący kod.

Nadal otwarte bez zmian: `CTF-014`, `evidence`→`audit_log`, realny restore drill AWS,
container scanning.

## Ślepe uliczki i rzeczy, które okazały się nieprawdą

1. **Mój komentarz twierdził, że `recover()` przed `pumpOnce()` jest „nie opcjonalny".
   Mutacja usuwająca ten call przeszła.** `pumpOnce()` sam woła `recover()`, single-flight.
   Realna wartość to **heartbeat** między recovery a pompą — recovery czyta wszystkie
   niedokończone case'y, więc jest wolną częścią, a przedłużenie leasu przed wywołaniem modelu
   chroni przed zreapowaniem joba w trakcie legalnie trwającego passu. Naprawione oba:
   komentarz mówi prawdę, i doszedł test asertujący **kolejność** heartbeat → model.
2. **`CTF-013` powtórzyło się w nowej formie.** Root `tsc` zgłosił trzy `TS2322` na
   `Database` z `src` vs `dist` — te same „separate declarations of a private property `pool`".
   Rozwiązane tak jak w `test/golden-path`: jeden udokumentowany cast na granicy. To jest
   otwarta połowa `CTF-004` i wraca przy każdym nowym teście root-level, który podaje harnessową
   bazę do kodu z `apps/`.
3. **Test root-level potrzebuje deklaracji zależności w ROOT `package.json`.** Import
   `@remoteagent/bedrock-runtime` z `test/` failował na `Cannot find package`, mimo że pakiet
   istnieje w workspace. Dodane do `devDependencies`.
4. **Zamrożony zegar w teście procesu jest pułapką.** `bootstrapWorker` buduje własny
   `JobStore` z `productionRuntime()` (zegar systemowy, `leaseTime: 'db'`). Enqueue z
   zamrożonym zegarem stawia czas kolejki godziny obok czasu procesu, a wynik zależy od tego,
   jak się rozjeżdżają: zielone solo, czerwone raz na dziewięć pełnych przebiegów.
5. **Nie wolno czekać na `run_completions`, żeby stwierdzić, że job się udał.** `Scheduler`
   oznacza joba `SUCCEEDED` **po** powrocie handlera, więc completion jest widoczny, gdy job
   jest jeszcze `LEASED`. Poll czeka na status joba, który ustala się ostatni.
6. **`case_entities` nie istnieje** — tabela nazywa się `external_entities`. SQL w stringu
   jest dla kompilatora nieprzejrzysty, więc typecheck był zielony; wykrył to pierwszy test.
7. **`agentCompletion.summary` jest zwykłym `text`**, nie obiektem z `trust`. Pierwszy fixture
   miał `{ trust, value }` — kształt `CaseCheckpoint.summary`, nie completion. Objaw był
   mylący: `Fake transport script is exhausted`, bo nieudana walidacja odpalała **repair call**.
8. **`CheckpointRepository.append` nie umie utworzyć rewizji 0** — pisze zawsze
   `expectedRevision + 1`. Bazowy checkpoint wstawia się wprost, tak jak robi to
   `completion-apply.integration.test.ts`.

## Stan drzewa

Czyste. `push`, MR i merge **nadal wymagają osobnej zgody**. Żaden deploy nie został wykonany,
żaden obraz nie został zbudowany, żaden call do AWS nie został wysłany.
