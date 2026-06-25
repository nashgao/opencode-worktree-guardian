---
description: Plan or apply the safest Guardian implementation-done path
argument-hint: [mode=plan|apply] [all=true] [commitMessage=...] [confirm=true]
---

Use the `guardian_done` native tool for the implementation-done workflow. Run `mode=plan` first and inspect the selected lane, preflight facts, dirty files, and blockers.

If the lane is `session-finish`, let `guardian_done` handle the whole session lifecycle. Active-session apply first checks whether the session commit is already reachable from the configured remote base; if it is, Guardian skips PR creation and performs token-gated stale worktree/local-branch cleanup. Otherwise it pushes, creates or reuses the PR, merges, proves remote-base reachability, and then cleans through Guardian gates. Do not manually push, merge, clean, or remove worktrees.

If `all=true` selects the `done-all` lane, run `mode=plan` first, inspect the readable `confirmToken`, summary, finishable sessions, and dirty/protected skipped sessions, then apply only with `confirm: true` and the fresh token. Batch apply is clean-only: it lands or already-landed-cleans each finishable session sequentially with per-session failure isolation, reports failed reasons, and leaves dirty/protected sessions for individual `guardian_done branch=<branch> commitMessage=...` handling.

If the current directory is an existing Guardian-root worktree without an active recorded session, `guardian_done` may reattach it with a fresh internal recovery session id and then use the normal `session-finish` lane. The worktree path, checked-out branch, protected-branch policy, dirty-file gates, and finish preflight are the safety proof; callers do not need to know or recover the old session id.

If the lane is `primary-main-publish`, apply only after explicit user confirmation with the same explicit `commitMessage` and `confirm: true`; the plugin reuses the matching internal plan token when the plan is still fresh. The tool creates a safety ref before committing, pushes normally, proves the new commit is reachable from the configured remote base branch, then returns a separate cleanup plan. Do not silently apply that cleanup plan.

If the lane is `cleanup-only`, apply only after explicit confirmation with `confirm: true`; cleanup still uses the internal workflow token from the matching plan. Cleanup still runs through `guardian_finish_workflow` and `guardian_delete_worktree`.

Never force-push, mutate stashes, delete remote branches, run raw worktree removal, run raw branch deletion, or bypass Guardian preflights. Full policy: `docs/adr/0001-guardian-safety-policy.md`.
