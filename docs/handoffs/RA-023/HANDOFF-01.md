# RA-023 — HANDOFF-01

- Task: `RA-023` AgentCore Gateway and official MCP targets
- Data: `2026-08-21`
- Bazowy commit: `2c05ca3`
- Status po tym handoffie: `DONE` (`AUDIT-01` → `PASS`)

## Najważniejsze w jednym zdaniu

**Nie adoptujemy AgentCore Gateway** — [ADR-0008](../../decisions/ADR-0008-agentcore-gateway-verdicts.md),
`DEFER` dla wszystkich providerów na podstawie świeżo zweryfikowanej dokumentacji
dostawców. Powstały trzy rzeczy o wartości niezależnej od tej decyzji.

## Co powstało

| Ścieżka | Rola |
|---|---|
| `packages/contracts/src/credential-refresh-errors.ts` | **`CTF-001` domknięty** — jedna definicja `CredentialRefresh*Error` + `RefreshIntentStatus` |
| `packages/policy/src/external-boundary.ts` | containment: zewnętrzny boundary może ZAWĘŻAĆ, nigdy POSZERZAĆ (AC3) |
| `packages/policy/src/runtime-session.ts` | sesja runtime to transport; Postgres to authority (AC6) |
| `docs/research/RA-023-CAPABILITY-MATRIX.md` | dowody AC1 z cytatami i datą weryfikacji |
| `docs/decisions/ADR-0008-…md` | werdykty i warunki ponownego rozważenia |

## Bramka

```text
packages/policy/test                 239/239, 9 plików, exit 0
całe repo                            1793/1793, 141 plików, 2 przebiegi
turbo run typecheck --force          36 successful, 0 cached
pnpm run build --force               26 successful, 0 cached
sonda eksportów (wartości + typy)    `CredentialRefresh*` ZNIKŁY z obu list
```

**Żadnego wywołania AWS.** Decyzja właściciela `2026-08-21`.

## Co następny task musi wiedzieć

### `RA-024` (hardening) — wejście

1. **`CTF-006` nadal otwarty** i nadal należy do RA-024. RA-023 nie polega na
   `SecretRedactor` w żadnym miejscu, więc nie dodał czwartej lokalnej tabeli wzorców.
2. **`CTF-001` ZAMKNIĘTY.** Jeżeli plan RA-024 zakłada inaczej, jest nieaktualny. Klasy
   są w `contracts`; `database` i `policy` re-eksportują.
3. **AC5 to nasz inwariant, nie gwarancja dostawcy.** Nie znalazłem w dokumentacji AWS
   zdania gwarantującego, że token nie wraca do wołającego. Każdy nowy caller
   `evaluatePolicy` musi podawać `now` z zegara bazy (`ports.now(tx)`), inaczej backdated
   `now` reanimuje wygasły credential — dowiedzione sondą w RA-022-WU-03.
4. **`PolicyEvaluation.evidence` nosi już wszystko, czego potrzebuje audit log** (tool,
   case, connection, id-ki eventów kill switcha), ale **nikt tego nie zapisuje** do
   `audit_log`. To zakres RA-024.

### `RA-025` (AWS deployment/DR) — upraszcza się

Brak zasobów AgentCore Gateway oznacza **brak konfiguracji console-only**, której nie da
się odtworzyć z IaC w ćwiczeniu restore. To był realny problem dla DR i przestaje
istnieć. Zapisane w ADR-0008.

### Rzeczy, które wyglądają jak defekt, a są decyzją

1. **`WU-01`, `WU-02`, `WU-03` nie istnieją.** Odstąpione świadomie (ADR-0008), nie
   pominięte. `WU-03` byłby findingiem BLOCKER — drugi silnik refresh nad tymi samymi
   credentialami.
2. **AC4 nie jest spełnione.** Dotyczy wykrywania na granicy Gateway'a, której nie ma.
   Zapisane jawnie w audycie jako „nie ma czego spełniać", nie jako spełnione. Wraca w
   pełni przy adopcji.
3. **`containExternalManifest` odrzuca manifest powyżej 64 ofert CAŁOŚCIOWO**, nie ucina
   do pierwszych 64. Ucięcie oddałoby wybór „które 64" temu, kto kontroluje kolejność.
4. **Provider jest derywowany z NAZWY narzędzia**, nie z deklaracji boundary'a. Wygląda
   na nadmiar, jest reakcją na finding HIGH sondy: sprawdzanie tylko zadeklarowanego
   providera znaczyło, że oferta bez deklaracji pomijała kontrolę, i case scoped na
   `jira` dostawał tools Gmaila.
5. **`resolveToolProvider` jest prefiksowe, z asercją pokrycia**
   (`assertEveryToolHasProvider`). Narzędzie dodane do `ACTION_REGISTRY` z nierozpoznanym
   prefiksem staje się niedostępne przez boundary — cicho, w kierunku który WYGLĄDA
   bezpiecznie. Asercja zmienia to w awarię startu.

### Warunki powrotu do adopcji (z ADR-0008)

1. Google wyda oficjalny serwer MCP dla Gmail/Calendar z izolacją per-account.
2. Template Jiry zacznie przyjmować OAuth.
3. GitLab MCP przejdzie z Beta do GA.
4. Built-in templates staną się dodawalne przez API.

## Czyste drzewo

Wszystko zacommitowane.
