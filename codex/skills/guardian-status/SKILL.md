---
name: guardian-status
description: Use when the user asks for Guardian status, worktree inventory, branch safety, stale sessions, or what Guardian sees now.
---

# Guardian Status

Run the Guardian Codex adapter instead of raw cleanup or Git mutation:

```bash
node <adapter-path> tool guardian_status '{}'
```

Treat the result as read-only evidence. Do not run raw cleanup, reset, stash mutation, worktree removal, branch deletion, or filesystem deletion commands.
