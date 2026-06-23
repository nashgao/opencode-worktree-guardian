---
name: guardian-delete-paths
description: Use when the user asks Guardian to delete exact files or directories through the safe path-deletion plan/apply flow.
---

# Guardian Delete Paths

Plan exact path deletion through the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_delete_paths '{"mode":"plan","paths":[...]}'
```

Inspect every approved target and blocker. Apply only after explicit delete confirmation with `mode: "apply"`, `confirmDelete: true`, and the same path options. Use `allowTracked` or `allowRecursive` only when explicitly intended.

Do not run raw filesystem deletion, forced cleanup, worktree removal, branch deletion, hard reset, forced clean, stash mutation, or protected-branch bypasses.
