# opencode-worktree-guardian

OpenCode plugin for safety-first multi-session Git worktree workflows. It creates or attaches sessions to guarded worktrees, blocks raw destructive commands, records repo-local ownership state, creates safety refs before finish operations, and reports recovery candidates without mutating by default.

## Install

Local development uses a project-local shim so OpenCode loads only the plugin server function:

```ts
// .opencode/plugins/worktree-guardian.ts
import Guardian from "/absolute/path/to/opencode-worktree-guardian/src/index.ts"

export const WorktreeGuardian = Guardian.server
export default Guardian.server
```

Replace `/absolute/path/to/opencode-worktree-guardian/src/index.ts` with the absolute path to this checkout's `src/index.ts`.

Do not mutate global OpenCode config for local smoke tests. Keep local host tests inside disposable repositories.

Package install after publish:

```bash
opencode plug opencode-worktree-guardian
```

The plugin package exposes both `./server` and `./tui`. After the package is published or otherwise made available to OpenCode's plugin installer, `opencode plug` can enable it in `opencode.json` and `tui.json`; OpenCode selects the right package export for the server or TUI plugin kind. That makes the Guardian slash commands visible in new OpenCode TUI sessions.

The package currently ships TypeScript source entrypoints for OpenCode/plugin-compatible hosts. Package smoke tests verify import through a TypeScript loader, so generic Node consumers need an appropriate TypeScript-capable loader or host until a compiled build is introduced.

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
  "autoStartMode": "eager",
  "autoFinish": false,
  "autoCleanup": false,
  "allowStashIfUnrelated": false,
  "allowBaseWorktreePreserveReset": false,
  "allowDirtyPaths": [],
  "protectedBranches": ["main", "master", "develop", "production"],
  "trustedUpstreamRemotes": []
}
```

Defaults are delivery-first, lifecycle-managed, and cleanup-conservative. `guardian_finish` defaults to `create-pr`: it creates a safety ref, pushes the session branch, and suggests a `gh pr create` command without merging or deleting the worktree. `autoStart` is enabled by default so Guardian can create/attach a session worktree and own its finish/delete lifecycle. `autoStartMode` defaults to `eager`, which creates ownership during chat-system setup. Set `autoStartMode: "lazy"` to leave read-only sessions on the current worktree and create ownership only before the first repo-local direct file mutation or command that is not proven read-only; once created, existing routing and finish logic is unchanged. Repo config can set `autoStart: false` to disable automatic ownership entirely. Terminal sessions (`deleted`, `abandoned`, `finished`, or `preserved`) are not auto-started again; agents should start a new session instead of recreating stale worktrees. `autoFinish` and `autoCleanup` remain disabled unless repo config opts in. Stash mutation is never cleanup. `allowBaseWorktreePreserveReset` defaults to `false`; when enabled (or passed per call to `guardian_finish`), `merge-to-base` may snapshot a dirty primary worktree's tracked and untracked changes into a recoverable Guardian safety ref, clean only those paths through Guardian's internal path-scoped reset/clean routine, and proceed, instead of blocking. `allowDirtyPaths` defaults to empty; when configured, it lets `guardian_finish` tolerate matching runtime or local-state dirt without deleting, stashing, reverting, staging, or committing those files. Dirty scanning enumerates untracked files, so narrow file-specific patterns such as `.claude/logs/hooks.log` or `.serena/project.yml` can match generated files inside otherwise-untracked runtime directories. `branchPrefix` is the default namespace for auto-created branch names, not the ownership rule; explicit descriptive branch names are allowed when Guardian state or a token-bound target proves ownership.

## Native Tools

- `guardian_start`: create or attach the session to a guardian worktree.
- `guardian_done`: plan or apply the safest implementation-done path for the current repository state. The native tool remains plan-first when `mode` is omitted so an accidental bare API call cannot commit, push, merge, or delete; command wrappers should run that plan, inspect it, then continue with confirmed apply when the user invoked the completion workflow. From a clean primary base branch, bare `guardian_done` now defaults to the repo-wide `done-all` lane: the plan enumerates every active Guardian feature session and reports finishable, dirty, or protected sessions; after confirmation, apply lands or already-landed-cleans each clean finishable session, skips dirty/protected sessions with exact next actions, fast-forwards the local base worktree from its tracked upstream when that upstream remote is trusted (falling back to the configured remote/base), then cleans token-bound safe redundant merged worktree/branch candidates while reporting dirty, protected, unmerged, detached, or otherwise blocked leftovers. Candidate-level cleanup blockers do not stop safe session finishing or safe cleanup; the result is `partial` until every remaining repo blocker is resolved. `all=true` remains accepted for explicit batch selection, but is no longer required for the normal finish workflow. For an active recorded session, confirmed apply commits dirty session work only when `commitMessage` is explicit, fetches the configured remote, and first checks whether the session commit is already reachable from `remote/baseBranch`. Already-landed sessions skip push/PR creation and go straight through Guardian's token-gated worktree and local-branch cleanup. Otherwise Guardian pushes the branch, creates or reuses the PR, merges it without requesting GitHub CLI branch deletion, fetches, proves the session commit is reachable from `remote/baseBranch`, then removes the stale Guardian worktree and local branch. Successful active-session apply also fast-forwards local base when safe, cleans safe redundant cleanup candidates, and reports dirty or protected leftovers. Admin bypass is never automatic; it requires explicit `allowAdminBypass: true`. `guardian_done` can also reattach an existing Guardian-root worktree with a fresh internal recovery session id when no active session owns it, routes clean primary-base cleanup to `guardian_finish_workflow`, and handles dirty protected primary `baseBranch` only with an explicit `commitMessage` plus explicit confirmation. Primary-main apply creates a safety ref before committing, pushes normally to the configured remote/base branch, proves the new commit is reachable, then cleans safe redundant cleanup candidates while reporting dirty or protected leftovers; that lane does not force-push, mutate stashes, delete unrelated remote branches, delete dirty worktrees, or weaken worktree safety. The batch lane is clean-only; dirty or protected sessions are skipped and reported under `remaining` for individual `guardian_done`, and apply fails closed with a token mismatch if the active session set, base ref, or any worktree changed since plan.
- `guardian_status`: read-only inventory of sessions, worktrees, refs, stashes, dirty files. Its native tool output renders a terminal-readable summary, while `metadata` keeps the full structured result for automation.
- `guardian_project_status`: read-only project intelligence snapshot from explicit project roots or the current repo root. It parses `definition/roadmap.md`, `.milestones/reviews/*impl-rating*.md|txt`, `.omo/plans/*.md`, and `.omo/ulw-loop/*/{goals.json,ledger.jsonl}` into structured metadata with warnings for malformed or skipped artifacts. The default call does not write files or mutate Guardian state. Passing `writeReport: true` writes only `.git/opencode-guardian/project-report.html` as static offline HTML.
- `guardian_delete_paths`: safe exact path deletion for files and directories inside the repo. Run `mode: "plan"` first with explicit `paths`, inspect statuses and blockers, then apply through the plugin with `mode: "apply"` and `confirmDelete: true`; low-level direct calls also require the matching `confirmToken`. Tracked source deletion requires `allowTracked: true`; directory deletion requires `allowRecursive: true`. Worktree deletion remains separate and must use `guardian_delete_worktree`.
- `guardian_delete_worktree`: safe explicit worktree deletion. Run `mode: "plan"` first to get a confirm token, then `mode: "apply"` with that token. It creates a safety ref before removal, uses non-force worktree removal, keeps the branch by default, and deletes local branches only when `deleteBranch: true`, the branch is checked out nowhere after any target worktree removal, ancestry is proven to the resolved base, and the local ref still matches the token-bound expected head. Dirty or untracked target worktrees still block by default. The direct tool can proceed only when `allowRedundantDirtyPaths: true` is present in both plan and apply, every dirty path is an eligible unstaged tracked modification, unstaged tracked deletion, or untracked regular file, and Guardian proves that final path state already matches the fetched base tree. Apply snapshots that dirt to `dirtySnapshotRef`, cleans only proof-approved paths, rechecks status, then removes the worktree. Intentional unmerged local abandonment requires `deleteBranch: true` plus `abandonUnmerged: true` in both plan and apply.
- `guardian_unblock_finish`: safe explicit finish-unblock helper. Run `mode: "plan"` first to get a confirm token, then `mode: "apply"` with that token. The first supported action, `commit-review-artifacts`, commits only `.milestones/reviews/*impl-rating-YYYYMMDD.md` or `.milestones/reviews/*impl-rating-YYYYMMDD.txt` review artifacts and refuses mixed source changes, renames/copies, and symlink artifacts. Descriptive branch names are allowed when the recorded session owns that exact branch/worktree binding. If the session is missing from Guardian state, plan and apply can resolve the current Guardian-root worktree or exactly one checked-out worktree under the configured Guardian worktree root from the same explicit `branch` or `worktreePath`, then attach a fresh internal recovery session id.
- `guardian_finish`: gated finish behavior based on `finishMode`. If the current directory is an existing Guardian-root worktree without an active recorded session, Guardian can attach a fresh internal recovery session id before running the finish preflight. Under `merge-to-base` with `allowMergeToBase: true`, finish can self-heal a clean primary repo worktree that is on the wrong branch by safety-reffing its original HEAD and the local base branch head, then repositioning it onto the base branch before the fast-forward merge. A dirty primary worktree fails closed unless `allowBaseWorktreePreserveReset: true` (per call or via config) is also set, in which case finish snapshots the base dirt (tracked changes and untracked files) into a recoverable safety ref, resets only those paths clean, then repositions and merges; the Guardian session worktrees under the worktree root are never touched. A base branch checked out in another worktree, a missing local base branch, or any non-fast-forward/push/proof failure still fail closed with safety refs recorded.
- `guardian_finish_workflow`: high-level implementation-done cleanup workflow. Run `mode: "plan"` first to fetch and resolve the configured base, verify stash policy, and scan redundant cleanup candidates already merged to the freshly resolved `remote/baseBranch` commit. A dirty primary worktree is a blocker; plan may still include a read-only cleanup inventory or blocked inventory with `candidateScan: completed`, but it must not return a `confirmToken` or permit dirty primary cleanup. Invalid mode, base-unavailable, and stash-blocker plans skip the candidate scan explicitly, so their candidate counts are not trustworthy completed evidence. Run `mode: "apply"` only with a fresh plan token; the token binds the resolved base commit and cleanup targets. If the plan has safe candidates plus candidate-level blockers, apply cleans the safe candidates and returns `partial` with the blockers still reported. Apply re-plans Guardian-root worktree, stale local branch, and merged unchecked-out cleanup-prefix branch targets through `guardian_delete_worktree`; stale local branches still require terminal Guardian state or matching safety-ref ownership proof, while merged cleanup-prefix branches require ancestry proof against the resolved base. Local branch refs are deleted only after a local safety ref and an exact expected-head check, so local base divergence does not veto remote-base proof but advanced local refs still block. Remote Guardian branch refs under the configured `branchPrefix` may be deleted only from the resolved effective remote (the configured remote, or a trusted tracked upstream when it supplies the base), only when merged to the resolved base, after creating a local safety ref, and with an expected-head lease that blocks advanced refs. It does not create commits, choose commit messages, merge protected branches, mutate stashes, force-delete local branches, delete unproven local stale branches, or run raw cleanup.
- `guardian_preserve`: mark the current Guardian worktree terminal/preserved and create a preserved ref. If no active session owns the current Guardian-root worktree, Guardian can attach a fresh internal recovery session id first. Preserved worktrees are cleanup-eligible through `guardian_delete_worktree`; preservation is not a long-term retention instruction.
- `guardian_recover`: read-only recovery refs, reflog/unreachable candidates, and suggested commands. Its native tool output renders a terminal-readable summary, while `metadata` keeps the full structured result for automation.
- `guardian_report_html`: write a self-contained offline control-room report to `.git/opencode-guardian/report.html` with sessions, worktrees, branch coverage, risks, recovery commands, and raw status/recover metadata.
- `guardian_hygiene`: scan, plan, or apply cleanup for workspace hygiene findings. With no `mode`, it classifies known scratch artifacts, nested Git repositories, suspicious research dumps, and protected exclusions without deleting or cleaning anything. With `mode: "plan"` or `mode: "apply"`, it uses the token-gated cleanup preflight and removes only internally token-bound approved hygiene findings with internal Node filesystem APIs after explicit confirmation.
  Scan output also includes scan-only `reviewableCandidates`; those entries are inventory, not cleanup findings.
- `guardian_gc`: plan or apply record-only cleanup of stale Guardian session records. Run `mode: "plan"` to inspect candidates (terminal sessions older than the safety-ref retention window, active sessions poisoned onto the primary worktree or a protected branch, active sessions whose worktree is gone, and active sessions whose worktree belongs to a different git repository than the state's `repoRoot` (`foreign-repo`)), then apply with `confirmDelete: true` and the returned `confirmToken`. It removes only JSON state records and never deletes git branches, worktrees, refs, stashes, or files.

## Slash Commands

When the TUI plugin entrypoint is enabled, Guardian registers these slash commands directly in OpenCode's command palette and slash command surface:

- `/guardian-status`
- `/guardian-project-status`
- `/guardian-done`
- `/guardian-start`
- `/guardian-finish`
- `/guardian-finish-workflow`
- `/guardian-preserve`
- `/guardian-recover`
- `/guardian-report`
- `/guardian-hud`
- `/guardian-hygiene`
- `/guardian-gc`
- `/guardian-delete-paths`
- `/guardian-delete-worktree`
- `/guardian-unblock-finish`

Each command submits a prompt to the current session telling the agent to use the matching native Guardian tool. If no session is open, the command shows a warning instead of mutating anything.

## Packaged Markdown Commands

The package also ships top-level `commands/*.md` assets for compatibility with hosts that support packaged markdown command discovery. Those hosts may register namespaced commands, for example:

- `/opencode-worktree-guardian:status`
- `/opencode-worktree-guardian:project-status`
- `/opencode-worktree-guardian:done`
- `/opencode-worktree-guardian:start`
- `/opencode-worktree-guardian:finish`
- `/opencode-worktree-guardian:finish-workflow`
- `/opencode-worktree-guardian:preserve`
- `/opencode-worktree-guardian:recover`
- `/opencode-worktree-guardian:report`
- `/opencode-worktree-guardian:hygiene`
- `/opencode-worktree-guardian:gc`
- `/opencode-worktree-guardian:delete-paths`
- `/opencode-worktree-guardian:delete-worktree`
- `/opencode-worktree-guardian:unblock-finish`

Each packaged command is a thin prompt wrapper around the matching native Guardian tool. It does not authorize raw shell cleanup, raw worktree removal, stash mutation, raw branch deletion, or bypassing `guardian_done`, `guardian_finish`, `guardian_finish_workflow`, `guardian_delete_paths`, `guardian_delete_worktree`, `guardian_hygiene`, or `guardian_unblock_finish` preflights.

Native OpenCode command discovery is separate from packaged plugin assets. User or project commands live in `~/.config/opencode/commands/*.md` or `<repo>/.opencode/commands/*.md`; OpenCode core does not automatically discover this package's internal `commands/*.md` without a loader that supports packaged plugin commands.

## Codex Skills

The Codex adapter exposes the same command-style entry points as `$guardian-*` skills because Codex plugin discovery surfaces skills rather than OpenCode slash-command registrations:

- `$guardian-status`
- `$guardian-project-status`
- `$guardian-done`
- `$guardian-start`
- `$guardian-finish`
- `$guardian-finish-workflow`
- `$guardian-preserve`
- `$guardian-recover`
- `$guardian-report`
- `$guardian-hud`
- `$guardian-hygiene`
- `$guardian-gc`
- `$guardian-delete-paths`
- `$guardian-delete-worktree`
- `$guardian-unblock-finish`

Each skill is a thin prompt wrapper around the same Codex adapter CLI and native Guardian tool policy. `$guardian-hud` maps to status/report output because Codex does not have OpenCode's TUI HUD layer.

## Safety Model

The canonical Guardian safety policy is [ADR 0001: Guardian Safety Policy](docs/adr/0001-guardian-safety-policy.md). This README summarizes the public workflow; the ADR is the authority for block, allow, route, plan/apply, confirmation, and deletion posture.

- Guardian blocks raw destructive Git and shell cleanup. Use native Guardian tools instead of hard reset, forced clean, raw worktree removal/prune, raw branch deletion, stash mutation, force push, protected-branch bypasses, or broad filesystem deletion.
- Use `guardian_start` for session worktree ownership and repair. Safe mutating Git commands can be routed into the owned worktree after Guardian records ownership; missing or invalid ownership fails closed for guarded operations.
- Use `guardian_done` for normal implementation completion. The native tool plans first, and command wrappers should continue to confirmed apply when the plan is safe and the user invoked completion. Post-finish maintenance fast-forwards the local base branch from its tracked upstream when that upstream remote is trusted. Repositories that track `gitlab/main` must add `"gitlab"` to `trustedUpstreamRemotes`; otherwise Guardian fails closed instead of using an untrusted remote as deletion or sync authority. Confirmed active-session apply commits dirty session work when `commitMessage` is explicit, lands the PR, and removes the stale worktree/local branch, while other repository states route to `guardian_finish_workflow`, the confirmed primary-main publish lane, or the current Guardian-root worktree recovery lane.
- Use `guardian_hygiene` for hygiene scan/plan/apply cleanup. Scan output is evidence only. Cleanup requires `mode: "plan"`, exact-target review, explicit confirmation, then `mode: "apply"` with `confirmDelete: true`.
  `reviewableCandidates` are scan-only inventory and are not accepted by the hygiene cleanup preflight.
- Use `guardian_delete_paths` for intentional exact file or directory deletion, including tracked source only when explicitly allowed. Worktree deletion is separate and must use `guardian_delete_worktree`.
- Use `guardian_delete_worktree` for Guardian worktree, orphan-branch, stale-branch, redundant-dirty worktree, or explicit unmerged-abandon cleanup. Run plan first, inspect blockers and safety evidence, then apply only through the native tool. Redundant dirty cleanup is direct-tool-only and requires `allowRedundantDirtyPaths: true`; high-level `guardian_done` and `guardian_finish_workflow` do not silently opt into it.
- Use `guardian_status`, `guardian_recover`, and `guardian_report_html` as read-only evidence/report surfaces. Their output can identify candidates but never authorizes deletion by itself.
- Use `guardian_unblock_finish` only for the narrow generated review-artifact finish blocker described in the ADR.

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

For redundant dirty target worktrees, pass `allowRedundantDirtyPaths: true` in both plan and apply. Plan fetches the configured remote, resolves `baseRef`/`baseRefOid`, and token-binds the per-path proof. Apply creates the normal `safetyRef`, creates `dirtySnapshotRef`, restores or removes only proof-approved paths internally, rechecks that the worktree is clean, and then performs the same non-force worktree removal. Staged changes, mixed status, renames/copies, conflicts, symlinks, directories, ignored files, unreadable paths, and non-redundant content remain blockers.

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

`guardian_hygiene` without `mode` reports workspace residue without cleanup approval:

```text
[WARN] guardian_hygiene scan
[INFO] repoRoot: /repo
[INFO] findings: 3 | warn: 2 | fail: 1 | exclusions: 1 | candidates: 8 | reviewable: 4
[WARN] top findings:
  - warn known-cleanable librarian-react: known librarian scratch artifact
  - fail nested-git test-hyperf-kafka: nested Git repository has uncommitted changes
  - warn suspicious research-dump: untracked path resembles a clone, research dump, or scratch workspace
[WARN] reviewable candidates: 4
[INFO] reviewable entries require exact-path guardian_delete_paths planning if cleanup is intended
  - ignored logs: not matched by Guardian hygiene cleanup rules
    guardian_delete_paths mode=plan paths=["logs"] allowRecursive=true
  - ignored plain.log: not matched by Guardian hygiene cleanup rules
    guardian_delete_paths mode=plan paths=["plain.log"]
[INFO] suggested commands:
  - guardian_hygiene
  - guardian_status
```

The structured scan result exposes the same split as `summary.candidateCount`, `summary.findingCount`, `summary.exclusionCount`, `summary.reviewableCandidateCount`, `summary.reviewableShownCount`, `summary.reviewableOmittedCount`, `summary.reviewableTruncated`, and `reviewableCandidates`. Reviewable entries are not cleanup findings, are not included in hygiene plan targets, and are not accepted by `guardian_hygiene` cleanup preflight. If a reviewable file should be deleted intentionally, plan exact-path deletion with `guardian_delete_paths mode=plan paths=["..."]`; for a reviewable directory, add `allowRecursive=true`.

`guardian_hygiene mode=plan|apply` uses a two-step confirmed cleanup flow for approved hygiene findings:

```text
[WARN] guardian_hygiene planned
[INFO] approvedTargets: 2 | removedTargets: 0 | blockers: 0 | fatal: 0
[INFO] approved targets:
  - known-cleanable librarian-react: known librarian scratch artifact
  - suspicious research-dump: untracked path resembles a clone, research dump, or scratch workspace
```

After explicit user confirmation, apply through the plugin with `confirmDelete: true`; no manual `confirmToken` is needed in the normal plugin flow. The plugin uses the cached internal token only when the session, repo, and cleanup options still match the plan, and treats empty or `CONFIRM_DELETE` token placeholders as absent. If any selected target disappears, gains tracked contents, changes fingerprint, resolves outside the repo, is a symlink root, or overlaps Guardian worktree/protected paths, apply blocks and requires a new plan.

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
- Workspace residue: run `guardian_hygiene`; with no `mode`, known artifacts, nested repos, suspicious paths, protected exclusions, and reviewable inventory are reported only.
  If the user explicitly approves cleanup of hygiene findings, run `guardian_hygiene` with `mode: "plan"`, inspect exact targets/blockers, get explicit delete confirmation, then apply through the plugin with `mode: "apply"` and `confirmDelete: true` for approved targets. The internal token/fingerprint gate remains enforced.
- Reviewable clutter: use the `suggestedDeletePathCommand` shown on a `reviewableCandidates` entry only as an exact-path planning handoff. Files use `guardian_delete_paths mode=plan paths=["..."]`; directories use `guardian_delete_paths mode=plan paths=["..."] allowRecursive=true`. Do not pass reviewable paths back to `guardian_hygiene` cleanup.
- Intentional file or source deletion: use `guardian_delete_paths` with exact `paths`. Add `allowTracked: true` only for intended tracked-source deletion and `allowRecursive: true` only for intended directory deletion, then apply through the plugin with `confirmDelete: true` after inspecting the plan.
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

## Release Docs

- [Changelog](CHANGELOG.md)
- [Release checklist](docs/release-checklist.md)
- [Publishing policy](docs/publishing.md)

## Dependency Audit

Last verified on 2026-06-12:

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
6. Ask OpenCode to run a known destructive reset command; confirm Guardian still blocks before mutation.

If this manual check disagrees with the deterministic smoke suite, treat the plugin as not release-ready until the discrepancy is understood.
