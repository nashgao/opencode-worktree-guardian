# opencode-worktree-guardian

OpenCode plugin for safety-first multi-session Git worktree workflows. It creates or attaches sessions to guarded worktrees, blocks raw destructive commands, records repo-local ownership state, creates safety refs before finish operations, and reports recovery candidates without mutating by default.

## Install

Local development uses a project-local shim so OpenCode loads only the plugin server function:

```ts
// .opencode/plugins/worktree-guardian.ts
import Guardian from "/Users/nashgao/Desktop/claude/opencode/plugins/opencode-worktree-guardian/src/index.ts"

export const WorktreeGuardian = Guardian.server
export default Guardian.server
```

Do not mutate global OpenCode config for local smoke tests. Keep local host tests inside disposable repositories.

Published package:

```bash
opencode plug opencode-worktree-guardian
```

The plugin package exposes both `./server` and `./tui`. `opencode plug` can enable the package in `opencode.json` and `tui.json`; OpenCode selects the right package export for the server or TUI plugin kind. That makes the Guardian slash commands visible in new OpenCode TUI sessions.

Manual config equivalent:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-worktree-guardian"]
}
```

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-worktree-guardian"]
}
```

Do not put `opencode-worktree-guardian/server` or `opencode-worktree-guardian/tui` directly in config. Those are package export names used by OpenCode's plugin loader after it resolves the package entry.

## Configuration

Repo-local config lives at `.opencode/worktree-guardian.json`. The current supported OpenCode/plugin API baseline is OpenCode `1.14.48` with `@opencode-ai/plugin` `^1.14.48`.

```json
{
  "remote": "origin",
  "baseBranch": "main",
  "worktreeRoot": ".worktrees/$REPO",
  "branchPrefix": "guardian/",
  "finishMode": "create-pr",
  "autoStart": true,
  "autoFinish": false,
  "autoCleanup": false,
  "allowStashIfUnrelated": false,
  "allowDirtyPaths": [],
  "protectedBranches": ["main", "master", "develop", "production"]
}
```

Defaults are delivery-first, lifecycle-managed, and cleanup-conservative. `guardian_finish` defaults to `create-pr`: it creates a safety ref, pushes the session branch, and suggests a `gh pr create` command without merging or deleting the worktree. `autoStart` is enabled by default so Guardian can create/attach a session worktree and own its finish/delete lifecycle; repo config can set `autoStart: false` to disable automatic ownership. Terminal sessions (`deleted`, `abandoned`, `finished`, or `preserved`) are not auto-started again; agents should start a new session instead of recreating stale worktrees. `autoFinish` and `autoCleanup` remain disabled unless repo config opts in. Stash mutation is never cleanup. `allowDirtyPaths` defaults to empty; when configured, it lets `guardian_finish` tolerate matching runtime or local-state dirt without deleting, stashing, reverting, staging, or committing those files. Dirty scanning enumerates untracked files, so narrow file-specific patterns such as `.claude/logs/hooks.log` or `.serena/project.yml` can match generated files inside otherwise-untracked runtime directories. `branchPrefix` is the default namespace for auto-created branch names, not the ownership rule; explicit descriptive branch names are allowed when Guardian state or a token-bound target proves ownership.

## Native Tools

- `guardian_start`: create or attach the session to a guardian worktree.
- `guardian_status`: read-only inventory of sessions, worktrees, refs, stashes, dirty files. Its native tool output renders a terminal-readable summary, while `metadata` keeps the full structured result for automation.
- `guardian_delete_worktree`: safe explicit worktree deletion. Run `mode: "plan"` first to get a confirm token, then `mode: "apply"` with that token. It creates a safety ref before removal, uses non-force `git worktree remove`, keeps the branch by default, and only uses non-force `git branch -d` when `deleteBranch: true` and ancestry is proven. Intentional unmerged local abandonment requires `deleteBranch: true` plus `abandonUnmerged: true` in both plan and apply.
- `guardian_unblock_finish`: safe explicit finish-unblock helper. Run `mode: "plan"` first to get a confirm token, then `mode: "apply"` with that token. The first supported action, `commit-review-artifacts`, commits only `.milestones/reviews/*impl-rating-YYYYMMDD.md` or `.milestones/reviews/*impl-rating-YYYYMMDD.txt` review artifacts and refuses mixed source changes, renames/copies, and symlink artifacts. Descriptive branch names are allowed when the recorded session owns that exact branch/worktree binding. If the session is missing from Guardian state, plan and apply can resolve exactly one checked-out worktree under the configured Guardian worktree root from the same explicit `branch` or `worktreePath`.
- `guardian_finish`: gated finish behavior based on `finishMode`.
- `guardian_preserve`: mark the session terminal/preserved and create a preserved ref. Preserved worktrees are cleanup-eligible through `guardian_delete_worktree`; preservation is not a long-term retention instruction.
- `guardian_recover`: read-only recovery refs, reflog/unreachable candidates, and suggested commands. Its native tool output renders a terminal-readable summary, while `metadata` keeps the full structured result for automation.
- `guardian_report_html`: write a self-contained offline control-room report to `.git/opencode-guardian/report.html` with sessions, worktrees, branch coverage, risks, recovery commands, and raw status/recover metadata.
- `guardian_hygiene`: scan untracked and ignored workspace artifacts for report-only hygiene findings. It classifies known scratch artifacts, nested Git repositories, suspicious research dumps, and protected exclusions without deleting or cleaning anything.
- `guardian_hygiene_cleanup`: plan or apply cleanup for exact approved hygiene findings. Plan is read-only; the plugin flow caches the internal token for the same session/repo/options, then applies after explicit user confirmation with `confirmDelete: true`. Apply still re-runs preflight and removes only internally token-bound paths with internal Node filesystem APIs.

## Slash Commands

When the TUI plugin entrypoint is enabled, Guardian registers these slash commands directly in OpenCode's command palette and slash command surface:

- `/guardian-status`
- `/guardian-start`
- `/guardian-finish`
- `/guardian-preserve`
- `/guardian-recover`
- `/guardian-report`
- `/guardian-hygiene`
- `/guardian-hygiene-cleanup`
- `/guardian-delete-worktree`
- `/guardian-unblock-finish`

Each command submits a prompt to the current session telling the agent to use the matching native Guardian tool. If no session is open, the command shows a warning instead of mutating anything.

## Packaged Markdown Commands

The package also ships top-level `commands/*.md` assets for compatibility with hosts that support packaged markdown command discovery. Those hosts may register namespaced commands, for example:

- `/opencode-worktree-guardian:status`
- `/opencode-worktree-guardian:start`
- `/opencode-worktree-guardian:finish`
- `/opencode-worktree-guardian:preserve`
- `/opencode-worktree-guardian:recover`
- `/opencode-worktree-guardian:report`
- `/opencode-worktree-guardian:hygiene`
- `/opencode-worktree-guardian:hygiene-cleanup`
- `/opencode-worktree-guardian:delete-worktree`
- `/opencode-worktree-guardian:unblock-finish`

Each packaged command is a thin prompt wrapper around the matching native Guardian tool. It does not authorize raw shell cleanup, raw worktree removal, stash mutation, raw branch deletion, or bypassing `guardian_finish`, `guardian_delete_worktree`, `guardian_hygiene_cleanup`, or `guardian_unblock_finish` preflights.

Native OpenCode command discovery is separate from packaged plugin assets. User or project commands live in `~/.config/opencode/commands/*.md` or `<repo>/.opencode/commands/*.md`; OpenCode core does not automatically discover this package's internal `commands/*.md` without a loader that supports packaged plugin commands.

## Safety Model

The plugin blocks raw destructive shell/git commands in `tool.execute.before`, including hard resets, forced cleans, worktree removal/prune, raw `git worktree add` outside Guardian-owned roots, raw branch deletion, stash mutation, force push, destructive checkout/restore/switch forms, shell-wrapped variants, context-mode code payloads, and `rm -rf` against known guardian worktrees. When config context is available, it also blocks manual Guardian-branch bypasses such as pushing `HEAD` or `guardian/*` directly to a protected branch, or merging `guardian/*` while already on a protected branch. Use `guardian_start`, not raw `git worktree add`, when a session needs a worktree.

Guardian owns a session worktree by default after the chat-system hook runs. It creates or attaches a session worktree, records repo-local ownership, and routes safe mutating shell/git tool calls for that session into the recorded worktree. Run `guardian_start` explicitly when ownership is needed before the hook has run, or set repo config `autoStart: false` to opt out of automatic ownership. Without recorded ownership, normal non-destructive commands pass through while destructive cleanup/reset/stash/force-push/worktree-removal guards still apply.

If older or corrupted state records an active session on the primary repo worktree or a protected branch, `guardian_start` is the repair path. With `createWorktree: true`, it creates a fresh Guardian worktree, overwrites the poisoned session binding, and leaves the primary worktree untouched. Without worktree creation enabled, it blocks with an actionable reason instead of returning the bad binding.

Guardian hooks do not move the OpenCode host process cwd. Instead, before safe shell/git tools run, Guardian rewrites the tool execution directory to the recorded worktree and then re-applies the destructive-command guards. Missing, unresolvable, or unrecorded worktrees fail closed. Raw cleanup/reset/stash/force-push/worktree-removal commands remain blocked.

Finish Guardian work through `guardian_finish`, not manual protected-branch push or merge commands. Finish always creates a safety ref before risky operations and reports preflight facts/blockers for automation. Dirty worktrees block finish unless every dirty path matches explicit `allowDirtyPaths` config. Allowed dirty paths are reported as `allowedDirtyFiles` and left untouched; any non-matching dirty path remains a blocker. `create-pr` pushes the branch and suggests a PR command; it does not create a PR natively. `merge-to-base` requires explicit approval, and cleanup only runs when `autoCleanup` or `allowCleanup` is set and ancestry is proven.

When `guardian_finish` is blocked only by generated review-rating artifacts, use `guardian_unblock_finish`, not raw cleanup or a broad commit. `mode: "plan"` is read-only and returns a `confirmToken` plus the exact review artifacts. If the `sessionId` is not recorded in Guardian state, pass an explicit `branch` or `worktreePath`; the tool refuses to infer a target from the session id alone and proceeds only when that input resolves exactly one checked-out worktree under the configured Guardian worktree root. `mode: "apply"` re-runs the same preflight, requires the fresh token, creates a safety ref, stages only those review artifacts, commits them, updates Guardian state, and refuses mixed dirty/source paths. Apply must receive the same explicit `branch` or `worktreePath` when state is still missing. It never deletes files, stashes, cleans, follows symlink artifacts, accepts renames/copies, or commits non-review source changes.

Delete stale, preserved, finished, or orphaned Guardian worktrees through `guardian_delete_worktree`, not raw shell cleanup. `mode: "plan"` is read-only: it resolves exactly one target by `targetPath`, `sessionId`, or `branch`, runs preflight checks, and returns a `confirmToken`. `mode: "apply"` re-runs the same preflight, recomputes the token from the normalized repo root, target kind, target path, worktree-listed state, branch or detached marker, HEAD, session identity/status, `deleteBranch`, `abandonUnmerged`, ancestry evidence, unmerged commits, and `allowIgnoredFiles`, then blocks if the token is stale or missing. Apply refuses the primary repo worktree, the current execution worktree, dirty or untracked targets, protected-branch worktrees even when `deleteBranch` is false, detached HEADs, ignored files unless `allowIgnoredFiles: true` is present in both plan and apply, and repo stashes unless `allowStashIfUnrelated` is enabled. That refusal still applies to worktree removal: passing the primary repo as `targetPath` stays blocked. Apply creates a safety ref before running non-force `git worktree remove <path>`. Branch deletion is opt-in with `deleteBranch: true`; by default it requires ancestry proof and uses non-force `git branch -d`. No Guardian status is a permanent retention instruction: preserved and finished sessions are cleanup-eligible once the preflight proves cleanup is safe.

If unmerged Guardian work is intentionally being abandoned, pass `deleteBranch: true` and `abandonUnmerged: true` during both plan and apply. Plan reports `ancestryProven: false`, the base ref, and the unmerged commits that will remain recoverable from the safety ref. Apply creates the safety ref first, then removes the clean Guardian worktree and deletes the local branch, recording the session as `abandoned`. This explicit abandon lane does not relax primary/current worktree, dirty-target, protected-branch, checked-out orphan branch, stale-token, stash, or ignored-file blockers.

If a recorded Guardian session's worktree path is already absent from `git worktree list`, or recorded state points at the primary repo path while the recorded Guardian branch is not checked out anywhere, `guardian_delete_worktree` can perform branch-only orphan cleanup with `deleteBranch: true`. This path still requires `plan` then `apply`, verifies the branch exists, is not checked out in any worktree, is not protected, and creates a safety ref before branch deletion. Normal orphan cleanup requires ancestry proof and uses non-force branch deletion; intentional unmerged orphan abandonment requires `abandonUnmerged: true` and records the session as abandoned. It deletes no filesystem path and does not allow primary repo worktree deletion.

If a local Guardian branch remains after its worktree and active state are gone, pass the exact `branch` or terminal `sessionId` with `deleteBranch: true` to request stale-branch cleanup. Terminal states include `deleted`, `abandoned`, `finished`, and `preserved`; preserved is cleanup-eligible, not a retention promise. This branch-only path returns `targetKind: stale-branch` only when terminal Guardian state or matching `refs/opencode-guardian` safety refs prove ownership. Branch prefixes alone are not ownership proof. It still verifies the branch exists, is checked out nowhere, is not protected, and requires ancestry proof unless `abandonUnmerged: true` is explicitly present in both plan and apply.

Workspace hygiene scanning is report-only. `guardian_hygiene` detects untracked or ignored scratch artifacts, nested Git repositories, and suspicious research dumps, but it does not delete, move, stash, or clean anything. `guardian_status`, `guardian_recover`, and `guardian_hygiene` are evidence-only surfaces; their findings do not authorize deletion. Agents should put research clones, downloaded upstream repos, generated fixtures, and temporary test data outside the active project tree, preferably under OS temp space such as `$TMPDIR/opencode/<repo>/<session>/`.

Hygiene cleanup is a separate native flow. Use `guardian_hygiene_cleanup` only after the user explicitly wants cleanup of reported residue. `mode: "plan"` is read-only and returns exact approved targets, blockers, and summary; raw metadata also carries an internal confirm token for automation/debugging, but the readable output does not ask users to copy it. Defaults allow only `known-cleanable`, including generated `node-compile-cache/`, `node-coverage-*`, and `tsx-<digits>/` cache roots; `suspicious` is blocked by default, and dirty `nested-git` is always blocked. Clean `nested-git` cleanup, when requested, requires explicit `allowCategories: ["nested-git"]` and the same internal token gate. In the plugin tool flow, run `mode: "plan"`, inspect exact targets/blockers, get explicit user confirmation, then run `mode: "apply"` with `confirmDelete: true`; the plugin injects the cached token only for the same session/repo/options. Low-level direct calls to `guardianHygieneCleanup` still require the matching `confirmToken` for `mode: "apply"`. Apply re-runs preflight and removes only token-bound approved paths using internal Node `fs` APIs. It never suggests or shells out to broad cleanup commands. Cleanup always blocks tracked files, protected directories, configured or registered Guardian worktrees, paths outside the repo root, `.git`, symlink cleanup roots, missing selected paths, stale fingerprints, and selected roots with unexpected tracked contents.

### Sample Tool Output

Clean `guardian_status` keeps the readable summary short and the structured fields available in `metadata`:

```text
[GOOD] guardian_status snapshot
[INFO] repoRoot: /repo
[INFO] sessions: 1 | worktrees: 1 | orphaned: 0 | dirty: 0 | stashes: 0 | safetyRefs: 0 | preservedRefs: 0 | recoveryCandidates: 0
[INFO] sessions: 1
  - session_id=ses_123 status=active branch=guardian/example worktree_path=/repo/.worktrees/example head=abc123def456
[INFO] worktrees: 1
  - branch=guardian/example head=abc123def456 path=/repo/.worktrees/example
[INFO] suggested commands:
  - guardian_status
  - guardian_recover
```

`guardian_status` and `guardian_recover` classify linked worktrees that are missing Guardian state. Worktrees outside the configured Guardian root are reported as `external-worktree`; temp-space worktrees such as `$TMPDIR/opencode/...`, `/tmp/...`, `/private/tmp/...`, or macOS `/var/folders/...` paths are reported as `external-temp-worktree` with `severity=fail` and metadata such as `commonGitDir`. These classifications are evidence only; they do not authorize cleanup.

`guardian_delete_worktree` requires a two-step token flow:

```text
[WARN] guardian_delete_worktree planned
[INFO] mode: plan | deleteBranch: false | branchDeleted: false
[INFO] targetPath: /repo/.worktrees/repo/old-session
[INFO] branch: guardian/old-session | head: abc123def456
[WARN] confirmToken: <sha256-token>
```

Apply with that token removes only the linked worktree unless `deleteBranch: true` is also supplied and ancestry is proven:

```text
[GOOD] guardian_delete_worktree deleted
[INFO] mode: apply | deleteBranch: false | branchDeleted: false
[INFO] targetPath: /repo/.worktrees/repo/old-session
[INFO] branch: guardian/old-session | head: abc123def456
[INFO] safetyRef: refs/opencode-guardian/ses_old/guardian/old-session/20260601T120000
```

For an already-absent Guardian worktree, or recorded state that points at the primary repo path while the stale Guardian branch is checked out nowhere, planning with `deleteBranch: true` returns `targetKind: orphan-branch` in metadata. Applying the returned token creates a safety ref, deletes only the branch, and records `branch_only_delete: true` in Guardian state. If the orphan branch is unmerged and deletion is still intended, include `abandonUnmerged: true` in both plan and apply after inspecting the reported unmerged commits.

For a local Guardian branch whose worktree and active state are already gone, planning with the exact `branch` or terminal `sessionId` and `deleteBranch: true` returns `targetKind: stale-branch` only when terminal Guardian state or matching Guardian safety refs prove ownership. Terminal states include `deleted`, `abandoned`, `finished`, and `preserved`; preserved is cleanup-eligible, not a retention promise. Applying the returned token creates a safety ref and deletes only the branch; if unmerged work is intentionally being abandoned, include `abandonUnmerged: true` in both plan and apply after inspecting the unmerged commit list.

An explicit unmerged abandon plan includes ancestry and unmerged commit evidence:

```text
[WARN] guardian_delete_worktree planned
[INFO] mode: plan | deleteBranch: true | abandonUnmerged: true
[INFO] branch: guardian/old-session | ancestryProven: false | unmergedCommitCount: 1
[WARN] confirmToken: <sha256-token>
```

If worktree removal succeeds but opt-in branch deletion is blocked by Git or a final safety check, report the remaining branch and safety ref. Do not retry with raw branch deletion.

Ignored files are reported and blocked by default. For stale worktrees that contain only ignored local residue such as `.claude/` or `data/`, pass `allowIgnoredFiles: true` during `plan`, inspect the ignored file list, then pass the same flag during `apply` with the returned token.

Warning-heavy `guardian_recover` lists recovery facts without mutating state:

```text
[GOOD] guardian_recover snapshot
[INFO] repoRoot: /repo
[INFO] sessions: 2 | worktrees: 2 | orphaned: 1 | dirty: 0 | stashes: 1 | safetyRefs: 1 | preservedRefs: 0 | recoveryCandidates: 2
[WARN] orphaned sessions: 1
  - ses_orphan
[WARN] worktrees without state: 1
  - /repo/.worktrees/guardian-old
[WARN] stashes: 1
  - stash@{0}
[INFO] recovery candidates: 2
  - HEAD@{1}
[INFO] suggested commands:
  - guardian_status
  - guardian_recover
  - git stash show -p stash@{0}
```

`guardian_report_html` writes the same inventory into a static offline HTML file and returns the path plus raw `status` and `recover` metadata:

```text
[GOOD] guardian_report_html wrote offline report
[INFO] reportPath: /repo/.git/opencode-guardian/report.html
[INFO] repoRoot: /repo
[INFO] sessions: 1 | worktrees: 1 | risks: 0 | recoveryCandidates: 0
```

`guardian_hygiene` reports workspace residue without cleanup approval:

```text
[WARN] guardian_hygiene scan
[INFO] candidates: 7 | findings: 2 | exclusions: 1
[WARN] known-cleanable: 1 | suspicious: 0 | nested-git: 1
  - severity=warn category=known-cleanable path=librarian-react reason=known librarian scratch artifact
  - severity=fail category=nested-git path=test-hyperf-kafka reason=nested Git repository has uncommitted changes
[INFO] suggested commands:
  - guardian_hygiene
  - guardian_status
  - git status --short --ignored
```

`guardian_hygiene_cleanup` uses a separate two-step confirmed cleanup flow for approved hygiene findings:

```text
[WARN] guardian_hygiene_cleanup planned
[INFO] approvedTargets: 1 | removedTargets: 0 | blockers: 1 | fatal: 0
[INFO] approved targets:
  - known-cleanable librarian-react: known librarian scratch artifact
[WARN] blockers:
  - blocked research-dump: category suspicious is not allowed for hygiene cleanup
```

After explicit user confirmation, apply through the plugin with `confirmDelete: true`; the plugin uses the cached internal token only when the session, repo, and cleanup options still match the plan. If any selected target disappears, gains tracked contents, changes fingerprint, resolves outside the repo, is a symlink root, or overlaps Guardian worktree/protected paths, apply blocks and requires a new plan.

Blocked `guardian_finish` exposes `preflight` and `report` for automation:

```text
{
  "ok": false,
  "status": "blocked",
  "reason": "worktree has uncommitted changes",
  "preflight": {
    "sessionRecorded": true,
    "sessionOwnedWorktree": true,
    "currentBranch": "guardian/foo",
    "branchProtected": false,
    "dirtyFileCount": 2,
    "allowedDirtyFiles": [".claude/logs/hooks.log"],
    "allowedDirtyFileCount": 1,
    "blockingDirtyFiles": ["src/app.ts"],
    "blockingDirtyFileCount": 1,
    "blockers": ["worktree has uncommitted changes"]
  },
  "report": {
    "action": "blocked",
    "mode": "create-pr",
    "remote": "origin",
    "baseBranch": "main",
    "allowedDirtyFileCount": 1,
    "blockingDirtyFileCount": 1,
    "blockers": ["worktree has uncommitted changes"]
  }
}
```

`guardian_unblock_finish` uses the same confirm-token posture for narrow finish blockers:

```text
[WARN] guardian_unblock_finish planned
[INFO] action: commit-review-artifacts | sessionId: ses_123 | branch: guardian/foo
[INFO] worktreePath: /repo/.worktrees/repo/foo
[INFO] review artifacts: 1
  - .milestones/reviews/foo-impl-rating-20260602.md
[WARN] confirmToken: <sha256-token>
[INFO] commitMessage: docs: add foo implementation rating
```

## Troubleshooting

- Blocked mutating command: run `guardian_status`; if the session owns a worktree, Guardian should route safe shell/git tools there automatically. A blocker means the recorded worktree is missing/unresolvable, state is fail-closed, or the command is unsafe.
- Recorded primary/protected ownership: run `guardian_start` with `createWorktree: true`; Guardian repairs the session into a proper Guardian worktree instead of requiring raw branch or switch commands.
- No owned worktree: normal non-destructive commands run in the current worktree. If you want Guardian ownership/routing, run `guardian_start`, then check `guardian_status` before retrying mutating commands.
- Intentional finish or preserve: use `guardian_finish` or `guardian_preserve`; `autoFinish` remains opt-in. Preservation creates a safety ref and terminal state, not a permanent worktree retention promise.
- Dirty worktree: commit real source/config/doc changes or intentionally preserve. If the only dirt is runtime/local state, configure narrow `allowDirtyPaths`; file-specific patterns can match untracked runtime files. Guardian reports those files as `allowedDirtyFiles`, leaves them untouched, and still blocks any non-matching dirty path.
- Dirty review artifact blocks finish: run `guardian_unblock_finish` with `mode: "plan"`, inspect the listed artifacts and confirm token, then apply only if the plan contains no source changes. If the session is unrecorded, include the explicit `branch` or `worktreePath` shown by `guardian_status`.
- Workspace residue: run `guardian_hygiene`; known artifacts, nested repos, and suspicious paths are reported only. If the user explicitly approves cleanup, run `guardian_hygiene_cleanup` with `mode: "plan"`, inspect exact targets/blockers, get explicit delete confirmation, then apply through the plugin with `mode: "apply"` and `confirmDelete: true` for approved targets. The internal token/fingerprint gate remains enforced.
- Stash exists: inspect with `git stash list` and `git stash show -p`; Guardian will not mutate stashes.
- Orphaned worktree: run `guardian_recover` for evidence. If deletion is explicitly intended, run `guardian_delete_worktree` in `mode: "plan"`, inspect the preflight and confirm token, then re-run with `mode: "apply"` and that token.

## Verification

Run:

```bash
npm run verify
npm run audit:deps
npm run test:contract
npm run test:smoke:package
npm run test:smoke:host
npm run test:readiness
```

`test:contract` validates the plugin export, hook, tool, documented local-shim contract, and fail-closed cwd enforcement. `test:smoke:package` packs the artifact, installs it into a clean temporary consumer, and imports it by package name. `test:smoke:host` is deterministic and host-like: it uses a disposable repo and local shim/tool/hook execution without mutating global OpenCode config. `test:readiness` aggregates verification, audit, smoke checks, and `npm pack --dry-run`. Test scripts route Node, tsx, and coverage temp/cache output to external OS temp space.

The test suite uses disposable repositories only. Do not run destructive-command smoke tests against live repositories.

## Dependency Audit

Last verified on 2026-05-14:

```text
npm run audit:deps
found 0 vulnerabilities
```


## Manual OpenCode Host Check

The automated host smoke intentionally avoids model-driven OpenCode tool invocation because that path depends on provider auth and can be nondeterministic. When manually validating a real OpenCode host, use a disposable repository only.

Suggested manual checklist:

1. Create a fresh temporary Git repo.
2. Add the local shim from the Install section under `.opencode/plugins/worktree-guardian.ts`.
3. Start OpenCode from that disposable repo.
4. Confirm `guardian_status` is visible and returns repository inventory, including any owned worktree path.
5. From the base repo, ask OpenCode to run an allowed write such as `git add`; confirm Guardian routes the tool execution to the owned worktree instead of mutating the base repo.
6. Ask OpenCode to run a blocked command such as `git reset --hard`; confirm Guardian still blocks before mutation.

If this manual check disagrees with the deterministic smoke suite, treat the plugin as not release-ready until the discrepancy is understood.
