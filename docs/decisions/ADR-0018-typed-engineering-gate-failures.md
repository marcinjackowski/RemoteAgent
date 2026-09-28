# ADR-0018 — typed Engineering gate failures

- Status: `ACCEPTED`
- Data: `2026-09-05`
- Uzupełnia: `ADR-0011`, `ADR-0015`, `ADR-0017`
- Task: `RA-055`

## Kontekst

`GateFailure` schema v1 wiąże błąd z gate receiptami i zachowuje bounded log
excerpt, ale wybór ścieżek korekty nadal częściowo zależy od wyszukiwania nazw
plików i symboli w nieufnym prose. Nie przechowuje też stabilnego powiązania z
kryteriami benchmarku ani klasy awarii. Zmiana wording, kapitalizacji albo
lokalizacji logu może więc zmienić control flow, a awaria infrastruktury może
zostać pomylona z defektem produktu.

## Decyzja

1. Nowe trwałe błędy bramek używają ścisłego `GateFailure` schema v2. V1
   pozostaje niezmienionym historycznym wariantem w unii artifacts.
2. V2 zawiera bounded listę server-owned typed observations. Każda observation
   wiąże `criterion_id`, `gate_id`, `failure_class`, `evidence_ref` oraz
   `related_target_ids`. Lista, nie pojedyncze pole, obsługuje gate dowodzący
   wielu kryteriów bez utraty provenance.
3. `failure_class` jest zamkniętym enumem:
   `ASSERTION_FAILED`, `COMPILE_FAILED`, `TEST_DISCOVERY_FAILED`,
   `INFRASTRUCTURE` albo `UNKNOWN`. Tylko klasy dopuszczone przez deterministyczną
   policy mogą utworzyć correction authority.
4. `criterion_id`, `gate_id`, evidence reference i target IDs pochodzą wyłącznie
   z code-owned manifestu, katalogu bramek i uruchomionych receipts. Model i log
   nie mogą ich dostarczyć ani poszerzyć.
5. `related_target_ids` są nieprzezroczystymi identyfikatorami katalogu, nie
   ścieżkami. Serwer rozwiązuje je do mutation paths i przecina z authority
   aktywnego slice przed utworzeniem operacji zapisu.
6. Human-readable excerpt pozostaje wyłącznie bounded diagnostyką. Zmiana jego
   tekstu bez zmiany receiptów i typed observations nie zmienia progress identity,
   zakresu ani wyboru korekty.
7. Legacy v1 ma jawny adapter diagnostyczny. Gdy nie da się potwierdzić pełnego
   typed mappingu z zachowanego code-owned katalogu i receipts, wynik to
   `UNCLASSIFIED_GATE_FAILURE`: bez poszerzenia scope i bez modelowego write.
8. Benchmark manifest wiąże wersję schema/mapping policy i digests katalogu.
   Config drift jest odmową preflight przed pierwszym model call.

## Odrzucone alternatywy

- Rozszerzenie v1 polami opcjonalnymi: pozwalałoby nowemu producerowi nadal
  zapisać semantycznie niepełny artifact i zacierałoby granicę migracji.
- Osobny envelope obok `GateFailure`: tworzyłby dwa konkurencyjne źródła prawdy
  dla jednej awarii i komplikował recovery.
- Parsowanie nazw plików/symboli z logu jako authority: prose jest
  `UNTRUSTED_DATA`, jest niestabilne i nie stanowi katalogu targetów.
- Jedno `criterion_id` na artifact: pojedynczy gate może dostarczać evidence dla
  kilku kryteriów i wymaga zachowania wszystkich powiązań.

## Konsekwencje

- Kontrakty, repository mapping i recovery muszą obsługiwać v1 oraz v2 bez
  przepisywania historycznych revisions.
- Katalog benchmarku staje się właścicielem criterion/target mappingu, a
  `VerificationGateCatalog` pozostaje właścicielem wykonania komend.
- Awaria infrastruktury nie uruchamia edycji kodu produktu; nieklasyfikowalna
  awaria zatrzymuje się jawnie zamiast zgadywać target.

## Migracja

1. Dodać strict schema v2 i pozostawić v1 w `engineeringArtifact` union.
2. Dodać immutable benchmark manifest z criterion/target mappingiem i jego
   wersją projekcji.
3. Emitować v2 z receipt-backed typed observations; konsument korekty rozwiązuje
   wyłącznie target IDs katalogu.
4. V1 czytać przez fail-closed adapter, bez nowych heurystyk prose.

## Rollback

Rollback wyłącza automatyczną korektę i kończy jako
`UNCLASSIFIED_GATE_FAILURE`; nie przywraca prose-driven target selection ani nie
zapisuje nowych v1 artifacts. Historyczne revisions pozostają bez zmian.
