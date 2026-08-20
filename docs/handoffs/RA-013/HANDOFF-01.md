# RA-013 — Handoff 01

## Metadata

- Task: `RA-013`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Work-units plan: `docs/work-units/RA-013/WORK_UNITS.md`
- Data: `2026-08-20`
- Bazowy commit: `7346cd4`
- Końcowy commit: `6f26aff`

## Wynik

Nowy pakiet `@remoteagent/test-evidence`: wersjonowany manifest komend, runner nad
`runProcess`, artifact store jako port z adapterem lokalnym, klasyfikacja
snapshotów i rola Verification. Werdykt jest **wyprowadzany** z receiptów, nigdy
zapisywany.

## Zrealizowany zakres

- `src/contracts.ts` — `TestRun`, `ArtifactReference`, `EvidenceVerdict`,
  `deriveVerdict` jako jedyny producent werdyktu.
- `src/artifact-store.ts` — port + `LocalArtifactStore` z redakcją na wejściu,
  integralnością na wyjściu i `prune` zachowującym metadane.
- `src/runner.ts` — `classify` (rdzeń AC4) i mennica receiptów.
- `src/snapshot.ts` — klasyfikacja diffów i bramka anty-rubber-stamping.
- `src/verification.ts` — rola Verification, która interpretuje, ale nie fałszuje.

## Odstępstwo od planu DRAFT — redakcja

Plan (rewizja 1) nakazywał użyć `SecretRedactor` i uznawał własny mechanizm za
finding. `CTF-006` wykazał sondą, że `SecretRedactor` przepuszcza absolutne host
paths, `glpat-`, `AKIA`, klucze prywatne i JWT — dokładnie to, co nosi output
testów. Sam by więc **nie spełnił AC5**, mimo że „redakcja jest włączona".

Decyzja: konsumować `redactCommandOutput` z `@remoteagent/implementation-tools`
(RA-012, `DONE`), które ma pełny zestaw wzorców. Nie tworzymy **czwartej**
niezależnej tabeli, nie ruszamy pakietów `DONE`, a `CTF-006` punkt 3 nadal
obowiązuje dla RA-024. Zapisane w planie i w module.

## Kryteria akceptacji

| # | Status | Dowód |
|---|---|---|
| 1. Model nie zapisze `PASS` bez receiptu | PASS | zero runs throws; brak required run throws; ręcznie budowany werdykt i sfałszowany receipt odrzucone przez schemat; nieznana komenda nie daje receiptu |
| 2. Wynik związany z workspace i tree digest | PASS | digest odczytany realnie; mutacja workspace zmienia binding; mieszanie drzew w jednym werdykcie odrzucone |
| 3. Snapshot update z diffem i uzasadnieniem | PASS | boilerplate, wklejony diff i acceptance replayowany na inne bajty — każde odrzucone; `UNAPPROVED` jest stanem pierwszorzędnym |
| 4. Timeout/cancel/OOM ≠ failed assertion | PASS | realny timeout, realny cancel, brakujący executable, zewnętrzny SIGKILL; kolejność sprawdzeń przetestowana osobno |
| 5. Redakcja w excerptach i pełnych logach | PASS | 4 canary + host paths, czytane **z dysku**; osobny test redakcji samego store'u |
| 6. Retention/size limits nie usuwają metadanych | PASS | truncation z `original_byte_length`; po `prune` receipt, digest i binding nadal odpowiadają; tamper wykryty |

## Testy i kontrole

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/test-evidence/test` | 0 | 40/40 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1273/1273, 119 plików** |
| `pnpm run typecheck --force` | 0 | 33/33 |
| `pnpm run build --force` | 0 | 24/24 |
| `pnpm exec eslint packages/test-evidence` | 0 | PASS |
| `pnpm exec prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| sonda przecięcia eksportów | 0 | brak kolizji (test w suite) |

## Mutation testing

| Mutacja | Wynik |
|---|---|
| non-assertion outcome → FAILED | 5 testów FAIL |
| store bez redakcji | **początkowo 0** → gap w testach, naprawiony → 1 FAIL |
| runner bez redakcji | 2 testy FAIL |
| bramka uzasadnienia snapshotu wyłączona | 1 FAIL |
| binding digestu snapshotu wyłączony | 1 FAIL |
| truncated artefakt oznaczony `complete` | 1 FAIL |
| brak weryfikacji digestu przy odczycie | 1 FAIL |
| `deriveVerdict` przyjmuje zero runs | 0 FAIL — drugi, redundantny guard łapie (defence in depth, nie luka) |

### Gap w testach znaleziony mutacją

Wyłączenie redakcji w artifact store zostawiło 39/39 zielono, bo runner redaguje
**przed** wywołaniem `put`. Store jest publicznym portem — RA-017 i RA-025 będą go
wołać bezpośrednio, bez runnera z przodu — więc musi redagować własne wejście, a nie
ufać wołającemu. Dodany test `direct-put` wywala się pod tą mutacją.

## Znane ograniczenia

- `CTF-006` (HIGH, otwarty) — ten pakiet konsumuje wzorce RA-012 zamiast tworzyć
  własne; zwinięcie do wspólnego źródła należy do RA-024.
- `CTF-008` (LOW) — repo lint nadal czerwony na 3 preexistujących błędach; RA-013
  nie dodał żadnego (sprawdzone licznikiem).
- OOM nie jest wykrywalny limitem pamięci na tym adapterze; rozpoznawany po sygnale
  i klasyfikowany jako `INFRASTRUCTURE`.
- Migracja: RA-013 **nie** wprowadza tabeli. Evidence jest zwracany jako kontrakt;
  persystencja receiptów należy do konsumenta (RA-017/RA-022). Numer `028` pozostaje
  wolny.

## Stan dla audytu

Working tree czysty, `6f26aff` zawiera całość. Audyt powinien niezależnie odtworzyć
pełny przebieg, przeczytać diff od `7346cd4`, sprawdzić sześć kryteriów osobno i
potwierdzić odstępstwo od planu w sprawie redakcji jako uzasadnione.
