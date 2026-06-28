---
name: guardian-finish-workflow
description: Use when the user asks Guardian to plan or apply the implementation-done cleanup workflow for redundant merged worktrees and branches.
---

# Guardian Finish Workflow

Plan first through the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_finish_workflow '{"mode":"plan"}'
```

Inspect primary-worktree preflight, stash status, cleanup candidates, blockers, resolved base evidence, and the confirm token posture. Apply only after explicit user confirmation with `mode: "apply"`, `confirm: true`, and the same options. A `planned-partial` token may authorize only the safe token-bound candidates it lists; candidate-level blockers and local base-sync divergence must remain reported after apply.

This workflow may remove only redundant merged Guardian worktrees and merged local branches through Guardian gates, plus token-bound merged remote Guardian refs from the resolved effective remote using expected-head leases. Local branch refs are deleted only after safety-ref creation, ancestry proof, and an exact expected-head check. It must not invent commits, merge protected branches, mutate stashes, force-delete branches, delete unproven local stale branches, or run raw cleanup.
