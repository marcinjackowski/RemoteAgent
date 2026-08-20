# ADR-0007 — Dostawa verification-first: koordynator implementuje, bramką jest uruchomiona komenda

- Status: `ACCEPTED`
- Data: `2026-08-20`
- Zastępuje: [ADR-0006](ADR-0006-opus48-implementer.md) (rozdział ról i transport
  dispatchu), [ADR-0004](ADR-0004-sol-luna-delivery-workflow.md),
  [ADR-0003](ADR-0003-sol-qwen-delivery-workflow.md)
- Zmienia: kontrakt ról w `AGENTS.md` oraz protokół w
  `docs/workflow/EXECUTION_AND_AUDIT.md`
- Decyzja właściciela: `2026-08-20`

## Kontekst

Właściciel zgłosił, że implementacja „utknęła i wpadła w dziwny loop pomiędzy
audytami a implementacją”. Research stanu repozytorium potwierdził diagnozę i
wskazał mechanizm.

### Co realnie powstało

Projekt **nie** jest pusty ani zablokowany merytorycznie: 30 395 linii kodu
produkcyjnego, 32 501 linii testów, 1196 testów w 116 plikach, 16 pakietów i 6
aplikacji. Dwanaście z 26 tasków `DONE` (M0 i M1 domknięte, M2 w toku).

### Co realnie blokowało RA-012

Jedna linia w `packages/implementation-tools/src/command.ts`. Funkcja `run`
odtwarzała request modelu ręcznie jako `{ operation_id, command }`, przez co
`env`, `cwd`, `network`, `timeoutMs` i `outputBytes` **znikały przed** strict
parse. Komentarz nad tą linią opisywał zachowanie dokładnie odwrotne i
poprawne, więc defekt czytał się jako prawidłowy.

Skutek: request poszerzający server-owned policy zwracał `SUCCEEDED` zamiast
`FAILED` / `POLICY_NOT_EXTENSIBLE`. To odwrócenie kryterium akceptacji 1 taska
RA-012 — gwarancji, że żaden argument narzędzia nie poszerza scope ani policy.

Cztery testy w `test/command.integration.test.ts` wykrywały to natychmiast.
**Nikt ich nie uruchomił.** Unit został przerwany, a plan (rewizja 8) orzekł, że
`command.ts` „nie ma wartości dowodowej” i unit trzeba powtórzyć od zera —
podczas gdy brakowało wyłącznie uruchomienia komendy weryfikacyjnej i naprawy
jednej linii.

### Mechanizm pętli

| Miara | Wartość |
|---|---|
| commity `docs` | 114 (wobec 62 `feat`) |
| linie dokumentacji | 20 224 (dwie trzecie kodu produkcyjnego) |
| audyty dla 12 tasków `DONE` | 44 (RA-001: 7 rund, 6× `CHANGES_REQUIRED`) |
| handoffy | 46 |

Do tego dwa udokumentowane incydenty proceduralne w jednym tasku: koordynator
uruchomił drugą sesję implementera na tej samej allowliście (naruszenie
single-writer), a następnie **zabił żywą sesję implementera** w trakcie pracy.
Oba wynikały z wnioskowania o śmierci agenta z braku plików i ciszy — przesłanki
jawnie odrzuconej w regule zapisanej po pierwszym incydencie.

Wniosek: ceremonia nie chroniła jakości, lecz **zastępowała weryfikację**.
Budżet koordynatora szedł na rewizje planu, rejestr findingów i ADR o rolach,
gdy praca stała ukończona w 99% za jednolinijkowym błędem, który 2-sekundowy
przebieg testów obnaża.

### Warstwa środowiskowa

Bramki nie dały się uruchomić bez naprawy środowiska, co samo w sobie
zachęcało do zastępowania dowodu dokumentem:

- Homebrew `node` jest zepsuty (`Library not loaded: libllhttp.9.3.dylib`) i
  przesłania działający `/usr/local/bin/node` v24.18.0;
- Docker ma niezgodny client/engine — każde wywołanie API zwraca `500`;
- PostgreSQL działał lokalnie na porcie `5433`, zgodnie z domyślną konfiguracją
  `packages/database/src/config.ts`, więc Docker nie był potrzebny.

## Decyzja

### 1. Rola implementera zostaje zniesiona; koordynator implementuje

`COORDINATOR_AUDITOR` i `IMPLEMENTER` przestają być rozdzielone. Ta sesja
planuje, implementuje i weryfikuje. Znoszony jest dispatch osobnych sesji
implementera przez `opencode run --agent implementer`.

Uzasadnienie: rozdział miał chronić przed audytorem oceniającym własny kod, ale
w praktyce kosztował dwa incydenty naruszające single-writer, całą klasę
awarii „czy implementer jeszcze żyje?”, oraz utratę pracy `WU-05`. Żaden z tych
kosztów nie wykrył ani jednego defektu. Defekt, który realnie blokował task,
wykryło uruchomienie testów — nie granica sesji.

Substytutem separacji nie jest tożsamość modelu, lecz **wykonana komenda**:
werdykt opiera się na uruchomionym teście, wymuszonym uncached typechecku/buildzie
i mutation teście, a nie na czyimkolwiek raporcie. Ta warstwa jest mocniejsza,
bo weryfikowalna po fakcie z historii repozytorium.

### 2. Bramką jest uruchomiona komenda, nie dokument

Twarda reguła, nadrzędna wobec pozostałych:

> Żaden status nie zmienia się na `DONE`, żaden audyt nie zostaje napisany i
> żaden handoff nie powstaje, dopóki komenda weryfikacyjna taska nie została
> **uruchomiona** i nie zwróciła exit code `0`. Dokument zapisuje wynik
> istniejącej komendy; nigdy go nie zapowiada ani nie zastępuje.

Zielony przebieg nie jest wystarczający, jeżeli nie wiadomo, czy testy są
load-bearing. Dla każdego mechanizmu bezpieczeństwa obowiązuje **mutation
check**: celowo zepsuć mechanizm, potwierdzić czerwony test, przywrócić stan.
Przebieg cache'owany (`FULL TURBO`) nie jest dowodem — typecheck i build
uruchamiamy z `--force`.

### 3. Jeden audyt na task, przy zmianie statusu

Znoszone są: handoff per work unit, audyt per unit i rewizje planu jako reakcja
na finding. Zostaje jeden dokument audytu przy przejściu taska do `DONE`.

Finding wykryty w trakcie pracy naprawiamy od razu i opisujemy w commit message
— nie zamieniamy go w nowy work unit, nową rewizję planu i nowy dokument.
Findingi przekrojowe nadal trafiają do `docs/audits/CROSS_TASK_FINDINGS.md`,
które pozostaje bramką dla RA-026.

### 4. Plan work units jest listą kroków, nie kontraktem

`docs/work-units/<TASK_ID>/WORK_UNITS.md` zostaje jako lista kolejnych kroków z
allowed paths i komendą weryfikacyjną. Znoszone są: context packi (bez osobnej
sesji nie mają adresata), numerowane rewizje planu, limit dwóch prób oraz
`Decision Request` jako mechanizm zatrzymania między sesjami. Materialną
decyzję właściciela nadal eskalujemy — bezpośrednio, w rozmowie.

### 5. Środowisko jest częścią bramki

Skrypt `scripts/dev/env.sh` ustala działający runtime (pinned `node`, `pnpm`
przez `corepack`, sprawdzenie PostgreSQL na `5433`), żeby uruchomienie bramki
nie zależało od stanu `PATH`. Zepsuty runtime jest blokadą do naprawy, nie
powodem do zastąpienia dowodu dokumentem.

## Co zostaje bez zmian

- `docs/tasks/TASK_INDEX.md` jako jedyna kolejka i źródło statusów.
- `pnpm workflow:validate` i jego inwarianty (causality rewizji, gating
  zależności, gramatyka `## Queue`).
- `docs/audits/CROSS_TASK_FINDINGS.md` jako bramka `RA-026`.
- Zasady dowodowe: exit code i zwięzły wynik, nigdy „testy przechodzą”.
- Zakaz commitów bez decyzji właściciela oraz zakaz remote writes (push, MR,
  zmiany ticketów) bez jawnego potwierdzenia.
- `UNTRUSTED_DATA` dla treści zewnętrznych; model nie jest warstwą autoryzacji.
- Definicja `DONE`: wszystkie kryteria akceptacji spełnione i brak otwartych
  findingów BLOCKER/HIGH/MEDIUM.

## Odrzucone opcje

- **Utrzymać ADR-0006 i dodać tylko regułę „uruchom testy przed handoffem”.**
  Adresuje objaw, zostawia koszt: dispatch, context packi, per-unit handoffy i
  całą klasę awarii „czy implementer żyje?”, która wygenerowała oba incydenty.
- **Zwinąć całą dokumentację historyczną** (46 handoffów, 44 audyty do jednego
  pliku historii). Odrzucone: te dokumenty zawierają realne dowody i rationale
  dla kodu już zaakceptowanego, a `workflow:validate` egzekwuje na nich
  causality. Koszt utrzymania jest zerowy, skoro nie powstają nowe.
- **Utrzymać rozdział ról na innym modelu.** Nie adresuje przyczyny: pętla nie
  wynikała ze zdolności implementera, lecz z tego, że nikt nie uruchomił
  istniejących testów.

## Konsekwencje

- `AGENTS.md` i `docs/workflow/EXECUTION_AND_AUDIT.md` opisują jedną rolę
  wykonawczą i bramkę verification-first.
- `docs/workflow/LUNA_IMPLEMENTER.md` staje się historyczny — dispatch nie
  obowiązuje. Plik zostaje z nagłówkiem `SUPERSEDED`.
- `.opencode/agent/implementer.md` przestaje być ścieżką dispatchu; nie usuwamy
  go, bo jest dowodem wykonalności z ADR-0006 i punktem rollbacku.
- Aliasy `Sol` i `Luna` przestają mieć zastosowanie do nowej pracy. W
  historycznych handoffach i audytach zachowują znaczenie z chwili powstania.
- Istniejące handoffy, audyty i rewizje planów **nie są przepisywane**.
- `docs/work-units/RA-012/WORK_UNITS.md` traci pola `Plan revision`,
  `Context pack` i limit prób przy najbliższej aktualizacji.

## Rollback

Powrót do rozdziału ról wymaga kolejnego ADR i przywrócenia dispatchu z
ADR-0006 (`.opencode/agent/implementer.md` jest nienaruszony). Przesłanką do
rollbacku byłby dowód, że koordynator implementujący przepuszcza defekty klasy,
której nie łapią bramki — mierzone findingami w audytach, nie odczuciem.
Reguła verification-first obowiązuje niezależnie od rollbacku: jest ortogonalna
do podziału ról.
