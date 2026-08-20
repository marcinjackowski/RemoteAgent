# ADR-0006 — Claude Opus 5 koordynuje i audytuje, Claude Opus 4.8 implementuje

- Status: `ACCEPTED`
- Data: `2026-08-20`
- Zastępuje model identity z: [ADR-0005](ADR-0005-opus5-coordinator-and-implementer.md)
- Nie zmienia: kontraktu ról z `AGENTS.md` ani protokołu z
  `docs/workflow/EXECUTION_AND_AUDIT.md`

## Kontekst

ADR-0005 przypisał obie role — `COORDINATOR_AUDITOR` i `IMPLEMENTER` — jednemu
modelowi (`Claude Opus 5`), ponieważ w poprzednim harnessie (Claude Code z
tożsamościami `opus`, `sonnet`, `haiku`, `fable`) `Opus 4.8` nie był osiągalny jako
model subagenta. ADR-0005 jawnie odnotował koszt tego wyboru: separacja opierała
się wyłącznie na granicy sesji i zamkniętym context packu, nie na różnicy modelu.

Harness zmienił się. Bieżąca sesja pracuje w `opencode` z providerem
`amazon-bedrock`, gdzie `us.anthropic.claude-opus-4-8` jest dostępny i został
zweryfikowany realnym wywołaniem. Przesłanka niewykonalności z ADR-0005 przestała
obowiązywać, więc właściciel wrócił do pierwotnej rekomendacji z handoffu
transferowego: `Opus 4.8` jako implementer, `Opus 5` jako koordynator/audytor.

Decyzja właściciela `2026-08-20`: planowanie, tworzenie tasków i audyty prowadzi
`Opus 5`; implementację i pozostałą pracę wykonawczą prowadzi `Opus 4.8` jako
worker, którego pracę sprawdza koordynator.

## Decyzja

- `COORDINATOR_AUDITOR` = **Claude Opus 5** (ta sesja) — plany, work units, statusy
  kolejki, handoffy, audyty. Nie pisze kodu produktowego.
- `IMPLEMENTER` = **Claude Opus 4.8** (`amazon-bedrock/us.anthropic.claude-opus-4-8`,
  `variant: high`) — osobna, ephemeryczna sesja per work unit.
- Dispatch: agent `implementer` zdefiniowany w `.opencode/agent/implementer.md`,
  uruchamiany komendą shellową na jeden work unit. Kontrakt uruchomienia i dokładna
  komenda: `docs/workflow/LUNA_IMPLEMENTER.md`.
- Granice work unitu są egzekwowane **deterministycznie poza modelem**, przez
  permissions harnessu, a nie tylko treścią promptu:
  - `edit` domyślnie `deny`, z allowlistą dokładnie tych ścieżek, które work unit
    dopuszcza (wstrzykiwaną per dispatch);
  - `docs/**`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `.opencode/**`, `.git/**`
    zablokowane do zapisu na poziomie agenta;
  - `docs/MASTER_PLAN.md`, `docs/PROGRESS-*.md`, `docs/tasks/**`,
    `docs/work-units/**`, `docs/handoffs/**`, `docs/audits/**`, `docs/workflow/**`
    zablokowane do **odczytu**, żeby zamknięty context pack był granicą techniczną,
    nie tylko prośbą;
  - `git commit`, `git push`, `git checkout/branch/reset/revert/stash/clean`,
    `gh`, `glab`, `curl`, `wget`, `ssh`, `npm/pnpm publish` zablokowane;
  - `webfetch`, `websearch` i zagnieżdżone `task` zablokowane.

Separacja `IMPLEMENTER` od `COORDINATOR_AUDITOR` opiera się teraz na trzech
niezależnych warstwach: różnym modelu, granicy sesji z zamkniętym context packiem
oraz deterministycznych permissions. Odpada wymóg z ADR-0005, by audyt tłumaczył
się z dzielonej tożsamości modelu — nie odpada natomiast wymóg, że **werdykt
powstaje z odczytu diffu i własnego uruchomienia testów**, nigdy z raportu
implementera.

## Dowód wykonalności

Trzy self-testy harnessu uruchomione przed przyjęciem decyzji, każdy w świeżej
sesji `opencode run --agent implementer`:

| Próba | Oczekiwane | Wynik |
|---|---|---|
| wywołanie modelu | `us.anthropic.claude-opus-4-8` odpowiada | PASS (`llm.model=us.anthropic.claude-opus-4-8`, `agent=implementer`) |
| `git commit --allow-empty` | `DENIED` przez harness | PASS — odmowa policy, nie prośba o zgodę |
| `write docs/zz-probe.md` | `DENIED` (globalny deny `docs/**`) | PASS — plik nie powstał |
| `write packages/zz-blocked.txt` przy wstrzykniętej allowliście | `DENIED` | PASS — `edit`/`*`/`deny` zadziałało |
| `write packages/zz-allowed.txt` przy tej samej allowliście | `ALLOWED` | PASS — tylko ścieżka z allowlisty |

Artefakty testowe zostały usunięte. Pierwsza próba ujawniła też pułapkę
konfiguracji: agent z `mode: subagent` jest przez `opencode run --agent`
odrzucany z cichym fallbackiem na agenta domyślnego i **domyślny model**, czyli
uruchomiłby się nie ten model i bez tych permissions. Dlatego agent ma
`mode: all`, a każdy dispatch jawnie podaje `-m` i weryfikuje w logu, że
`agent=implementer` oraz `llm.model=us.anthropic.claude-opus-4-8`.

## Odrzucone opcje

- **Utrzymanie ADR-0005 (Opus 5 w obu rolach)** — działa, ale świadomie rezygnuje z
  najprostszej dostępnej warstwy separacji. Skoro `Opus 4.8` jest osiągalny,
  trzymanie audytora i writera na jednej tożsamości nie ma uzasadnienia.
- **`scripts/bedrock-worker`** (Claude Code headless na Opus 4.8) — istnieje, jest
  przetestowany i ma budżetowe limity oraz schemat raportu. Odrzucony jako domyślny
  transport: jest zorientowany na cały task (`continue`), wymaga drugiej ścieżki
  credentiali i nie potrafi wstrzyknąć per-unit allowlisty ścieżek. Pozostaje jako
  fallback, gdy dispatch przez `opencode` jest niedostępny.
- **Sonnet 5 jako implementer** — tańszy, ale units adwersarialne (`RA-011`,
  `RA-016`) już dwa razy przegrały pod implementerem o niższej zdolności.

## Konsekwencje

- `docs/workflow/LUNA_IMPLEMENTER.md` opisuje dispatch przez `opencode run`;
  nazwa pliku i alias `Luna` pozostają historyczne.
- `AUDIT_CHECKLIST.md` traci klauzulę o dzielonej tożsamości modelu, zachowuje
  wymóg samodzielnego odtworzenia dowodów.
- `docs/work-units/*/WORK_UNITS.md` aktualizują pole `Implementer` przy najbliższej
  rewizji swojego planu; nie przepisujemy historii wstecz.
- Handoffy i audyty powstałe przed tym ADR zachowują zapisaną tożsamość modelu jako
  stan z chwili powstania.
- Nadal obowiązuje: maksymalnie trzy równoległe strumienie, jeden writer na
  task/case, rozłączne allowed paths, zakaz commitów i remote writes po stronie
  implementera, dwie nieudane próby tego samego celu kończą się udokumentowaną
  blokadą.

## Znane ograniczenie

`bash` implementera jest szeroki (potrzebuje `pnpm`, `node`, `git status/diff`),
więc deny na `read`/`edit` można obejść przez `cat` albo przekierowanie w shellu.
Permissions harnessu są **defense in depth**, nie granicą kryptograficzną.
Autorytatywną kontrolą pozostaje porównanie rzeczywistego diffu z allowlistą przez
koordynatora przed akceptacją unitu. Zawężenie `bash` do allowlisty komend jest
możliwym późniejszym wzmocnieniem; nie jest warunkiem tej decyzji.

## Rollback

Powrót do ADR-0005 wymaga wyłącznie zmiany `model` w
`.opencode/agent/implementer.md` na `amazon-bedrock/us.anthropic.claude-opus-5` i
zapisania kolejnego ADR. Jeżeli `Opus 4.8` dwa razy nie domknie tego samego celu,
koordynator nie ponawia cicho trzeciej próby: dokumentuje blokadę, dzieli unit
inaczej albo zwraca właścicielowi Decision Request o zmianie zakresu lub modelu.
