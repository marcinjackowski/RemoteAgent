# ADR-0010 — Single-owner Jira auth: personal API token, nie OAuth 3LO

- Status: Accepted
- Date: 2026-08-24
- Task: RA-030

## Kontekst

RemoteAgent jest **prywatnym systemem jednego właściciela** (Master Plan §1: „prywatny system
pracy sterowany z Discorda"). Właściciel potwierdził (`2026-08-24`), że system nie będzie
udostępniany nikomu i **nie ma wymogu multi-tenancy** ani wielu kont.

Master Plan §3.3 zakłada, że „pierwszy runtime używa OAuth 3LO / Bearer". Rozpoznanie
(`2026-08-24`) wykazało, że OAuth 3LO **nie jest zbudowany**: brak flow authorization-code
(redirect w ingressie jest pusty), brak realnego HTTP-refresh access tokenu przeciwko Atlassian.
Istnieje jedynie schemat metadanych (`oauth_expires_at/refresh_after/revoked_at`) i bookkeeping
odświeżania (`credential-refresh-intent`), oraz `CredentialVault` (interfejs + `LocalCredentialVault`).

`JiraRestClient` domyślnie wysyła `Authorization: Bearer`, ale **transport jest sankcjonowanym
punktem wstrzyknięcia**: `scripts/dev/jira-poll.ts` podmienia nagłówek na `Basic base64(email:token)`
bez osłabiania audytowanego klienta (origin allow-list, walidacja ścieżki, odrzucanie
przekierowań, klasyfikacja retry pozostają). Audyt RA-016 zaakceptował ten wzorzec.

## Decyzja

Produkcyjne uwierzytelnianie Jiry używa **personal API token właściciela + Basic auth**, nie
OAuth 3LO.

- Token pochodzi ze **środowiska procesu** (`JIRA_EMAIL` + `JIRA_API_TOKEN`), trzymany w pamięci
  jako `Uint8Array` i zerowany po użyciu (klient już robi `token.fill(0)` po każdym żądaniu).
  Nie trafia do logów (SecretRedactor), promptów ani kontekstu modelu (AGENTS.md §3).
- Klient dostaje **transport Basic** — ten sam wzorzec co dev-skrypt, wydzielony do
  reużywalnej funkcji. Domyślny Bearer klienta nie jest usuwany; transport go nadpisuje.
- `CredentialVault` (in-memory `LocalCredentialVault`) **nie jest** na tej ścieżce warstwą
  persystencji: dla pojedynczego, długożyciowego API tokenu env jest źródłem prawdy, a vault
  dawałby indirekcję bez zysku (brak rotacji/refresh do wykonania). Pozostaje w kodzie jako
  boundary dla przyszłej historii OAuth/multi-connection.

### Dlaczego to jest „zrobione dobrze", nie skrót

1. **Bezpieczeństwo dopasowane do modelu zagrożeń.** Ryzykiem systemu jednego właściciela nie
   jest cross-tenant leakage (nie ma innych tenantów), lecz wyciek sekretu do logów/modelu —
   pokryty redakcją i zerowaniem bufora. API token ma węższy blast radius niż długo-utrzymywana
   sesja OAuth, i jest rewokowalny jednym kliknięciem w Atlassian.
2. **Personal API token to wspierany produkcyjny mechanizm** dla integracji server-to-server w
   Jira Cloud, nie tryb deweloperski.
3. **OAuth 3LO byłby narzutem bez zysku**: zgoda użytkownika, redirect, store i refresh tokenu
   mają sens przy wielu kontach/użytkownikach — czego z definicji nie ma.

## Konsekwencje

- Odejście od Master Plan §3.3 jest świadome i ograniczone do warstwy auth; reszta kontraktów
  (scope owner/connection, UNTRUSTED_DATA, policy) bez zmian.
- Gdyby kiedyś pojawił się drugi właściciel/konto, OAuth 3LO wraca jako osobny task; ten ADR
  wtedy zostaje `Superseded`. Punkty wstrzyknięcia (transport, `getAccessToken`) są tak dobrane,
  by tamta zmiana nie dotykała reszty.
- `env.sh`/deployment: worker i scheduler dostają `JIRA_*` (origin, email, token, projekty) oraz
  konfigurację kanałów Discord (do routingu case→#jira). Brak `JIRA_*` = handler/ task
  niezarejestrowany (fail-closed, jak `jira.webhook.renewal`).
