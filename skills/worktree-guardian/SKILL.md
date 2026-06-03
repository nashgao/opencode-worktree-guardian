# Worktree Guardian

Use the native guardian tools for worktree inspection and completion. The skill is guidance only; the plugin hooks enforce safety.

## Packaged command surface

- Hosts with packaged plugin command discovery, such as `oh-my-openagent`, can expose this package's top-level `commands/*.md` files as namespaced commands like `/opencode-worktree-guardian:status`, `/opencode-worktree-guardian:hygiene`, `/opencode-worktree-guardian:hygiene-cleanup`, and `/opencode-worktree-guardian:delete-worktree`.
- Treat those slash commands as prompt wrappers only. The native `guardian_*` tools remain the authority for safety checks and mutation gates.
- Native OpenCode user/project commands are separate files under `~/.config/opencode/commands/*.md` or `<repo>/.opencode/commands/*.md`.

## Rules

- Do not run raw cleanup, reset, stash mutation, force-push, worktree removal, raw `git worktree add` outside Guardian-owned roots, or `rm -rf` against worktrees. Use `guardian_start` for session worktree creation.
- Use `guardian_status` for read-only inventory.
- Use `guardian_hygiene` when the user asks about unowned scratch, research clones, nested repos, or workspace residue. It is report-only and must not be treated as cleanup approval.
- Use `guardian_hygiene_cleanup` only when the user explicitly wants cleanup of hygiene findings. First run `mode: "plan"`; inspect exact approved targets and blockers, get explicit user confirmation, then run `mode: "apply"` with `confirmDelete: true`. Defaults clean only `known-cleanable` findings, including generated `node-compile-cache/`, `node-coverage-*`, and `tsx-<digits>/` cache roots; dirty `nested-git` is always blocked.
- Use `guardian_report_html` or `/guardian report` when the user wants a browser-readable branch/worktree/session report. It writes a static offline file at `.git/opencode-guardian/report.html` and returns the exact path.
- Use `guardian_delete_worktree` only when the user explicitly wants a Guardian-mediated worktree deleted. First run `mode: "plan"`; only run `mode: "apply"` with the returned `confirmToken` after checking blockers.
- Use `guardian_unblock_finish` when `guardian_finish` is blocked by narrow generated review artifacts. First run `mode: "plan"`; only run `mode: "apply"` with the returned `confirmToken` after verifying the plan contains only `.milestones/reviews/*impl-rating-YYYYMMDD.md` or `.milestones/reviews/*impl-rating-YYYYMMDD.txt` artifacts. Descriptive branch names are allowed when state proves the session owns the exact branch/worktree binding. If state does not record the session, pass the same explicit `branch` or `worktreePath` during plan and apply; the target must be under the configured Guardian worktree root.
- Use `guardian_finish` for gated completion.
- Use `guardian_preserve` when work should intentionally remain available.
- Use `guardian_recover` for safety refs, orphaned sessions, stash inventory, reflog, and recovery suggestions.
- For mutating commands such as `git add` or `git commit`, rely on Guardian routing after the default auto-start hook or explicit `guardian_start` records a session worktree. Repo config `autoStart=false` disables automatic ownership; without recorded ownership, normal non-destructive commands run in the current worktree.
- If Guardian state records the current session on the primary repo worktree or a protected branch, use `guardian_start` with `createWorktree: true` to repair the session into a proper Guardian worktree. Do not use raw `git switch`, raw branch creation, or protected-branch bypass commands to escape the poisoned binding.
- If the plugin blocks a command, report the blocker, preserved path, branch, safety refs, and suggested guardian tool.

## Defaults

- `finishMode`: `create-pr`
- `branchPrefix`: default branch naming only, not ownership proof
- `autoStart`: enabled by default; repo config `autoStart=false` opts out of automatic ownership
- `autoFinish`: disabled unless repo config opts in
- `autoCleanup`: disabled unless repo config opts in
- stash mutation is never cleanup
- workspace hygiene scanning is report-only; no artifact deletion is implied from `guardian_hygiene`
- hygiene cleanup is separate, internally token-gated, exact-target only, and never uses raw shell cleanup
- worktree deletion is never automatic from `guardian_status`, `guardian_recover`, or `guardian_hygiene`
- finish unblocking is never broad cleanup; `commit-review-artifacts` commits only matching review-rating artifacts and refuses mixed dirty/source paths, source-to-review renames/copies, and symlink artifacts

## Scratch posture

- Put research clones, downloaded upstream repos, generated fixtures, and temporary test data outside the active project tree, preferably under OS temp space such as `$TMPDIR/opencode/<repo>/<session>/`.
- If scratch inside a repo is explicitly required, use a configured scratch root and keep it clearly session-scoped.
- Treat `guardian_hygiene` findings as evidence to report. If cleanup is approved, use `guardian_hygiene_cleanup` plan, inspect targets/blockers, get explicit confirmation, then apply with `confirmDelete: true` rather than raw cleanup or `guardian_delete_worktree`.
- Treat `external-temp-worktree` and `external-worktree` findings in `guardian_status`/`guardian_recover` as report-only evidence, not cleanup approval.

## Delete posture

- Never run raw `git worktree remove`, `git worktree prune`, `rm -rf`, or raw branch deletion. The hooks intentionally block those commands.
- `guardian_delete_worktree` resolves a target by `targetPath`, `sessionId`, or `branch` and refuses primary/current worktrees for worktree deletion, dirty or untracked targets, protected-branch worktrees even when `deleteBranch` is false, detached HEADs, stale tokens, ignored files unless `allowIgnoredFiles: true` is present in both plan and apply, and repo stashes unless config allows unrelated stashes. Passing the primary repo as `targetPath` remains blocked.
- Apply mode creates a safety ref before non-force `git worktree remove <path>`.
- If a recorded Guardian session's worktree is already absent from `git worktree list`, or recorded state points at the primary repo path while the stale Guardian branch is checked out nowhere, use `guardian_delete_worktree` with `deleteBranch: true` for branch-only orphan cleanup. It still requires plan/apply, creates a safety ref, verifies ancestry, refuses protected or checked-out branches, removes no filesystem path, and does not allow primary repo worktree deletion.
- If a local Guardian branch remains after its worktree and active state are gone, pass the exact `branch` or terminal deleted/abandoned `sessionId` with `deleteBranch: true` for stale-branch cleanup. Guardian only plans this when terminal Guardian state or matching `refs/opencode-guardian` safety refs prove ownership; branch prefixes alone are not ownership proof.
- `allowIgnoredFiles` is for deleting a whole stale worktree that contains ignored local residue such as `.claude/` or `data/`; it is not a general hygiene cleanup approval.
- `deleteBranch` defaults to `false`; with `true`, Guardian normally requires ancestry proof and uses non-force `git branch -d`.
- Use `abandonUnmerged: true` only when the user explicitly intends to abandon unmerged local Guardian work. It must be present with `deleteBranch: true` in both plan and apply, and the plan's unmerged commits must be inspected before applying. Guardian creates a safety ref before deleting the local branch and records the session as `abandoned`; do not replace this with raw branch deletion.
- `guardian_status`, `guardian_recover`, and `guardian_hygiene` are evidence-only. Their output can identify candidates, but it is not approval to delete. `guardian_hygiene_cleanup` is the only native hygiene artifact cleanup path, and apply removes only internally token-bound approved paths. The plugin caches the plan token for matching session/repo/options when applying with `confirmDelete: true`; low-level direct calls still require the matching token.

## Recovery posture

Recovery is read-only by default. Creating recovery branches requires explicit user approval.

## Finish-unblock posture

- Never loosen `guardian_finish` dirty-worktree safety to force progress.
- `guardian_finish` may tolerate dirty runtime/local-state files only when every dirty path matches explicit repo config `allowDirtyPaths`. File-specific patterns match untracked runtime files, so prefer narrow entries like `.claude/logs/hooks.log` over broad directory allowlists unless the whole directory is intentionally allowed. Allowed dirty files are reported and left untouched; Guardian must not delete, stash, revert, stage, or commit them.
- Treat any non-matching dirty source, config, doc, or policy file as a blocker even when some runtime dirt is allowed.
- Prefer `guardian_unblock_finish` for the narrow case where review-rating artifacts are the only blocker.
- Treat plan output as evidence, not approval. Apply requires an explicit fresh confirm token for the exact current preflight.
- Do not use the unblocker for source changes, deletions, ignored files, stashes, or cleanup.
