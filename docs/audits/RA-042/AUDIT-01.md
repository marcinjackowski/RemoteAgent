# RA-042 — AUDIT-01

- Task: `RA-042` Deterministyczny gate runner i evidence binding
- Data: `2026-08-26`
- Bazowy commit: `40c81dbdae91fcbb3a4a97a2a89e3ab7e415794d`
- Commit implementacji: `3e1637f`
- Audyt: pełny diff od bazowego commita, kod wywołujący/wywoływany i własne
  uruchomione bramki Sol zgodnie z `ADR-0007`

## 1. Uruchomiona bramka

Po odczycie diffu i korektach audytowych uruchomiono od początku:

```text
. scripts/dev/env.sh                    Node 24.19.0; PG15/5432 reachable
pnpm lint                               exit 0; tylko istniejące warnings boundaries
pnpm format                             exit 0
pnpm run build --force                  26/26, 0 cached, exit 0
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run
                                        2652/2652, 206 plików, exit 0
pnpm run typecheck --force              38/38, 0 cached, exit 0
pnpm workflow:validate                  OK — 45 tasks, exit 0
git diff --check                        exit 0
```

Pierwsza próba użyła błędnej nazwy nieistniejącego skryptu `format:check` z
planu i zakończyła exit `254` po lint. Plan poprawiono do repozytoryjnego
`pnpm format`, po czym całą bramkę uruchomiono ponownie; to rozstrzygnięty błąd
planu, nie pominięty krok ani flake. Po pełnej bramce audyt ponowił pełny Vitest
z reporterem JSON: `2652/2652`, `206` plików i `639/639` suites, exit `0`, oraz
osobno wymuszony build `26/26`, `0 cached`, exit `0`.

## 2. Kryteria akceptacji

1. **Brak raw shell:** spełnione. Strict katalog wymaga canonical absolute
   executable z code-owned allowlisty i `argv[]`; runner zachowuje `shell:false`.
   Adwersarialny optional canary nie został wykonany.
2. **Disposable workspace:** spełnione. Exact copy nie przenosi `.git`, authority
   ma identyczny digest przed/po, a protected inventory i post-run mutable-root
   canonicalization wykrywają zapis oraz symlink-swap poza allowlistą.
3. **Exact receipt binding:** spełnione. Receipt wiąże case/workspace/run/op/gate/
   target, tree/config/command, exit/signal/duration i durable redacted log.
   Obcy, stary, zmieniony lub szeroki joined row jest odrzucany.
4. **Fail-closed aggregate:** spełnione. Empty/missing/duplicate/optional/foreign,
   zły tree/config/operation i niespójny receipt nie mogą utworzyć PASS/bundle.
5. **Test-first/vacuity:** spełnione. Osobne durable baseline/current operations;
   wyłącznie baseline `FAILED` + current `PASSED` daje dowód. Baseline green nie.
6. **Mutation evidence:** spełnione. Allowlist, protected write, mutable symlink,
   durable reread, STARTED replay, active workspace, baseline-vacuity, completion
   ID i required-only selection mają rzeczywiste RED→GREEN.
7. **Timeout/cancel/recovery:** spełnione. `AbortSignal` zabija detached process
   group, cancel i timeout są rozłączne. `STARTED` bez completion jest
   `AMBIGUOUS` i nie jest replayowany; missing durable log daje infrastructure.
8. **Profile adapter:** spełnione. Generic path obsługuje tylko
   `HERMETIC`+`DENY`; inne jawne profile bez server adaptera kończą się
   `INFRASTRUCTURE`. Implementacja nie deklaruje uniwersalnego sandboxu Xcode.
9. **Bramki:** spełnione. Pełna komenda, niezależny rerun i workflow mają exit `0`.

## 3. Trwałość, bezpieczeństwo i operacyjność

Nie powstał drugi journal ani process runner. Każdy required gate/target używa
`bindOperationIntent -> commitOperationStarted -> JobStore.recordCompletion ->
observeOperationCompletion`, a wynik jest składany po exact durable reread.
Completion observation jest wiązana z operation/intent/job/completion oraz
canonical payload digest. Retry odzyskuje potwierdzony receipt bez ponownego
dispatch; brak receipt po `STARTED` pozostaje niejednoznaczny.

Katalog, authority metadata, workspace scope i verdict są ustalane poza modelem.
Proces dostaje tylko canonical executable i argv, pracuje na disposable root,
a bundle zawiera bounded `UNTRUSTED_DATA` summaries i digests zamiast treści logu
lub host paths. Durable log jest wymagany dla PASS. Platform adapter przechodzi
ten sam strict scope/tree/manifest/receipt-digest guard.

Audyt odczytał pełny diff od bazowego tree i ponowił testy niezależnie od raportu
Luny. Zmiany mieszczą się w allowed paths WU-00..04. Nie wykonano push, MR,
zewnętrznego write ani live Xcode.

## 4. Findings

Audyt zamknął dwa findingi w zakresie: publiczny DB read zwracał szeroki joined
row zamiast dokładnej projekcji 18 pól oraz downgrade do `INFRASTRUCTURE` tracił
rzeczywiście obserwowany exit code. Odpowiednie mutacje dały RED (`1/35` i
`2/14`), po korekcie wspólna bramka `74/74` była GREEN. Wcześniej zamknięto też
HIGH symlink-swap w mutable root. Nie pozostał finding BLOCKER, HIGH ani MEDIUM;
nie ma nowego findingu przekrojowego do `CROSS_TASK_FINDINGS.md`.

## 5. Werdykt

- Werdykt: `PASS`

Wszystkie dziewięć kryteriów RA-042 jest spełnionych, mechanizmy bezpieczeństwa
mają RED→GREEN, a pełna bramka i niezależny rerun zakończyły się exit code `0`.
