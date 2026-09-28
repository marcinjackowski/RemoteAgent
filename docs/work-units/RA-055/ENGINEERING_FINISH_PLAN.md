# Engineering Loop — aktywny plan domknięcia i testów live

Aktualny checkpoint 2026-09-28: [ENGINEERING_CURRENT_STATUS](../../ENGINEERING_CURRENT_STATUS.md).
Właściciel autoryzował commit i push dotychczasowej pracy. RA-055 pozostaje
IN_PROGRESS; następna kwalifikacja ma dotyczyć iOS, nie kolejnego Node smoke'a.

Data: 2026-09-07. Baseline całego RA-055: `b4fb467e929fa06193d6bb881856a1d4c0daf9a0`.
Checkpoint wznowienia: `ce9b2ff62e3c947c72c0fafca47d192af983ce98`.
Aktualny task: RA-055, `IN_PROGRESS` w [TASK_INDEX](../../tasks/TASK_INDEX.md).

Ten dokument jest aktualną nawigacją wykonania. Nie jest audytem, PASS ani
nową kolejką. Szczegóły istniejących R0–R9 pozostają w
[ENGINEERING_COMPLETION_PLAN](ENGINEERING_COMPLETION_PLAN.md), a wykonane
komendy, mutation checks i prywatne referencje w [WORK_UNITS](WORK_UNITS.md).
Nie zaczynać ponownie napraw już potwierdzonych. Nie uruchamiać live na podstawie
samego odczytu tego planu.

## Plan wykonania od 2026-09-13

### Aktualny terminal celu pilota — 2026-09-15

**Kontrolowany pilot Node jest zakwalifikowany** według ADR-0030. LIVE07
zakończył się COMPLETED/exit0 z lokalnym commitem0515c519e5a8d41335df5588c7f3c843ae9b0184.
Primary niezależnie przeczytał diff, zweryfikował exact receipts i Git,
uruchomił oracle oraz dodany test w sandboxie: exit0. Pełna bramka44066 exit0,
3846testów,build/typecheck bez cache.128826tokens/111.266s; cała kampania
687053tokens/7prób. Instrukcja: ENGINEERING_PILOT_RUNBOOK.md.

Zakończyć automatyczną kwalifikację małego smoke'a; dalsze użycie to świadomy
pilot kolejnych zadań z odpowiednim config/oracle i zbieraniem logów. Nie
kontynuować historycznych testów głosu/UI ani nie zaczynać starego LIVE09.
RA-055 nadal IN_PROGRESS: pierwotne kryteria iOS nie zostały zamknięte ani
zastąpione małym smoke'em. Nie pisać formalnego PASS/DONE i nie robić commita
zamykającego RA-055. Wszystkie WIP, lokalne wyniki i stare worktree zachowane.
Znane nieblokujące pilota ograniczenia prezentacji checklist/status oraz
sumowania kampanii są jawnie opisane w runbooku.

Poniższe sekcje opisują historię dochodzenia do tego terminala, nie kolejkę
nowych automatycznych prób. Najnowsze dowody są na początku WORK_UNITS.md.

Ta sekcja zastępuje poniższe historyczne instrukcje „następnego kroku”.
Nie zmienia kolejki TASK_INDEX ani nie deklaruje ukończenia RA-055.
Stan bazowy HEAD: `ce9b2ff62e3c947c72c0fafca47d192af983ce98`.
Istniejące duże dirty tree jest zamierzonym WIP; zachować je oraz wszystkie
prywatne worktree. Nie wykonywać cleanupu ani częściowego commita.

### Cel i aktualny dowód

Aktywny cel po decyzji właściciela: kontrolowany pilot według ADR-0030.
Nie czekamy na naprawę wszystkich błędów iOS, ale nie zmieniamy starego wyniku
ani kryteriów zamknięcia MOBL-2023. Pilot ma osobny mały Node smoke, uruchamialne
run/status/stop, prawdziwe receipts/review/commit oraz osobny journal/report.
CLI jest wdrożony i zakwalifikowany lokalnie; dwa pierwsze live zakończyły się
FAILED (22103 oraz131242 tokeny), bez commita. Pierwszy ujawnił sprzeczność
promptu planowania z istniejącym test scope, naprawioną w v5. Drugi ujawnił
rozbieżność receipt history/actual diff po przywróceniu pliku; trwa ograniczona
naprawa normalizacji i regresja. Po niej pełna bramka i nowy LIVE03, bez
zmian zadania/config/modeli i bez usuwania starych prób. Jeszcze nie ma
zielonego światła do samodzielnego pilota.
Allowed paths i wyniki w aktualnym początku WORK_UNITS.md.

Request-aware budget lokalnie potwierdzony przez primary: 173 testy/4 pliki,
exit `0`, strict nowego testu `0`; mutant ignorujący rozmiar requestu wykonał
delegate (1 zamiast 0), exit `1`, potem dokładny restore/GREEN.
Żadnych model calls w tej weryfikacji; rezerwa nadal jest szacunkiem, nie
gwarancją, że provider nigdy nie przekroczy limitu. Nowy pilot użyje Codex
subskrypcji dopiero po lokalnym teście jego realnego production composition.

Aktualizacja 2026-09-14 — profil tekstowy jest wdrożony jako
`full-flow-text-v1`, osobny od historycznego `full-flow-v1`. Pakiet prywatny
`diagnostics/benchmark-text-flow-040PkD` zawiera 9 model tests/3 niezmienione
inputs oraz 4 UI tests/5 niezmienionych inputs. Przygotowanie i niezależna
walidacja realnego factory (1 positive/7 negatives) zakończyły się exit `0`,
bez model calls. Focused 81 testów/5 plików i strict pięciu plików: exit `0`;
dwa mutation RED z dokładnym restore i ponownym GREEN. Szczegóły i digests
w najnowszym checkpoint WU. Pełna bramka exit `0`: 3797 testów, 2 jawne opt-in
skips, 267 plików zaliczonych, 241.19 s; build 29/29 i typecheck 46/46 bez cache,
strict 14 plików i workflow 55 tasków exit `0`. Log
`/tmp/text-flow-primary-full-gate.log`. Bez formalnego PASS ani zamknięcia RA-055.

Aktualna zewnętrzna blokada: canonical preflight nowego pakietu exit `1`,
za mało wolnego dysku (ostatnio 37.90 GiB przy minimum 40 GiB), ponownie
potwierdzone po pełnej bramce w `/tmp/text-flow-primary-final-preflight.log`.
Nie usuwać worktree ani obniżać progu. Po zwolnieniu miejsca:
ponowić preflight, wykonać rzeczywiste testy Xcode nowego zakresu i stosować
dotychczasową bramkę zatwierdzenia dokładnego nowego live. Nie uruchamiać
starego LIVE09. Stare 4 błędy UI pozostają istotne; voice disconnect już nie.
Rezerwa tokenów przed wywołaniem i nadmierny kontekst nadal są osobnymi
nierozwiązanymi problemami, których ta zmiana zakresu nie naprawia.

Wpisy poniżej są historią; propozycja rozszerzenia voice context jest odrzucona.

OWNER DECISION2026-09-14 supersedes voice-context expansion below: task is text
alert; new voice pause/disconnect behavior is out of scope. Latest continue
starts ADR0029 text-only profile implementation:9nonvoice modeltests+4unchangedUI,
new identity/digests, unchanged old full-flow-v1. Do not add voice context or
manually fix iOS voice. WU top holds bounded steps/gates. No new live admitted.
Old09 remains FAILED; four UI failures and budget/context cost remain unresolved.

Latest local qualification40965 EXIT0:3785passed/2explicit opt-in skips,
build29/typecheck46 Cached0,strict12/workflow55/diff0,206.38s;
/tmp/live09-primary-full-gate.log. Primary inspected actual typed postresponse
error and real executor regression, two mutation REDs/exactrestore/GREEN.
No change to hardlimit or reservation sizing; no proof of autonomous delivery.
No live/mutant/writer active. RA055 IN_PROGRESS, all WIP intentionally retained,
including new engineering-model-usage-limit.test.ts; no partial commit/push.
Pause only at OWNER DECISION for changed frozen input proposed below. Existing
same-NLZRRp retry grant does not authorize silently changing its context/digests.
Do not restart09 or admit10 before this decision and local qualification.

Post09 continuation decision — existing frozen input is insufficient for voice
semantics while discovery is sealed. Primary real read-tools replay0 measured
330986evidencebytes/368877promptbytes lower bound,29calls/cap42, unchanged
candidate,0modelcalls; BOTH voice dependency paths absent. This replaces the
earlier unsupported inference from generic pause word matches.

Next proposed work, requiring owner approval for changed frozen inputs (not a
blind10 retry):
1. Add read-only support context for
   `SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/VoiceChat/VoiceChatViewModel.swift`
   and `SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentVoiceCoordinator.swift`.
   Actual candidate sizes28353+5860bytes; no write authority for these files.
2. Replace unnecessarily whole localization/test reads with scoped exact context,
   retaining required copy, neighboring test framework/setup, state/event tests
   and all diagnostic obligations. Measure complete prompt, not only gate payload.
   No silent clipping or dropping owner objective/regression history.
3. Correct misleading behavioral-repair instruction to distinguish writable
   product source from immutable evaluator assertions. Keep existing source scope.
4. Before live, make admission reserve reflect actual request size/cost instead
   of assuming128k is conservative for a measured262k response. The current
   typed post-response fix does NOT fix pre-dispatch reserve sizing. Preserve
   target750k/warning1.2M/hard1.8M, no model/API fallback. Document that provider
   usage arrives after dispatch; never claim a fixed estimate is an exact cap.
5. Build a NEW bundle with new bound digests, same seed/objective/test criteria,
   executable evaluators, four gpt-5.6-sol subscription roles and budget. Preserve
   all old bundles/worktrees. Provider-free replay, focused negatives/mutations,
   full gate and canonical preflight precede ONE sequential newly approved live.

No new bundle or LIVE10 has been admitted. RA055 IN_PROGRESS. Primary qualified
typed overrun code locally (162tests/strict0, two mutation REDs and exact restore),
but rejected/replaced Luna's vacuous negative tool counter before accepting the
test. Full command40965 running in /tmp/live09-primary-full-gate.log. Latest
test-only cleanup separates control/overrun journals; own59212 focused/strict0.
This checkpoint is not formal acceptance or proof of fixed admission/context.

LIVE09 TERMINAL14:48:08Z EXIT1/session12276, FAILED during implementation7.
1856462tokens/18responses COMPLETE; last call overshot hard1.8M by56462.
Campaign INCLUDING09=11501473tokens/0delivered. Six completed corrections/gate
rounds; final11modelcases/2failures and4UIcases/4failures. No review/verifier/commit.
Primary read full final13path277+/28- diff and real voice lifecycle methods:
candidate disables microphone rather than pausing room; UI/design issues remain.
Preserve worktree/seed; no manual iOS edits. Read-only context/token reservation
diagnosis underway. Require concrete reproducer/local qualified fix before any10;
do not relaunch09. WU contains exact export/log refs. All ACTIVE entries below
are history. RA055 remains IN_PROGRESS; no formal acceptance or closing commit.

LIVE09 latest14:45:34Z ACTIVE/session12276,1594513tokens/17responses COMPLETE;
205487remain under hard1.8M. Sixth model gate executed11cases,9pass/2voice
pause failures unchanged. UI gate still active. No review/verifier/commit yet.
Read-only voice diagnosis in parallel; do not edit runtime/candidate or restart.
Exact sixth log and candidate observations in WU. Provisional usage is not yet
added to campaign BEFORE09=9645011tokens/0delivered. RA055 remains IN_PROGRESS.

LIVE09 latest14:23:08Z ACTIVE/session12276,1302096tokens/15responses COMPLETE.
Fourth candidate compiled far enough to execute11modeltests (26failed assertions).
Loop completed semantic correction5 (4source paths, prior-state restoration
now present) and fifth Xcode round is active. No full gate pass/review/commit.
WU holds exact logs/observations. Keep same run; no manual candidate/runtime edits.

LIVE09 checkpoint13:46:37Z ACTIVE/session12276,794303tokens/8responses,
COMPLETE. Initial candidate reached Xcode but had Swift unwrap syntax error;
loop repaired it automatically in attempt2, second Xcode round running.
Candidate engineering-69560a6b0c92cad9eb31c9e5a0e07ef4, case/journal and
nonterminal source observations in WU. No success/review/commit yet, no manual
candidate edits or restart. Follow this live until terminal before next change.

LIVE09 ADMITTED ONCE/session12276, same NLZRRp frozen bundle and Codex
subscription gpt-5.6-sol four roles, hard1.8M. Before admission primary full
gate66367 EXIT0:3784tests/2opt-in skips,build29/typecheck46 Cached0,
strict11/workflow55/diff0; canonical preflight/auth0, seed clean,45.09GB free.
V6 real filesystem tests,4mutation RED/exactrestore/ownGREEN and07/08replays
qualified. Monitor session12276/status-live-09.mjs; do not relaunch or edit
runtime/config/iOS candidate. Campaign BEFORE09=9645011tokens/0delivered.
RA055 IN_PROGRESS; no result claimed. All below no09 instructions historical.

V6 latest checkpoint: exhaustive source FILE READs replace incomplete search
as member uniqueness evidence; exact-domain retained var/let/func declaration
resolves finalizer obligations (never incidental usage SEARCH). Real broker
tests replace obsolete mocks, including let/multiline/ambiguity/late failed
reads. Primary inspected actual source and executed4 mutation REDs with exact
restore. Restored3274 EXIT0:162tests,strict,07/08replays,diff.08context remains
26895bytes6724tokens with43reads/cap48, candidate unchanged/no modelcalls.
Full gate66367 RUNNING, /tmp/v6-primary-full-gate.log. No09prepared/admitted.
Wait actual exit0 then canonical preflight and one approved sequential live.
All below V5/fullgate1664 instructions are historical. Campaign unchanged.

Fullgate1664 EXIT0:3769tests,2opt-in skips,forced build29/typecheck46 Cached0,
strict11/workflow55/diff0. Live09 still NOT admitted: primary found production
search returns first file, so V5 global result cannot establish uniqueness and
literal var lookup misses let/whitespace. Next bounded correction is exhaustive
complete READ of trusted source files for member lookup, with actual read-tools
tests, first-match mutation and replays before another full gate. Details/paths
in WU and ADR0024. No new live tokens; campaign remains9645011/0delivered.

Latest recovery: full gate20843 failed TS6133(exit2), fixed without behavior
change. Repeated v2 log shows3769passed/2opt-in skipped and final workflow55OK,
but terminal exit receipt was lost across compaction. Primary therefore repeats
the identical full command, session1664 RUNNING, /tmp/live08-primary-full-gate-v3.log.
No live09 prepared/admitted. Require actual exit0, then canonical same-bundle
preflight and one sequential approved run. No changes to caps, authority or
frozen inputs. Below fullgate20843-running entries are historical.

Post08 local correction now in full qualification20843 (log
/tmp/live08-primary-full-gate.log). Own147focusedtests/strict/07+08replays exit0;
08context34reads/cap48,26895bytes6724tokens,both member declarations retained.
Generic V5 member lookup, complete trusted-domain oversize fallback, conservative
root cost, inferred implicit-vs-explicit diagnostic distinction and corrected
prompt; all authority/caps/frozen inputs unchanged. New real executor test proves
source patch receipt from separate diagnostic site and out-of-slice refusal.
Four mutationREDs inspected; exactpre-source hashes restored and checked before
fullgate. No09admission/live. Wait for20843 then canonical preflight if exit0;
do not restart08. Historicalcampaign9645011tokens/0delivered. Details inWU.

LIVE08 TERMINAL2026-09-14T12:04:58.605Z: exit1, BLOCKED/NO_PROGRESS after4
implementations. 1213822tokens/13responses, campaign9645011/0delivered.
Both Xcode gates failed65 in all4rounds, source-prechecks passed0. No
review/verifier/commit;10 staged candidate paths preserved, full diff read.
Receiver source files now changed, but last2 rounds repeat compile errors and
actual full-screen integration remains absent. Diagnose diagnostic provenance,
frozen evaluator compatibility and correction context locally before any09.
Do not relaunch08; below ACTIVE entries are historical. RA055 IN_PROGRESS.

LIVE08 checkpoint 2026-09-14T11:32:43Z: still ACTIVE/session62782,
950671 tokens (936943 input +13728 output), 8 responses, COMPLETE accounting.
Initial implementation reached Xcode directly; compiler reported missing
EmergencyResources in SafetyAlert.swift. Automatic correction attempt2 completed
11:30:34Z and second Xcode round is running. This is not a passing receipt.
Case ra045_22494443-f779-4c9e-87bd-6804f09db8ee-case; journal
engineering-9d3e17104f73f242458690563a9a7232cd41548e554e0c44fbc4924c22070554.jsonl
under NLZRRp/artifacts/engineering-debug. No runtime/candidate edits or relaunch.

LIVE08 ADMITTED/session62782, same NLZRRp frozen bundle/models/hard1.8M.
Full gate73020 exit0:3758passed/2opt-in skipped,build29/typecheck46 Cached0,
strict11tests0/workflow55OK. Additional required-receiver mutation RED1,
exact source restored; primary99tests/replay/workflow/diff exit0 after restore.
Canonical preflight+subscription auth0; no08result yet. Monitor status-live-08
and session62782; do not restart or edit runtime/config/candidate. Historical
campaign before08=8431189tokens/0delivered. Earlier pending entries are history.

Post07 local repair qualified focused, full gate pending73020. Fixed context
selection: a test filename no longer substitutes production receiver declaration;
generic receiver arguments do not pollute declaration discovery; exact configured
READs carry source-backed symbol provenance. PolicyV4, unchanged budgets/scope.
Primary184tests+strict+actual07replay exit0:20reads6607bytes1652tokens, both source
receivers retained, candidate unchanged. Plain tool budget failures now have
distinct journal detail codes; no limits increased. Full gate log and mutations
in WU. No08live yet; only full0→canonical preflight may justify next same-bundle run.

LIVE07 TERMINAL2026-09-14T10:45:22.374Z: exit1,1490964tokens/17responses,
campaign8431189/0delivered. Copy/precheck/changelog were repaired autonomously;
real Xcode compile and UI gates reached, but integration remains incomplete.
Final attempt7 hit tool-loop LIMIT_EXCEEDED after two rejected non-substantive
patches, NOT hard token cap. No review/verifier/commit. Preserved7path candidate
and receipts in WU. Runtime can now be diagnosed locally; no blind08.
Next: compare correction target selection/prefetched evidence to missing
AgentAIFlow/ChatViewModel integration. Only a verified concrete repair may
justify another run; increasing limits alone is not the plan. F5/F6/F7 remain
unmet, RA055 IN_PROGRESS. Below ACTIVE entries are historical.

LIVE07 ACTIVE2026-09-14T10:05:48.145Z/session92591, same NLZRRp frozen bundle,
same Codex gpt-5.6-sol roles/hard1.8M. Packet continuity fix qualified by
two independent loss-point mutation RED/restored GREEN checks, primary
focused123/strict4 exit0 (including real URL-config database isolation),
full98087 exit0:3753passed/2explicit opt-in skipped, build29/typecheck46
Cached0,strict11tests0,workflow55OK. Canonical preflight/auth completed.
Monitor status-live-07.mjs and session92591; no runtime/bundle/iOS edits,
no relaunch until terminal. Historical campaign before07=6940225/0delivered.
Receipt result, Xcode/review/commit and07usage remain unknown.

LIVE06 TERMINAL: NO_PROGRESS/BLOCKED,exit1,1201956tokens/10responses,
kampania6940225/0delivered. Exact3 authority działa: dwie korekty doszły do
modelu i kolejnych gate runs. Trzy razy pozostały te same4braki copy; brak
Xcode/review/commit. Nie restartować06. WU zawiera zachowane ścieżki i receipts.
Nowa lokalnie potwierdzona luka: compaction usuwa cały case context przy
korektach/epochach, pozostawiając generic objective i sam digest. Naprawa
ADR0020 preserve bounded/redacted packet + regression/mutations/full gate
jest w toku. To naprawa przekazywania wymagań, nie zmiana benchmarku/orakla.
Nie planować nowego kosztownego live przed własną kwalifikacją tej poprawki.

2026-09-14 kwalifikacja naprawy source-precheck: własne65focused+strict0,
mutation7RED/restoreGREEN, pełna73413 exit0 (3752passed/2opt-in skipped,
build29/typecheck46 Cached0,strict8tests0). Nowy bundle NLZRRp z exact3,
stary hcakTA niezmieniony; rzeczywisty GateFailure05 replay oldUNCLASSIFIED /
newAUTHORIZED3. Canonical preflight0. Następny krok: zatwierdzony live06,
hard1.8M, nie ponawiać generatora ani launcherów04/05. Szczegóły WU.

Wznowienie po decyzji właściciela 2026-09-14: `continue` na dokładne pytanie
zatwierdza exact3 source-precheck candidates i nowy live06 do1.8M. Kolejność:
Luna bounded common-contract/fixtures → własny diff i mutation evidence →
pełna bramka → osobny bundle z jedyną zmianą authority/bindings → preflight
i jeden live06. Zadanie/model/seed/oracle/scope bez zmian, bez push.
Poniższa historyczna blokada zgody jest rozwiązana; kwalifikacja jeszcze nie.

Aktualizacja 2026-09-14 po live05: TERMINAL FAILED,731306tokens,
kampania5738269/0delivered. Asset PASS, source-precheck FAILED (4braki copy),
próba korekty2 zatrzymana PRZED modelem. Potwierdzony digest wyjątku wskazuje
UNCLASSIFIED_GATE_FAILURE: w frozen katalogu source-precheck nie ma żadnych
candidate paths. Runtime prawidłowo egzekwuje ADR0021; obecny preflight
błędnie akceptuje (wręcz wymaga) pustą authority tego naprawialnego testu.
Nie uruchamiać identycznego live06 ani nie omijać guarda. Xcode/review/commit
nie osiągnięte; brak nowej kwalifikacji F5. Własny focused resolver1/profile15
exit0 potwierdza diagnozę, nie naprawę. Szczegóły i plan w WORK_UNITS.

Następna decyzja: nowy frozen bundle z jawnymi3 candidate paths source-precheck
(AgentAI/SafetyAlert.swift, AgentAI/SafetyAlertPresentation.swift,
Resources/en.lproj/Localizable.strings w Sources/Shared). Bez rozszerzania
ogólnego write scope, zmian orakla, generator outputs, modeli i limitu1.8M.
Po zatwierdzeniu: bounded zmiana exact preflight contract + real mapping
regression + mutation RED/restore GREEN → pełna bramka → nowy frozen bundle
i preflight → live06. Nie podmieniać zatwierdzonego hcakTA. To materialna
zmiana konfiguracji dopuszczalnej korekty, wymagająca jawnej decyzji właściciela.
Brak aktywnych procesów testu; WIP i oba kandydaty04/05 zachowane.

Aktualizacja 2026-09-14 rano: host odciążony(load~3), oba solo2/2 i3/3 exit0
bez zmiany timeoutów. Ostateczna własna pełna bramka56012 exit0:
3735passed/2live opt-in skipped,build29/typecheck46 Cached0,strict6helpers0,
workflow55OK. CTF025 zamknięty na podstawie mutation/regression/diff evidence;
RA055 nadal IN_PROGRESS. Poniższa nocna blokada nie jest już aktywna.
Aktualny krok: canonical preflight hcakTA, następnie przygotowana jednorazowa
provider-free UI diagnostic gLCghJ na zachowanym kandydacie04. Dopiero wynik
tej diagnostyki określi, czy wolno przejść do nowego pełnego live05.

Najnowszy checkpoint 2026-09-14 01:43CEST: zachowany journal jednej dodatkowej
diagnostyki wykazał normalny postęp pierwszego slice do fast gate PASS i review,
lecz cały test znowu timeout120000ms. Od mutacji do FAST_GATES_PASSED~54.5s;
nie wykazano deadlocku scheduler/recovery ani błędu nowego ambiguity guarda.
Dalsze identyczne retry wstrzymane. Warunek wznowienia kwalifikacji to porównanie
na odciążonym hoście; jeżeli timeout utrzyma się, mierzyć konkretną operację
actualEvidence/baseline/Git/DB zamiast zwiększać limity. Źródło opóźnienia nie
jest jeszcze ostatecznie rozstrzygnięte. Żadna z poniższych historycznych
wzmianek o trwającej próbie nie jest poleceniem ponownego uruchomienia.

Checkpoint 2026-09-14 01:35CEST: oba timeouty odtworzone solo, a dodatkowa
diagnostyka potwierdziła postęp do gates wewnątrz handlera (scheduler resume
~1.2s, zaobserwowany gate PASSED0/901ms). Nie ma końcowej kwalifikacji.
Host load106,swap~8.4GB; JumpConnect~358%CPU jest procesem użytkownika,
nie wolno go samodzielnie zatrzymać. Wysokie obciążenie jest zaobserwowane,
ale nie dowodzi wyłącznej przyczyny wszystkich opóźnień. Nie wprowadzać
optymalizacji ani wyższych timeoutów na podstawie samej hipotezy.
Najbliższy krok wymaga stabilnych zasobów hosta do porównania lub bounded
pomiaru konkretnego opóźnienia w lifecycle handlera. Kolejność po diagnozie:
oba solo0 → pełna bramka0 → provider-free exact UI → live05 → F6/F7.
Dokładne komendy/wyniki oraz zamierzone dirty paths zapisuje WORK_UNITS.
Nie ma uruchomionego testu w tle ani nowego provider admission.

Aktualizacja 2026-09-14 01:22CEST: bounded naprawy CTF025 i cleanup Xcode
są zaimplementowane; rzeczywiste mutation RED i restored focused GREEN
opisuje WORK_UNITS. Primary wykrył i skorygowano również zależny od kolejności
mock testu cleanup. Pełna bramka po naprawach nie jest zakwalifikowana:
pierwsza exit1 na unused parameter (poprawiony); druga lint/format/build29
Cached0, potem dwa integration failures i kontrolowane przerwanie exit130.
Provider-qualification solo ponownie exit1 przez timeout240000ms; drugi
cross-fence solo trwa. Wysokie obciążenie i swap hosta, brak dowodu na
deterministyczny związek timeoutu z nowym guardem. Nie omijać ani wydłużać
gates dla PASS. Provider-free Xcode nadal przygotowany, NIE uruchomiony.
Następny krok: rozstrzygnąć drugi solo wynik, zapisać stan środowiska i
uruchomić pełną bramkę dopiero po usunięciu przyczyny; brak blind live retry.

2026-09-13, podczas live04: ponownie otwarty CTF-025, nowy wariant
null/UNKNOWN outcome po udanej mutacji. Primary potwierdził syntetycznym
publicznym eksportem (bez provider calls); znany FAILED pozostaje blokowany.
Po terminalu04 naprawić fail-closed malformed mutation receipt i wykonać
regresje/mutation check/full gate przed F7. Nie zmieniać runtime w biegu.
To nie nowy task ani pretekst do blind retry; dokładny dowód w CTF/WORK_UNITS.

Aktualizacja 2026-09-13 22:31UTC: F5 live04 TERMINAL FAILED, sesja53412 exit1,
finished22:31:05.497UTC; nie uruchamiać launchera04 ponownie.
Exact grant hcakTA/do1.8M pozostaje zatwierdzony, ale brak kwalifikacji F5.
Trzy tanie gates PASS0; model Xcode TIMED_OUT1253544ms; UI INFRASTRUCTURE
1213788ms, protected configuration dir ADDED. Brak test IDs/review/verifier/
commita/attempt2. Usage6responses735104=720041input+15063output COMPLETE;
historyczne+04=5006963tokens,0delivered. Zachowane13stagedpaths, HEADseedcd46c82.
Runtime może być teraz lokalnie naprawiany; nie poprawiać ręcznie iOS.
Najpierw CTF025, potem gwarantowane sprzątanie exact owned SwiftPM subtree
także po błędzie rm(outputRoot), bez nowego mutable output/frozen inputs.
Następnie własne focused/mutation/full gate. Przed następnym provider run
preferować jedną provider-free próbę dokładnej bramki Xcode na zachowanym
kandydacie, wyłącznie w nowym disposable/output scope. To diagnostyka
infrastruktury, nie zastępstwo pełnego F5 ani podstawa deklaracji delivery.

Checkpoint wykonania 2026-09-13: F1/F2/F3 zweryfikowane na końcowej exact11
wersji. Primary full gate47215 exit0:3729passed/2jawne opt-in skipped,
211.02s,build29/typecheck46 Cached0,strict0,workflow55OK. Finalne mutacje
przywrócone; realny GateFailure replay: stary katalog odmowa, nowy AUTHORIZED11.
F4 przygotowany osobno: `benchmark-full-flow-source-repair-hcakTA`, manifest
`sha256:0130c9a25fb4edd65e57c127e291c7de9662f1cc057b4fe7bd8cc9e741bf5b89`.
Canonical preflight, subscription auth i kontrola niezmienności starych
wejść: każda komenda exit0, powtórzona przed admission04. Sam preflight nie
dowodzi dostępnej quota; obecny live04 ma już rzeczywiste odpowiedzi providera.
Zachować lokalny wynik i nie resetować historii kosztu.

Pierwszy rezultat: autonomiczny MOBL-2023 od czystego seeda do zweryfikowanego
lokalnego commita, przez rzeczywiste handlers/PG/Git/Xcode, bez ręcznej naprawy
kodu iOS. Drugi, osobny rezultat: używalny lokalny pilot dla nowych zadań.
Jeden wyuczony benchmark nie dowodzi niezawodności na nowych zadaniach.

Ostatni pełny lokalny gate przed nowymi naprawami: 3729 passed, 2 jawne
opt-in skipped, exit0, na końcowej poprawce authority. Ostatni zakończony
live04: FAILED, 735104 zgłoszone tokeny; szczegółowe wyniki powyżej.
Kampania po live04: 5006963 tokeny, 0 delivered. Wcześniejszy live03 zużył
844529 tokenów i zakończył obie kompilacje Xcode exit65.
Nie dopisywać tokenów subagentów do tego licznika bez provider evidence.

Przyczyny zatrzymania: puste candidate paths końcowych gates; następnie
wykryty lokalnie limit16 niezgodny z 19 zatwierdzonymi plikami modelu.
Propozycja cap256/exact19 została wycofana po replay prawdziwego GateFailure:
osiem TEST paths nie może być SOURCE correction candidates. Aktualna naprawa
to exact11 SOURCE, bez zmiany cap16 ani ownership. Fixture obejmuje już
prawdziwy catalog parser, ownership mapping i factory control; ponowione
mutacje i pełna bramka tej ostatecznej wersji mają dowody w WORK_UNITS.
Przerwany subagent pozostawił niesprawny nowy test; 2026-09-13 zgłosił limit
użycia. Primary może wykonać lokalną naprawę, jeśli Luna jest niedostępna;
nie wnioskować z tego automatycznie o stanie osobnego live loginu.

### Kolejność, zakres i warunki wyjścia

| Krok | Konkretny rezultat | Dowód wymagany przed kolejnym krokiem |
|---|---|---|
| F1 — dokończyć authority | Exact11 SOURCE, bez generatora i TEST; cap16 bez zmian; testy evaluatorów pozostają chronione | Prawdziwy parser katalogu + ownership mapping + pozytywny factory1 i negatywny factory0; focused gate i strict tsc exit0 |
| F2 — sprawdzić naprawę | Sześć negatywów resolvera zaczyna od poprawnej niepustej authority; compiler failure może legalnie przejść do attempt2 | Pozytywny kontrolny fixture, każdy uszkodzony warunek osobno RED; wszystkie mutacje przywrócone i GREEN |
| F3 — zakwalifikować całość | Brak regresji w produkcyjnej ścieżce, safety i recovery | Pełna bramka RA-055 bez cache, realny PG; każdy flake rozstrzygnięty |
| F4 — nowy frozen bundle | Ten sam seed/objective/20targets/evaluatory; jedyna zmiana funkcjonalna: jawne11SOURCE candidate paths obu Xcode gates | Osobne pliki, config/catalog/schema/manifest/mapping digests, canonical host/profile/auth preflight0, zachowany stary Phbmzv |
| F5 — pierwszy pełny live | Jeden nowy invocation na świeżym izolowanym worktree | Design → implementacja → rzeczywiste gate receipts → fresh review → final verifier → jeden lokalny commit receipt |
| F6 — odbiór wyniku | Zweryfikowany finalny tree i wszystkie AC, nie tylko exit runnera | git show/status/parent/tree, wykonane11 Swift i4 UI IDs, brak unresolved B/H/M, kontrola wyglądu i dokładnej treści |
| F7 — zamknięcie RA-055 | Pełny diff od baseline, formalny audyt i odtwarzalna dokumentacja | Ponowna pełna bramka0, AUDIT PASS, HANDOFF, statusy/CTF, workflow0, logiczne commity bez push |

F1 allowed paths: `apps/agent-worker/test/engineering-live-full-flow-*.ts`,
`packages/test-evidence/src/engineering-gates.ts` i jego unit test.
F2: `apps/agent-worker/test/engineering-execution.integration.test.ts`; runtime
`engineering-execution.ts` tylko jeśli poprawny reproducer ujawni defekt kodu.
F3 nie ma planowanych nowych zmian; każdy finding naprawiać minimalnie i
ponowić jego test, a potem całą bramkę. F4 wyłącznie nowy prywatny katalog,
bez edycji seed/source/starych bundles. F5/F6 zapis iOS tylko przez Engineering.
F7 dokumenty RA-055, TASK_INDEX i CTF zgodnie z AGENTS, bez rozszerzenia scope.

Focused F1/F2 (nowy fixture musi istnieć i wykonywać się, nie skip):

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/test-evidence/test/engineering-gates.test.ts apps/agent-worker/test/engineering-live-full-flow-evaluators.test.ts apps/agent-worker/test/engineering-live-full-flow-profile-contract.test.ts apps/agent-worker/test/engineering-live-full-flow-common-contract.test.ts apps/agent-worker/test/engineering-live-full-flow-repair-authority.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts
```

Pełna bramka F3/F7:

```sh
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check
```

Dodatkowo strict tsc nowych test helpers pomijanych przez src-only tsconfig;
dokładna lista zmienionych plików i komenda trafiają do WORK_UNITS.
Mutacje: pominięcie exact candidate equality, dopuszczenie generatora/obcego
pliku, wyłączenie cap, pominięcie każdego badanego predicate resolvera.
RED ma oznaczać zaobserwowane unsafe acceptance, nie błąd składni/importu.

### Protokół live i ograniczenie liczby ślepych prób

Nie startować live, jeśli F1–F4 nie mają dowodów, działa inny writer, jest
aktywny mutant albo nie potwierdzono zgody na dokładny nowy bundle.
Istniejąca jawna zgoda obejmuje nowy hcakTA do1.8M na próbę. Nie rozszerza
się na zmianę objective, scope, modelu, frozen inputs ani limitu. Dalsze
próby tego samego pakietu wymagają diagnozy i lokalnego dowodu naprawy,
nie ponownego pytania o tę samą, już udzieloną zgodę.

Przed admission: canonical CLI/subscription login i wszystkie role
`gpt-5.6-sol`, PG SELECT1, Xcode/simulator/disk, clean seed SHA, wszystkie
digests. Nie przełączać do API key/Bedrock/OpenCode ani innego modelu przy
limicie subskrypcji. Status/report nie wywołują modelu. Dla nowego bundle
utworzyć i lokalnie sprawdzić konkretny launcher z unikalnym invocation ID,
exclusive admission/log/exit oraz canonical preflight. Nie używać launch-live-03.

Na próbę: cel750k, ostrzeżenie1.2M, hard limit1.8M, bez podnoszenia limitu
w odpowiedzi na błąd harnessu. F5 to jedna próba diagnostyczna, nie seria w tle.
Po FAILED klasyfikacja harness/code/model/provider/environment i minimalny
lokalny reproducer; kolejny run dopiero po naprawie i jej bramce.
Druga porażka tej samej przyczyny w tej samej wersji zamyka retry tej wersji:
wrócić do testu lokalnego, nie wydawać kolejnych tokenów na identyczny błąd.
Zmieniona konfiguracja wymaga nowej tożsamości benchmarku/bundle; koszt starych
prób nadal w raporcie. Sukces kończy diagnostyczne retry MOBL-2023.

Raport każdej próby: invocation/config/model identity, terminal reason,
etap/attempt, actual input/output/total i missing usage osobno, czas modeli
oraz gates, wykonane test IDs, corrections, zachowany worktree/commit,
koszt kampanii i liczba dostarczonych zadań. Nie raportować kosztu na delivered
task jako skończonej liczby przy zerze sukcesów. Początkowe180k–450k było
estymatą; historyczne800k–1.5M to koszt prób, nie dowód kosztu udanego zadania.
Każdy run ma osobny content-free journal; logujemy działania i receipts,
nie prywatny tok rozumowania, prompty ani sekrety.

### Kiedy wolno powiedzieć „gotowe do używania”

RA-055 DONE wymaga F7, lecz nie zamyka kwalifikacji nowych tasków. Następna
faza to istniejące propozycje Q1/Q2 z ENGINEERING_COMPLETION_PLAN, bez tworzenia
samowolnie nowych statusów w TASK_INDEX:

1. Uzgodniony local entrypoint `preflight/run/status/report/cancel/resume`
   używający tego samego control plane, nie ręcznych prywatnych launcherów.
   Nowa sesja operatora uruchamia task wyłącznie według runbooka.
2. Osobno zatwierdzony zestaw mały/średni/przekrojowy, co najmniej jedno
   zadanie niewykorzystane do strojenia; trzy fresh runs na zamrożony profil.
   Proponowany próg pilota:3/3 małe,2/3 średnie,2/3 przekrojowe i bezpieczny
   terminal każdej porażki. To propozycja budżetowa, nie już udzielony live grant.
3. Routing ról pozostaje konfigurowalny. Claude wymaga własnego auth/live opt-in;
   nie jest blokadą obecnej kwalifikacji Codex. Refactor dużych modułów dopiero
   po dowodzie zachowania, bez dokładania go do krytycznej ścieżki F1–F7.

Nie obiecywać daty zakończenia zależnej od modelu/Xcode/zgody. Postęp mierzyć
zamkniętymi bramkami i dostarczonymi commitami, nie liczbą dokumentów lub prób.
Następny ruch: dokończyć bounded naprawy CTF025 i Xcode cleanup opisane
w WORK_UNITS, następnie własne gates. Nie ponawiać providera na identycznym
niezdiagnozowanym timeoutcie. Nie poszerzać frozen authority dla scratch dir,
który istniejący adapter ma już obowiązek usunąć przed kontrolą drzewa.

## Historia checkpointów — nie instrukcje aktywnego wykonania

Checkpoint po diagnozie LIVE03: oba finalne gate'y Xcode w Phbmzv
mają puste listy kandydatów naprawy. Runtime zgodnie z ADR-0021 odmawia;
validator full-flow błędnie wymagał pustych obu list zamiast tylko chronionych
required_test_paths. Trwa lokalna korekta preflightu: jawne 19 już dozwolonych
model-owned candidates (20 minus generator), żadnego rozszerzenia scope.
Stary pakiet pozostaje nietknięty. Wysłano pytanie o osobny poprawiony pakiet
i kolejne live w tym samym limicie; odpowiedź oczekiwana. Najpierw lokalne
testy, meaningful mutation checks i pełna bramka. Dodatkowo znaleziono sześć
negatywnych testów resolvera maskowanych wcześniejszą odmową pustej authority;
ich fixture wymaga poprawy przed uznaniem dowodu zabezpieczeń.

Poprzedni checkpoint 2026-09-10 02:21CEST: LIVE03 FAILED exit1 po844529tokens,
suma historyczna4,271,859/0delivered. Prefetch naprawiony, model dokonał zmian
(8plików z generatorem),3cheapgatesPASSED,2XcodegatesFAILED65 na kompilacji.
Compiler diagnostics zapisane, ale attempt2 zatrzymał się przed modelem
naprawczym z genericError. Trwa read-only diagnoza tego błędu; nie retryować
live ani nie poprawiać ręcznie zachowanego iOS worktree. Szczegóły i ścieżki
w WORK_UNITS. Kolejny live04 dopiero po lokalnej naprawie/bramce.

Poprzedni checkpoint 2026-09-10 02:07CEST: lokalna naprawa prefetch ma pełną
bramkę primary exit0,3708passed/2opt-in skipped, build29/29 i typecheck46/46
bez cache, dodatkowy strict0, workflowOK55. Logfragment-full-gate-qualified.log.
Mutacje i wcześniejsze odrzucone fixture/błędy opisane w WORK_UNITS. Uruchomiono
LIVE03 `mobl-2023-full-flow-20260910-03`, sesja11078. Trwa SYSTEM_DESIGN,
nowy journal7a76d2d097040e061e6bd1e893e576bd4cc063e909fb5fed7769ca4d13aeadb5.
Monitorować istniejącą sesję/status03, nie powtarzać launchera i nie edytować
runtime w biegu. Frozen inputs i seed zachowane;3,427,330 tokenów przed03.
Sukces końcowy nadal niepotwierdzony, RA-055 IN_PROGRESS.

ZGODA 2026-09-10: właściciel zatwierdził następną i kolejne próby live tego
samego Phbmzv, do1.8M na próbę, z zachowaniem izolowanych worktree/lokalnych
commitów, bez push/Jira/Discord. Nie pytać ponownie o każdą próbę w tym zakresie.
Wykonywać sekwencyjnie, z diagnozą i weryfikacją poprawek pomiędzy próbami;
nie resetować historycznego usage. Próba `mobl-2023-full-flow-20260910-02`
zakończona FAILED,30,305 tokenów; suma3,427,330/0delivered. Planowanie przeszło,
prefetch zatrzymał się na brakujących planowanych plikach przed implementacją.
Naprawa precise FILE_NOT_FOUND ma własną bramkę116/116 i trzy mutation RED.
Następna wykryta bariera to duże pliki kontekstu; trwa wiring bounded fragments.
Realny read-only prefetch całego seeda przeszedł exit0:18pozycji,29calls,
11fragmentów,2jawne missing planned markers; bytes i digests porównane z seedem.
To nie jest live ani końcowa kwalifikacja. Przed03: domknąć review/mutacje,
usunąć błędne umieszczenie fragment policy w frozen config identity (ma należeć
tylko do implementation executor identity), pełna bramka i canonical preflight.
Aktualny session/status i dowody w WORK_UNITS.
Poniższe oczekiwanie na zgodę jest historyczne.

AKTUALNY CHECKPOINT 2026-09-09: lokalna naprawa kontraktu planowania zakończona
i zweryfikowana przez primary. Pełna bramka sesja28242 exit0:
3678 passed/2 opt-in skipped, build29/29 i typecheck46/46 bez cache, dodatkowy
strict tsc trzech fixture'ów0, workflow:validate OK55tasks, lint/format/diff0.
Dowód: `planner-gate-cO857p/full-gate-qualified.log` pod prywatnym diagnostics
root; dokładna komenda i wcześniejsze czerwone/przerwane próby w WORK_UNITS.
ADR0028 count/scope, prompt/repair/materializacja i feasibility-before-factory
są spójne. Regresje sprawdzają realne MEDIUM1slice20paths i scoped repair;
12 mutation mechanisms dało RED, jedyny survivor rozstrzygnięty poprawą fixture
i ponownym RED, potem pełny restoration GREEN. Generic cap4 i MEDIUM bez zmian.
Fixture E2E poprawiony bez SOURCE-as-TEST; wykonuje osobne asercje i zachowuje
review/correction/recovery/provenance. Nie wracać do opisanych niżej fallbacków.

Następny krok wymaga zgody na JEDNĄ NOWĄ próbę live tego samego frozen Phbmzv,
limit1.8M, nowy invocation i izolowany worktree, zachowany lokalny commit,
bez push/Jira/Discord. Poprzednia zgoda została zużyta; nie wznawiać launchera01.
Przed nowym admission ponowić host/profile/auth preflight. Nie ma nowej
generacji ani autonomicznego delivery. Historyczne live usage3,397,025/0delivered,
RA-055 IN_PROGRESS; lokalna bramka nie jest końcowym PASS ani visual acceptance.
Dirty tree jest zamierzonym WIP; nie commitować częściowo ani czyścić.
Poniższe wpisy są historią, zastąpioną tym checkpointem.

WYNIK LIVE 2026-09-09T05:59:07Z: Phbmzv/01 FAILED, exit1,
49,720 tokens/3responses,~4m12s, przed implementacją; zero gates/commit/worktree.
Przyczyna odrzucenia: duplicated sliceIDs. Potwierdzona sprzeczność kontraktów:
MEDIUM wymaga >=2blueprints, nowy bound benchmark dokładnie1. Następna bariera
to4model-write-roots przy file-exact zadaniu obejmującym >4pliki. Nie poprawiać
przez zwiększenie tokenów, obniżenie riskFacts ani poszerzenie directory scope.
Następny lokalny krok: jeden spójny kontrakt server-bound count/scope + prompt/
validation/materialization i preflight feasibility, testy/mutacje/pełna bramka.
Dokładny plan korekty, ograniczenia schema16vs20targets oraz dowody w WORK_UNITS.
Korekta w implementacji lokalnej; doprecyzowanie ADR0028 określa nadrzędność
benchmark order, per-slice target scope i strukturalny max256 zgodny z
SliceContract, przy zachowaniu generic policy max4. Read-only kontrola obu
frozen benchmarków potwierdziła obecność wymaganych test/generator paths w
slice scopes. Pierwszy review kodu wymaga usunięcia fallbacków dla pustego
test scope i niepełnych fixtures; nie ma jeszcze końcowej bramki tej korekty.
Wykorzystano jedną nowo zatwierdzoną próbę live.
Łącznie historyczne+nowy live3,397,025 tokens/0 delivered tasks. RA-055 IN_PROGRESS.

Historyczny start LIVE 2026-09-09: właściciel przywrócił zgodę na jedną próbę Phbmzv
do1.8M. Invocation `mobl-2023-full-flow-20260909-01`, session12471,
start05:54:56Z, SYSTEM_DESIGN. Monitorować istniejący live-01.log i journal;
nie uruchamiać drugiej próby i nie zmieniać runtime podczas biegu.
Szczegóły i polecenie w najnowszym WORK_UNITS. Poprzednia informacja o braku
zgody poniżej jest historyczna. Wyniku live jeszcze nie ma.

Poprzedni checkpoint 2026-09-09 01:12 CEST: pełna bramka primary
`root-gate-yEZogG` exit0,3662 passed/2 opt-in skipped; build29/29 oraz
typecheck46/46 Cached0. Naprawiono utratę process-group SIGKILL w obu runnerach
(model/control), CTF029 zamknięty z post-cancel mutation evidence. Nowy profil
i canonical before-factory wiring zweryfikowane. Bundle Phbmzv ma rzeczywisty
host/profile preflight0, a osobny read-only auth check potwierdził subskrypcję
Codex0.153.3/gpt-5.6-sol, zero nowych generacji. Następny krok to JEDNA dokładnie
zatwierdzona próba live Phbmzv do1.8M tokenów. Pytanie o opt-in wysłane, jeszcze
bez odpowiedzi zatwierdzającej; dawnych4zgód nie wolno użyć ponownie.
Nie mylić pełnej lokalnej bramki z autonomicznym delivery ani visual PASS.
RA-055 pozostaje IN_PROGRESS; szczegóły, digests, logi i stan WIP w WORK_UNITS.

Poprzedni krok 2026-09-09: bundle `benchmark-full-flow-v1-Phbmzv` został
utworzony osobno i przeszedł własny production-route canonical host/profile
preflight (exit0), bez modeli. Wiring i canonical profile regressions są
podłączone; strict tsc obejmujący nowe helpery/testy i harness exit0. Pełna
bramka `root-gate-SlXCHr` jednak exit1:3660 passed/1 failed/2 skipped.
Fail process-tree cancellation przeszedł solo11/11, lecz dalszy post-cancel
reproducer potwierdził prawdziwą utratę SIGKILL escalation po śmierci leadera.
Naprawa obejmuje model runner ORAZ control-command runner w tym samym pliku;
trwa finalizacja stabilnego handshake/PID polling i testów mutacyjnych.
Po own odbiorze powtórzyć pełną bramkę. Szczegóły i digests w WORK_UNITS.md.
Brak nowego provider live; wysłane pytanie o dokładny bundle/1.8M nie oznacza zgody.

Poprzedni checkpoint 2026-09-09: wszystkie zaplanowane UI mutation controls
(routing, suppression, sharing authority, single/multi identity, Close) mają
rzeczywiste RED i restoration GREEN. Combined11 wykonał się razem w398760ms,
runner/Xcode0, bez hidden failures, z niezmienionymi czterema input files.
Najnowsze qualified inputs: combinedc924af... i UIb10e21.... To nadal prywatna
referencja, nie autonomiczny commit ani visual/design PASS.
ADR-0028 definiuje osobny jawny profil full-flow i jeden kompletny slice.
Selector9, precheck14, common25, evaluator24 i wrapper8 mają primary przebieg
80/80, exit0. Dodatkowy strict TypeScript check czterech common/wrapper plików
(w tym testów pomijanych przez src-only tsconfig) oraz powtórzenie33/33 exit0.
Write-authority mutation: cztery rzeczywiste unsafe acceptances, przywrócone.
Real pinned evaluator assertions0; dawny common positive z szerokim scope jest
historyczny i wymaga ponowienia z exact20paths. Trwa canonical preflight wiring
i regresje przed factory. Pierwszy private builder odrzucony w review przed
wykonaniem (profil/cwd/output/context/objective); wymagana poprawka i rzeczywista
walidacja z loaderami, nie samo node --check. Następnie nowy private bundle
i pełna bramka. Nie uruchomiono nowego provider live.
Pełna bramka3577 poniżej poprzedza najnowsze helpery; nie przypisywać im tego
wyniku. Szczegóły błędów wykrytych w review i poprawek są w WORK_UNITS.md.

Historyczny checkpoint recovery 2026-09-08 (zastępuje starsze ACTIVE poniżej):
pełna bramka `root-gate-wGXq6z/full-gate.log`, exit0,3577 passed/2 opt-in
skipped; build29/29 i typecheck46/46 z Cached0. Accepted commit oraz per-slice
gate projections są podłączone do live harnessu; realny lokalny PostgreSQL/Git
E2E przyjął slice-1:3 i slice-2:4 po correction/recovery. CTF028 zamknięty.
State, voice, UI suppression, variant authority i routing mają zamknięte
mutation cycles. UI identity `03E3Wz`: Xcode65,4 executed/2 failed tylko
single-agent; multi guard mutant przeżył i wymaga rozstrzygnięcia. Trwa dokładne
przywrócenie mutanta. Następnie source GREEN, multi identity i Close control,
połączona current-only bramka 11 Swift tests, nowy jawny profil/bundle.
Bez nowego provider live, bez końcowego PASS ani dowodu pixel/design zgodności.
Szczegółowe aktualne sesje i dowody: początek WORK_UNITS.md.

Historyczny checkpoint wykonania 2026-09-08 22:45: state snapshot GREEN→RED→GREEN zamknięty
(LGjryd/q73QwT/QuxUaG,4/4,4failed,4/4), bez ukrytych błędów zależności.
Voice fix2 OlVOPm 2/2 exit0 → ZTb8AV2/2FAILED po wyłączeniu pause →
EgXdoL2/2 exit0 po restore; każdy pełny log bez hidden framework reports.
Ten cykl jest zamknięty. UI variant-authority tkU9zj4/4FAILED po przełączeniu
na błędną preferencję; aktywny restoration session16039/31U2TT. Nie zmieniać
inputs/source/DIST podczas aktywnej sesji.
Adapter Xcode odrzuca teraz takie hidden reports także po stream truncation;
29/29 own focused exit0, dwa rzeczywiste unsafe-acceptance mutation RED,
restore i forced build exit0. Accepted-gates projection ma15/15 i pięć
nowych mechanizmów mutation RED→restore GREEN, primary combined54/54 exit0.
Per-slice provenance caller nadal w korekcie selekcji/testów i niepodłączony
do live. Ostatnia pełna bramka3542 nie obejmuje
tych dwóch najnowszych dodatków. Prywatna referencja nadal nie dowodzi
autonomicznego dostarczenia ani pixel/design zgodności ekranu.

Najnowszy checkpoint 2026-09-08: ADR-0026 jest podłączony do katalogu,
disposable workspace, receipt identity, agregacji i durable recovery. Własna
weryfikacja wiring 77/77, exit 0, dziewięć mutacji RED→restore/GREEN.
Niezależny prywatny evaluator Swift wykonał cztery rzeczywiste przebiegi Xcode:
compile-only reference RED (3/3 failed), positive control GREEN (3/3 passed),
zepsute SMS/Safari RED (2/3 failed), restoration GREEN (3/3 passed). Ten sam
digest evaluator-a, niezmienione źródła podczas każdej bramki. To dowód copy
i akcji konfiguracji, nie full-screen, Close ani inline-card suppression,
i nie autonomiczny sukces. Dokładne komendy/digests w WORK_UNITS.

Następny rezultat: regression canonical preflight dla nowego bundle z
rzeczywistym katalogiem evaluator-a, zachowując manifest V1 i frozen bundle.
Manifest V1 już wiąże config/catalog digest; sama opcjonalna capability nie
wymaga nowej wersji schematu. Potem dopiero wydzielić walidację kontraktu
nowego benchmarku z lexical-only harness. Nie wybierać trybu na podstawie
samej obecności dowolnego pola i nie wyłączać istniejących acceptance checks.
Nie uruchamiać provider live bez nowego dokładnego opt-in.

**Aktualizacja 2026-09-08 po zwolnieniu dysku:** blokada miejsca ustąpiła.
Izolowany XCUITest host wykonał prawdziwe tap Close obu wariantów:
positive 2/2, odłączone onClose 2/2 FAILED (asercja liczby callbacków),
restoration 2/2. Runner exits odpowiednio 0/1/0, Xcode 0/65/0, te same pięć
chronionych wejść i executed IDs; szczegóły/digests w WORK_UNITS. To dowód
rendered Close/dismissal hosta, nie produkcyjnego routingu rozmowy.
Naprawiono świeże SwiftPM scratch ownership i dodano dokładnie ograniczone
wejście lockfile (ADR-0027). Pełna bramka tych zmian: 3503 passed / 2 opt-in
skipped, exit 0, build/typecheck wymuszone. Późniejsza poprawka zachowywania
logów przy invalid xcresult ma focused 28/28 oraz rzeczywisty tsc exit 0;
nowa pełna bramka primary zakończona exit 0: 3503 passed / 2 opt-in skipped,
192.89 s, wymuszony build/typecheck, workflow55OK (session3472).

Aktualny wynik full-flow: nowa prywatna referencja `full-flow-reference-kHxqNA`
ma produkcyjny event→alert, wariant według `sonderActivity`, blokadę send,
Close i suppression w obu chat flows. Własny przebieg `full-flow-ui-2ssWzy`
wykonał 4/4 testy UI, runner/Xcode exit 0. Mutacja wyłączająca filtr
renderowanych items (`full-flow-ui-qB87Sg`) wykonała 4/4 FAILED, runner1/Xcode65,
każdy z powodu widocznej starej karty. Przywrócono dokładne bajty źródła
(własne diff -qr exit0); restoration `full-flow-ui-etGAdN` wykonał 4/4 PASS,
runner/Xcode exit0. Cykl suppression GREEN→RED→GREEN zamknięty, te same inputs.
Model send guard także ma pełny cykl: 2/2 PASS (`pZtLIC`), 1/2 FAILED po
usunięciu guarda (`7GG54t`, dokładna wiadomość dotarła do silnika), 2/2 PASS
po przywróceniu (`KtZoqe`), runner0/1/0 i Xcode0/65/0, te same inputs.
Pierwszy state build (`MKMDyN`) zakończył się compile failure; po korekcie
evaluator-a v1 wykonał 4/4 PASS (`OJmFrd`, runner/Xcode0). Rozszerzona v2
sprawdza osiem scenariuszy z niezależnymi początkowymi wartościami focus/send;
jej positive jest następny po pełnej bramce root (session20021 w toku).
Voice positive (`McJVE3`) wykonał 2/2 PASS, runner/Xcode0: rozpoczęty mock
room connect, raw emergency event, disconnect i unsubscribe przed Close.
Nie potwierdza fizycznego połączenia sieciowego ani no-reconnect/cancel-race.
Nowszy przegląd pełnych logów wykrył ukryte zgłoszenia niezainicjalizowanego
ContinuousClock w state v2 (`JJy5KG`, mimo runner0/4 passed) i voice (`McJVE3`).
Nie traktować tych positive jako czystej kwalifikacji. Poprawiono jawny zegar
single-flow fixtures; stan aktualnego rerunu i nowe digests są na początku
WORK_UNITS. UI etGAdN i model KtZoqe nie zawierają tych zgłoszeń.
Nadal do wykonania: dalsze mutation checks, state restoration, voice/reset,
nowy profil benchmarku i autonomiczna kwalifikacja. Testy używają prawdziwych
flow oraz syntetycznego eventu w raw items, nie sieciowego klasyfikatora.
Nie jest to jeszcze dowód ukończenia Engineering Loop.

Najnowszy odbiór state po poprawce zakresu zegara: LGjryd4/4 (8 scenariuszy),
runner/Xcode0, zero hidden dependency reports, own boundary checks0.
Trwa kontrola mutation snapshot-swap; exact active session i restore instrukcje
są na początku WORK_UNITS. Accepted commit projection i read-only Git observation
są podłączone; pełna bramka tego checkpointu:3542passed/2opt-in skipped,
exit0, build29/29 i typecheck46/46 Cached0 (session50666).
Następna pure walidacja accepted gate aggregate jest w implementacji i jeszcze
NIE jest objęta tym wynikiem. Nadal brak nowego benchmark profile/provider live.

Równolegle bounded poprawka harnessu live: niezależna obserwacja rzeczywistego
commita (schema, HEAD, symbolic branch, jeden parent, clean worktree i
computeTreeDigest). Nie zastępuje pełnego doboru accepted bundle/descriptor
w nowym profilu. Lista ścieżek i konkretna bramka są w WORK_UNITS;
bez live, push i commitów w roboczym repozytorium.

Właściciel zatwierdził ten krok słowami
„kontynuuj bez potwierdzania masz pelny dostep”: przygotować odrębną
referencyjną implementację w nowej izolowanej kopii, bez zmiany
oryginału, seed, poprzednich worktrees, frozen bundle i bez provider call.
Po niej: rzeczywiste scenariusze obu flow, mutacje routing/suppression/Close,
nowy profil benchmarku, pełna bramka i osobna zgoda na dokładny live.
Poniższe akapity o dysku i eksperymencie accessibility są historią, nie
obecną blokadą. RA-055 pozostaje IN_PROGRESS; autonomous_success nadal false.

Powyższe preflight regression i wydzielenie legacy harness są już lokalnie
zweryfikowane: 17 qualification + 10 legacy tests, exit 0; mutacje catalog
identity/global ownership/context cap RED→restore/GREEN. Pełna bramka po
ekstrakcji: 3485 passed / 2 opt-in skipped, exit 0, build/typecheck bez cache.
Nie ma jeszcze nowego profilu benchmarku. Następny eksperyment: rzeczywisty
rendered Close w istniejącym SharedTests przez publiczne UIKit accessibility
APIs, z bounded traversal i callback count, bez projektu/dependency changes.
Wynik śledzić w najnowszym checkpoint WORK_UNITS; nie zakładać, że SwiftUI
udostępni ten element przez publiczny bridge. Nawet sukces tego testu nie
potwierdza jeszcze produkcyjnego full-flow dismissal/session interruption.

Aktualizacja wyniku: eksperyment wykonał 2 metody w Xcode, obie FAILED,
exit 65 (runner exit 1): brak Close w publicznym accessibility traversal.
Nie jest to compiler failure ani dowód niedziałającego przycisku. Nie ponawiać
tej samej heurystyki ani nie podmieniać jej na bezpośredni callback.

### Zatwierdzony kolejny zakres — izolowany harness UI

Decyzja właściciela 2026-09-08: `continue` zatwierdziło poniższy izolowany
harness. ADR-0027 zapisano przed implementacją; portable capability ma pełną
bramkę primary exit 0 (3497 passed / 2 opt-in skipped, forced build/typecheck).
Prywatny harness przeszedł schema/PBX/XML validation, lecz nie wykonał testów
UI: admission zatrzymało runner przed Xcode z powodu mniej niż 40 GiB wolnego
miejsca. Exact log/komenda/digest i dalszy krok są w WORK_UNITS.md.
Poniższe uzasadnienie opisuje granicę sprzed zgody, nie aktualną
prośbę o ponowne zatwierdzenie. Zgoda nie obejmuje nowego providera live ani
zmian oryginalnego worktree/frozen bundle.

Proponowany następny rezultat to niezależny app/UI-test harness z XCUIApplication,
który renderuje produkcyjny SafetyAlert, naciska rzeczywisty Close i obserwuje
skutek. Obie wersje, kontrola pozytywna oraz odłączona akcja RED→restore/GREEN.
To nadal pierwszy slice; produkcyjne event→full-screen→Close i inline suppression
w obu flow wymagają osobnych scenariuszy, nie testowej reimplementacji routera.

Wymagało decyzji właściciela przed implementacją: kontrakt ADR-0026
pozwala wyłącznie dodawać nowe Swift files pod Tests/. Istniejący target
SonderClientUITests ma jawne PBXFileReference/PBXBuildFile w project.pbxproj,
nie automatyczne włączanie dowolnego nested Tests/. Nowy harness wymaga
więc związanych hashami plików projektu/test hosta albo innej jawnie
zatwierdzonej integracji targetu; nie wolno tego przemycić jako Swift input
ani modyfikować oryginalnego projektu w gate adapterze.

Wykonanie po zgodzie: ADR-0027 ustala additive-only paths, formaty/limity wejść,
hashowaniem project/harness i ich granicą protected-tree; rozszerzyć walidator
i testy bezpieczeństwa; stworzyć prywatny harness; uruchomić rzeczywiste
XCUITest positive/mutant/restoration, następnie dwuflowową kwalifikację i nowy
benchmark. Żadnego nowego provider live bez osobnego dokładnego opt-in.
Po tej decyzji: zmieniać capability tylko w granicach ADR-0027. Task pozostaje
IN_PROGRESS, nie DONE/PASS. Pozostałe lokalne poprawki są zweryfikowane, ale
nie spełniają samodzielnie kryterium autonomicznego MOBL-2023.

Ograniczenie kolejnej kwalifikacji UI: istniejące SonderClientUITests są
puste; SnapshotTestCase potwierdza render/lifecycle, nie tap. Brak gotowego
UI launch/setup/accessibility seam. Nie traktować `view.onClose()` jako testu
połączenia przycisku ani samego snapshotu jako dowodu przerwania sesji.
Rzeczywisty Close/full-screen/inline suppression wymaga osobnego scenariusza
na produkcyjnym flow oraz uruchomionego dowodu interakcji. Obecna capability
ADR-0026 obejmuje nowe Swift pliki pod konwencjonalnym `Tests/`, nie dowolne
pliki targetu UITests; ewentualne rozszerzenie tej granicy wymaga jawnej decyzji
architektonicznej i mutacji ochrony, nie obejścia walidatora.

Wcześniejszy checkpoint 2026-09-08: syntetyczny reproducer lexical predicate jest zapisany;
parser Xcode odrzuca teraz Skipped/Expected Failure i niezgodny target/kształt ID.
Typed observations kryteriów są zachowane w correction, historii i compact epoch
(prompt v14). Własna bramka tych zmian: 150/150, exit 0; osiem mutation checks
RED i restore/GREEN. Pełna bramka primary: 3424 passed / 2 opt-in skipped,
exit 0, build 29/29 i typecheck 46/46 bez cache; szczegóły w WORK_UNITS.
To częściowy postęp etapów 1–3,
nie kwalifikacja nowego oracle ani sukces live. Nie powtarzać tych napraw.

## 1. Odpowiedź na pytanie właściciela i granica celu

Praca może przebiegać ciągle: lokalna reprodukcja → ograniczona implementacja
Luny → własny diff i test primary → korekta → pełna bramka → kwalifikacja.
Granica kroku, audyt i dozwolony commit nie wymagają kolejnego `continue`.

Nie da się uczciwie zagwarantować dowolnie długiego, bezobsługowego sukcesu
modelu. Pętla kończy się osiągnięciem mierzalnego celu albo konkretną blokadą
wymagającą decyzji właściciela. Zewnętrzne uprawnienia i budżety nie stają się
nieograniczone przez polecenie „pracuj do końca”.

Rozdzielić dwa odbiory:

1. **RA-055:** autonomiczny MOBL-2023, wymagane rzeczywiste testy, fresh review,
   verifier i jeden zachowany lokalny commit; pełna bramka i audyt każdego AC.
2. **Engineering Local v1:** powtarzalny lokalny interfejs description → run →
   wynik, wybieralne profile, niezależne zadania, stop/recovery i czytelny raport.
   To proponowana kolejna faza Q1/Q2, wymagająca wpisania do oficjalnej kolejki
   po decyzji właściciela. Nie dopisywać jej po cichu do AC RA-055.

Poza celem pozostają Jira/Discord/GitLab, AWS/Bedrock/OpenCode, API keys,
push/MR/merge oraz ogólny refactor całego monorepo. Profile ról pozostają
konfigurowalne; bieżący live używa `codex-sol-live / gpt-5.6-sol` we wszystkich
rolach. Claude live nie jest objęty dotychczasową zgodą.

## 2. Co wiemy, a czego jeszcze nie udowodniliśmy

Ostatnia pełna lokalna bramka: 3408 passed, 2 opt-in skipped, exit 0;
build 29/29 i typecheck 46/46, cached 0. Nie jest to sukces iOS live.
Trzy zachowane compiler-context replaye na aktualnym kodzie: COMPLETE, exit 0.

| Próba obecnego bundle | Provider tokens | Wynik i główna blokada |
|---|---:|---|
| 1 | 1 036 388 | FAILED: wyszukiwanie deklaracji / OVERSIZE przed korektą |
| 2 | 713 928 | FAILED: wymagany kontekst nie mieścił się w 24k bytes |
| 3 | 999 408 | FAILED: poprawny SEARCH bez deklaracji nie uruchamiał fallbacku |
| Dodatkowa, osobno zatwierdzona | 597 581 | BLOCKED / NO_PROGRESS: review i kruchy lexical gate |
| Razem | **3 347 305** | **0 dostarczonych zadań** w tej kohorcie |

Suma nie obejmuje starszych wersji benchmarku ani tokenów głównej sesji Codex.
Koszt jednego dostarczonego zadania pozostaje nieustalony — nie wolno dzielić
przez zero ani prezentować kosztu nieudanej próby jako kosztu sukcesu.
Zakres 800k–1.5M z historii to orientacja oparta na częściowych przebiegach,
nie zweryfikowana estymata poprawnego delivery.

### A. Potwierdzony problem benchmarku

Frozen incremental gate wymaga w tekście testu `EmergencyResourcesViewModel(`
albo jednocześnie `SafetyAlert(` i `.emergencyResourcesViewModel`.
Review kieruje test przez produkcyjną `SafetyAlertConfiguration`.
Końcowy test dodatkowej próby zawiera konstrukcję konfiguracji, jej model,
dwie akcje i asercje efektów; lexical predicate mimo tego zwraca false.
Własna sonda potwierdziła to asercjami i exit 0.

To dowodzi false-negative heurystyki. **Nie dowodzi**, że test kompiluje się
ani że zachowanie aplikacji jest poprawne: ostatnia próba nie dotarła do Xcode.
Podobna klasa błędu występowała wcześniej dla nazw kolekcji URL i konstrukcji
`SafetyAlert`. Kolejny wariant `includes()` sam nie domyka tej klasy problemu.

Harness dodatkowo przypina dokładny tekst kruchego warunku w
`apps/agent-worker/test/engineering-live-ios.integration.test.ts`.
Zatem należy poprawić także kontrakt kwalifikacyjny, nie tylko prywatny JSON.

### B. Potwierdzone luki kontekstu — lokalnie naprawione, live nie domknięty

- Brak obsługi rzeczywistego kodu OVERSIZE i deklaracji w pliku o innej nazwie.
- Pakowanie wymaganych deklaracji/manifestów oraz za mały limit 24k bytes.
- Brak deklaracji receivera przy błędzie nieistniejącej właściwości.
- SEARCH zwracający filename/usages bez deklaracji traktowany jako koniec discovery.

Aktualne naprawy mają mutation RED/GREEN i replaye. Nie podnosić ponownie
limitu 48k bytes / 12k estimated tokens ani 48 calls bez nowego pomiaru.

### C. Problem korekt i spójności dowodów

Ostatnio bramka przechodziła przed review prób 1/3/4/6, a po poprawkach
odmawiała w 2/5/7. Część review wykrywała rzeczywiste wiring/localization/API
defekty; część cyklu wynikała z ograniczenia oracle. Nie klasyfikować wszystkich
uwag jako błędu review ani wszystkich zmian plików jako postępu kryteriów.
Zabezpieczenie NO_PROGRESS zatrzymało churn i prawidłowo zachowało BLOCKED.

### D. Luka metody kwalifikacji

Zielona macierz TypeScript nie oznacza poprawnej kompilacji Swift. Sam
niepusty xcresult nie oznacza, że testuje się właściwy production path.
`test/engineering-evals/behavioral-oracle.ts` ocenia przekazane obserwacje;
syntetyczne znaczniki EVALUATOR/EXECUTED_ASSERTION nie są same dowodem,
że takie obserwacje zebrał prawdziwy Xcode. Trzeba sprawdzić producenta dowodu,
jego powiązanie z tree/testem i odmowę dla danych zgłoszonych przez implementera.

## 3. Plan wykonania w istniejącym RA-055

Kolejność: R4/R5 → R2/R6 → R8 → R9. Poniższe etapy są nawigacją,
nie nowymi makro-taskami ani kolejnymi dokumentami audytu per poprawka.

### Etap 1 — zamrozić reprodukcję i ustalić prawdziwy kontrakt testu

Rezultat: rozróżnienie błędu oracle od błędu aplikacji bez model call.

Allowed paths: `test/engineering-evals/`, plan RA-055; nowe prywatne fixture
poza starym bundle. Stary bundle/worktree/export pozostają immutable.

1. Zachować exact export dodatkowej próby, jego identity i gate/tree digests.
2. Utworzyć syntetyczne odpowiedniki bez kopiowania kodu Sondermind do Git.
3. Macierz: production direct construction, production configuration/factory,
   zmieniona nazwa lokalnej zmiennej, test-only duplicate, nieużyty helper,
   komentarz/string z markerem, brak jednej akcji, brak URL/analytics assertion,
   incorrect expected value, disabled/skipped test, brak wykonanych testów.
4. Odtworzyć dotychczasowy false-negative jako RED, bez zmiany expected result
   pod aktualny kod. Zachować pozytywne i negatywne wymagania zachowania.
5. Utrwalić decyzję o granicy FAST/FULL i sposobie zbierania dowodu w ADR przed
   zmianą kontraktu. Kolejny wolny numer ADR ustalić przez `rg --files`.

Brama: G1 poniżej. Odbiór: problem odtwarza się deterministycznie, a fixture
opisuje obserwowane efekty, nie jedną obowiązkową nazwę konstruktora.

### Etap 2 — rozdzielić szybki precheck od dowodu zachowania

Rezultat: bramka nie odrzuca równoważnego production path i nie zalicza bypassu.

Allowed paths: `test/engineering-evals/**`,
`apps/agent-worker/src/{engineering-live-qualification,xcode-gate-adapter}.ts`,
ich testy, `engineering-live-ios.integration.test.ts`; katalog test-evidence
tylko jeżeli wymaga tego zaakceptowany ADR. Prywatny nowy bundle, nie stary.

1. FAST ma sprawdzać ownership, integralność wejść i jednoznaczne braki;
   wynik „nie rozpoznaję konstrukcji” nie może udawać dowodu błędu zachowania.
   Dokładny status/semantykę unknown ustalić w ADR, bez cichego PASS.
2. Zachowanie rozstrzyga uruchomiony focused Swift/Xcode test wywołujący
   produkcyjną konfigurację/model i obserwujący URL, safari, analytics, Close
   oraz obie wersje udostępniania. Żadnych testowych reimplementacji logiki.
3. Pierwszy slice musi mieć odpowiedni focused gate przed akceptacją review;
   pełna integracja przepływów pozostaje własnością drugiego slice'a.
4. Zweryfikować test selection i xcresult: wymagane test IDs faktycznie
   wykonane, liczba >0, zero niejawnych skipów, właściwy tree/config/receipt.
5. Jeśli używany jest structured trace, związać go z execution evidence;
   output implementera ani wpisany ręcznie JSON nie może wystawić PASS.
6. Zmienić harness z kontroli tekstu funkcji na kontrolę wersji, identity,
   kryteriów i zweryfikowanego evaluator digestu. Nie usunąć wymagania testu.
7. Mutacje: puste xcresult, podmieniony digest, nieodpalona akcja, usunięta
   asercja, test-only duplicate i claim modelu. Każda musi dać RED.

Brama: G1 + rzeczywisty focused Xcode według nowego katalogu. Wykonanie na
zachowanym failure tree tylko w osobnej kopii diagnostycznej i jako diagnoza,
nie jako zaliczony autonomiczny run. Błędy Swift z takiej próby zachować.

### Etap 3 — utrzymać wymagania między gate → review → correction

Rezultat: poprawka realizuje review i nie gubi wcześniej spełnionego kontraktu.

Allowed paths: `engineering-execution.ts`, `engineering-repair-context.ts`,
ich tests/evals, `packages/review-loop/src/pre-commit.ts` i jego testy;
workflow tylko przy potwierdzonym defekcie przejść.

1. Przekazać korekcie tę samą checklistę criterion IDs, aktualne findingi,
   ostatnie bramki i niezmienne wymagania. Nie dopisywać uprawnień z prose.
2. Dodać transcript regression: gate PASS → review wymaga produkcyjnej factory
   → korekta → gate rozpoznaje równoważną ścieżkę → fresh review → następny slice.
3. Negatywny przebieg: korekta usuwa efekt/asercję → gate FAIL; powtórzenie
   daje NO_PROGRESS, nigdy automatyczne wyłączenie guarda.
4. Przed patchem API ma pochodzić z aktualnej deklaracji i manifestu. Użyć
   istniejącego bounded discovery; powtórzyć trzy rzeczywiste replaye.
5. Rozliczać postęp po kryteriach/findings, nie po nowym diff digest.
   Jeśli obecny kontrakt wymaga zmiany, ADR i test migracji przed wdrożeniem.

Brama: G2. Wymagane własne RED/restore/GREEN dla retention i fail-closed.

### Etap 4 — pełna próba generalna bez providera

Rezultat: produkcyjny handler z realnym PG/Git dowodzi całej sekwencji,
z kontrolowanym transportem tylko na granicy modelu.

Allowed paths: istniejące `engineering-qualification*.test.ts`, fixture,
`test/engineering-evals/**`. Finding produkcyjny wraca do właściwego R-kroku.

Pokryć sukces dwóch slices do jednego commita, gate→review→compiler repair,
utrzymanie wymagań, no-progress, cancellation, restart po receipt, ambiguous
write, stale configuration i dwóch writerów. Nie seedować końcowych receipts.
Osobno sprawdzić klasyfikację: task defect / evaluator defect / missing context /
provider / environment. `UNKNOWN` pozostaje jawny; nie zgadywać przyczyny z hasha.

Brama: G3, potem G4. Dopiero po exit 0 można przygotować następny live.

### Etap 5 — nowa wersja benchmarku i ograniczona kampania live

Rezultat: porównywalna, uprzednio zakwalifikowana próba, nie kolejna naprawa
bench­marku w trakcie wykonania.

1. Utworzyć nowy prywatny bundle z nowym benchmark ID, opisem delta i
   referencją do oracle/version. Nie nadpisywać `benchmark-20260907-changelog`.
2. Produkcyjne loadery wyliczają config/catalog/schema/manifest/overlay digests;
   nie przepisywać hashy ręcznie ani nie zmieniać ich w historycznych receipts.
3. Sprawdzić source/seed SHA, scope, profile, login, PG, Xcode, simulator,
   dysk, brak mutantów i równoległego writera. Preflight ma exit 0.
4. Uzyskać jedną zbiorczą zgodę na dokładny nowy bundle i budżet kampanii.
   Propozycja: do 3 fresh attempts, łącznie do 4.5M tokenów, przy 1.8M/run.
   To propozycja, nie udzielona już zgoda i nie reset kosztu 3 347 305.
5. Po dowolnej porażce brak następnego live, dopóki nie istnieje local
   reproducer, poprawka i bramka. Powrót do tej samej niewyjaśnionej porażki
   zatrzymuje live, nie całą możliwą pracę lokalną.
6. Nie zmieniać modeli, seed, objective ani parametrów „dla ratowania wyniku”.
   Zmiana oracle tworzy nową wersję i wymaga ponownej lokalnej kwalifikacji.

Live brama: istniejący harness RA-055 z nowymi, exact zatwierdzonymi ścieżkami;
komendę zapisać przed startem w WORK_UNITS. Bez opt-in ma pozostać skipped.

### Etap 6 — domknięcie RA-055

Każdy punkt jest konieczny: design, oba slices, wszystkie wymagane gates,
fresh review PASS, final verification, dokładnie jeden commit receipt,
zgodność rzeczywistego git show/parent/tree, brak niejawnych ręcznych korekt.
Potem G4, pełny diff od bazowego commita, każde AC, formalny audyt i handoff,
statusy + workflow:validate oraz logiczne lokalne commity zgodnie z AGENTS.
Push nadal wymaga osobnej zgody. Jeśli którykolwiek punkt nie ma dowodu,
RA-055 nie jest DONE.

## 4. Polecenia weryfikacyjne

Każde polecenie uruchamia primary po odczycie rzeczywistego diffu. Nie zastępuje
go raport implementera. Nowe fixtures umieszczać w istniejących suite'ach albo
zaktualizować jawnie tę listę przed wykonaniem; zero filtrów pomijających regresję.

**G1 — katalog, oracle i Xcode adapter (lokalnie):**

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals/catalog.test.ts test/engineering-evals/behavioral-oracle.test.ts apps/agent-worker/test/engineering-live-qualification.test.ts apps/agent-worker/test/xcode-gate-adapter.integration.test.ts
```

**G2 — correction i context:**

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals/repair-context.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts packages/review-loop/test/pre-commit.integration.test.ts apps/agent-worker/test/vertical-slice-e2e.integration.test.ts
```

**G3 — macierz handlera:**

```sh
. scripts/dev/env.sh && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run test/engineering-evals apps/agent-worker/test/engineering-qualification-control.integration.test.ts apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts apps/agent-worker/test/engineering-qualification-adversarial.integration.test.ts apps/agent-worker/test/vertical-slice-e2e.integration.test.ts
```

**G4 — pełna bramka RA-055:**

```sh
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check
```

Do G2 dochodzi direct strict tsc dwóch suite'ów nieuwzględnionych kompletnie
przez package test tsconfig — dokładna sprawdzona komenda jest w WORK_UNITS.
Do G1/G4 dochodzi realny Xcode z niepustym xcresult, nie dodatkowy fake transport.
Pojedynczy flake wymaga powtórzenia i zapisu obu wyników.

## 5. Następna faza Local v1 — plan, nie ukryte rozszerzenie RA-055

Po decyzji właściciela utworzyć taski w TASK_INDEX z zależnością od RA-055.

- **Interfejs lokalny (Q2):** `preflight/run/status/report/cancel/resume/export` jako
  cienka warstwa nad obecnym control plane, nie drugi orchestrator. Description
  z pliku, repo z allowlisty, jawne profile; status/report bez model call.
  Trwały katalog runów, receipts i raporty, bez ręcznego SQL. Testy kontraktu CLI,
  recovery i zamknięcia procesu. Komendy są projektowane, nie dostępne dziś.
- **Niezależna kwalifikacja (Q1):** mały synthetic task, średni state/action task
  i iOS; przynajmniej jeden niewykorzystany w strojeniu. Osobno zatwierdzona
  kampania. Proponowany próg pilota: 3/3 małe, 2/3 średnie i 2/3 iOS, wszystkie
  porażki bezpiecznie rozliczone. To próg pilota, nie gwarancja niezawodności.
- **Handoff użytkowy:** nowa sesja odtwarza run, wynik, koszty i bezpieczny kolejny
  krok wyłącznie z runbooka; nie wymaga znajomości historii tego czatu.
- **Q3/refactor:** osobny backlog po dowodzie używalności. Nie blokować Local v1
  kosmetycznym podziałem plików ani przebudową providerów.

## 6. Raportowanie i reguły ciągłego wykonania

Po każdym kroku: zmiana, komenda, exit, test count, mutation RED/GREEN, następny
krok. Po live: wynik, stage/slice/attempt, provider input/output/total, osobno
estimated/missing/partial, czas modelu i gates, preserved worktree/commit/journal.
Nie obiecywać dostępu do prywatnego toku myślenia — logować jawne działania
i krótkie powody decyzji związane z dowodami.

Budżet invocation pozostaje target 750k / warning 1.2M / hard 1.8M. Cel 750k
nie jest gwarancją. Raportować wszystkie nieudane próby w campaign total;
zmiana configu/modelu nie usuwa kosztu. Nie stosować API cennika do subskrypcji.

Gdy nie ma nowej zgody live, kontynuować do końca bezpieczne prace lokalne
w zatwierdzonym zakresie. Gdy pozostaje wyłącznie nowy zewnętrzny opt-in,
materialna decyzja lub niedostępne środowisko, zapisać exact blocker i stan
odzyskania. Brak sukcesu modelu nie uzasadnia wyłączenia zabezpieczeń.

Najbliższy krok po checkpoint 2026-09-08: **Etap 2/R4–R5 — evaluator-owned
testy i rzeczywisty focused Xcode dla nowej kwalifikacji, zgodnie z ADR-0025;
nie piąty live.** Zachowany reproducer nie jest naprawionym oracle. Narzędzia
XcodeBuildMCP nie są obecnie wystawione w sesji, lecz produkcyjny adapter
projektu wykonał focused diagnostykę w disposable copy: skrypt exit `1`,
Xcode exit `65`, brak modułu `DesignSystem`, zero wykonanych testów.
Zachowane worktree ma identyczny digest przed i po. Read-only replay tego
diagnostic ujawnił brak automatycznego consuming `Package.swift` w kontekście;
ta lokalna regresja jest naprawiana przed rozbudową evaluator boundary.
Context V3 następnie zaliczył dokładny replay (exit `0`, 13803 bytes /
3451 estimated tokens) i 122 testy context/execution. Exact method selectors
adaptera zaliczyły 22 testy oraz mutation RED/restore/GREEN. Aktywny następny
krok to immutable disposable inputs według ADR-0026, później ich binding
w katalogu/receipt/recovery. Sam helper nie będzie dowodem gotowego evaluator-a.
Szczegóły i ścieżki dowodów są w WORK_UNITS. Nowy bundle i kampania live
nadal wymagają odrębnego opt-in.
