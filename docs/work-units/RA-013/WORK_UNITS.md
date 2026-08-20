# RA-013 — Work units

## Metadata

- Task: `RA-013`
- Plan status: `ACTIVE` (zrewidowany `2026-08-20` przy starcie; RA-010 i RA-012
  oba `DONE`)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md) —
  jedna rola wykonawcza; bramką jest uruchomiona komenda
- Base commit: `7346cd4`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/test-evidence/test`

## Weryfikacja założeń planu przy starcie (`2026-08-20`)

Sprawdzone w kodzie, nie przyjęte z rewizji 1:

| Założenie rewizji 1 | Stan faktyczny |
|---|---|
| brak kontraktów `TestRun`/`ArtifactReference` | potwierdzone — do stworzenia |
| `runProcess` z `timedOut`, `outputTruncated`, env allowlistą | potwierdzone |
| `computeTreeDigest`/`inspectWorkspace` istnieją | potwierdzone |
| najwyższa migracja `026` | **nieaktualne** — RA-012 zajął `027`, RA-013 bierze **`028`** |
| „RA-013 musi **użyć** `SecretRedactor`; duplikat byłby findingiem" | **nieaktualne** — patrz decyzja o redakcji niżej |

### Decyzja o redakcji (koryguje rewizję 1)

Rewizja 1 nakazywała użyć `SecretRedactor` z `@remoteagent/observability` i
uznawała własny mechanizm za finding. Od tego czasu `CTF-006` (HIGH) wykazał
sondą, że `SecretRedactor` **przepuszcza** dokładnie te klasy, które nosi output
testów: absolutne host paths, `glpat-`, `AKIA`, klucze prywatne i JWT. Jego
`INLINE_PATTERNS` pokrywają tylko `Bearer`/`Basic`, URL-e z hasłem i wrażliwe
klucze `k=v`.

AC5 wymaga redakcji w excerptach **i** w pełnych logach, a output testów jest
pełen absolutnych ścieżek. Użycie samego `SecretRedactor` nie spełniłoby więc
kryterium, mimo że „redakcja jest włączona".

**Decyzja: RA-013 konsumuje `redactCommandOutput` z
`@remoteagent/implementation-tools`** (RA-012, `DONE`, zaakceptowane), które ma
pełny zestaw wzorców. Uzasadnienie:

1. nie tworzy **czwartej** niezależnej tabeli wzorców — `CTF-006` punkt 3 wymaga,
   by RA-024 zwinął wszystkie, a każda nowa kopia zwiększa ten dług;
2. nie narusza decyzji właściciela z `CTF-006`, że domknięcie zostaje w RA-024 —
   nie dotykamy `observability` ani `repository-planner`, które są `DONE`;
3. zależność `package → package` jest dozwolona przez `eslint.config.mjs`.

Koszt: `test-evidence` zależy od `implementation-tools` dla jednej funkcji. To
świadomy, tymczasowy koszt; RA-024 przeniesie wzorce do `observability` i wtedy
oba pakiety będą konsumować wspólne źródło. Odnotowane w `CTF-006`.

### Uwaga do AC4 (OOM)

`runProcess` odrzuca `cpuTimeMs`/`memoryBytes` kodem `NOT_ENFORCEABLE`, więc OOM
**nie jest** wykrywalny limitem pamięci. Rozpoznajemy go po sygnale procesu i
nigdy nie raportujemy „OOM detected" na podstawie limitu. SIGKILL, który nie
pochodzi z naszego timeoutu, jest klasyfikowany jako `INFRASTRUCTURE`, nie jako
regresja testu — to bezpieczny kierunek.

## Global boundaries

- In scope: deterministyczne uruchamianie weryfikacji i przechowywanie dowodów
  niezależnych od deklaracji modelu.
- Out of scope: independent code review (RA-015), Git commit (RA-014), provider CI.
- **Model nie może zapisać `PASS`.** Verdict jest wyprowadzany deterministycznie z
  trwałego `TestRun` receipt; rola Verification interpretuje wyniki, ale nie może
  ich sfałszować.
- Każdy wynik jest związany z konkretnym workspace oraz commit/tree digest.
- Output testów jest `UNTRUSTED_DATA`; sekrety redagowane w excerptach **i** w
  pełnych przechowywanych logach.

## Ustalenia z kodu przed planowaniem (2026-08-20)

Sprawdzone w repozytorium, nie założone:

1. **Nie ma jeszcze żadnych kontraktów `TestRun`/`ArtifactReference`.**
   `packages/contracts/src/` nie zawiera modułu artefaktów — trzeba je stworzyć.
2. **Redakcja sekretów już istnieje:** `packages/observability/src/redaction.ts`
   udostępnia `SecretRedactor` z `redactString` i `RedactionOptions`. RA-013 musi
   go **użyć**, nie pisać drugiego mechanizmu. Duplikat redaktora byłby findingiem.
3. **Uruchamianie procesów już istnieje:** `runProcess` z
   `packages/workspace-runner/src/process-runner.ts` ma `ProcessLimits`
   (`timeoutMs`, `outputBytes`), `timedOut`, `outputTruncated`, env allowlistę
   (`LANG`/`LC_ALL`/`LC_CTYPE`/`TZ`) i `NetworkMode`. RA-013 buduje **na nim**,
   nie tworzy drugiego runnera. Uwaga: `cpuTimeMs`/`memoryBytes` są odrzucane
   kodem `NOT_ENFORCEABLE` na tym adapterze — kryterium „OOM różni się od failed
   assertion" musi to uwzględnić i nie może udawać, że OOM jest wykrywalny przez
   limit pamięci.
4. **Tree digest już istnieje:** `computeTreeDigest` i `inspectWorkspace` w
   `workspace-runner/src/digest.ts` — binding wyniku do stanu drzewa opiera się na
   nich.
5. Najwyższa migracja to `026`; RA-012 zajmuje `027`. RA-013 musi wziąć **następny
   wolny numer po ponownym sprawdzeniu** — nie rezerwować teraz.

## Decyzje architektoniczne do potwierdzenia przy starcie

1. **Nowy pakiet `@remoteagent/test-evidence`**, nie rozszerzanie
   `workspace-runner` ani `implementation-tools`. Uzasadnienie: evidence boundary
   jest konsumowany przez RA-015, RA-017 i RA-021, więc musi być samodzielnym,
   stabilnym kontacktem, a nie doczepką do warstwy wykonawczej.
2. **Artifact store jako port z adapterem lokalnym.** Interfejs musi dopuszczać
   przyszły adapter S3 bez zmiany kontraktu (RA-025).
3. **Uwaga na kolizję nazw eksportów** — patrz finding w
   `docs/work-units/RA-012/WORK_UNITS.md`. Nowy pakiet nie może eksportować nazwy
   już eksportowanej przez `@remoteagent/contracts` (ESM cicho usuwa niejednoznaczne
   nazwy z `export *`). Sprawdzić sondą przecięcia eksportów przed zamknięciem taska.

## Unit index (DRAFT)

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-013-WU-01` | `DRAFT` | strict `TestRun` + `ArtifactReference` contracts | RA-012 DONE |
| `RA-013-WU-02` | `DRAFT` | local artifact store z integralnością i digestem | WU-01 |
| `RA-013-WU-03` | `DRAFT` | test runner nad `runProcess` z klasyfikacją błędów | WU-01, WU-02 |
| `RA-013-WU-04` | `DRAFT` | snapshot evidence i klasyfikacja diffów | WU-01, WU-02 |
| `RA-013-WU-05` | `DRAFT` | evidence composition + Verification role | WU-03, WU-04 |
| `RA-013-WU-06` | `DRAFT` | final integration/evidence proof | WU-05 |

## Wymagania do rozdzielenia na units

Mapowanie kryteriów akceptacji taska na units — do uszczegółowienia przy starcie:

- **AC1 (model nie zapisze `PASS` bez receiptu)** → `WU-01` (kontrakt nie pozwala
  wyrazić verdictu bez referencji do `TestRun`) + `WU-05` (Verification role) +
  `WU-06` (dowód adwersarialny: próba sfałszowania `PASS` jest odrzucana).
- **AC2 (binding do workspace i commit/tree digest)** → `WU-01` + `WU-03`, oparte
  na `computeTreeDigest`.
- **AC3 (snapshot update z diffem i uzasadnieniem)** → `WU-04`; brak uzasadnienia
  musi blokować akceptację snapshotu (anty-rubber-stamping).
- **AC4 (timeout/cancel/OOM ≠ failed assertion)** → `WU-03`; wykorzystać
  `timedOut` z `runProcess`; **OOM traktować ostrożnie** — adapter nie wymusza
  limitu pamięci, więc OOM rozpoznawać po sygnale procesu, nie po limicie.
- **AC5 (redakcja w excerptach i pełnych logach)** → `WU-02` + `WU-03`, przez
  `SecretRedactor`; test z canary secret w obu miejscach.
- **AC6 (retention/size limits nie usuwają metadanych audytowych)** → `WU-02`;
  test dowodzący, że po przycięciu artefaktu metadane i digest zostają.

## Final task gate

Koordynator uruchamia pełną suite pakietu na prawdziwym PostgreSQL, całe repo bez
regresji, typecheck/build/scoped lint/format, `pnpm workflow:validate`,
`git diff --check`, sondę przecięcia eksportów, oraz osobno weryfikuje sześć
kryteriów akceptacji — w szczególności próbę sfałszowania `PASS` bez receiptu i
redakcję canary secret w pełnym artefakcie. Następnie handoff i niezależny audyt.
