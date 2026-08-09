---
name: guardian-recover
description: Use when the user asks Guardian to recover, inspect recovery refs, orphaned sessions, stashes, or suggested recovery evidence.
---

# Guardian Recover

Run the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_recover '{}'
```

Treat the result as read-only evidence. Terminal reattach and stale cleanup are plan-only handoffs: inspect native pending-to-active proof and absent empty-lease reconciliation, then obtain a fresh plan before a separate mutation tool acts. Do not create recovery branches, mutate stashes, delete worktrees, clean files, or remove refs from this skill.
