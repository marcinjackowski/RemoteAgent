# RA-001 — Audit 02

## Metadata

- Task: `RA-001`
- Audytowany handoff: `docs/handoffs/RA-001/HANDOFF-02.md`
- Audytor: Codex (niezależny AUDITOR)
- Data: 2026-08-18
- Werdykt: `CHANGES_REQUIRED`

## Podsumowanie

Cztery z pięciu findingów AUDIT-01 zostały zamknięte, a większość piątego działa:
dedykowane repo Git ma commit `d04a305`, skan 130 śledzonych blobów jest czysty,
runtime jest spójnie przypięty, cleanup fixture'ów działa, a pełny clean-archive
install/check przeszedł na dokładnym Node `24.19.0` i pnpm `10.26.1`. Nie można
jednak wydać `PASS`, ponieważ główna bramka workflow nadal akceptuje dokumenty z
wieloma markerami werdyktu oraz nie egzekwuje wymaganej relacji dla audytowego
`BLOCKED`. Reprodukcje adwersarialne zwracają `ok: true`.

## Zakres audytu

- Przeczytane dokumenty: `AGENTS.md`, Master Plan, protokół wykonania i audytu,
  checklist audytora, RA-001, AUDIT-01, HANDOFF-02, ADR-0001 i README.
- Sprawdzony diff/commity: root commit
  `d04a305bd061db8e78c748cda05d0a46df85d6cd`, wszystkie 130 śledzonych plików
  oraz working-tree diff HANDOFF-02 i statusu `AWAITING_AUDIT`.
- Uruchomione kontrole: clean `git archive`, frozen install i pełny gate na Node
  `24.19.0`, bieżący full gate, testy adwersarialne validatora, skan sekretów
  śledzonych blobów, workspace graph, Docker Compose, Git integrity i ignore set.

## Kryteria akceptacji

| Kryterium | Wynik | Dowód/uwagi |
|---|---|---|
| 1. Clean checkout instaluje się jednym poleceniem | PASS | `git archive d04a305` do pustego katalogu; Node `v24.19.0`, pnpm `10.26.1`; `pnpm install --frozen-lockfile` exit 0. |
| 2. Root lint/typecheck/test/build są deterministyczne | PASS | Clean archive `pnpm run check` exit 0; 24/24 testy, 20/20 typecheck i build, 0 cache. |
| 3. Wszystkie app/package manifests są w workspace | PASS | 21 projektów: root, 6 apps, 13 packages i `infra/cdk`. |
| 4. CI używa lockfile i nie wymaga sekretów | PASS | Dokładny obraz `node:24.19.0-bookworm-slim`, pnpm `10.26.1`, frozen install, brak zmiennych credentialowych. |
| 5. Strict TS i dependency boundaries mają failing fixtures | PASS | Guardrail tests przechodzą i asercyjnie wymagają TS7006 oraz `boundaries/dependencies`. |
| 6. Brak credentiali i danych lokalnych w Git | PASS | Niezależny skan 130 blobów i podejrzanych nazw: 0 findingów; ignorowane artefakty tracked: 0. |
| 7. Validator odrzuca niezgodne stany i wadliwe audyty | FAIL | `BLOCKED` + audyt `PASS`, dwie sprzeczne linie `Werdykt` i `PASS PASS` zostały zaakceptowane (`ok: true`). |

## Findingi

### HIGH — Validator nadal akceptuje wielokrotny werdykt i niepełne mapowanie `BLOCKED`

- Lokalizacja: `scripts/workflow/validate.ts:53`,
  `scripts/workflow/validate.ts:57`, `scripts/workflow/validate.ts:182`,
  `test/workflow/validate.test.ts:197`, `test/workflow/validate.test.ts:215`.
- Dowód: `parseAuditVerdict` wybiera tylko pierwszą linię przez `.find(...)`, a
  następnie deduplikuje tokeny przez `Set`. Niezależne fixture'y zwróciły:
  `BLOCKED` z `Werdykt: PASS` -> `ok: true`; dwie linie `Werdykt: PASS` i
  `Werdykt: CHANGES_REQUIRED` -> `ok: true`; jedna linia `Werdykt: PASS PASS` ->
  `ok: true`. `STATUS_TO_REQUIRED_VERDICT` świadomie nie zawiera `BLOCKED`, mimo
  jawnego wymagania AUDIT-01.
- Wpływ: przypadkowo nieuzupełniony lub konfliktowy dokument może zostać uznany
  za `PASS`, a status `AUDIT_PASSED` może odblokować zależne taski mimo drugiego
  werdyktu odrzucającego. Dodatkowo stan po audytowym `BLOCKED` nie jest związany
  z werdyktem, więc źródło blokady pozostaje niejednoznaczne.
- Wymagana zmiana: parser musi przeglądać cały dokument i zaakceptować dokładnie
  jedną deklarację `Werdykt` zawierającą dokładnie jedno wystąpienie dozwolonego
  tokenu. Dwie deklaracje, dwa tokeny (także identyczne), brak tokenu i placeholder
  muszą failować zamknięcie. Należy też domknąć semantykę `BLOCKED`: co najmniej
  audytowe `BLOCKED` musi deterministycznie wymagać werdyktu `BLOCKED`, przy
  zachowaniu legalnej proceduralnej blokady/Decision Request bez audytu. Można
  użyć jawnego provenance blokady albo innego udokumentowanego, testowalnego
  rozróżnienia; samo bezwarunkowe pominięcie statusu nie wystarcza. Dodać testy:
  proceduralny `BLOCKED` bez audytu, audytowy `BLOCKED` + `BLOCKED`, audytowy
  `BLOCKED` + `PASS/CHANGES_REQUIRED`, dwie linie verdict oraz powtórzony token.

## Testy audytora

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `git archive HEAD` do pustego katalogu | 0 | 130 plików z commita `d04a305`, bez lokalnego cache i `node_modules`. |
| `npx --package=node@24.19.0 --package=pnpm@10.26.1 --call 'node --version && pnpm --version && pnpm install --frozen-lockfile && pnpm run check'` w archiwum | 0 | Node `v24.19.0`, pnpm `10.26.1`; lint/format/typecheck/test/build/workflow green; 24 testy, 20 buildów, 0 cache. |
| Ta sama pełna bramka w bieżącym drzewie | 0 | Wszystkie kontrole green; `workflow:validate OK — 26 tasks`. |
| Adwersarialny harness `validate(...)` | 0 | Wszystkie trzy niedozwolone fixture'y zostały zaakceptowane; finding reprodukowalny. |
| Skan wzorców sekretów na `git ls-tree -r HEAD` | 0 | 130 blobów; 0 content findings i 0 suspicious filenames. |
| `git ls-files` dla runtime/build/cache/log pathspecs | 0 | 0 śledzonych artefaktów. |
| `docker compose config --quiet` | 0 | Konfiguracja poprawna. |
| `git fsck --full` | 0 | Repo integralne; branch `main`, brak remote. |

## Ryzyka przekrojowe

- Security/privacy: skan commita jest czysty; pliki sesji i klucz Bedrock są poza
  Git. Pozostaje logiczne ryzyko obejścia bramki przez wielokrotny verdict.
- Idempotencja/recovery: RA-001 nie wprowadza side effectów domenowych; frozen
  install i clean build są powtarzalne.
- Współbieżność: poza zakresem fundamentu; granica jednego writera pozostaje w
  kontrakcie planu.
- Observability: poza zakresem RA-001.
- Kompatybilność: Node i pnpm są dokładnie przypięte i zweryfikowane; zmiana
  parsera musi zachować istniejące polskie pole `Werdykt` i numerowanie audytów.

## Wymagane działania po `continue`

1. Zmienić `parseAuditVerdict`, aby wymagał dokładnie jednej deklaracji i jednego
   wystąpienia tokenu w całym dokumencie.
2. Wprowadzić deterministyczne, udokumentowane rozróżnienie audytowego i
   proceduralnego `BLOCKED`, egzekwując werdykt `BLOCKED` dla pierwszego bez
   łamania ścieżki Decision Request.
3. Dodać wymienione pozytywne i negatywne testy; testy muszą reprodukować trzy
   fixture'y z tego audytu.
4. Uruchomić pełny gate na Node `24.19.0`, przeskanować staged/tracked content,
   zapisać poprawkę w lokalnym repo Git i potwierdzić clean archive tego commita.
5. Utworzyć `HANDOFF-03`, ustawić RA-001 na `AWAITING_AUDIT` i zatrzymać się bez
   rozpoczynania RA-002.

## Uzasadnienie werdyktu

Wszystkie elementy reprodukowalności i cztery findingi AUDIT-01 mają niezależny
dowód pozytywny. Pozostały błąd dotyczy jednak głównej bramki audytowej i ma
bezpośrednią reprodukcję pozwalającą zaakceptować konfliktowy dokument jako
`PASS`. Zgodnie z AGENTS.md nierozwiązany finding HIGH wyklucza `PASS`, dlatego
werdykt to `CHANGES_REQUIRED`.
