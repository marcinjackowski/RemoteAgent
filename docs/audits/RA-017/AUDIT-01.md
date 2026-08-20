# RA-017 — Audit 01

## Metadata

- Task: `RA-017`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-017/HANDOFF-01.md`
- Data: `2026-08-20`
- Zakres diffu: `d307eed..48e04f5`
- **Werdykt: `PASS`**

## Podstawa werdyktu

Odczyt diffu, samodzielne bramki, 11 mutacji i sondy adwersarialne na
`Audit focus` taska: repository scope, credential leakage, remote idempotency,
webhook signatures, powiązanie SHA i bezpieczeństwo write feature flag.

Sondy znalazły dwa findingi HIGH — **piąty task z rzędu**. Oba dotyczyły wycieku
credentiala i oba przechodziły wszystkie istniejące testy.

## Kryteria akceptacji — każde sprawdzone osobno

| # | Werdykt | Jak sprawdzone |
|---|---|---|
| 1 | PASS | typ brandowany, jedyny producent to `resolve`; sonda potwierdziła odrzucenie `"42"` (string), `42.0`, `" acme/repo"`, `"acme/repo "` oraz prefiksów i wariantów wielkości liter; event o obcym projekcie odrzucony i audytowany |
| 2 | PASS | dwa przebiegi → `create` **dokładnie raz**; świeży publisher (symulowany restart) nie duplikuje; mutacja pomijająca lookup wywala 2 testy |
| 3 | PASS **po dwóch naprawach** | userinfo, query i fragment odrzucone; token jako osobny argument (asercja na nagranych argumentach); redakcja stdout, stderr, błędu pusha, zwracanych wartości **i prozy opisu**. Patrz findingi 1 i 2 |
| 4 | PASS | realne payloady pipeline/job/push/MR; `refs/heads/` obcinane; SHA rozpoznawane z czterech pozycji (`last_commit.id`, `object_attributes.sha`, `checkout_sha`, `after`) |
| 5 | PASS | trzy bramki testowane osobno; podpis pusty/zły/z sufiksem; timestamp stary **i przyszły**; replay w oknie; audit asertowany w każdym przypadku; sekret nieobecny w audycie |
| 6 | PASS | intent bez receiptów, bez readiness i ze skróconym SHA nieprzedstawialny; „None known" obecne; `ESCALATED` ujawniane, nie ukrywane; opis wysłany do API sprawdzony pod kątem treści |

## Findingi

### Finding 1 — token w query stringu URL-a przechodził obie bramki (HIGH, **naprawiony**)

Sonda audytora:

```text
SCHEMA-OK  ASSERT-OK  https://.../repo.git?private_token=glpat-LEAKME1234567890
SCHEMA-OK  ASSERT-OK  https://.../repo.git#glpat-LEAKME1234567890
```

`?private_token=` jest **udokumentowaną metodą uwierzytelniania GitLaba**, więc
uznanie wyłącznie userinfo za „część URL-a z credentialem" zostawiało łatwiejszy
kanał otwarty. URL clone'a ani web URL nie potrzebują ani query, ani fragmentu.

**Naprawa.** Oba odrzucone w `gitlabRemote` i w `assertNoCredentialInUrl`.

### Finding 2 — opis MR publikował token z `task_summary` (HIGH, **naprawiony**)

```text
description leaks token -> !! YES
```

`task_summary` i `unresolved_risks` to jedyna proza autorstwa modelu w tym pakiecie,
a opis jest **publikowany na remote**, skąd nie da się go odpublikować. Sonda
umieściła token w summary i odczytała go dosłownie w wyrenderowanym opisie.

**Naprawa.** Redakcja pól prozatorskich tym samym zestawem wzorców co output komend —
co pokrywa też bardziej prawdopodobny wypadek: summary cytujące komendę, której output
zawierał absolutną ścieżkę hosta.

### Probe'y bez findingu

Warte zapisania, bo wykluczają całe klasy:

- allowlista odrzuca `"42"`, `42.0`, `" acme/repo"`, `"acme/repo "` — dopasowanie
  dokładne wytrzymuje warianty typu i whitespace;
- **odrzucone delivery nie zużywa swojego id**: legalna retransmisja po próbie ze
  złym podpisem jest nadal akceptowana. Odwrotne zachowanie byłoby DoS-em na własny
  webhook;
- `http://`, `file://` i `ssh://` z hasłem odrzucone przez schemat.

Brak otwartych findingów BLOCKER/HIGH/MEDIUM na moment werdyktu.

## Kontrole wykonane samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1375/1375, 122 pliki** |
| `pnpm vitest run packages/connector-gitlab/test` | 0 | 37/37 |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| 11 mutacji | — | każda wykryta |
| sondy adwersarialne | — | **findingi 1 i 2** |

## Bezpieczeństwo — ocena wprost wobec `Audit focus`

1. **Repository scope**: strukturalny przez typ brandowany, nie przez kontrolę,
   którą wołający mógłby pominąć. Dopasowanie dokładne w obie strony (id i ścieżka).
2. **Credential leakage**: cztery kanały zamknięte — URL (userinfo + query +
   fragment), output procesu, wartości zwracane, proza opisu. Broker nie wystawia
   tokena jako property, więc nie da się go odczytać z serializowanego obiektu.
3. **Remote idempotency**: ustalana wobec remote'a; lokalna flaga byłaby błędna po
   crashu między create i zapisem flagi.
4. **Webhook signatures**: `timingSafeEqual` po digestach o stałej szerokości, więc
   ani wartość, ani długość nie są kanałem czasowym; weryfikacja przed parsowaniem.
5. **Powiązanie SHA**: `commit_sha` w kontrakcie zdarzenia, rozpoznawany z czterech
   pozycji payloadu, walidowany jako 40-hex.
6. **Write feature flag**: `writes_enabled` domyślnie `false`, pochodzi z
   server-owned allowlisty; mutacja usuwająca bramkę wywala test. Nic, co wysyła
   model, tego nie przełącza.

## Ograniczenia, które potwierdzam jako właściwe dla tego taska

- GitLab API i pusher są **fake'ami nagrywającymi**, zgodnie z `Required
  verification`. Sandbox integration test wymaga jawnie dostępnych credentiali —
  nie ma ich, więc należy do RA-018.
- `GitLabDeliveryLog` in-memory; wersja bazodanowa i Discord routing należą do
  RA-018 golden path.

## Werdykt

- Werdykt: `PASS`

Sześć kryteriów spełnione i sprawdzone osobno. Dwa findingi HIGH znalezione w tym
audycie i naprawione z testami regresyjnymi przed werdyktem.

Status: `AUDIT_PASSED` → `DONE`. **Odblokowuje RA-018** — wszystkie jego dziewięć
zależności jest `DONE`, więc golden path jest gotowy do startu.
