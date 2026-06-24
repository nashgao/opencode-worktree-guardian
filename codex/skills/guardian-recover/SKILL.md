---
name: guardian-recover
description: Use when the user asks Guardian to recover, inspect recovery refs, orphaned sessions, stashes, or suggested recovery evidence.
---

# Guardian Recover

Run the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_recover '{}'
```

Treat the result as read-only evidence. Do not create recovery branches, mutate stashes, delete worktrees, clean files, or remove refs from this skill.
