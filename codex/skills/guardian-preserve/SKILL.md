---
name: guardian-preserve
description: Use when the user asks Guardian to preserve, keep, or mark current worktree work as terminal with a safety ref.
---

# Guardian Preserve

Run the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_preserve '{}'
```

Report the preserved path, branch, and any safety ref returned by Guardian. Preservation does not authorize deletion, cleanup, reset, stash mutation, push, or merge.
