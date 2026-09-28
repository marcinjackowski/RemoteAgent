# ADR-0017 — Engineering evidence identity and outcomes

- Status: `ACCEPTED`
- Data: `2026-09-05`
- Uzupełnia: `ADR-0011`, `ADR-0015`, `ADR-0016`
- Task: `RA-055`

## Kontekst

Kwalifikacja RA-055 ujawniła dwa rozjazdy między trwałym evidence a znaczeniem
operator-facing. Pre-commit review utożsamiał finding z samą effective lokalizacją,
więc dwie niezależne wymagane poprawki na tej samej linii zlewały się w jedną.
Journal uznawał natomiast brak wyjątku callbacku za sukces Engineering, także gdy
trwały terminal wskazywał `BLOCKED` i nie istniał wymagany commit receipt.

Lokalizacja pozostaje ważną granicą authority: tylko server-observed linia w
rzeczywistym patchu może uruchomić korektę. Nie jest jednak pełną tożsamością
defektu. Podobnie poprawne obsłużenie joba nie oznacza ukończenia zadania.

## Decyzja

1. Tożsamość findingu pre-commit jest wyprowadzana przez serwer z wersjonowanej,
   kanonicznej projekcji validated findingu: effective anchor, severity, summary,
   required fix i digest evidence. Model nadal nie podaje `finding_id`.
2. Deduplikujemy tylko identyczne projekcje. Dwa różne required fixes, nawet na tej
   samej effective linii, zachowują osobne IDs i osobne pozycje checklisty.
3. Effective anchor jest jedyną write-authority findingu. Oryginalna modelowa
   lokalizacja może być zachowana jako diagnostyczna provenance, ale nigdy nie
   poszerza scope i nie zastępuje server-observed anchoru.
4. Stabilność ID jest gwarantowana dla tej samej wersji projekcji i tych samych
   validated danych. Nie obiecujemy semantic identity przy arbitralnej parafrazie
   modelu; zmiana algorytmu identity wymaga nowej wersji kontraktu/projekcji.
5. Raport runu rozdziela co najmniej: outcome handlera, durable outcome zadania i
   kompletność diagnostyki. Brak wyjątku oznacza wyłącznie obsłużenie callbacku.
6. `COMPLETED` Engineering wynika z trwałych terminali i wymaganych artifacts; gdy
   task wymaga commita, bez exact `LocalCommitReceipt` nie wolno raportować sukcesu.
   `BLOCKED`, `WAITING`, `CANCELLED`, `INCOMPLETE` i diagnostyczne `UNKNOWN` są
   odrębnymi wynikami.
7. Awaria odczytu albo zapisu diagnostyki nie powtarza zakończonego side effectu i
   nie tworzy domniemanego sukcesu. Jest raportowana jako niekompletna diagnostyka.
8. Journal, summary i późniejszy benchmark wiążą schema/projection version oraz
   digests wejściowych artifacts. Content-free summary nie zastępuje canonical
   receipts.

## Odrzucone alternatywy

- `path:line` jako pełne ID: traci niezależne wymagania na wspólnej linii.
- Losowy UUID: uniemożliwia deterministyczne odtworzenie tej samej projekcji.
- Hash samego prose: odłącza finding od server-owned authority anchoru.
- Brak wyjątku jako `SUCCEEDED`: miesza poprawność handlera z wynikiem produktu.
- Domniemanie sukcesu po awarii DB: ukrywa brak evidence i może skłonić operatora
  do niebezpiecznego powtórzenia lub publikacji niezweryfikowanej pracy.

## Konsekwencje

- Checklisty mogą zawierać kilka findingów na jednej linii; UI i korekta muszą
  używać IDs, nie mapy `path:line`.
- Finding po reanchorze zachowuje authority effective linii, a jego identity nadal
  rozróżnia niezależny required fix.
- Historyczne IDs pozostają historyczne; nie przepisujemy zapisanych artifacts.
- Operator widzi osobno, że handler zakończył się technicznie oraz że Engineering
  zostało zablokowane albo nie ma kompletnego evidence.

## Migracja

1. R2 RA-055 zmienia server-owned projection/dedup i dodaje regresje dwóch findingów
   na jednej linii oraz foreign-scope isolation.
2. R3 wprowadza wersjonowany run report i mapowanie durable terminali/artifacts.
3. Historyczne journale są czytane przez jawny legacy adapter jako diagnostycznie
   niepełne; nie są przepisywane.
4. R4 wiąże wersję tych projekcji z manifestem benchmarku.

## Rollback

Rollback zatrzymuje kwalifikację na `REVIEW_INCONCLUSIVE` albo diagnostycznym
`UNKNOWN`; nie wolno wrócić do location-only dedup ani callback-only success.
Historyczne raw journale i artifacts pozostają zachowane.
