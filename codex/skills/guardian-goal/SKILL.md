---
name: guardian-goal
description: Use when the user asks Codex to drive the repo to the configured Guardian desired end state, such as commit, land, push, clean Guardian worktrees/branches, and safe hygiene cleanup.
---

# Guardian Goal

Use the Guardian Codex adapter for the configured desired-state workflow:

```bash
node <adapter-path> tool guardian_goal '{"mode":"plan"}'
```

Inspect the configured goal flags, child `guardian_hygiene` and `guardian_done` steps, blockers, and selected dirty target. If the user invoked this goal workflow and the plan is safe, continue with the same plan options plus `confirm: true`; the adapter reuses the matching plan token. Include an explicit `commitMessage` when Guardian needs to commit dirty implementation work.

`guardian_goal` composes existing Guardian gates. It applies safe known-cleanable hygiene cleanup before `guardian_done`, then lets `guardian_done` commit, land, push, sync base, and clean Guardian-owned stale worktrees or branches according to the repo state and config. It does not force unmerged abandonment, raw cleanup, stash mutation, or protected-branch bypasses.

Never replace `guardian_goal` with raw push, merge, branch deletion, worktree deletion, stash mutation, force-push, or cleanup commands.
