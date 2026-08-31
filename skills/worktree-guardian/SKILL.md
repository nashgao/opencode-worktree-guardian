# Worktree Guardian

Use the native guardian tools for worktree inspection and completion. The skill is guidance only; the plugin hooks enforce safety.

Canonical safety policy: [ADR 0001: Guardian Safety Policy](../../docs/adr/0001-guardian-safety-policy.md).

## Packaged command surface

- Hosts with packaged plugin command discovery, such as `oh-my-openagent`, can expose this package's top-level `commands/*.md` files as namespaced commands like `/opencode-worktree-guardian:status`, `/opencode-worktree-guardian:goal`, `/opencode-worktree-guardian:hygiene`, `/opencode-worktree-guardian:delete-paths`, and `/opencode-worktree-guardian:delete-worktree`.
- Treat those slash commands as prompt wrappers only. The native `guardian_*` tools remain the authority for safety checks and mutation gates.
- Native OpenCode user/project commands are separate files under `~/.config/opencode/commands/*.md` or `<repo>/.opencode/commands/*.md`.

## Rules

- Do not run raw cleanup, reset, stash mutation, force-push, worktree removal, raw `git worktree add` outside Guardian-owned roots, raw branch deletion, or `rm -rf` against worktrees. Use the matching native Guardian tool.
- Use `guardian_status` for read-only inventory within its bounded operational scope, not as a repository-wide cleanliness claim. Additional remotes are names-only unscanned secondary remotes unless native metadata selects an effective authority.
- Use `guardian_project_status` for read-only project intelligence evidence from roadmap, milestone review, `.omo/plans`, and `.omo/ulw-loop` artifacts. It does not establish ownership or approval to mutate. Only pass `writeReport: true` when the user explicitly asks for the static project report.
- Use `guardian_done` for normal implementation completion. It inventories dirty implementation targets across the primary worktree and active Guardian sessions before choosing a lane, so it can be run from any cwd. Bare `guardian_done` auto-selects exactly one dirty target; multiple dirty targets return `needs-selection` with exact `primary=true`, `sessionId=...`, or `branch=...` follow-up options. With no dirty targets, clean primary with active sessions plans the repo-wide done-all lane; after confirmation it lands finishable sessions, syncs local base when safe, and applies safe redundant cleanup from the same clean no-blocker plan while reporting dirty or protected leftovers. Prefer it over raw protected-branch push/merge commands or low-level finish tools unless the user explicitly asks for those tools.
- Use `guardian_goal` when the user wants the configured desired repo state in one command. The strict default targets the selected session worktree, applies safe token-bound `known-cleanable` and verified empty-directory cleanup, then compares the current index with the immutable recorded session-start commit before delegating commit/land/push/worktree/branch cleanup. Run `mode: "plan"` first and inspect `trackedBaseline`, `complete`, `hygienePostcondition`, and exact reviewables. Pass legitimate current regular newly added files through exact `intentionalPaths` in both plan and apply; this one-shot list is token-bound and never becomes persistent policy or deletion authority. Baseline tracked files cannot be acknowledged, and `protectedPaths` do not hide tracked additions. Strict residue blocks the completion child before commit/push. Explicit legacy completion modes remain available.
- Use `guardian_hygiene` for hygiene scan/plan/apply cleanup. With no `mode`, it scans only. For cleanup, first run `mode: "plan"`; inspect exact approved targets and blockers, get explicit user confirmation, then run `mode: "apply"` with `confirmDelete: true`.
- Use `guardian_delete_paths` when the user intentionally wants exact files or directories deleted, including tracked source only with explicit `allowTracked: true`. Worktree deletion must use `guardian_delete_worktree`.
- Use `guardian_report_html` or `/guardian report` when the user wants a browser-readable branch/worktree/session report. It writes a static offline file at `.git/opencode-guardian/report.html` and returns the exact path.
- Use `guardian_delete_worktree` only when the user explicitly wants Guardian-mediated worktree, orphan-branch, stale-branch, or unmerged-abandon cleanup. First run `mode: "plan"`; only run `mode: "apply"` with the returned `confirmToken` after checking blockers and confirming intent.
- Use `guardian_unblock_finish` only when `guardian_finish` is blocked by narrow generated review artifacts. First run `mode: "plan"`; only apply after explicit confirmation with the returned `confirmToken` and the same target options.
- Use `guardian_finish` for explicit low-level gated completion.
- Use `guardian_preserve` only to create a safety ref and mark a session terminal/preserved. Preserved worktrees are cleanup-eligible; do not treat preservation as a reason to keep disk state forever.
- Use `guardian_recover` for safety refs, orphaned sessions, stash inventory, reflog, and recovery suggestions. Terminal reattach and stale cleanup are plan-only handoffs: native pending-to-active proof and absent empty-lease reconciliation are evidence, never authorization to mutate.
- Treat repository stash inventory as advisory by default. Guardian reports it and never mutates it; only repo config `requireEmptyStashInventory: true` makes it a finish, goal, or cleanup blocker.
- For mutating commands such as `git add` or `git commit`, rely on Guardian routing after the default auto-start hook or explicit `guardian_start` records a session worktree. Repo config `autoStart=false` disables automatic ownership; without recorded ownership, normal non-destructive commands run in the current worktree.
- If Guardian state records the current session on the primary repo worktree or a protected branch, use `guardian_start` with `createWorktree: true` to repair the session into a proper Guardian worktree. Do not use raw `git switch`, raw branch creation, or protected-branch bypass commands to escape the poisoned binding.
- If the plugin blocks a command, report the blocker, preserved path, branch, safety refs, and suggested guardian tool.

## Defaults

- `finishMode`: `create-pr`
- `pullRequestMergeMethod`: `merge`; linear-history repositories may opt into `squash`, which remains bound to exact parent/tree landing proof
- `branchPrefix`: default branch naming only, not ownership proof
- `autoStart`: enabled by default; repo config `autoStart=false` opts out of automatic ownership
- `autoFinish`: disabled unless repo config opts in
- `autoCleanup`: disabled unless repo config opts in
- `goal.hygieneCompletion`: `no-unprotected-residue` by default. Guardian cleans token-bound `known-cleanable` findings and filesystem-verified empty directories, then blocks delivery on remaining findings, unacknowledged tracked or untracked additions, other reviewables, or incomplete coverage. Exact `intentionalPaths` acknowledge legitimate regular newly added files for one token-bound goal call.
- Explicit `authorized-cleanup` and `no-unprotected-findings` retain their legacy completion semantics. No mode broadens deletion authority.
- stash inventory is advisory by default; stash mutation is never cleanup
- workspace hygiene scan mode is report-only; cleanup requires `guardian_hygiene mode=plan`, exact-target review, explicit confirmation, and `mode=apply confirmDelete=true`
- `guardian_delete_paths` is the exact intentional path deletion surface
- `guardian_delete_worktree` is the only worktree deletion surface
- read-only scan/report surfaces are evidence, not approval to mutate

## Scratch posture

- Put research clones, downloaded upstream repos, generated fixtures, and temporary test data outside the active project tree, preferably under OS temp space such as `$TMPDIR/opencode/<repo>/<session>/`.
- If scratch inside a repo is explicitly required, use a configured scratch root and keep it clearly session-scoped.
- Treat `guardian_hygiene` scan findings as evidence to report. If cleanup is approved, use `guardian_hygiene mode=plan`, inspect targets/blockers, get explicit confirmation, then apply with `confirmDelete: true`.
- Treat `external-temp-worktree` and `external-worktree` findings in `guardian_status`/`guardian_recover` as report-only evidence, not cleanup approval.

## Delete posture

- Never run raw `git worktree remove`, `git worktree prune`, `rm -rf`, or raw branch deletion. The hooks classify guarded forms: audit mode records and allows them, while strict mode blocks them.
- Use `guardian_hygiene` for hygiene findings, `guardian_delete_paths` for exact file or directory deletion, and `guardian_delete_worktree` for Guardian worktree/branch cleanup.
- `guardian_delete_worktree` requires plan/apply and explicit confirmation. Branch deletion is opt-in with `deleteBranch: true`; unmerged abandonment additionally requires `abandonUnmerged: true` in both plan and apply.
- `guardian_status`, `guardian_recover`, and `guardian_hygiene` scan output are evidence-only. Their output can identify candidates, but it is not approval to delete.

## Recovery posture

Recovery is read-only by default. Creating recovery branches requires explicit user approval.

If native metadata reports advanced state-only retirement, preserve the branch/proof or report pending proof absent. Do not sync, postflight, or delete; obtain a fresh plan before a separate tool acts.

## Finish-unblock posture

- Never loosen `guardian_finish` dirty-worktree safety to force progress.
- `guardian_finish` may tolerate dirty runtime/local-state files only when every dirty path matches explicit repo config `allowDirtyPaths`. File-specific patterns match untracked runtime files, so prefer narrow entries like `.claude/logs/hooks.log` over broad directory allowlists unless the whole directory is intentionally allowed. Allowed dirty files are reported and left untouched; Guardian must not delete, stash, revert, stage, or commit them.
- Treat any non-matching dirty source, config, doc, or policy file as a blocker even when some runtime dirt is allowed.
- Prefer `guardian_unblock_finish` for the narrow case where review-rating artifacts are the only blocker.
- Treat plan output as evidence, not approval. Apply requires an explicit fresh confirm token for the exact current preflight.
- Do not use the unblocker for source changes, deletions, ignored files, stashes, or cleanup.

## Release references

- Release checklist: [docs/release-checklist.md](../../docs/release-checklist.md)
- Publishing policy: [docs/publishing.md](../../docs/publishing.md)
