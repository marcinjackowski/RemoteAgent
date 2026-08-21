# RemoteAgent — least privilege review

- Task: `RA-024-WU-04`
- Ustalone: `2026-08-21`
- Rejestr maszynowy: `packages/observability/src/privileges.ts`
- Bramka: `pnpm vitest run test/security/least-privilege.test.ts`

## Co tu znaczy „least privilege"

**Nie** „najmniejszy istniejący scope" — to byłoby nieużywalne. Znaczy: **żaden
scope nie jest żądany, którego nie potrzebuje jakaś zarejestrowana akcja.**

Kierunek sprawdzenia jest sednem. Weryfikowanie „czy każda akcja ma scope?" nie
znajduje nic: brakujący scope psuje funkcję natychmiast i zostaje naprawiony.
Groźny jest przypadek odwrotny — scope dodany podczas developmentu, nigdy nie
usunięty i nigdy nie zauważony, bo wszystko działa. Grant, którego nikt nie używa,
nie może niczego umożliwić i jest dostępny dla wszystkiego, co się dostanie do
środka.

Dlatego rejestr jest sprawdzany testem w obie strony: scope bez uzasadnienia jest
**czerwonym testem**, a każdy write scope musi wskazywać akcję faktycznie obecną w
`ACTION_REGISTRY` i w tierze, który ten przegląd założył.

## Powierzchnia zapisu — pełna lista

To jedyne uprawnienia, które mogą wywołać efekt widoczny na zewnątrz. Krótka lista
celowo: reszta rejestru to odczyty.

| Provider | Scope | Akcje | Over-grant |
|---|---|---|---|
| Jira | `write:jira-work` | `jira.issue.comment` (R3), `jira.issue.transition` (R3), `jira.issue.delete` (R4) | **ACCEPTED** |
| GitLab | `write_repository` | `git.push.force` (R4), `gitlab.branch.delete` (R4) | **ACCEPTED** |
| GitLab | `api` | `gitlab.mr.draft.update` (R2), `gitlab.mr.comment` (R3), `gitlab.mr.merge` (R4) | **ACCEPTED** |
| Gmail | `https://www.googleapis.com/auth/gmail.compose` | `gmail.draft.create` (R2) | **ACCEPTED** |
| Calendar | `https://www.googleapis.com/auth/calendar.events` | `calendar.event.create/update/respond` (R3), `calendar.event.delete` (R4) | **ACCEPTED** |
| Discord | `SEND_MESSAGES_IN_THREADS` | `discord.post_status`, `discord.ask_decision` | brak |
| Discord | `CREATE_PUBLIC_THREADS` | `discord.open_case_thread` | brak |
| AWS | `secretsmanager:PutSecretValue` | `credential.refresh` | brak |

## Over-granty — decyzje i kontrole kompensujące

Pięć scope'ów jest **szerszych, niż potrzebujemy**, i żadnego nie da się zawęzić na
poziomie providera. Zapisuję je jako `ACCEPTED` z jawną kontrolą kompensującą,
zamiast usuwać wiersz, bo to realne ryzyko rezydualne — a `RA-026` AC3 wymaga, by
każde znane ryzyko miało ownera i decyzję `accept/fix/defer`.

### `gmail.compose` — najważniejszy z nich

Google **nie ma** scope'u „twórz draft, ale nigdy nie wysyłaj". `gmail.compose`
pozwala **wysłać**.

Tego nie da się naprawić w OAuth, więc jest zatrzymane deterministycznie:
`gmail.message.send` jest **celowo nieobecne** w `ACTION_REGISTRY`, a narzędzie
nieobecne w rejestrze rozwiązuje się do `R4` i zostaje odrzucone z
`UNKNOWN_ACTION`. Jedynym osiągalnym zapisem jest draft (`R2`).

Zauważ, gdzie leży kontrola: **nie** w liście dozwolonych narzędzi, lecz w tym, że
brak deklaracji jest odmową, nie zgodą (`CTF-010`, finding 4). Test
`least-privilege.test.ts` asertuje wprost, że `gmail.message.send` nie jest
zarejestrowane — bo kontrola kompensująca, której nikt nie sprawdza, jest
komentarzem.

### `write:jira-work`

Jira nie ma scope'u „tylko komentarz". Każdy zapis idzie przez `ACTION_REGISTRY`:
komentarz i transition są `R3` (dokładna zgoda właściciela), delete jest `R4`. Co
nie jest w rejestrze — jest `R4` i odrzucone.

### `write_repository`

Pozwala na force-push i usunięcie brancha. Oba są `R4`
(`git.push.force`, `gitlab.branch.delete`) i **nigdy** nie mogą być auto-allowed —
stwierdzone **dwukrotnie**, przez `APPROVAL_REQUIRED_TIERS` i przez
`assertR4NeverAutoAllowed`, bo awaria tego kryterium jest nieodwracalna.

**Zwykły push brancha case'a nie przechodzi przez policy engine** — i to jest
finding tego przeglądu, nie pominięcie. Zapisany jako `CTF-014`. Komentarz w
`ACTION_REGISTRY` mówi, że `R2` obejmuje „case-branch pushes", ale **takiego klucza
nie ma**, a ścieżka pushu (`connector-gitlab/src/merge-request.ts`) nigdy nie
wywołuje `evaluatePolicy`. To znów wzorzec `CTF-010`: komentarz opisuje gwarancję,
której kod nie daje.

Nie jest to jednak niekontrolowane — push jest zatrzymany trzema innymi warstwami:

1. `project.writes_enabled` jest **domyślnie wyłączone**; projekt jest celem zapisu
   tylko wtedy, gdy serwer tak powie;
2. `GitLabProjectAllowlist` jest **zamkniętą** listą, więc tokenem nie da się
   wskazać innego repozytorium;
3. allowlista argv w `git-lifecycle` dopuszcza **dziewięć** subkomend, więc
   `push --force` ani `branch -D` **nie da się złożyć** — to allowlista, nie
   denylista (`CTF-010`, finding 2).

Dlatego oceniam to jako LOW, nie HIGH: nie ma osiągalnej eskalacji, jest natomiast
rozjechanie kontraktu z komentarzem. Domknięcie wymaga ADR-a, bo dopisanie klucza
do `ACTION_REGISTRY` zmienia zaakceptowany kontrakt RA-022 — nie robię tego „po
drodze" w tasku o hardeningu.

### `api` (GitLab)

Scope gruby, nie da się zawęzić do operacji MR. Zatrzymany przez
`GitLabProjectAllowlist` — zamkniętą listę projektów, więc tokenem nie da się
wskazać innego repozytorium — plus tiery R2/R3/R4. Merge jest `R4`.

### `calendar.events`

Obejmuje create, update i delete bez podziału. Create/update/respond są `R3`,
delete `R4`. Dodatkowo per-case resource grant wiąże każdą akcję z **jednym** id
kalendarza, więc dwa konta nie mogą się nawzajem dosięgnąć.

## Scope'y zakazane

Lista, której brak jest **decyzją**, nie przeoczeniem. Denylista obok allowlisty
wygląda redundantnie (`CTF-010` finding 2 zaleca allowlisty), ale robi tu inną
robotę: dodanie któregoś z tych scope'ów wymaga **usunięcia linii z
uzasadnieniem**. Bez tego dopisanie `gmail.send` wyglądałoby jak zwykła praca nad
funkcją.

| Scope | Dlaczego nigdy |
|---|---|
| `https://www.googleapis.com/auth/gmail.send` | wysyłanie maila nie jest capability tego systemu; osiągalny jest tylko draft (R2) |
| `https://mail.google.com/` | pełny dostęp do skrzynki wraz z usuwaniem; nic tego nie potrzebuje |
| `https://www.googleapis.com/auth/gmail.modify` | pozwala usuwać i zmieniać wiadomości w skrzynce właściciela |
| `sudo` | impersonacja admina GitLaba; eskalacja uprawnień bez zastosowania |
| `admin:org` | administracja organizacją jest poza każdą zarejestrowaną akcją |
| `iam:*` | mutacja IAM pozwoliłaby systemowi poszerzać własne uprawnienia |
| `bedrock:*` | wildcard ukrywa, które operacje modelu są używane; `RA-025` AC2 wymaga ADR dla wildcardu |
| `s3:*` | wildcard na obiekty; zapisy artefaktów są ograniczone do jednego prefiksu per case |

Test asertuje dodatkowo, że **żaden** żądany scope nie zawiera `*` ani nie wygląda
na administracyjny (`admin`, `sudo`, `owner`, `superuser`) — więc nowy scope tego
kształtu zaświeci się na czerwono, nawet jeśli nikt nie dopisze go do denylisty.

## Odczyty

Pełna lista jest w rejestrze; tutaj tylko zasada. Każdy provider ma osobny scope
`*.readonly` / `read_*` i osobny capability string (`jira:read`, `gitlab:read`,
`gmail:read`, `calendar:read`) sprawdzany przez broker. Rozdzielenie capability od
scope'u OAuth jest celowe: scope mówi, co **token** może, capability mówi, co
**narzędzie w tym case** może — i to drugie jest zawężane przez per-case grant.

`bedrock:InvokeModel` i `secretsmanager:GetSecretValue` są sklasyfikowane jako
odczyty, bo nie produkują efektu zewnętrznego widocznego dla człowieka.
`secretsmanager:PutSecretValue` jest zapisem i ma własny wiersz — refresh
credentiala jest jedynym, co go używa, i jest leasowany, a niejednoznaczny zapis
**nie jest ponawiany**.

## Czego ten przegląd nie obejmuje

1. **Konkretne polityki IAM i ich boundary** — `RA-025` (AC2: role per component,
   bez szerokich wildcardów bez ADR). Tutaj jest lista *akcji* IAM, których
   potrzebujemy, nie kształt roli.
2. **Rotacja credentiali** — mechanizm jest w `packages/policy`
   (`credential-refresh.ts`), harmonogram należy do `RA-025`.
3. **Uprawnienia w bazie** (role Postgresa) — `RA-025`. Aplikacja łączy się dziś
   jako jeden użytkownik; rozdział na role read/write jest zadaniem deploymentu.
