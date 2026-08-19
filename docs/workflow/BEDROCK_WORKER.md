# Bedrock Opus 4.8 worker (legacy)

> Ten worker nie jest już domyślnym implementerem procesu budowy repozytorium.
> Aktualny flow używa Sol jako koordynatora/audytora i lokalnego Qwena przez
> oMLX + Codex CLI; zob. `docs/workflow/QWEN_IMPLEMENTER.md` i ADR-0003.
> Skrypt pozostaje jako historyczne, przetestowane narzędzie i nie jest usuwany.

## Cel

`scripts/bedrock-worker` pozwala nadrzędnemu agentowi wywoływać z shella Claude
Code w trybie headless jako implementera RemoteAgent. Claude Code korzysta z
Amazon Bedrock, dokładnego modelu Opus 4.8 i pełnego repozytoryjnego workflow.

Model `us.anthropic.claude-opus-4-8` ma natywne okno 1M tokenów. Wrapper ustawia
również `--autocompact 1M`, żeby nie kompaktować kontekstu wcześniej niż wymaga
tego wybrana granica. Nie jest potrzebny historyczny beta header 1M.

## Bezpieczeństwo

- wrapper nie zapisuje ani nie przyjmuje credentiali;
- preferuje `AWS_BEARER_TOKEN_BEDROCK` z environment;
- jeśli zmiennej nie ma, odczytuje wyłącznie ten jeden klucz z
  `~/.claude/settings.json`, nie włączając pozostałych ustawień użytkownika;
- AWS credential chain jest fallbackiem, gdy Bedrock API key nie istnieje;
- domyślny region to `us-east-1`, zgodny z profilem `us.*`;
- model i region można zmienić wyłącznie przez jawne environment overrides;
- MCP jest wyłączone dla workera przez pustą, strict konfigurację;
- worker nie używa `--dangerously-skip-permissions`;
- built-in tools i Bash commands mają allowlistę;
- `git push` i `glab mr` są domyślnie niedostępne;
- local runtime logs mają permission wynikające z `umask 077` i są ignorowane
  przez Git.

## Prerequisites

```text
claude 2.1.234 lub kompatybilny
jq
uuidgen
Bedrock API key w AWS_BEARER_TOKEN_BEDROCK albo ~/.claude/settings.json
lub AWS credentials z bedrock:InvokeModel/InvokeModelWithResponseStream
model access dla us.anthropic.claude-opus-4-8
```

Sprawdzenie lokalne bez połączenia z AWS:

```bash
scripts/bedrock-worker --doctor
```

Sprawdzenie credential chain i dostępu do metadanych profilu bez płatnego
wywołania modelu:

```bash
scripts/bedrock-worker --check-bedrock
```

Preflight preferuje Bedrock API key i nie wymaga wtedy STS ani znajomości AWS
account ID. Jeżeli klucza nie ma, używa standardowego AWS credential chain.
Preflight nie potrafi potwierdzić `InvokeModelWithResponseStream` bez prawdziwej
inference; potwierdza dostęp do wskazanego profilu.

## Opcjonalny wariant IAM dla profilu US

Ta sekcja nie jest potrzebna przy działającym Bedrock API key. Dla wdrożenia
opartego na IAM/STS szablon least-privilege znajduje się w
`docs/workflow/bedrock-worker-iam-policy.json`. Przed podpięciem polityki zastąp
wszystkie wystąpienia `<ACCOUNT_ID>` numerem konta AWS. Polityka zezwala wyłącznie na:

- `InvokeModel` i `InvokeModelWithResponseStream` dla profilu
  `us.anthropic.claude-opus-4-8`;
- wywołanie tego modelu przez wskazany profil w regionach docelowych
  `us-east-1`, `us-east-2` i `us-west-2`;
- `GetInferenceProfile` używane przez `--check-bedrock`.

Politykę podłącza ręcznie właściciel konta albo administrator IAM. Wrapper nigdy
nie modyfikuje IAM. Jeżeli konto należy do AWS Organizations, SCP musi również
pozwalać na wszystkie trzy regiony docelowe; zablokowanie jednego z nich może
zatrzymać cały profil cross-region.

## Wywołania

Nowy implementer i rozpoczęcie kolejki:

```bash
scripts/bedrock-worker --name implementer --new -- "continue"
```

Kolejna wiadomość w tej samej Claude session:

```bash
scripts/bedrock-worker --name implementer -- "continue"
```

Przekazanie findingów lub innego polecenia:

```bash
scripts/bedrock-worker --name implementer -- \
  "Przeczytaj najnowszy audyt bieżącego taska i wykonaj continue."
```

Read-only konsultant:

```bash
scripts/bedrock-worker --readonly --name adviser --new -- \
  "Przeanalizuj bieżący plan i wskaż ryzyka. Nie zmieniaj plików."
```

Prompt można przekazać przez stdin. Bez promptu wrapper używa `continue`.

## Raport po każdym wywołaniu

Worker zawsze zwraca JSON zgodny z
`scripts/bedrock-worker-report.schema.json`. Raport zawiera:

- status i task ID;
- podsumowanie i wykonane kroki;
- rationale oraz rozważone alternatywy bez prywatnego chain-of-thought;
- pliki, komendy i test evidence;
- pytania decyzyjne i rekomendację;
- ryzyka, handoff path oraz następny krok.

Wrapper dodaje `_worker` z session ID, modelem, regionem, bezpieczną nazwą źródła
uwierzytelnienia, exit code, lokalnymi ścieżkami pełnego envelope i stderr oraz
polem `error`. Wartość klucza nigdy nie trafia do raportu. Dla udanego transportu
`error` ma wartość `null`. Dla błędu zawiera wyłącznie bezpieczne pola:

```text
category: authentication | authorization | throttling | model_access |
          invalid_output | cli
http_status: number | null
retriable: boolean
safe_message: string
```

Błąd IAM, credentiali albo dostępu do modelu daje `status: blocked`. Pełna
odpowiedź dostawcy, która może zawierać ARN lub account ID, pozostaje tylko w
lokalnym envelope albo pliku stderr. Publiczny raport używa stałego,
zanonimizowanego komunikatu.

Każdy report/envelope jest zapisywany pod:

```text
.remote-agent/bedrock-worker/<name>/reports/
.remote-agent/bedrock-worker/<name>/envelopes/
.remote-agent/bedrock-worker/<name>/stderr/
```

`--raw` wypisuje envelope zamiast bezpiecznego raportu na stdout, ale nadal
zapisuje oba pliki. Używaj tej opcji wyłącznie lokalnie: envelope może zawierać
ARN, account ID albo treść błędu dostawcy.

Raport runtime nie zastępuje handoffu. Po ukończeniu taska worker tworzy
`docs/handoffs/<TASK_ID>/HANDOFF-<NN>.md`, ustawia `AWAITING_AUDIT` i zwraca
`audit_requested: true`. Nadrzędny model wykonuje wtedy niezależny audyt.

## Remote writes

Dopiero gdy aktualny task i policy pozwalają na remote writes:

```bash
REMOTE_AGENT_WORKER_ALLOW_REMOTE=1 scripts/bedrock-worker \
  --name implementer -- "continue"
```

Ta flaga tylko udostępnia komendy. Nie zastępuje scope grant, approval ani reguł
z `AGENTS.md`.

## Koszt i limity

Jedno wywołanie ma domyślnie limit 10 USD i 80 turns. Można je jawnie zmniejszyć:

```bash
REMOTE_AGENT_WORKER_MAX_BUDGET_USD=2 \
REMOTE_AGENT_WORKER_MAX_TURNS=20 \
scripts/bedrock-worker --name implementer -- "continue"
```

Nie ma automatycznego fallbacku na inny model: brak Opus 4.8 kończy wywołanie
błędem zamiast cicho zmieniać model.

## Test transportowy

Po udanym `--check-bedrock` wykonaj jeden osobny test read-only. Ten prompt nie
rozpoczyna RA-001 i nie udostępnia narzędzi zapisujących:

```bash
REMOTE_AGENT_WORKER_MAX_BUDGET_USD=0.25 \
REMOTE_AGENT_WORKER_MAX_TURNS=1 \
scripts/bedrock-worker --readonly --name smoke-auth --new -- \
  "Transport smoke test only. Do not read files or call tools. Return a completed structured report with no work done."
```

Oczekiwany rezultat to exit code `0`, `status: completed`, model
`us.anthropic.claude-opus-4-8`, region `us-east-1` i `_worker.error: null`.

Regresyjne testy wrappera nie wywołują AWS ani płatnego modelu:

```bash
scripts/test-bedrock-worker
```
