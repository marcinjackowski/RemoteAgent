# ADR-0002 — Warstwa SQL i migracji dla trwałego stanu

- Status: Accepted
- Date: 2026-08-19
- Task: RA-003

## Kontekst

RA-003 buduje autorytatywny, trwały stan RemoteAgent w PostgreSQL (Master Plan
§3.2: „PostgreSQL jest autorytatywnym źródłem stanu biznesowego”). Wymagania
taska i planu wymuszają cechy, które są łatwe do wyrażenia w natywnym SQL, a
trudne albo ryzykowne za grubą warstwą ORM:

- **append-only ledgery i audit** — brak publicznego UPDATE/DELETE, egzekwowany w
  bazie (triggery/rewokacja uprawnień), nie tylko w kodzie aplikacji;
- **optimistic concurrency (CAS) na `checkpoint_revision`** — atomowy warunkowy
  `UPDATE ... WHERE revision = $expected` i `INSERT` nowej rewizji;
- **deduplikacja providera** — natywne `UNIQUE` na `(provider, connection_id,
  dedupe_key)` z `ON CONFLICT DO NOTHING`;
- **integralność owner/connection** — złożone klucze obce i `UNIQUE (id, owner_id)`
  wymuszające, że encja/case nie może wskazać connection innego ownera zwykłym
  zapisem;
- **indeksy hot-path** — częściowe i złożone indeksy (`WHERE ... IS NOT NULL`),
  które ORM abstrahuje niedeterministycznie;
- **retencja raw payload** — jawne kolumny/polityki, natywne typy `bytea`,
  `timestamptz`, `jsonb`;
- **bezpieczna ewolucja migracji** — pełny audytowalny SQL widoczny w diffie.

Model nie jest warstwą autoryzacji (AGENTS.md §6), więc granice owner/connection
i append-only muszą być egzekwowane deterministycznie w bazie, a nie tylko w
kodzie modelu czy repozytoriów.

## Decyzja

**Sterownik:** `pg` (node-postgres) `8.16.3` — dojrzały, bez ukrytej warstwy
mapowania. Repozytoria piszą jawny, parametryzowany SQL i otrzymują natywny
dostęp do PostgreSQL (transakcje, `ON CONFLICT`, `RETURNING`, `SELECT ... FOR
UPDATE`, `jsonb`, częściowe indeksy, funkcje/triggery). Żaden ORM ani query
builder nie pośredniczy między repozytorium a bazą.

**Migracje:** ręcznie pisane pary plików SQL `NNN_name.up.sql` /
`NNN_name.down.sql` w `packages/database/migrations/`, uruchamiane przez własny,
lekki runner (`src/migrate.ts`). Runner:

- stosuje migracje w kolejności numeru, każdą w osobnej transakcji;
- rejestruje zastosowane migracje w tabeli `schema_migrations` (wewnątrz tej
  samej transakcji co sama migracja), z checksumą pliku dla wykrycia dryfu;
- wspiera `up`, `down` (rollback ostatniej / do wskazanej wersji) i `status`;
- używa `pg_advisory_lock`, aby dwie równoległe instancje nie migrowały naraz;
- odmawia startu, gdy checksum zastosowanej migracji różni się od pliku
  (fail-closed przeciw cichej edycji zaakceptowanej migracji).

**Down migracje** są obowiązkowe (kryterium akceptacji 1: „może zostać cofnięta
zgodnie z ADR”), aby up/down/up na czystej bazie był deterministyczny.

## Dlaczego nie ORM / nie framework migracji

- **Prisma:** własny język schematu i wygenerowany klient przesłaniają natywny
  SQL; częściowe indeksy, triggery append-only, `ON CONFLICT`-CAS i złożone
  klucze `UNIQUE(id, owner_id)` wymagają i tak surowego SQL, więc ORM dokłada
  warstwę bez zysku, a utrudnia audyt integralności w bazie.
- **Drizzle / Kysely (query buildery):** lżejsze niż ORM, ale nadal wprowadzają
  warstwę typów budującą SQL; task jawnie wymaga „zachowania natywnego dostępu
  PostgreSQL”, a integralność (FK, triggery, partial unique) i tak żyje w SQL.
- **node-pg-migrate / Umzug:** kompetentne, ale dokładają zależność i własne DSL
  ponad tym, czego potrzebujemy; runner tego taska to ~mały, audytowalny plik.
  Rezygnujemy z zewnętrznej zależności na rzecz przejrzystości i mniejszej
  powierzchni ataku (AGENTS.md: bez zbędnych zależności/sekretów).

Świadomie akceptujemy koszt ręcznego pisania down-migracji i lekkiego runnera w
zamian za pełną kontrolę nad natywnymi cechami PostgreSQL i audytowalnym SQL.

## Konsekwencje

- Repozytoria są cienkie i jawne; każdy invariant integralności ma odpowiednik w
  bazie (constraint/trigger), nie tylko w TypeScript.
- Diff migracji jest czytelnym SQL — audyt integralności referencyjnej i
  indeksów odbywa się na poziomie schematu.
- Integration testy używają prawdziwego PostgreSQL (Docker Compose lub lokalny
  klaster `pg_ctl`); mock SQL jest zakazany kryterium akceptacji 6.
- Konfiguracja połączenia pochodzi wyłącznie z env (`RA_DATABASE_URL` lub
  dyskretne `PG*`); żaden sekret nie jest commitowany. Lokalne, nie-sekretne
  wartości pozostają w `docker-compose.yml` z RA-001.

## Ewolucja i rollback

- **Nowa migracja:** kolejny numer `NNN`, para up/down, świadoma i addytywna,
  gdy to możliwe (nowe kolumny `NULL`/`DEFAULT`, nowe tabele, nowe indeksy
  `CONCURRENTLY` poza transakcją w przyszłości). Zmiany łamiące wymagają nowej
  migracji i, jeśli dotykają kontraktów, aktualizacji `@remoteagent/contracts`.
- **Rollback:** `migrate down` cofa ostatnią (lub do wskazanej) wersję,
  wykonując `*.down.sql` w transakcji i usuwając wpis z `schema_migrations`.
- **Checksum guard:** zmiana treści już zastosowanej migracji jest wykrywana i
  blokuje start — ewolucja odbywa się przez nowy plik, nie przez edycję starego.
