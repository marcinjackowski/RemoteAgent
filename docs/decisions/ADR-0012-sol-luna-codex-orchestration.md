# ADR-0012 — Natywna orkiestracja Codex: Sol planuje i audytuje, Luna wykonuje

- Status: `ACCEPTED`
- Data: `2026-08-25`
- Zmienia: wyłącznie decyzję o jednej roli wykonawczej z
  [ADR-0007](ADR-0007-verification-first-delivery.md)
- Zachowuje: verification-first, mutation checks, uncached gates, jeden writer,
  jeden audyt taska i brak handoffów per work unit
- Decyzja właściciela: `2026-08-25`, konfiguracja
  `SOL_CODEX_SOL_LUNA_SETUP.md`

## Kontekst

ADR-0007 usunął dawny, ręczny dispatch osobnych sesji implementera, ponieważ
powodował incydenty single-writer, utratę pracy i zastępowanie uruchomionych
testów dokumentami. Codex udostępnia teraz projektowe custom agents z jawnym
modelem, sandboxem i limitem współbieżności. Właściciel zdecydował użyć tego
mechanizmu do przeniesienia głośnej eksploracji oraz implementacji na GPT-5.6
Luna, pozostawiając wymagania, architekturę i finalny audyt GPT-5.6 Sol.

## Decyzja

1. Primary agentem jest GPT-5.6 Sol z reasoning effort `high`.
2. `luna_explorer` jest read-only i służy wyłącznie do ograniczonego mapowania
   niejasnego lub przekrojowego zakresu.
3. `luna_implementer` wykonuje bounded implementation, testy, buildy i celowane
   poprawki z reasoning effort `medium`.
4. Explorer nie jest uruchamiany automatycznie dla małych, oczywistych zmian.
5. Sol zachowuje wymagania, podejmuje decyzje architektoniczne, przygotowuje plan,
   odczytuje rzeczywisty diff i decyduje o akceptacji.
6. Jednocześnie nie działa więcej niż jeden write-capable agent na nakładającym
   się zakresie. Limit projektowy wynosi dwa wątki subagentów, nie dwóch writerów.
7. Raport Luny nie jest evidence. Sol uruchamia właściwą komendę weryfikacyjną i
   stosuje wszystkie wymogi ADR-0007, w tym mutation check mechanizmów
   bezpieczeństwa oraz `--force` dla cache'owanych typecheck/build.

## Czego ta decyzja nie przywraca

- ręcznego `opencode run --agent implementer`;
- context packów, rewizji planów i handoffów per unit;
- audytu pisanego przed uruchomieniem bramki;
- wielu równoległych writerów;
- zaufania do podsumowania implementera zamiast diffu i testów.

## Konfiguracja

- `.codex/config.toml` — Sol, multi-agent enabled, limit 2, Luna jako default;
- `.codex/agents/luna_explorer.toml` — Luna medium, `read-only`;
- `.codex/agents/luna_implementer.toml` — Luna medium, `workspace-write`;
- `AGENTS.md` — reguły delegacji, audytu, korekt i single-writer.

## Konsekwencje

ADR-0007 pozostaje obowiązujący w całości poza sekcją znoszącą rozdział ról.
W razie konfliktu co do dowodu pierwszeństwo zawsze ma jego reguła nadrzędna:
uruchomiona komenda z exit code `0` przed statusem, audytem i handoffem.

`ADR-0013` uzupełnia tę decyzję o ciągłe wykonanie kolejnych tasków: podział ról
pozostaje ten sam, lecz normalna granica taska nie wymaga `continue` ani nowej
zgody właściciela.
