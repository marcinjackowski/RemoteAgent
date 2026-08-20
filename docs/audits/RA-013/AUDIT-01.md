# RA-013 — Audit 01

## Metadata

- Task: `RA-013`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-013/HANDOFF-01.md`
- Data: `2026-08-20`
- Zakres diffu: `7346cd4..2d5506d`
- **Werdykt: `PASS`**

## Podstawa werdyktu

Audyt z odczytu diffu, samodzielnego uruchomienia bramek i **własnych sond
adwersarialnych** — nie z treści handoffu. Sondy znów zarobiły na siebie: znalazły
defekt AC1, którego nie znalazły testy unitu (finding 1).

## Kryteria akceptacji — każde sprawdzone osobno

| # | Kryterium | Werdykt | Jak sprawdzone |
|---|---|---|---|
| 1 | Model nie zapisze `PASS` bez receiptu | PASS **po naprawie** | zero runs, brak required run, ręcznie budowany werdykt, sfałszowany receipt (`PASSED` z exit 1 i bez post-state), nieznana komenda. **Plus finding 1** |
| 2 | Binding do workspace i tree digest | PASS | digest odczytany realnie; mutacja workspace zmienia binding; mieszanie drzew odrzucone; `derived_from` re-checkowalne |
| 3 | Snapshot z diffem i uzasadnieniem | PASS | boilerplate (5 wariantów), wklejony diff, acceptance na innych bajtach, acceptance dla `UNCHANGED` — wszystkie odrzucone; 2 mutacje wykryte |
| 4 | Timeout/cancel/OOM ≠ failed assertion | PASS | realny timeout, realny cancel, brakujący executable, zewnętrzny SIGKILL; kolejność sprawdzeń testowana osobno; mutacja kolapsu → 5 FAIL |
| 5 | Redakcja w excerptach i pełnych logach | PASS | 4 canary + host paths czytane **z dysku**; osobny test redakcji store'u (dodany po mutacji) |
| 6 | Retention/size limits nie usuwają metadanych | PASS | truncation z `original_byte_length`; po `prune` receipt/digest/binding odpowiadają; tamper wykryty; 2 mutacje wykryte |

## Findingi

### Finding 1 — `PASSED` gdy wymagana komenda w ogóle nie uruchomiła się (HIGH, **naprawiony**)

- Lokalizacja: `packages/test-evidence/src/contracts.ts`, `deriveVerdict`
- Status: **NAPRAWIONY** w `2d5506d`, przed werdyktem

**Dowód** (sonda audytora):

```text
MISSING REQUIRED RUN -> PASSED   !! required command never ran
```

**Przyczyna.** Funkcja sprawdzała, że istnieje *co najmniej jedna* wymagana
run, a potem oceniała outcome tylko po przekazanych runach. Zbiór z jedną zieloną
wymaganą komendą i drugą **całkowicie pominiętą** dawał `PASSED`.

**Wpływ.** To ta sama luka co guard na zero runs, tylko na poziomie pojedynczej
komendy — i groźniejsza, bo częściowo wykonana suite jest nieodróżnialna od pełnej.
Nikt nie audytuje zielonego werdyktu pod kątem tego, których komend w nim brakuje.
AC1 dotyczy niemożności zdobycia niezasłużonego `PASS`, a pominięcie wymaganej
komendy było tanim sposobem na jego zdobycie.

**Naprawa.** Każda wymagana komenda musi mieć receipt. Brak daje `INCONCLUSIVE`, nie
`FAILED` — komenda nic nie zaraportowała, a nie zaraportowała regresji — i trafia do
`blocking` jako `<name> (no receipt)`, żeby luka była czytelna, a nie domyślna.
Mutacja usuwająca guard odtwarza porażkę testu.

### Finding 2 — odstępstwo od planu w sprawie redakcji (zaakceptowane)

Plan DRAFT nakazywał `SecretRedactor` i nazywał alternatywę findingiem.
Implementacja użyła `redactCommandOutput` z RA-012. **Potwierdzam jako słuszne**:
`CTF-006` udowodnił sondą, że `SecretRedactor` przepuszcza host paths, `glpat-`,
`AKIA`, klucze i JWT, więc sam nie spełniłby AC5. Alternatywa (czwarta lokalna
tabela) byłaby gorsza. Nie ruszono pakietów `DONE`.

### Finding 3 — duplikaty receiptów w `derived_from` (LOW, zaakceptowany)

Sonda: dwa runy o tym samym `receipt_digest` dają `derived_from` długości 2. Nie
wpływa na werdykt i nie tworzy fałszywego sukcesu; kosmetyczne. Odnotowane, nie
blokuje.

### Probe'y bez findingu

Warte zapisania, bo wykluczają całe klasy błędów: traversal przez `artifact_id`
(`../escape`, `..`, `a/b`, `a\b`, `.`), przez `scope.case_id` oraz przez podmieniony
`relative_path` przy odczycie — **odrzucony w każdej próbowanej formie**.

## Kontrole wykonane samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1275/1275, 119 plików** |
| `pnpm vitest run packages/test-evidence/test` | 0 | 42/42 |
| `pnpm run typecheck --force` | 0 | 33/33 |
| `pnpm run build --force` | 0 | 24/24 |
| `pnpm exec eslint packages/test-evidence` | 0 | PASS |
| `pnpm exec prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| sondy adwersarialne | — | **finding 1**, findingi 3, 8 probe'ów czystych |

## Bezpieczeństwo i wiarygodność evidence

- **Werdykt jest wyprowadzany, nie zapisywany.** `deriveVerdict` to jedyny
  producent; `VerificationSession` nie ma metody przyjmującej werdykt, override ani
  `force`. Test re-derywacji dowodzi, że wniosek jest odtwarzalny z wejść.
- **Receipt nie jest fabrykowalny**: `PASSED` z exit != 0 i `PASSED` bez post-state
  są nieprzedstawialne w schemacie (dowód testem).
- **Rozróżnienie infrastruktury od regresji** działa w obie strony i ma pierwszeństwo
  nad `FAILED`.
- **Anty-rubber-stamping**: nieuzasadniony snapshot wstrzymuje `PASSED`, ale nigdy nie
  podnosi `FAILED` do sukcesu (dowód testem).
- Redakcja przed zapisem, integralność przy odczycie, izolacja po scope.
- Brak push, MR i external writes.

## Werdykt

- Werdykt: `PASS`

Sześć kryteriów spełnione i sprawdzone osobno. Brak otwartych findingów
BLOCKER/HIGH/MEDIUM — jedyny HIGH znaleziony w tym audycie i naprawiony z testem
regresyjnym przed werdyktem.

Status: `AUDIT_PASSED` → `DONE`. Odblokowuje RA-014 (`RA-010`, `RA-012`, `RA-013`
wszystkie `DONE`).
