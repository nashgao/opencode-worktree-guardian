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

Configured protected untracked or ignored regular files require one absolute external `archivePath` and its exact lowercase `archiveSha256`. The plan must show a matching archive proof for every selected file. This never authorizes tracked source, Git metadata, dependencies, worktree roots, symlink roots, protected directories, duplicate members, hardlinks, or special archive types.

Do not run raw filesystem deletion, forced cleanup, worktree removal, branch deletion, hard reset, forced clean, stash mutation, or protected-branch bypasses.
