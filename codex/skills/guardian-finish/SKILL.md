---
name: guardian-finish
description: Use when the user explicitly asks for low-level Guardian finish behavior rather than the normal guardian-done workflow.
---

# Guardian Finish

Prefer `guardian_done` for normal completion. If the user explicitly asks for the low-level finish tool, run:

```bash
node <adapter-path> tool guardian_finish '{}'
```

If finish is blocked, report the blockers and the next safe Guardian action. Do not manually push, merge, clean, remove worktrees, delete branches, or bypass protected branches.
