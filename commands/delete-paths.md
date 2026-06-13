---
description: Plan or apply exact Guardian-mediated path deletion
argument-hint: [paths...]
---

Use the native `guardian_delete_paths` tool for exact file or directory deletion.

Run `mode: "plan"` first with the exact `paths` to delete. Inspect every approved target and blocker, then apply only after explicit user confirmation with `mode: "apply"` and `confirmDelete: true`.

When this command is reached from a hygiene `reviewableCandidates` entry, treat the shown command as a plan-only exact-path handoff. Files use `guardian_delete_paths mode=plan paths=["..."]`; directories require `guardian_delete_paths mode=plan paths=["..."] allowRecursive=true`. Reviewable candidates are not hygiene cleanup findings and must not be sent back to `guardian_hygiene` cleanup preflight.

Tracked source deletion requires `allowTracked: true`. Directory deletion requires `allowRecursive: true`. Worktree deletion must use `guardian_delete_worktree`.

Do not run raw filesystem deletion, forced cleanup, worktree removal, branch deletion, hard reset, forced clean, stash mutation, or protected-branch bypasses from this command. Full policy: `docs/adr/0001-guardian-safety-policy.md`.
