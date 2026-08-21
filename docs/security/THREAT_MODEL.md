# RemoteAgent — threat model and trust boundaries

- Task: `RA-024-WU-02` (AC1)
- Ustalone: `2026-08-21`
- Rejestr maszynowy: `packages/observability/src/trust-boundaries.ts`
- Bramka: `pnpm vitest run test/security/threat-model.test.ts`

## Dlaczego ten dokument ma test

Model zagrożeń żyjący wyłącznie w prozie rozjeżdża się w momencie dodania szóstego
providera — i **nic się nie psuje**. To dokładnie wzorzec `CTF-010` („komentarz
opisuje gwarancję, której kod nie daje") przeniesiony na dokumentację
bezpieczeństwa.

Dlatego granice są zapisane dwukrotnie: jako proza tutaj i jako rejestr w
`packages/observability/src/trust-boundaries.ts`. Test sprawdza zgodność **w obie
strony** oraz — co okazało się najważniejsze — że **każda cytowana kontrola jest
plikiem, który istnieje**.

Ta trzecia asercja nie jest teoretyczna. Przy pisaniu tego rejestru **cztery
cytowane ścieżki były błędne** (`connector-gitlab/src/allowlist.ts`,
`connector-jira/src/webhook-ingress.ts`, `git-lifecycle/src/publish.ts` oraz dwie
ścieżki katalogowe bez pliku). Bez tego testu model zagrożeń wskazywałby kontrole
w miejscach, w których ich nie ma — a to czyta się **dokładnie tak samo
autorytatywnie** jak ścieżka prawdziwa. Cytat bez weryfikacji jest gorszy od braku
cytatu, bo brzmi jak dowód.

## Zasady nadrzędne, z których wynikają wszystkie kontrole

Cztery reguły z `AGENTS.md` i Master Planu, do których sprowadza się każda pozycja
poniżej. Nie powtarzam ich w każdej sekcji.

1. **Model nie jest warstwą autoryzacji.** Uprawnienia, scope i policy ustalane są
   deterministycznie poza modelem. Żaden argument narzędzia nie poszerza scope.
   Egzekwowane w `packages/policy/src/policy-engine.ts`: tier pochodzi z
   server-owned rejestru, nie z wejścia.
2. **Wszystkie treści zewnętrzne są `UNTRUSTED_DATA`.** Typ wymusza obecność
   markera — nie ma domyślnej wartości (`packages/contracts/src/trust.ts`).
3. **Granica zewnętrzna może zawężać, nigdy poszerzać**
   (`packages/policy/src/external-boundary.ts`, RA-023).
4. **Side effect bez potwierdzonego receiptu pozostaje `AMBIGUOUS`, nigdy
   `SUCCESS`** i nigdy nie jest automatycznie powtarzany
   (`packages/policy/src/action-executor.ts`).

## Słownik klas zagrożeń

Zamknięty słownik, żeby granica nie mogła zostać opisana jako „przejrzana" bez
powiedzenia, czego dotyczy. Wartości pochodzą z `ThreatClass` w rejestrze.

| Klasa | Znaczenie |
|---|---|
| `PROMPT_INJECTION` | wroga treść dociera do modelu i próbuje go przekierować |
| `EXFILTRATION` | sekrety albo dane prywatne wychodzą kanałem wyglądającym niewinnie |
| `CROSS_TENANT_LEAK` | dane jednego konta albo repozytorium stają się widoczne dla innego |
| `PRIVILEGE_ESCALATION` | wywołujący uzyskuje efekt, którego nigdy mu nie przyznano |
| `DUPLICATE_OR_AMBIGUOUS_EFFECT` | zapis zewnętrzny dzieje się dwa razy albo jego wynik jest nieustalony |
| `RESOURCE_EXHAUSTION` | druga strona jest zalewana albo zalewa nas |
| `EVIDENCE_LOSS` | dowód potrzebny do odtworzenia przebiegu ginie albo jest podrabiany |
| `COST_RUNAWAY` | wydatek rośnie bez ograniczenia i bez czerwonego testu |

## Diagram granic zaufania

```text
                         ┌─────────────────────────────────────────┐
    OWNER                │        RemoteAgent (trusted core)       │
      │                  │                                         │
      ▼                  │  ┌───────────────────────────────────┐  │
 ┌──────────┐   commands │  │ deterministic policy / executor   │  │
 │ Discord  ├────────────┼─▶│ (tier, scope, approval, receipt)  │  │
 │ (tb-discord)          │  └───────────────┬───────────────────┘  │
 └──────────┘◀───────────┼──────────────────┘                      │
      status/questions   │                  │ tool intents only     │
                         │                  ▼                       │
 ┌──────────┐  UNTRUSTED │  ┌───────────────────────────────────┐  │
 │  Jira    ├────────────┼─▶│ agent orchestrator                │  │
 │(tb-jira) │◀───R3 ─────┼──│  context is REDACTED before send  │  │
 ├──────────┤            │  └───────────────┬───────────────────┘  │
 │  GitLab  ├────────────┼─▶                │                       │
 │(tb-gitlab)◀───R2/R4───┼──                ▼                       │
 ├──────────┤            │        ┌──────────────────┐             │
 │ Gmail ×2 ├────────────┼─▶      │ Bedrock          │             │
 │(tb-gmail)◀───R2───────┼──      │ (tb-bedrock)     │             │
 ├──────────┤            │        └──────────────────┘             │
 │Calendar×2├────────────┼─▶                │                       │
 │(tb-calendar)◀─R3/R4───┼──                ▼                       │
 ├──────────┤            │        ┌──────────────────┐             │
 │ MCP srv  ├────────────┼─▶      │ workspace (DENY  │             │
 │ (tb-mcp) │◀───────────┼──      │ network)         │             │
 └──────────┘            │        │ (tb-workspace)   │             │
                         │        └──────────────────┘             │
 ┌──────────┐            │                  │                       │
 │ Secrets  ├────────────┼─▶                ▼                       │
 │(tb-secrets)           │   ┌──────────────────────────────────┐  │
 └──────────┘            │   │ PostgreSQL — system of record    │  │
                         │   │ (tb-postgres) append-only audit  │  │
 ┌──────────┐            │   └──────────────────────────────────┘  │
 │Artifacts │◀───────────┼──────────────────┘                      │
 │(tb-artifacts)         │   redacted on write                     │
 └──────────┘            └─────────────────────────────────────────┘
```

Dwie rzeczy, które ten diagram mówi jawnie:

- **Bedrock jest po zewnętrznej stronie granicy.** Model jest niezaufanym
  komponentem, nie częścią rdzenia. Kontekst jest redagowany **przed** wysłaniem, a
  wracają z niego wyłącznie *intencje* narzędzi — nigdy decyzje policy.
- **Żadna strzałka „out" nie wychodzi bez przejścia przez policy/executor.** To
  jedyna droga do efektu zewnętrznego, co czyni kill switch realnie skutecznym
  (`tb-postgres` → `AC6`).

## Granice

Każda sekcja ma anchor `tb-<id>` zgodny z rejestrem; test tego wymaga.

### <a id="tb-jira"></a>Jira Cloud

- Kierunek: `BIDIRECTIONAL`
- Data flow: pola issue, komentarze i webhook deliveries wchodzą; komentarze i
  transitions wychodzą.
- Zagrożenia: `PROMPT_INJECTION`, `EXFILTRATION`, `DUPLICATE_OR_AMBIGUOUS_EFFECT`,
  `CROSS_TENANT_LEAK`.

Treść issue jest **głównym wektorem prompt injection** w tym systemie: właściciel
zleca pracę taskiem Jira, więc wroga instrukcja w opisie jest na najkrótszej
możliwej ścieżce do modelu. Kontrola nie polega na wykrywaniu injectiona (to
zawodzi), lecz na tym, że model nie może niczego autoryzować: komentarz i
transition są `R3`, więc wymagają dokładnej zgody właściciela, a `jira.issue.delete`
jest `R4`.

Webhook to druga, cichsza droga wejścia — dlatego podpis i replay są sprawdzane w
`webhook/verify.ts`, zanim payload cokolwiek dotknie.

### <a id="tb-gitlab"></a>GitLab

- Kierunek: `BIDIRECTIONAL`
- Data flow: treść repozytorium, stan MR i pipeline wchodzą; branch, draft MR i
  komentarze wychodzą.
- Zagrożenia: `PROMPT_INJECTION`, `EXFILTRATION`, `PRIVILEGE_ESCALATION`,
  `DUPLICATE_OR_AMBIGUOUS_EFFECT`.

Tu mieszka najgroźniejsza para uprawnień: `gitlab.mr.merge` i `git.push.force` są
`R4` i **nigdy** nie mogą być auto-allowed — stwierdzone dwoma niezależnymi
mechanizmami (`APPROVAL_REQUIRED_TIERS` oraz `assertR4NeverAutoAllowed`), bo
awaria tego kryterium jest nieodwracalna: zmergowanego MR nie odmerguje poprawka
policy.

`glpat-` w URL-u remote'a był realnym defektem RA-017 (`CTF-010`), dlatego token
jest przekazywany jako argument, a wzorce `glpat-`/userinfo są w jednej wspólnej
tabeli (`CTF-006`).

### <a id="tb-gmail"></a>Gmail — dwa niezależne konta

- Kierunek: `BIDIRECTIONAL`
- Data flow: wątki i wiadomości wchodzą; drafty wychodzą. Dwa konta, nigdy złączone.
- Zagrożenia: `PROMPT_INJECTION`, `CROSS_TENANT_LEAK`, `EXFILTRATION`.

Kryterium §13.6 Master Planu wymaga, by konta prywatne i SonderMind **nie
przeciekały**. Izolacja nie jest konwencją nazewniczą: to osobne connection per
konto, a scope case'a jest przecięciem grantów case'a z aktualnie skonfigurowanymi
scope'ami connection (`scope.ts`), więc alias nie może wskazać cudzego konta.

Warto zauważyć, czego **nie ma** w rejestrze akcji: `gmail.message.send`. Wysłanie
maila nie jest zarejestrowaną akcją, więc nie ma tieru — a nieznane narzędzie jest
`R4` i zostaje odrzucone. Możliwy jest tylko draft (`R2`).

### <a id="tb-calendar"></a>Google Calendar — dwa niezależne konta

- Kierunek: `BIDIRECTIONAL`
- Data flow: eventy i watch notifications wchodzą; create/update/respond wychodzą.
- Zagrożenia: `PROMPT_INJECTION`, `CROSS_TENANT_LEAK`,
  `DUPLICATE_OR_AMBIGUOUS_EFFECT`.

Ta sama izolacja dwóch kont co w Gmailu. Specyfiką jest `watch expiry`: kanał
notyfikacji wygasa, a niewznowiony daje **ciche** przestanie działać — dlatego
renewal failure jest jedną z czterech obowiązkowych klas alertu (`AC4`), a nie
tylko logiem.

### <a id="tb-discord"></a>Discord — kanał kontrolny właściciela

- Kierunek: `BIDIRECTIONAL`
- Data flow: komendy i odpowiedzi decyzyjne właściciela wchodzą; status i pytania
  wychodzą.
- Zagrożenia: `PROMPT_INJECTION`, `PRIVILEGE_ESCALATION`, `EXFILTRATION`.

Discord jest jednocześnie **kanałem autoryzacji** i kanałem niezaufanym — kto inny
może pisać na serwerze. Tożsamość właściciela jest sprawdzana po stronie serwera
(`authorization.ts`), a nie brana z treści wiadomości; `custom_id` interakcji jest
mintowany przez nas i nie jest parsowany jako źródło uprawnień.

Kierunek wyjściowy jest wektorem exfiltracji: status i pytania cytują treść
zewnętrzną i błędy, więc przechodzą przez redakcję.

### <a id="tb-bedrock"></a>Amazon Bedrock — model

- Kierunek: `BIDIRECTIONAL`
- Data flow: prompt i wyniki narzędzi wychodzą; completions i tool intents wchodzą.
- Zagrożenia: `PRIVILEGE_ESCALATION`, `EXFILTRATION`, `COST_RUNAWAY`,
  `RESOURCE_EXHAUSTION`.

Model jest **poza** granicą zaufania. Wyjście modelu to `UNTRUSTED_DATA` na równi z
komentarzem w Jirze — dokładnie ten defekt (`POLICY_NOT_EXTENSIBLE`) zablokował
RA-012: kod walidował wartość dostarczoną przez model zamiast usunąć ją z jego
wyjścia.

Kierunek „out" jest realną drogą wycieku, bo kontekst zawiera treść repozytorium i
wyniki narzędzi. `CTF-006` dowiódł, że redakcja tej ścieżki była niekompletna
(`compaction.ts` konstruował `SecretRedactor` bez `knownSecrets`), i to jest
domknięte w `WU-01`.

`COST_RUNAWAY` jest tu, a nie w „operations": pętla tool-loop z retry to mechanizm,
w którym koszt rośnie bez żadnego czerwonego testu, dlatego licznik tokenów ma
próg anomalii (`AC4`).

### <a id="tb-mcp"></a>Serwery narzędzi MCP

- Kierunek: `BIDIRECTIONAL`
- Data flow: deskryptory i wyniki narzędzi wchodzą; wywołania wychodzą.
- Zagrożenia: `PRIVILEGE_ESCALATION`, `PROMPT_INJECTION`, `EXFILTRATION`.

Deskryptor MCP niesie podpowiedzi w rodzaju `readOnlyHint`. Przychodzą kanałem
niezaufanym, więc są metadanymi, nigdy autoryzacją. Adnotacja twierdząca niższy
tier niż rejestr nie jest **ignorowana** — jest **odmową**, bo skoro się nie
zgadza, to coś jest nie tak po drugiej stronie, a kontynuowanie na wartości z
rejestru to ukryłoby.

Narzędzie nieobecne w rejestrze jest `R4`, nie `R0`: brak deklaracji nie jest zgodą
(`CTF-010`, finding 4).

### <a id="tb-workspace"></a>Workspace filesystem

- Kierunek: `BIDIRECTIONAL`
- Data flow: treść repozytorium i output komend wchodzą; zapisy plików i komendy
  wychodzą.
- Zagrożenia: `PROMPT_INJECTION`, `EXFILTRATION`, `CROSS_TENANT_LEAK`,
  `RESOURCE_EXHAUSTION`.

Komendy działają domyślnie `network-DENY`, więc kod z repozytorium nie ma wyjścia
sieciowego, którym mógłby coś wysłać. Ścieżki są weryfikowane wobec roota; jeden
writer na workspace danego `case_id`.

Dwie subtelności zapisane, bo obie były realnymi findingami:

- **Pliki instrukcji.** `isForbiddenPath` z RA-011 zna credentiale i VCS, ale **nie
  zna** `AGENTS.md`/`CLAUDE.md` (`CTF-009`) — bo RA-011 *musi* je czytać, żeby
  zbudować profil. Warstwa model-facing dokłada własną bramkę
  (`toolset.ts`/`isProtectedPath`), zamiast dziedziczyć cudzą.
- **Output komendy to głównie host paths.** Stack trace i echo `cwd` to wyciek
  topologii hosta do kontekstu modelu, dlatego redakcja outputu nie jest opcjonalna
  i dlatego `CTF-006` był HIGH, a nie MEDIUM.

### <a id="tb-postgres"></a>PostgreSQL — system of record

- Kierunek: `BIDIRECTIONAL`
- Data flow: każdy case, checkpoint, job, approval, action i receipt.
- Zagrożenia: `EVIDENCE_LOSS`, `CROSS_TENANT_LEAK`,
  `DUPLICATE_OR_AMBIGUOUS_EFFECT`.

Postgres jest **authority**, także po odrzuceniu AgentCore (ADR-0008). `audit_log`
jest append-only przez trigger bazodanowy, nie tylko przez API repozytorium — więc
inwariant trzyma także wtedy, gdy przyszły caller spróbuje go ominąć.

Najważniejsza nauka z `CTF-005`: **wiązanie z mutowalnym licznikiem nie jest
wiązaniem.** Approval jest fencowany na najwyższej kiedykolwiek zapisanej rewizji z
append-only `case_checkpoints`, nie na `cases.checkpoint_revision`, bo cofnięcie
licznika (recovery, restore, naprawa operatorska) wskrzeszało grant już odrzucony
jako `STALE_REVISION`.

### <a id="tb-artifacts"></a>Artifact i evidence store

- Kierunek: `OUTBOUND`
- Data flow: logi testów, diffy i evidence review, do przeczytania przez
  właściciela.
- Zagrożenia: `EXFILTRATION`, `EVIDENCE_LOSS`.

Artefakty są tym, co właściciel czyta, więc sekret w logu testu jest wyciekiem
trwałym, nie ulotnym. Redakcja następuje **przy zapisie**; znane roots (workspace,
artifact) są podstawiane przed wzorcami, bo żaden wzorzec nie zna ścieżki tego
konkretnego przebiegu.

### <a id="tb-secrets"></a>Secret storage — AWS Secrets Manager

- Kierunek: `INBOUND`
- Data flow: materiał credentiala, dla jednego connection naraz.
- Zagrożenia: `EXFILTRATION`, `PRIVILEGE_ESCALATION`,
  `DUPLICATE_OR_AMBIGUOUS_EFFECT`.

Credential jest **używany**, nigdy zwracany wywołującemu (`credential-vault.ts`).
Model nie otrzymuje ani refresh, ani access tokenu (RA-023 AC5).

Refresh jest leasowany, a niejednoznaczny zapis credentiala **nie jest ponawiany** —
`CredentialWriteAmbiguousError` istnieje właśnie dlatego, że powtórzony refresh
niszczy token, którego druga strona już wydała.

`SecretRedactor` maskuje wrażliwe klucze **po nazwie**, nie tylko po wartości
(`AUDIT-01 HIGH-03`), bo wartość nieznana z rejestru inaczej przeszłaby.

## Jak każda kontrola jest dowodzona

Zgodnie z ADR-0007 bramką jest uruchomiona komenda. Mapowanie granic na suity:

| Granica | Suita dowodowa |
|---|---|
| `tb-jira`, `tb-gitlab` | `test/golden-path/`, `packages/connector-*/test/` |
| `tb-gmail`, `tb-calendar` | `test/security/cross-account.test.ts`, `packages/connector-*/test/` |
| `tb-discord` | `packages/discord/test/` |
| `tb-bedrock`, `tb-workspace` | `test/security/canary.test.ts` (logi, traces i kontekst modelu **osobno**) |
| `tb-mcp` | `packages/mcp-tool-broker/test/malicious.integration.test.ts` |
| `tb-postgres` | `test/security/retention.test.ts`, `test/security/kill-switch-drill.test.ts` |
| `tb-artifacts` | `test/security/canary.test.ts` |
| `tb-secrets` | `packages/policy/test/`, `test/security/canary.test.ts` |

Kompletność samego modelu: `test/security/threat-model.test.ts`.

## Co ten model jawnie zostawia poza zakresem

Zapisane, bo „nie wspomniane" czyta się jak „pokryte".

1. **Bezpieczeństwo infrastruktury AWS** (IAM, VPC, KMS, ingress) — RA-025. Ten
   dokument opisuje granice aplikacyjne.
2. **AgentCore Gateway** — nie jest wdrażany (ADR-0008), więc nie ma tej
   powierzchni.
3. **Wykrywanie prompt injection jako mechanizm obronny.** Świadomie nie polegamy
   na detekcji. Obrona jest strukturalna: model nie ma autoryzacji, więc udany
   injection nie daje uprawnień.
4. **Złośliwy właściciel.** Właściciel jest w modelu zaufania. Chronimy go przed
   pomyłką (approval, kill switch, audit), nie przed sobą samym.
5. **Kompromitacja hosta.** Jeżeli atakujący wykonuje kod jako proces
   RemoteAgent, żadna z tych kontrol nie obowiązuje.
