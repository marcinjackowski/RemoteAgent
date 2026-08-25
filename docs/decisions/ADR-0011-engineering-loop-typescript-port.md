# ADR-0011 — Human-steered, durable Engineering Control Plane

- Status: Accepted
- Date: 2026-08-25
- Scope: M8 (`RA-037..RA-044`) i kwalifikacja iOS `RA-045`
- Supersedes: write-loop `RA-034`

## Kontekst

RemoteAgent ma już zaudytowane elementy coding loopu: `agent-orchestrator`,
`repository-planner`, `implementation-tools`, `test-evidence`, `review-loop`,
`git-lifecycle` i `workspace-runner`. Brakuje spójnego procesu, który przed
implementacją rozstrzyga projekt, wykonuje zmianę małymi obserwowalnymi krokami,
wiąże każdy side effect z trwałym dowodem i przeżywa restart bez niebezpiecznego
replayu.

Punktem wyjścia był prywatny projekt `../EngineeringLoop`. Jego najcenniejsze
elementy to strict contracts, jawna maszyna stanów, intent/completion journal,
provenance, świeże context packety, zewnętrzne gates i fail-closed recovery.
OpenCode, filesystem run-store, Python, `dulwich`, Darwin `sandbox-exec` i
benchmarki Phase 5 są szczegółami tej implementacji, nie kontraktem RemoteAgent.

Research wykonany `2026-08-25` uzupełnił ten wzorzec o trzy wnioski:

1. **Kontekst jest pamięcią roboczą, nie historią rozmowy.** Surowe źródła mają
   pozostać trwałe, a każda rola dostaje świeży, celowy packet z dowodami
   potrzebnymi do następnej decyzji.
2. **Bezpieczny loop nie gwarantuje utrzymywalnego kodu.** Test szybko odpowiada,
   czy zachowanie działa, ale koszt złego projektu ujawnia się przy kolejnych
   zmianach. Dlatego product intent, system architecture i program design muszą
   powstać przed kodem, zależnie od ryzyka taska.
3. **Review, nie generowanie, jest ograniczeniem systemu.** Implementacja idzie
   pionowymi slices: mały działający przekrój, deterministyczne backpressure,
   review i dopiero następny slice. Więcej agentów nie zastępuje zrozumienia ani
   nie usuwa bottlenecku review.

Źródła researchu:

- `../EngineeringLoop` — lokalny reference implementation durability i gates;
- [Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md)
  — product/system/program design i vertical slices;
- [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) — własny
  context i control flow, małe role w większym deterministycznym systemie;
- [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/) —
  repozytorium jako system wiedzy, twarde inwarianty i agent-legible environment;
- [SWE-agent](https://arxiv.org/abs/2405.15793) — interfejs narzędzi jest częścią
  jakości agenta, nie neutralnym transportem.

## Decyzja nadrzędna

Budujemy **jeden human-steered, durable Engineering Control Plane**, nie kopię
EngineeringLoop i nie drugi orchestrator.

`packages/agent-orchestrator` (`SupervisorRuntime`) pozostaje jedynym production
control plane, a `apps/agent-worker` jedynym composition rootem wykonującym jego
role. M8 rozszerza te komponenty o kontrakty projektu, trwałe operacje, context
compiler, etapy engineering workflow, gates i pionowe slices. Nowy pakiet może
hostować czyste kontrakty lub adaptery, ale nie może mieć niezależnego drivera,
kolejki ani autorytatywnej maszyny stanów.

`EngineeringPhase` jest domenowym payloadem/projekcją obsługiwaną przez
`SupervisorRuntime`, a nie drugim właścicielem transitions. Tylko runtime może
claimować unit, zmieniać jego status, enqueue'ować pracę albo finalizować run.

## Proces zależny od ryzyka

Task otrzymuje deterministycznie egzekwowaną klasę procesu. Model może
zaproponować klasę, ale nie może jej obniżyć ani usunąć wymaganych bramek.

### `SMALL`

Lokalna, odwracalna zmiana o małym blast radius i jednoznacznym kryterium:

```text
discover -> implement slice -> gates -> review -> complete
```

### `MEDIUM`

Zmiana obejmująca kilka modułów albo nowe zachowanie:

```text
discover -> combined system/program design -> implement slices -> gates/review -> complete
```

### `LARGE_OR_HIGH_RISK`

Architektura, migracje, auth/policy, dane użytkownika, współbieżność, zewnętrzne
side effecty albo szeroki iOS flow:

```text
product contract -> system architecture -> program design -> owner/design approval
-> vertical slices (implement -> gates -> review) -> final verification -> complete
```

Polityka bierze pod uwagę co najmniej: zakres ścieżek/modułów, nowość wzorca,
zmianę kontraktu lub danych, bezpieczeństwo, nieodwracalność, side effecty i
brak deterministycznego oracle. Właściciel może podnieść klasę jawną decyzją
związaną z rewizją, ale pojedyncza decyzja runu nie może zejść poniżej
deterministycznego minimum. Obniżenie tego minimum jest zmianą wersjonowanej
policy/architektury, nie argumentem modelu ani operacyjnym wyjątkiem.

## Kontrakty przed implementacją

Control plane utrzymuje wersjonowane, strict kontrakty:

- `OutcomeContract`: problem, rezultat, non-goals, kryteria sukcesu i klasa
  ryzyka;
- `SystemDesign`: granice modułów/usług, dane, API, integracje i inwarianty;
- `ProgramDesign`: call-flow/call-stack, file-tree diff, kluczowe typy i
  sygnatury, niepewności, spodziewane testy i kolejność slices;
- `SliceContract`: jeden obserwowalny rezultat, allowed paths, gate IDs,
  inspection method i stop condition;
- `ContextManifest`: użyte źródła, revision/digest, trust, freshness, powód
  dołączenia, budżet i referencja do pełnego artefaktu;
- `EvidenceBundle`: tree/config digests, command receipts, test-first evidence,
  diff, findings i decyzje review.

Kontrakty modelowe są propozycjami. Kod niezależnie sprawdza semantykę,
uprawnienia, policy, kompletność gates i zgodność dowodów z bieżącym drzewem.

## Vertical-slice loop

Implementer jest jedynym writerem workspace danego `case_id`. Wykonuje jeden
zaakceptowany `SliceContract` naraz. Po każdym slice:

1. odczyt rzeczywistego drzewa i diffu;
2. deterministyczne gates związane z tree/config digestem;
3. test-vacuity/test-first i wymagane mutation checks;
4. niezależny, read-only, diff-bound review;
5. materializacja dowodów i aktualizacja projekcji pamięci;
6. decyzja: następny slice, correction, pytanie właściciela albo terminal.

Heurystyka małego diffu jest pomocna, ale liczba linii nie jest inwariantem.
Slice definiuje obserwowalne zachowanie i możliwość taniego resteeringu.

## Pamięć i kontekst

Rozdzielamy trzy warstwy:

1. **Raw evidence** — niezmienne wiadomości, tool results, logi, diffy i
   receipty. Nigdy nie jest zastępowane streszczeniem.
2. **Durable knowledge** — ADR-y, aktualna mapa architektury, kontrakty, runbooki
   i przyczyny decyzji. Repozytorium jest preferowanym interfejsem wiedzy
   inżynierskiej; Postgres przechowuje autorytatywny stan operacyjny.
3. **Working projection** — aktywny cel/slice, ukończone wymagania, otwarte
   problemy i referencje do źródeł. `checkpoint.summary` jest niewładczą,
   wersjonowaną projekcją, nie źródłem policy ani evidence.

Każdy etap dostaje nowy context packet z `ContextManifest`; nie odtwarza pełnej
historii. Stage boundaries tworzą naturalne fresh sessions. Kompakcja jest
konfigurowana per model i mierzona; nie opiera się na jednym magicznym procencie
okna.

Zewnętrzne treści pozostają `UNTRUSTED_DATA`. Summary ani dane źródłowe nie mogą
zmieniać owner/integration/case scope, tool policy, gate catalogu lub klasy
ryzyka.

## Trwałość i recovery

PostgreSQL jest jedynym autorytatywnym magazynem operacyjnym. Control plane
utrzymuje append-only operations/events i materializowaną projekcję runu.

Operation/event log jest źródłem prawdy dla przebiegu i side effectów.
`case_checkpoints` jest wersjonowanym snapshotem stanu biznesowego/kontekstu, a
`run_completions` write-once rezultatem modelowego runu; żaden z nich nie jest
alternatywnym journalem operacji. Projekcje muszą być odbudowywalne, a migracja
zachowuje semantykę istniejących completion/checkpoint/outbox flows.

Każda operacja ma:

```text
intent -> started -> completion/receipt -> projection/event
```

Intent jest trwały przed wywołaniem modelu, komendy lub side effectu. Brak
potwierdzonego receiptu po możliwym wykonaniu daje `AMBIGUOUS`, nie replay i nie
`SUCCESS`. Recovery sprawdza operation identity, fencing token, tree digest,
contract/prompt/model/config version i artefakty.

Pytanie do człowieka kończy bieżący run jako `NEEDS_CLARIFICATION` /
`WAITING_FOR_USER` na poziomie odpowiedniego kontraktu. Odpowiedź tworzy nowy
one-shot run związany przyczynowo ze starą decyzją i checkpoint revision; nie
wznawia niedokończonego model calla.

`WAITING_FOR_USER` jest stanem case'a, nie żywą sesją modelu. Zdarzenie
`ANSWER_MATERIALIZED` (nazwa implementacyjna może być równoważna) wiąże
`decision_id`, `parent_run_id`, odpowiedź i oczekiwaną checkpoint revision z
nowym runem. Stara albo powtórzona odpowiedź jest odrzucana/idempotentna.

Stany `AMBIGUOUS`/`BLOCKED` mają minimalny interfejs operatorski: bezpieczny
odczyt statusu oraz jawne acknowledge/retry/cancel/reconcile zgodne z policy.
Operator nie może ręcznie nadać `SUCCESS`, pominąć receipt ani ominąć fencing;
każda decyzja operatorska sama ma intent, authorization i receipt.

## Modele i structured output

Bedrock pozostaje transportem. `bedrock-runtime` otrzyma generyczne,
schema-owned API dla kontraktów etapowych zamiast zakładać jeden globalny
`AgentCompletion`. Completion wiąże: stage, schema version/digest, prompt
version, model identity i request metadata. Repair jest bounded i zależny od
etapu; implementacji nie wolno po cichu powtórzyć jako „repair JSON".

## Gates i review

Model wybiera wyłącznie gate ID. Kod rozwiązuje `executable + argv[]`, cwd,
środowisko, timeout i profil sieci; raw shell command od modelu jest zakazany.

Dowód gate jest ważny tylko dla dokładnego tree digest i config digest. Brak
required gate, brak receiptu albo niezgodność digestu oznacza brak PASS. Wyniki
rozróżniają co najmniej `PASSED`, `FAILED`, `TIMED_OUT`, `CANCELLED`,
`INFRASTRUCTURE` i `AMBIGUOUS`.

Review korzysta z istniejącego `review-loop`. LLM reviewer generuje findings,
ale nie jest dowodem utrzymywalności ani warstwą autoryzacji. Dla high-risk
zmian wymagana jest akceptacja właściciela programu/rezultatu zgodnie z policy.

## Zakres milestone'ów

- **M8 / RA-037..RA-044:** deterministycznie zweryfikowany core control plane na
  fake transportach i throwaway repo, wpięty przez prawdziwy `agent-worker`.
- **RA-045 / M9 iOS Qualification:** profile Xcode/Swift i jawnie uruchamiany
  live smoke na `sondermind-ios`. Brak lokalnego Xcode/AWS nie blokuje jakości
  core M8.

## Konsekwencje

- RA-034 pozostaje `BLOCKED` jako superseded; jego writer-fence i workspace
  scaffolding są wejściem do RA-041/RA-043/RA-045.
- Nie portujemy benchmarków EngineeringLoop ani HumanLayer ACP. ACP jest
  Kubernetesowym schedulerem outer-loop; RemoteAgent ma już Postgres, leases,
  worker i control plane.
- Nie kopiujemy pełnych transkrypcji ani cudzych repozytoriów do
  `docs/reference`. Zachowujemy link/provenance i adaptujemy kontrakty po
  niezależnym przeglądzie licencji oraz bezpieczeństwa.
- M8 nie ma celu „wyeliminować człowieka z review". Ma przenieść kosztowne
  decyzje przed kod, ograniczyć rozmiar zmian i uczynić ludzkie rozumienie
  systemu trwałym artefaktem.
