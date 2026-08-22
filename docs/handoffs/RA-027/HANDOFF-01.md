# RA-027 — HANDOFF-01

- Task: `RA-027` Composition roots: uruchamialne procesy
- Data: `2026-08-22`
- Bazowy commit: `1c50f40` (stan po domknięciu RA-026)
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Najważniejsze w jednym zdaniu

**System się uruchamia** — proces wstaje, odpowiada na `/livez` i `/readyz`, zamyka
się czysto na `SIGTERM`, udowodnione przeciwko realnemu PostgreSQL-owi. **System nie
wykonuje jeszcze pracy**: trzy procesy startują z pustą konfiguracją i failują głośno.

## Jak uruchomić — komendy, które faktycznie działają

```bash
. scripts/dev/env.sh                 # node + pnpm + sprawdzenie Postgresa na 5433
pnpm run build --force

# Wszystkie testy procesów przeciwko realnej bazie
RA_REQUIRE_POSTGRES=1 pnpm vitest run test/processes     # 32 testy

# Health CLI, dokładnie jak wywołuje ją ECS
node apps/agent-worker/dist/health.js --liveness ; echo "exit=$?"
```

Żywy proces (to, co pokazuje `AUDIT-01` §2): `bootstrapWorker` z `port: 0`, potem
`fetch` na `/livez` i `/readyz`, potem `runtime.shutdown("SIGTERM")`.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `packages/observability/src/process-runtime.ts` | wspólny bootstrap: sekwencja shutdownu, serwer health |
| `packages/database/src/queue/dispatch.ts` | `job_type` → handler; nieznany typ **fail-closed do DLQ** |
| `apps/agent-worker/src/worker.ts` | Scheduler + dispatch + tracking pracy w locie |
| `apps/agent-worker/src/health.ts` | health CLI; domyślnie **liveness** |
| `apps/action-executor/src/executor.ts` | pętla po `PROPOSED`/`APPROVED` — **nigdy** `AMBIGUOUS` |
| `apps/ingress-api/src/ingress.ts` | serwer webhooków; dwa porty, limit body, 202/401/413 |
| `apps/discord-bot/src/discord.ts` | `main()` nad istniejącym `runFromEnv()` |
| `apps/scheduler/src/scheduler.ts` | ticki; pierwszy natychmiast, bez nakładania |
| `Dockerfile`, `docker-compose.app.yml` | jeden obraz, pięć komend — **nie zbudowane** |
| `test/processes/**` (3 pliki, 32 testy) | entry pointy, lifecycle, zachowanie per-proces |

## Bramka

```text
RA_REQUIRE_POSTGRES=1 pnpm vitest run     2374/2374, 166 plików, TRZY przebiegi, exit 0
… test/processes                           32/32, exit 0
pnpm run lint / format                     exit 0
root tsc --noEmit                          exit 0
pnpm run typecheck --force                 37 successful, 0 cached
pnpm run build --force                     exit 0
pnpm workflow:validate                     OK — 27 tasks
```

Mutation checki: **31 mutacji**, wszystkie czerwone poza jedną **nieosiągalną**
(udowodnioną sondą).

## Stan faktyczny: co działa, a co nie

**To jest system, który się URUCHAMIA, a nie system, który WYKONUJE PRACĘ.** Stawiam to
wprost, bo różnica jest łatwa do przeoczenia po `PASS`.

| Proces | Startuje | Robi pracę | Dlaczego nie |
|---|---|---|---|
| `worker` | tak | **nie** | pusta mapa handlerów → każdy job do DLQ z `UnknownJobTypeError` |
| `executor` | tak | **nie** | brak `ProviderAdapter` → `runOneAction` rzuca |
| `ingress` | tak | **nie** | pusta tablica routów → każdy webhook 404 |
| `scheduler` | tak | **nie** | pusta lista tasków → loguje jawne `warn` na starcie |
| `discord` | tak | **tak** | `runFromEnv()` jest w pełni podłączone (wymaga tokenu) |

Każdy failuje **głośno**, nie cicho — z wyjątkiem schedulera, który jest jedynym cicho
złym przypadkiem i dlatego loguje ostrzeżenie przy starcie.

To jest **świadome zawężenie zakresu**, nie niedokończona praca: handlery wymagają
runtime'u Bedrocka, workspace roota i katalogu narzędzi; `executeAction` wymaga
adaptera per provider; `ingestJiraWebhook` wymaga `RawPayloadStore` i sekretu podpisu.
Zakres RA-027 to składanie istniejących części.

## Wejściowe ustalenia dla następnego taska

Cztery rzeczy do podłączenia, w kolejności wartości:

1. **Handlery workera** (`case.resume`, `agent.implementer`) — największy, bo wymaga
   `SupervisorRuntime` (`recover()` + `pumpOnce()` już istnieją), runtime'u Bedrocka i
   katalogu narzędzi. To jest to, co zamienia „startuje" w „przeprowadza task z Jiry
   do MR".
2. **`ProviderAdapter` per provider** dla executora — `executeAction` jest gotowe i
   audytowane; brakuje funkcji, które faktycznie wołają Jirę, GitLaba, Gmaila,
   Calendar.
3. **Routy ingressu** — `ingestJiraWebhook` jest gotowe; brakuje `RawPayloadStore`
   (S3 lub lokalny) i pobrania sekretu podpisu z Secrets Managera.
4. **Taski schedulera** — skany renewalowe. Serwisy istnieją
   (`JiraWebhookRenewalService`, `sync.ts` dla Calendara), brakuje wywołania ich w
   ticku.

Plus nadal otwarte z poprzednich tasków, bez zmian: `CTF-014`,
`evidence`→`audit_log`, realny restore drill AWS, container scanning.

## Ślepe uliczki i rzeczy, które okazały się nieprawdą

1. **DWANAŚCIE z 31 mutacji przeżyło pierwszy przebieg**, i wzorzec był jednolity:
   `lifecycle.integration.test.ts` dowodził, że każdy proces **startuje, serwuje health
   i się zatrzymuje** — dokładnie to, o co prosi AC1 — i **nie asertował niczego o tym,
   co dany proces robi**. Więc przeszły mutacje każące executorowi podejmować akcje
   `AMBIGUOUS` (blind replay!), usuwające limit body ingressu i pozwalające tickom
   schedulera stackować się. **„Startuje i się zatrzymuje" jest realną właściwością i
   niewystarczającą.**
2. **Body health nie było redagowane.** Rozumowałem, że `HealthReport.detail` jest
   pisany przez nasz kod i nie nosi credentiala — prawda **dziś**, i dokładnie kształt
   `CTF-006`: powierzchnia zwolniona z redakcji, bo jej aktualna treść jest przypadkiem
   bezpieczna. Ścieżka health jest osiągalna z **load balancera**, czyli jest
   najbardziej wyeksponowanym outputem w systemie.
3. **`request.destroy()` na zbyt dużym body sprawiał, że provider nigdy nie dowiadywał
   się o 413** — widział zamknięte połączenie, więc retryował to samo body w
   nieskończoność. Naprawione na `pause()`. Wykryte testem, nie przeglądem.
4. **Monkey-patch na `Scheduler.tick`** był pierwszym podejściem do trackowania pracy w
   locie. Źle dwukrotnie: sięga do instancji cudzego pakietu i liczy cały pass jako
   „praca w locie", gdy tylko **handler** może zostawić joba w połowie.
5. **`secretName` na konstrukcie CDK to token** — ta pułapka z RA-025 powtórzyła się w
   innej formie: `bootstrapIngress` musiało zwrócić **zbindowany** port webhooka,
   bo `webhookPort: 0` (jak testy unikają kolizji) sprawia, że skonfigurowana wartość
   nic nie mówi o faktycznej.
6. **Jedna mutacja przeżywa i jest NIEOSIĄGALNA** — guard przeciw nakładającym się
   tickom schedulera. Pętla `await`uje pass przed zaplanowaniem następnego timera, więc
   `inFlight` jest zawsze `null`. Sondowane; guard zostaje na wypadek drugiego call
   site, i jest to **zapisane w kodzie**, żeby nie był niewyjaśnionym ocalałym.
7. **Trzy ustalenia zmierzone przed planowaniem oszczędziły większość roboty:**
   `Scheduler` ma już `tick`/`start`/`stop` z reapingiem, relayem i bounded retry;
   `apps/discord-bot` ma już `runFromEnv()`; `Database.fromEnv()` istnieje. Bez tej
   sondy rozpisałbym plan na budowę maszynerii, która już jest.

## Stan drzewa

Czyste. `push`, MR i merge **nadal wymagają osobnej zgody**. Żaden deploy nie został
wykonany, żaden obraz nie został zbudowany.
