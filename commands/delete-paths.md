---
description: Plan or apply exact Guardian-mediated path deletion
argument-hint: [paths...]
---

Use the native `guardian_delete_paths` tool for exact file or directory deletion.

Run `mode: "plan"` first with the exact `paths` to delete. Inspect every approved target and blocker, then apply only after explicit user confirmation with `mode: "apply"` and `confirmDelete: true`.

Tracked source deletion requires `allowTracked: true`. Directory deletion requires `allowRecursive: true`. Worktree deletion must use `guardian_delete_worktree`.

Do not run raw filesystem deletion, forced cleanup, worktree removal, branch deletion, hard reset, forced clean, or stash mutation from this command.
