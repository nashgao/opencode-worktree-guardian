---
description: Plan or apply the safest Guardian implementation-done path
argument-hint: [mode=plan|apply] [commitMessage=...] [confirmToken=...]
---

Use the `guardian_done` native tool for the implementation-done workflow. Run `mode=plan` first and inspect the selected lane, preflight facts, dirty files, blockers, and `confirmToken`.

If the lane is `session-finish`, let `guardian_done` delegate to `guardian_finish`; do not manually push, merge, clean, or remove worktrees.

If the lane is `primary-main-publish`, apply only with the same explicit `commitMessage` and fresh `confirmToken`. The tool creates a safety ref before committing, pushes normally, proves the new commit is reachable from the configured remote base branch, then returns a separate cleanup plan. Do not silently apply that cleanup plan.

If the lane is `cleanup-only`, apply only with the returned cleanup token after explicit confirmation. Cleanup still runs through `guardian_finish_workflow` and `guardian_delete_worktree`.

Never force-push, mutate stashes, delete remote branches, run raw worktree removal, run raw branch deletion, or bypass Guardian preflights.
