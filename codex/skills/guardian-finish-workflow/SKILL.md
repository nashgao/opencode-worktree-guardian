---
name: guardian-finish-workflow
description: Use when the user asks Guardian to plan or apply the implementation-done cleanup workflow for redundant merged worktrees and branches.
---

# Guardian Finish Workflow

Plan first through the Guardian Codex adapter:

```bash
node <adapter-path> tool guardian_finish_workflow '{"mode":"plan"}'
```

Inspect primary-worktree preflight, stash status, cleanup candidates, blockers, resolved base evidence, and the confirm token posture. Stash inventory is advisory by default and remains visible without blocking; only repositories that explicitly set `requireEmptyStashInventory: true` block on a non-empty inventory. Apply only after explicit user confirmation with `mode: "apply"`, `confirm: true`, and the same options. A `planned-partial` token may authorize only the safe token-bound candidates it lists; candidate-level blockers and local base-sync divergence must remain reported after apply.

This workflow may remove only redundant merged Guardian worktrees and merged local branches through Guardian gates, plus token-bound merged remote Guardian refs from the resolved effective remote. Legacy missing-phase reservations are active. New reservations persist `pending-proof` before their canonical direct non-symbolic raw commit OID ref under `refs/opencode-guardian/remote-branch-cleanup/`, then promote after proof; retry can create or promote. Active retirement requires and preserves exact proof. Pending no-ref retirement requires a strict descendant advance and preserves the remote branch without a safety ref. Absent reconciliation uses an empty-expectation leased CAS immediately before completion. Retirement-only work is counted, bounded with omitted counts, skips deletion, base sync, and final postflight, and requires a fresh plan. Local branch refs are deleted only after safety-ref creation, ancestry proof, and an exact expected-head check. It must not invent commits, merge protected branches, mutate stashes, force-delete branches, delete unproven local stale branches, or run raw cleanup.

After a successful apply, relay the attached bounded `postCompletionHygiene` inventory, including protected-root counts and truncation markers, before declaring completion. `scan-failed` or `incomplete` means the cleanup mutation may have succeeded, but the completion result remains partial until a fresh read-only scan succeeds.
