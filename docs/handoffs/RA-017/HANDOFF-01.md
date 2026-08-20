# RA-017 — Handoff 01

## Metadata

- Task: `RA-017`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Data: `2026-08-20`
- Bazowy commit: `d307eed`
- Końcowy commit: `48e04f5`

## Wynik

`@remoteagent/connector-gitlab` przestał być szkieletem: allowlista projektów,
weryfikowany webhook ingress z ochroną replay, push brancha z izolacją credentiala i
idempotentne draft MR z prawdziwym evidence.

## Kryteria akceptacji

| # | Status | Dowód |
|---|---|---|
| 1. Projekt spoza allowlisty nieodczytywalny i niezapisywalny | PASS | `GitLabProjectRef` jest brandowany, a jedynym producentem jest `resolve`; dopasowanie **dokładne** (prefiks, wielkość liter i whitespace odrzucone); event o obcym projekcie odrzucony |
| 2. Ponowienie push/create MR nie tworzy duplikatu | PASS | dwa przebiegi, **licznik `create` = 1**; idempotencja ustalana wobec remote'a, nie lokalnej flagi; świeży publisher (jak po restarcie) też nie duplikuje |
| 3. Token nie trafia do modelu, outputu ani URL-a | PASS | userinfo **oraz query/fragment** odrzucone; token przekazywany osobnym argumentem (asercja na zapisanych argumentach pushera); stdout, stderr, błąd pusha i **proza opisu MR** redagowane |
| 4. Pipeline event aktualizuje właściwy case i SHA | PASS | realne kształty payloadów pipeline/job/push/MR; `refs/heads/` obcinane; SHA, branch i status wyciągane |
| 5. Replay/stary timestamp odrzucony i audytowany | PASS | trzy niezależne bramki (podpis `timingSafeEqual`, okno świeżości, delivery id); **każda odmowa emituje audit**; brak delivery id rzuca |
| 6. Draft MR zawiera prawdziwe evidence i unresolved risks | PASS | intent bez receiptów/readiness/SHA nieprzedstawialny; „None known" zamiast pominiętej sekcji; opis wysyłany do API sprawdzony |

## Kluczowe decyzje

- **Allowlista jako typ, nie kontrola.** Un-allowlisted projekt nie da się *nazwać*
  w wywołaniu, bo `GitLabProjectRef` powstaje wyłącznie z `resolve`.
- **Trzy bramki replay, w tej kolejności.** Podpis nie wystarcza (przechwycone body
  zachowuje ważny podpis na zawsze); świeżość nie wystarcza (replay wewnątrz okna);
  delivery id jest kluczem exactly-once. Weryfikacja **przed** parsowaniem, bo
  niezweryfikowane body to input atakującego.
- **`timingSafeEqual` po digestach o stałej szerokości** — porównanie surowych
  sekretów rzuca przy różnej długości, więc wyciekałaby też długość.
- **Idempotencja wobec remote'a.** Lokalna flaga „utworzono" jest dokładnie tym, co
  unieważnia crash między wywołaniem create i zapisem flagi.
- **Usunięty `packageName`** — jeden z sześciu duplikatów z `CTF-002`; brak
  konsumentów potwierdzony grepem.

## Findingi z własnego audytu (naprawione przed handoffem)

1. **Token w query stringu URL-a przechodził** (HIGH). `?private_token=glpat-...` to
   udokumentowana metoda uwierzytelniania GitLaba; traktowanie wyłącznie userinfo jako
   „części URL-a z credentialem" zostawiało łatwiejszy kanał otwarty. Sonda przeszła
   **obie** bramki. Naprawa: query i fragment odrzucone.
2. **Opis MR wyciekał token z `task_summary`** (HIGH). To proza autorstwa modelu
   **publikowana** na remote, gdzie nie da się jej odpublikować. Naprawa: redakcja pól
   prozatorskich tym samym zestawem wzorców co output komend.

## Testy i kontrole

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/connector-gitlab/test` | 0 | 37/37 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1375/1375, 122 pliki** |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| repo lint error count | — | 3 (baseline `CTF-008`, bez zmian) |

## Mutation testing

| Mutacja | Wynik |
|---|---|
| kontrola podpisu usunięta | 1 FAIL |
| okno świeżości usunięte | 2 FAIL |
| dedupe delivery id usunięty | 1 FAIL |
| allowlista na eventach wejściowych usunięta | 1 FAIL |
| lookup MR pominięty (zawsze create) | 2 FAIL |
| output pusha nieredagowany | 1 FAIL |
| bramka `writes_enabled` usunięta | 1 FAIL |
| refinement userinfo usunięty | 1 FAIL |
| kontrola query/fragment usunięta (schemat) | 1 FAIL |
| kontrola query/fragment usunięta (assert) | 1 FAIL |
| redakcja prozy opisu usunięta | 1 FAIL |

## Znane ograniczenia

- **GitLab API i pusher są fake'ami** — zgodnie z `Required verification` taska
  („fake GitLab API/webhook contract tests"). Są to jednak **fake'i nagrywające**:
  zapisują każdy argument, więc asercje dotyczą tego, co faktycznie poszłoby na wire,
  w szczególności czy token pojawił się w URL-u. Sandbox integration test wymaga
  jawnie dostępnych credentiali, których nie ma — należy do RA-018.
- Brak persystencji: `GitLabDeliveryLog` ma implementację in-memory. Wersja oparta o
  bazę należy do RA-018 (golden path) razem z Discord routingiem. Migracja `028` wolna.
- Rate limit i pipeline ordering: kontrakt zdarzeń niesie `observed_at_ms` i
  `commit_sha`, ale kolejkowanie należy do konsumenta.
- `CTF-006` — connector konsumuje `redactCommandOutput` z RA-012; zwinięcie wzorców
  do wspólnego źródła nadal należy do RA-024.

## Stan dla audytu

Working tree czysty, `48e04f5`. Audyt powinien niezależnie sprawdzić sześć kryteriów
i poszukać dalszych kanałów wycieku credentiala — dwa znalezione dotąd przechodziły
wszystkie testy.
