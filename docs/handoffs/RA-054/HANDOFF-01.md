# RA-054 — HANDOFF-01

- Task: `RA-054` Codex subscription live compatibility repair
- Data: `2026-08-29`
- Bazowy commit: `a4caec6c8fa066b12bb37b28f52c7d5549065b79`
- Status po handoffie: `DONE` (`AUDIT-01` -> `PASS`)

## Rezultat

Engineering ma potwierdzoną realnie, subskrypcyjną ścieżkę Codex CLI bez API
key. Preflight toleruje oficjalne położenie pojedynczej linii auth na stdout lub
stderr, ale odrzuca ambiguity i obcą metodę loginu. Code-owned structured
response envelope jest zgodna z live strict schema. Model pozostaje jawnym
parametrem profilu; RA-054 nie przypisał żadnego modelu na stałe do roli.

Opt-in smoke uruchomił `gpt-5.6-sol` przez produkcyjny transport w pustym,
read-only root bez tools i zwrócił `CODEX_ENGINEERING_OK`. Ostatni exact przebieg
zaraportował `8749` input, `84` output i `8833` total tokens.

Budżet diagnostyczny całego Engineering invocation jest trzykrotnie większy:
target `750000`, warning `1200000`, hard limit `1800000`, next-call reserve
`105000`. Journal nadal zapisuje realne usage per response i sumę runu.

## Inwarianty do zachowania

- `codex_cli` korzysta wyłącznie z oficjalnego loginu ChatGPT; API key/cloud env
  ma pozostać fail-closed.
- Auth status pochodzi z dokładnie jednego kanału i jednej niezmienionej linii;
  nigdy nie kopiować raw control output do błędu lub journalu.
- Każdy code-owned `const`/`enum` w output schema musi mieć jawny JSON Schema
  `type`; digest wiąże cały schema/tool surface.
- Model i executable pozostają explicit deployment/test input. Nie dodawać
  hardcoded roli, fallbacku ani auto-switcha.
- Live test pozostaje opt-in, pusty, read-only i tools-disabled. Jego log może
  zawierać wyłącznie content-free identity/usage, bez promptu i model prose.
- Budżet 3× jest globalny dla jednego Engineering invocation, ponieważ role w
  jednym runie mogą używać różnych providerów. Nie traktować go jako output
  limitu jednego calla.

## Dowód

```text
real Codex subscription smoke             1/1, 4.960s, exit 0
real provider usage                        8749 in / 84 out / 8833 total
pełna real-PG suite                        3069/3069, 244/244, exit 0
build --force                              29/29, 0 cached, exit 0
typecheck --force                          46/46, 0 cached, exit 0
lint / format / diff-check                 exit 0
workflow:validate                          OK — 54 tasks
audit                                      AUDIT-01 PASS
```

## Decyzje i ślepe uliczki

- `gpt-5.6-codex` i `gpt-5.3-codex` zostały odrzucone przez usługę dla tego
  konta ChatGPT; nie dodano fallbacku. Owner jawnie wybrał do smoke
  `gpt-5.6-sol`, które przeszło.
- Pierwszy live success ujawnił dodatkowy prawidłowy event
  `MODEL_SESSION_STARTED`; poprawiono testową asercję, nie transport.
- Pierwsze pełne bramki ujawniły wyłącznie format oraz stary liczbowy fixture
  progu. Fixture korzysta teraz z produkcyjnych stałych; finalna suite jest
  zielona.
- Claude, Bedrock i OpenCode pozostały wyłączone. Wybór implementera/reviewera
  jest nadal decyzją na późniejsze testy profili.

## Granice zewnętrzne

Jedyną operacją zewnętrzną był jawnie zatwierdzony, read-only live model smoke.
Nie wykonano push, MR, Jira, Discord, commita w obcym repo ani zmiany projektu
SonderMind.
