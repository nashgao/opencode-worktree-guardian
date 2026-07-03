---
name: guardian-init
description: Use when the user asks Guardian to initialize, bootstrap, or write the repo-local Guardian config.
---

# Guardian Init

Run the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_init '{}'
```

This writes `.opencode/worktree-guardian.json` only when it is missing. It must not create sessions, worktrees, branches, commits, or cleanup anything. If the config already exists, report that it was left unchanged.
