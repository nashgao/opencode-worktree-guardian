---
name: guardian-start
description: Use when the user asks Guardian to start, create, attach, or repair a Guardian-owned worktree session.
---

# Guardian Start

Run the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_start '{}'
```

Use `createWorktree: true` only when the user wants Guardian to create or repair ownership into a Guardian worktree. Report the owned worktree path and any blockers returned by the tool.

Do not use raw `git worktree add` as a substitute for Guardian ownership.
