---
name: guardian-delete-worktree
description: Use when the user asks Guardian to delete a worktree, orphan branch, stale branch, or explicitly abandon unmerged Guardian work.
---

# Guardian Delete Worktree

Plan explicit worktree deletion through the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_delete_worktree '{"mode":"plan"}'
```

Include an exact `targetPath`, `sessionId`, or `branch` when the user provided one. Inspect blockers, ignored files, target identity, branch, HEAD, and token posture. Apply only after explicit confirmation with `mode: "apply"`, the same target options, and the confirm token handled by the adapter.

Use `deleteBranch: true` only when branch deletion is explicitly intended. Use `abandonUnmerged: true` only when the user explicitly confirms abandoning unmerged local Guardian work.
