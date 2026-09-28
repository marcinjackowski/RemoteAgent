# Engineering Loop — current status

Updated: **2026-09-28**. This is a checkpoint, not a completion audit.
Canonical task status: **RA-055 / IN_PROGRESS** in [TASK_INDEX](tasks/TASK_INDEX.md).

## Bottom line

The production loop completed a small Node task end to end with real Codex
subscription calls. **It is not yet qualified for the owner's actual iOS work.**
The owner clarified that future tasks will be iOS tasks; another Node smoke is
not the next product milestone. The next meaningful qualification is a small,
explicitly scoped iOS task in SonderMind, not unrelated voice or broad UI work.

## What is implemented

- Subscription-based model routing; the qualified live profile used
  `gpt-5.6-sol` for designer, implementer, reviewer and verifier. This does not
  establish a successful Claude end-to-end run. Bedrock/OpenCode and API-key
  fallback are not part of the active qualification.
- Production orchestration through isolated worktrees, bounded tools, real
  verification gates, independent review, final verification and receipt-bound
  local commits. Stop, scope, writer fencing and ambiguous outcomes have
  regression coverage; a model claim is not an authorization or success receipt.
- Local pilot CLI: `pnpm engineering:pilot run`, `status`, `stop`.
  **This CLI's qualified configuration is Node-only; do not substitute an iOS
  config and assume that Xcode execution is supported by that entry point.**
- Per-invocation JSONL journals and readable summaries with stages, tool
  outcomes, gate results, elapsed time and provider-reported token usage.
  Raw prompts, secrets and hidden chain-of-thought are intentionally excluded.
- Request-size-aware budget reservations, receipt normalization after restored
  files, bounded repair context, typed correction targets and stricter evidence
  handling. Estimates are not a mathematical guarantee against provider overruns.
- macOS sandbox metadata fix: Node can resolve worktree modules without granting
  access to sibling file contents or directory listings. Mutation checks and
  real sandbox tests cover the boundary.

## Verified live result

| Item | Recorded result |
| --- | --- |
| Run | `run_9cf5c936-a393-4e2d-92a0-c0829c8096be` (pilot LIVE07) |
| Outcome | `COMPLETED`, CLI exit `0` |
| Gate / review / verifier | PASSED, exit `0` / PASS / VERIFIED |
| Local commit | `0515c519e5a8d41335df5588c7f3c843ae9b0184` |
| Provider usage | 128826 tokens, 9 responses |
| Time | 111.266 seconds |
| Pre-run estimate | 100000–300000 tokens, heuristic |
| Entire pilot campaign | 687053 tokens, 7 attempts, 1 completed task |

The campaign changed during diagnosis, including its task description, so it is
not a reliability measurement of one frozen release. The result was independently
checked against durable receipts and Git, and both the oracle and added regression
test were rerun in the sandbox with exit `0`. The source checkout remained unchanged.
No new live model calls are part of the 2026-09-28 commit/push checkpoint.

## Still unfinished / known limitations

1. **iOS qualification is unfinished.** Node success does not close MOBL-2023 or
   RA-055. Do not mark either complete or silently replace historical failures.
2. Recheck Xcode, simulator, subscription login and resources before a new iOS
   trial. The last recorded iOS disk blocker was below the unchanged 40 GiB
   preflight threshold; that is historical evidence, not a current measurement.
3. Some journal checklist entries remain stale `PENDING` after completion;
   `status` can show `UNPROJECTED` at `LOCAL_COMMIT`. Use `result.json`, exact
   receipts and actual Git evidence as the terminal outcome. Commit subjects
   can be generic. These presentation issues remain open.
4. A journal's campaign counter does not automatically sum separate pilot runs.
   The campaign total above was summed from preserved summaries.
5. A single successful live run is not a guarantee of autonomous reliability or
   low cost. Preserve failures and compare usage on subsequent tasks.

## Next session: bounded iOS qualification

1. Read [AGENTS.md](../AGENTS.md), the mandatory repository documents and current
   RA-055 criteria. Use this status document to distinguish current facts from
   historical retry instructions in the long work log.
2. Obtain the owner's next small iOS task and explicit acceptance criteria. Define
   source/test scope and a concrete Xcode build/test command before model execution.
3. Inspect the existing iOS execution/qualification entry point. Adapt only the
   missing operator wiring if needed; do not pretend the Node CLI already
   qualifies iOS. Preserve subscription routing and deterministic permissions.
4. Recheck actual preflight prerequisites without lowering thresholds or deleting
   preserved worktrees. Keep any necessary tests strictly tied to the selected
   task; do not resume unrelated voice or UI expansion.
5. Run local regression verification, then one isolated live task. Preserve its
   worktree, local commit, journals, receipts and usage. No implicit push, PR or
   external ticket/channel writes.
6. Independently inspect the resulting diff, actual Xcode results, review,
   verification and commit receipts. Only then decide readiness for iOS use.

## Evidence and navigation

- [Pilot runbook and commands](work-units/RA-055/ENGINEERING_PILOT_RUNBOOK.md)
- [Technical completion plan](work-units/RA-055/ENGINEERING_COMPLETION_PLAN.md)
- [Milestone context](work-units/RA-055/ENGINEERING_FINISH_PLAN.md)
- [Detailed work log, prior commands and mutation evidence](work-units/RA-055/WORK_UNITS.md)
- [Cross-task findings](audits/CROSS_TASK_FINDINGS.md)
- [Architecture diagram PDF](architecture/ENGINEERING_LOOP_DIAGRAM.pdf)

Private live data remains outside this repository at
`/Users/marcinjackowski/.remoteagent/engineering-pilot-smoke-Ph1BPS`:

- `runs/pilot-live-07/result.json`;
- `pilot-live-07-primary-verification.log`;
- `artifacts/engineering-debug/engineering-e591624df7677c290bef27276dd000d6970ba17bd469a1729608f79339b8933b.summary.md`
  and its companion JSONL;
- `workspaces/case_0f2e8d2c-a580-4ecd-9614-1fcc73d6edb0/engineering-42bc92e9523a3d308b40ff7e244dbfa4`.

Pushing RemoteAgent does **not** upload those private databases, worktrees or the
separate pilot result commit. Their references are preserved; no cleanup was requested.

## Commit checkpoint and verification

Owner explicitly authorized committing all current repository work and pushing
on 2026-09-28. This supersedes earlier “leave WIP uncommitted” instructions for
this checkpoint, but does not close RA-055. Base HEAD before checkpoint:
`ce9b2ff62e3c947c72c0fafca47d192af983ce98`. Destination: `origin/main`.
Implementation/test checkpoint: `8256e4f` (`feat(engineering): harden execution
and add controlled subscription pilot`). The following documentation commit
contains this status, the architecture diagram, decisions and historical evidence.

Previous full gate (2026-09-15): exit `0`, 3846 passed / 2 explicit opt-in live
skips, forced build 29 and typecheck 46 with zero cached tasks.

Fresh pre-push verification on 2026-09-28: **exit `0`**, 3846 passed / 2
explicit opt-in live skips, 273 test files passed, 223.79 seconds. Forced build:
29/29, cached 0. Forced typecheck: 46/46, cached 0. Lint, formatting,
`workflow:validate` (55 tasks) and `git diff --check` also completed successfully.
Local log: `/tmp/ra055-20260928-prepush-gate.log`.

Executed command:

```sh
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force &&
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force &&
pnpm workflow:validate && git diff --check
```

Documentation-only additions made while the gate ran are checked again before
the documentation commit. No task status was changed and no new formal PASS
or completion handoff was created.
