---
name: guardian-gc
description: Use when the user asks Guardian to prune stale terminal, poisoned primary/protected, or orphaned session records.
---

# Guardian GC

Plan record-only state cleanup through the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_gc '{"mode":"plan"}'
```

Apply only after explicit confirmation with `mode: "apply"`, `confirmDelete: true`, and the returned token posture handled by the adapter.

`guardian_gc` removes only Guardian JSON session records. It never deletes git branches, worktrees, refs, stashes, or files.
