# ADR 0001: Guardian Safety Policy

## Status

Accepted.

## Context

Guardian protects multi-session Git worktree workflows by routing normal work into owned worktrees and by requiring native, token-gated tools for destructive or lifecycle operations. This policy records the canonical safety contract for public Guardian surfaces.

This document is the authority for block, allow, route, plan/apply, confirmation, and deletion posture. README, skills, slash commands, packaged markdown commands, and Codex adapter docs are discoverability surfaces and must summarize or point here instead of defining a conflicting policy.

## Policy Authority And Public Surfaces

The public native tools are:

- `guardian_start`
- `guardian_status`
- `guardian_recover`
- `guardian_report_html`
- `guardian_done`
- `guardian_finish`
- `guardian_finish_workflow`
- `guardian_preserve`
- `guardian_unblock_finish`
- `guardian_delete_worktree`
- `guardian_delete_paths`
- `guardian_hygiene`
- `guardian_gc`

OpenCode slash commands and packaged `commands/*.md` wrappers are prompt surfaces only. They must instruct the agent to use the matching native tool and must not authorize raw shell cleanup, raw worktree removal, stash mutation, raw branch deletion, force-push, protected-branch bypasses, or deletion outside Guardian preflights.

The Codex adapter is also a first-class public surface. It must invoke the same Guardian tool policies through the adapter CLI and hooks, not through raw destructive Git or shell commands.

## Raw Destructive Git And Shell Blocks

Guardian blocks raw destructive shell and Git commands in `tool.execute.before`. Blocked command classes include:

- hard reset and forced clean,
- raw worktree removal or prune,
- raw `git worktree add` outside Guardian-owned roots,
- raw branch deletion,
- stash mutation,
- force push,
- destructive checkout, restore, or switch forms,
- shell-wrapped variants and context-mode code payloads,
- `rm -rf` against known Guardian worktrees.

Agents must use Guardian-native tools for lifecycle and deletion work. A prompt, slash command, skill, or adapter invocation cannot override these blocks.

## Read-Only And Normal Safe Git Allowances

Read-only inventory and recovery surfaces are allowed through `guardian_status`, `guardian_recover`, and `guardian_hygiene` without `mode`. Their output is evidence only and does not authorize cleanup.

When a session owns a valid Guardian worktree, normal safe mutating commands such as `git add` and `git commit` may proceed through Guardian routing. Without recorded ownership, normal non-destructive commands may run in the current worktree, but destructive cleanup, reset, stash, force-push, worktree-removal, and protected-branch bypass guards still apply.

## `guardian_start` Session And Worktree Ownership

Guardian owns a session worktree after the chat-system hook creates or attaches one, unless repo config disables automatic ownership with `autoStart: false`. `guardian_start` is the explicit path to create or attach ownership before the hook has run.

Ownership is proven by Guardian state or by token-bound target resolution, not by branch prefix alone. Explicit descriptive branch names are allowed when state or a token-bound target proves the exact branch/worktree binding.

If older or corrupted state records an active session on the primary repo worktree or a protected branch, `guardian_start` with `createWorktree: true` is the repair path. It creates a fresh Guardian worktree, overwrites the poisoned binding, and leaves the primary worktree untouched. Without allowed worktree creation, Guardian must block rather than return the bad binding.

## Session Routing And Mismatch Fail-Closed Rules

Guardian hooks do not move the OpenCode host process cwd. Before safe shell or Git tools run, Guardian rewrites the execution directory to the recorded worktree and then reapplies destructive-command guards.

Direct file mutation tool paths under the primary repo are rewritten into the recorded worktree when the session owns one. They are blocked when the recorded worktree cannot be validated. Missing, unresolvable, unrecorded, stale, primary-worktree, or protected-branch session bindings fail closed.

## Protected Branch Bypass Prevention

Protected branches include the configured `protectedBranches`, with defaults including `main`, `master`, `develop`, and `production`.

When config context is available, Guardian blocks manual bypasses such as pushing `HEAD` or `guardian/*` directly to a protected branch, and merging `guardian/*` while already on a protected branch. Normal Guardian work must finish through `guardian_done` or the lower-level finish tools. A command wrapper must not ask the agent to bypass this policy with raw push, merge, switch, or branch commands.

## `guardian_done` Implementation-Done Policy

`guardian_done` is the user-facing implementation-done workflow. Run `mode: "plan"` first and inspect the selected lane, preflight facts, dirty files, blockers, and confirmation posture.

The supported lanes are:

- `session-finish`: for an active recorded session, confirmed apply commits dirty session work only with an explicit `commitMessage`, pushes the branch, creates or reuses the PR, merges it, proves the session commit is reachable from `remote/baseBranch`, then removes the stale Guardian worktree and local branch. Admin bypass is never automatic and requires explicit `allowAdminBypass: true`. If the current directory is an existing Guardian-root worktree without an active recorded session, `guardian_done` may first attach a fresh internal recovery session id to that worktree and then finish it through the low-level `guardian_finish` path.
- `cleanup-only`: routes clean primary-base cleanup through `guardian_finish_workflow`.
- `primary-main-publish`: handles dirty protected primary `baseBranch` work only with an explicit `commitMessage`, explicit confirmation, and the matching internally token-bound dirty snapshot.

The current worktree path, checked-out branch, protected-branch policy, dirty-file gates, and finish preflight are the recovery proof for an existing Guardian-root worktree. The old session id is not required for recovery and must not be the only way to finish a leftover Guardian worktree.

Active-session apply must not clean up until the PR merge has completed and the session commit is proven reachable from the freshly fetched remote base ref. Primary-main apply creates a pre-commit safety ref, commits only token-bound dirty paths, pushes normally to the configured remote/base branch, fetches, proves remote reachability, and returns a separate cleanup plan. The primary-main lane must not silently apply cleanup, force-push, mutate stashes, delete remote branches, merge PRs, or treat old primary/protected session records as ownership.

In plugin flow, the internal plan token may be cached and reused only when session, repo, options, and dirty snapshot still match the plan. Blank token values and confirmation placeholders are treated as absent.

## `guardian_finish` Session Finish Policy

Use `guardian_finish` for explicit low-level Guardian worktree finishing. Prefer `guardian_done` for normal completion.

Finish always creates a safety ref before risky operations and reports preflight facts and blockers. Dirty worktrees block finish unless every dirty path matches explicit `allowDirtyPaths` config. Allowed dirty paths are reported as `allowedDirtyFiles` and left untouched. Guardian must not delete, stash, revert, stage, or commit allowed dirty files.

If no active session owns the current checked-out worktree, `guardian_finish` may attach a fresh internal recovery session id when the current worktree is inside the configured Guardian worktree root, is not the primary repo worktree, is not detached, and is not on a protected branch. If a stale or terminal session id is present, that old session id is metadata only; it must not make an otherwise recoverable Guardian worktree unusable.

`create-pr` pushes the session branch and suggests a PR command; it does not create a PR natively. `merge-to-base` requires explicit approval via `allowMergeToBase: true`. Under that approval it may self-heal a clean primary repo worktree that is on the wrong branch: it creates safety refs for the primary worktree's original HEAD and the local base branch head, then repositions the primary worktree onto the base branch with a non-overwriting checkout before the fast-forward merge. A dirty primary worktree fails closed unless `allowBaseWorktreePreserveReset` is explicitly enabled per call or in repo config; under that opt-in Guardian snapshots the primary worktree's blocking dirt — including untracked files that `git stash create` would drop — into a recoverable safety ref, then resets only those paths clean with a path-scoped reset and clean that never removes the Guardian session worktrees living under the worktree root, before repositioning and merging. Guardian still never auto-creates a missing local base branch and never checks out the base branch while it is checked out in another worktree; those cases, plus any failed snapshot, incomplete clean, non-fast-forward merge, push failure, or remote-proof failure, fail closed with safety refs recorded. Cleanup can run only when `autoCleanup` or `allowCleanup` is enabled and ancestry is proven.

## `guardian_finish_workflow` Cleanup Policy

Use `guardian_finish_workflow` only after implementation is already committed, pushed, merged to the configured base, and synced locally.

Run `mode: "plan"` first. The workflow verifies the primary worktree is clean, stash policy is satisfied, the configured remote can be fetched, and redundant cleanup candidates are already merged to the freshly resolved `remote/baseBranch` commit. It discovers Guardian-root worktrees and non-protected, checked-out-nowhere local branches whose heads are ancestors of that base commit. At most 25 cleanup candidates can be applied from one plan.

Run `mode: "apply"` only with the returned token after explicit confirmation. The token binds the resolved base commit and cleanup targets. Apply re-plans each target and delegates deletion to `guardian_delete_worktree`. It must not create commits, choose commit messages, merge protected branches, mutate stashes, force-delete branches, or run raw filesystem/Git cleanup. Any blocker fails closed and apply deletes nothing until a fresh plan has no blockers.

## `guardian_preserve` Policy

`guardian_preserve` marks the current Guardian worktree terminal/preserved and creates a preserved ref. It does not delete, clean, reset, stash, push, or merge. If no active session owns the current Guardian-root worktree, it may attach a fresh internal recovery session id first.

Preservation is not a permanent retention instruction. Preserved worktrees remain cleanup-eligible through `guardian_delete_worktree` once that tool proves deletion is safe.

## `guardian_unblock_finish` Policy

Use `guardian_unblock_finish` only when `guardian_finish` is blocked by narrow generated review-rating artifacts. It is not a broad cleanup or source-change commit tool.

Run `mode: "plan"` first. The supported action is `commit-review-artifacts`, which may commit only `.milestones/reviews/*impl-rating-YYYYMMDD.md` or `.milestones/reviews/*impl-rating-YYYYMMDD.txt` review artifacts. If Guardian state does not record the session, plan may resolve the current Guardian-root worktree or receive an explicit `branch` or `worktreePath` that resolves exactly one checked-out worktree under the configured Guardian worktree root.

Run `mode: "apply"` only with the fresh token and the same resolved current worktree, explicit branch, or explicit worktree path when state is still missing. Apply creates a safety ref, stages only approved review artifacts, commits them, and updates Guardian state. It refuses mixed dirty/source paths, renames/copies, symlink artifacts, deletions, ignored files, stashes, and cleanup.

## `guardian_delete_worktree` Worktree Deletion Policy

Use `guardian_delete_worktree` for stale, preserved, finished, orphaned, or explicitly abandoned Guardian worktree cleanup. Raw `git worktree remove`, `git worktree prune`, raw branch deletion, and filesystem deletion are forbidden substitutes.

Run `mode: "plan"` first. It resolves exactly one target by `targetPath`, `sessionId`, or `branch`, runs preflight checks, and returns a confirm token. Run `mode: "apply"` only with that token and the same options after explicit confirmation.

Apply recomputes the token from the normalized repo root, target kind, target path, worktree-listed state, branch or detached marker, HEAD, session identity/status, `deleteBranch`, `abandonUnmerged`, ancestry evidence, unmerged commits, and `allowIgnoredFiles`. Stale or missing tokens block.

Apply refuses primary repo worktree deletion, current execution worktree deletion, dirty or untracked targets, protected-branch worktrees even when `deleteBranch` is false, detached HEADs, ignored files unless `allowIgnoredFiles: true` is present in both plan and apply, and repo stashes unless `allowStashIfUnrelated` is enabled. Passing the primary repo as `targetPath` remains blocked.

Apply creates a safety ref before non-force `git worktree remove <path>`. Branch deletion is opt-in with `deleteBranch: true`; by default it requires ancestry proof and uses non-force `git branch -d`.

## `guardian_delete_worktree` Orphan And Stale-Branch Policy

If a recorded Guardian session's worktree path is absent from `git worktree list`, or state points at the primary repo path while the recorded Guardian branch is checked out nowhere, `guardian_delete_worktree` can perform branch-only orphan cleanup with `deleteBranch: true`. It deletes no filesystem path, does not allow primary repo worktree deletion, verifies the branch exists, verifies it is checked out nowhere, verifies it is not protected, creates a safety ref, and uses non-force branch deletion after ancestry and checkout checks pass.

If a local Guardian branch remains after its worktree and active state are gone, pass the exact `branch` or terminal `sessionId` with `deleteBranch: true` for stale-branch cleanup. Terminal states include `deleted`, `abandoned`, `finished`, and `preserved`. This branch-only path is allowed only when terminal Guardian state or matching `refs/opencode-guardian` safety refs prove ownership. Branch prefixes alone are not ownership proof.

## `guardian_delete_worktree` Unmerged Abandon Policy

Intentional unmerged local abandonment requires `deleteBranch: true` and `abandonUnmerged: true` in both plan and apply. Plan reports ancestry evidence, the base ref, and unmerged commits that remain recoverable from the safety ref.

Apply creates the safety ref first, then removes the clean Guardian worktree and deletes the local branch, recording the session as `abandoned`. This lane does not relax primary/current worktree, dirty-target, protected-branch, checked-out orphan branch, stale-token, stash, ignored-file, or missing-safety-ref blockers.

## `guardian_delete_paths` Exact Path Deletion Policy

Use `guardian_delete_paths` when the user intentionally wants to delete exact files or directories that are not Guardian hygiene findings, including source files.

Run `mode: "plan"` first with explicit `paths`. The plan reports each path's repo-relative path, absolute path, kind, tracked/ignored/untracked status, tracked contents, and blockers. Apply only after explicit confirmation with `mode: "apply"` and `confirmDelete: true`; low-level direct calls also require the matching `confirmToken`.

Tracked source deletion requires `allowTracked: true`. Directory deletion requires `allowRecursive: true`. Worktree deletion must use `guardian_delete_worktree`, not `guardian_delete_paths`.

The tool blocks paths outside the repo, the repo root, `.git`, `.opencode`, dependency roots such as `node_modules` and `vendor`, configured or registered Guardian worktree roots, the current worktree root, missing paths, symlink roots, overlapping selections, tracked contents without `allowTracked: true`, and directories without `allowRecursive: true`.

Apply re-runs the same fingerprinted preflight immediately before deletion, deletes files with internal Node `fs` APIs, and does not stage changes. Tracked deletions remain visible in `git status` for review and commit.

## `guardian_hygiene` Scan Policy

`guardian_hygiene` without `mode` is report-only. It detects untracked or ignored scratch artifacts, nested Git repositories, suspicious research dumps, generated cache roots, protected exclusions, and scan-only `reviewableCandidates`. Scan output does not authorize deletion.

`reviewableCandidates` are the untracked or ignored candidate roots Guardian saw but did not classify as cleanup findings or protected exclusions. They are inventory for human review, not `findings`, not hygiene cleanup targets, and not accepted by the `guardian_hygiene` cleanup preflight. They do not increment finding, severity, category, risk, or approved-target counts.

The hygiene scan summary reports `candidateCount`, `findingCount`, `exclusionCount`, `reviewableCandidateCount`, `reviewableShownCount`, `reviewableOmittedCount`, and `reviewableTruncated`. Readable scan output must keep reviewable entries separate from findings, for example:

```text
[WARN] guardian_hygiene scan
[INFO] findings: 3 | warn: 2 | fail: 1 | exclusions: 1 | candidates: 8 | reviewable: 4
[WARN] top findings:
  - warn known-cleanable librarian-react: known librarian scratch artifact
  - fail nested-git test-hyperf-kafka: nested Git repository has uncommitted changes
[WARN] reviewable candidates: 4
[INFO] reviewable entries require exact-path guardian_delete_paths planning if cleanup is intended
  - ignored logs: not matched by Guardian hygiene cleanup rules
    guardian_delete_paths mode=plan paths=["logs"] allowRecursive=true
  - ignored plain.log: not matched by Guardian hygiene cleanup rules
    guardian_delete_paths mode=plan paths=["plain.log"]
```

If cleanup is intended for a reviewable file, the handoff is exact-path planning with `guardian_delete_paths mode=plan paths=["..."]`. If cleanup is intended for a reviewable directory, use `guardian_delete_paths mode=plan paths=["..."] allowRecursive=true`. Protected exclusions must not receive suggested delete-path templates.

`guardian_status`, `guardian_recover`, and `guardian_hygiene` scan output are evidence-only surfaces. Research clones, downloaded upstream repos, generated fixtures, and temporary test data should live outside the active project tree, preferably under OS temp space such as `$TMPDIR/opencode/<repo>/<session>/`.

## `guardian_hygiene` Plan/Apply Cleanup Policy

`guardian_hygiene` is the single hygiene scan/plan/apply surface. Use `mode: "plan"` before cleanup; inspect exact approved targets, blockers, and summary; then get explicit user confirmation. Apply with `mode: "apply"` and `confirmDelete: true` using the same cleanup options.

Default cleanup includes current hygiene finding categories: known scratch artifacts, clean nested Git repositories, suspicious residue roots, generated `node-compile-cache/`, `node-coverage-*`, and `tsx-<digits>/` cache roots. Dirty `nested-git` findings require explicit `allowDirtyNestedGit: true`.

The plugin tool flow caches the plan token only for matching session, repo, and options. Empty token values and `CONFIRM_DELETE` placeholders are treated as absent; the cached token may be injected only when the plan matches. Low-level direct calls to `guardianHygiene` still require the matching `confirmToken`.

Apply re-runs preflight and removes only token-bound approved paths using internal Node `fs` APIs. It never suggests or shells out to broad cleanup commands. Cleanup blocks tracked files, protected directories, configured or registered Guardian worktrees, paths outside the repo root, `.git`, symlink cleanup roots, missing selected paths, stale fingerprints, and selected roots with unexpected tracked contents.

## `guardian_gc` State Record Cleanup Policy

`guardian_gc` prunes stale Guardian session records from state. It is record-only: it removes JSON session entries and never deletes git branches, worktrees, refs, stashes, or files. Nothing reachable becomes unreachable, so recovery refs and reflog remain available.

Run `mode: "plan"` first. Candidates are terminal sessions older than `safetyRefRetentionDays`, active sessions bound to the primary worktree or a protected branch (which validate and status already treat as poisoned), and active sessions whose worktree is absent from disk and from `git worktree list`. Healthy active sessions are never candidates. Apply with `mode: "apply"`, `confirmDelete: true`, and the returned `confirmToken`; the token binds the exact candidate set, and a changed set fails closed.

## Stale Tokens, Fingerprints, And Safety Ref Posture

Plan output is evidence, not approval. Apply must bind to the current preflight state through a fresh confirm token, cached internal token, or fingerprint appropriate to that tool surface.

Tokens and fingerprints must cover the target identity and safety-relevant options. Apply must re-run preflight and block when token data is stale, missing, mismatched, or derived from a different repo, session, dirty snapshot, base commit, path list, target, or cleanup option set.

Safety refs are required before risky finish, preserve, deletion, orphan cleanup, stale-branch cleanup, explicit unmerged abandon, and finish-unblock operations. Safety refs are recovery evidence; they do not authorize raw cleanup or bypass plan/apply gates.

## Codex Adapter Hook Policy

The Codex adapter must route Guardian workflows through `codex/hooks/guardian-hook.ts` in this source repository, or through `node_modules/opencode-worktree-guardian/codex/hooks/guardian-hook.ts` after package install. Codex plugin hooks invoke the same adapter from `hooks/hooks.json`.

For `guardian done`, `guardian_hygiene`, `guardian_delete_paths`, and `guardian_finish_workflow`, Codex usage must run plan first and apply only after explicit user confirmation with the same options. The adapter may reuse matching cached internal plan tokens and must not ask users to copy internal confirm tokens.

The Codex adapter must never replace Guardian workflows with raw `git reset --hard`, `git clean -fd`, `git worktree remove`, `git worktree prune`, `git branch -D`, `git stash drop`, `git stash clear`, force-push, broad filesystem deletion, or protected-branch bypass commands.

## Legacy Alias Deprecation And Removal Policy

Legacy command or tool aliases that overlap a current safety surface must be removed only as an intentional public-surface change. Removal must update native tool registries, slash command rewrites, TUI commands, packaged markdown commands, README, skills, package smoke expectations, and contract tests.

Removed aliases must not remain documented as active commands. Historical notes may mention them only as removed or deprecated legacy surfaces. The current hygiene cleanup authority is `guardian_hygiene` with scan, plan, and apply modes; there is no separate active hygiene cleanup alias.
