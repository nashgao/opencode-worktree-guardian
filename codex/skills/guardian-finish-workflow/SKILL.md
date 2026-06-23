---
name: guardian-finish-workflow
description: Use when the user asks Guardian to plan or apply the implementation-done cleanup workflow for redundant merged worktrees and branches.
---

# Guardian Finish Workflow

Plan first through the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_finish_workflow '{"mode":"plan"}'
```

Inspect primary-worktree preflight, stash status, cleanup candidates, blockers, resolved base evidence, and the confirm token posture. Apply only after explicit user confirmation with `mode: "apply"`, `confirm: true`, and the same options.

This workflow may remove only redundant merged Guardian worktrees and merged local branches through Guardian gates. It must not invent commits, merge protected branches, mutate stashes, force-delete branches, or run raw cleanup.
