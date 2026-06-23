---
name: guardian-done
description: Use when the user says Guardian done, finish the job, complete the implementation, land and clean up, or asks Codex to run the normal Guardian completion workflow.
---

# Guardian Done

Use the Guardian Codex adapter for the implementation-done workflow:

```bash
node <adapter-path> tool guardian_done '{"mode":"plan"}'
```

Inspect the selected lane, dirty files, blockers, and cleanup preview. Apply only after explicit user confirmation with the same plan options plus `confirm: true`. Include an explicit `commitMessage` when Guardian needs to commit dirty work. Add `allowAdminBypass: true` only when the user explicitly approves a branch-protection bypass for that run.

Never replace `guardian_done` with raw push, merge, branch deletion, worktree deletion, stash mutation, force-push, or protected-branch bypass commands.
