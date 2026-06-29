---
name: guardian-done
description: Use when the user says Guardian done, finish the job, complete the implementation, land and clean up, or asks Codex to run the normal Guardian completion workflow.
---

# Guardian Done

Use the Guardian Codex adapter for the implementation-done workflow:

```bash
node <adapter-path> tool guardian_done '{"mode":"plan"}'
```

Inspect the selected lane, dirty files, blockers, and cleanup preview. If the user invoked this completion workflow and the plan is safe, continue with the same plan options plus `confirm: true`; the adapter reuses the matching plan token. Include an explicit `commitMessage` when Guardian needs to commit dirty work. Add `allowAdminBypass: true` only when the user explicitly approves a branch-protection bypass for that run.

`guardian_done` resolves the target from repo-wide inventory, not from whichever cwd Codex happens to be in. Bare `guardian_done` auto-selects exactly one dirty implementation target. If multiple dirty targets exist, stop on `needs-selection` and rerun the exact `primary=true`, `sessionId=...`, or `branch=...` option shown in the output. Use explicit `primary=true`, `sessionId=...`, or `branch=...` from any cwd when the user already selected the target.

Never replace `guardian_done` with raw push, merge, branch deletion, worktree deletion, stash mutation, force-push, or protected-branch bypass commands.
